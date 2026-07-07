import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { OpencodeServerClient } from "./opencode-server.mjs";
import { resolveStateDir } from "./state.mjs";

export const SERVER_URL_ENV = "OPENCODE_COMPANION_SERVER_URL";
export const PID_FILE_ENV = "OPENCODE_COMPANION_SERVER_PID_FILE";
export const LOG_FILE_ENV = "OPENCODE_COMPANION_SERVER_LOG_FILE";

const SERVER_STATE_FILE = "server.json";
const SERVER_LOCK_DIR = "server.lock";
const SERVER_LOCK_INFO_FILE = "owner.json";
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_LOCK_POLL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
  const normalized = String(url ?? "").trim().replace(/\/+$/, "");
  return normalized || null;
}

export function createServerSessionDir(prefix = "occ-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resolveServerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), SERVER_STATE_FILE);
}

function resolveServerLockDir(cwd) {
  return path.join(resolveStateDir(cwd), SERVER_LOCK_DIR);
}

export function loadServerSession(cwd) {
  const stateFile = resolveServerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveServerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveServerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearServerSession(cwd) {
  const stateFile = resolveServerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function isServerHealthy(url, timeoutMs = 500) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return false;
  }

  try {
    const client = new OpencodeServerClient(normalized);
    await withTimeout((signal) => client.health({ signal }), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForServerHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerHealthy(url, 500)) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readServerLockInfo(lockDir) {
  const infoFile = path.join(lockDir, SERVER_LOCK_INFO_FILE);
  try {
    return JSON.parse(fs.readFileSync(infoFile, "utf8"));
  } catch {
    return {};
  }
}

function serverLockAgeMs(lockDir, info) {
  const created = Date.parse(info?.createdAt ?? "");
  if (Number.isFinite(created)) {
    return Date.now() - created;
  }

  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return 0;
  }
}

function isServerLockStale(lockDir, staleMs) {
  if (!fs.existsSync(lockDir)) {
    return true;
  }

  const info = readServerLockInfo(lockDir);
  const ownerPid = Number(info?.pid);
  if (processIsAlive(ownerPid) === false) {
    return true;
  }

  // Age is only a backstop for zombie/reused PIDs where liveness is unreliable;
  // staleMs (default 30s) is well past normal startup (timeoutMs default 10s),
  // and the atomic steal bounds any misfire against a live owner to one winner.
  return serverLockAgeMs(lockDir, info) > staleMs;
}

function removeServerLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Another process may have removed or replaced the lock.
  }
}

function stealStaleServerLock(lockDir) {
  // Atomically move the stale lock aside instead of removing it in place.
  // renameSync has a single winner, so concurrent stealers cannot all clear the
  // path — a blind remove could delete a lock another process just created. The
  // winner deletes the moved copy; losers get ENOENT and re-race the atomic
  // mkdir. Residual: a lock refreshed within the rename window could be moved,
  // which is rare and costs at most one orphaned local server.
  const stealPath = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockDir, stealPath);
  } catch {
    return;
  }
  removeServerLock(stealPath);
}

function releaseServerLock(lockDir, token) {
  const info = readServerLockInfo(lockDir);
  if (info?.token !== token) {
    return;
  }
  removeServerLock(lockDir);
}

async function loadHealthyServerSession(cwd, healthTimeoutMs) {
  const existing = loadServerSession(cwd);
  if (existing?.url && (await isServerHealthy(existing.url, healthTimeoutMs))) {
    return existing;
  }
  return null;
}

async function acquireServerLock(cwd, options = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });

  const lockDir = resolveServerLockDir(cwd);
  const staleMs = Math.max(1000, Number(options.lockStaleMs) || DEFAULT_LOCK_STALE_MS);
  const pollMs = Math.max(25, Number(options.lockPollMs) || DEFAULT_LOCK_POLL_MS);
  const healthTimeoutMs = options.healthTimeoutMs ?? 500;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      // The lock is held. Reuse an already-started healthy server if one exists.
      const existing = await loadHealthyServerSession(cwd, healthTimeoutMs);
      if (existing) {
        return { session: existing, release: null };
      }

      // If the holder looks stale, clear it via an atomic single-winner steal
      // (never a blind remove), then re-race the mkdir.
      if (isServerLockStale(lockDir, staleMs)) {
        stealStaleServerLock(lockDir);
      }
      await sleep(pollMs);
      continue;
    }

    // We own the freshly created lock dir; record ownership. If that write
    // fails, remove the dir so we do not leak an unowned lock others wait out.
    try {
      fs.writeFileSync(
        path.join(lockDir, SERVER_LOCK_INFO_FILE),
        `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8"
      );
    } catch (error) {
      removeServerLock(lockDir);
      throw error;
    }
    return {
      release: () => releaseServerLock(lockDir, token)
    };
  }
}

function findOpenPort(hostname = DEFAULT_HOSTNAME) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("Could not allocate an OpenCode server port."));
        }
      });
    });
  });
}

export function spawnServerProcess({ cwd, port, hostname = DEFAULT_HOSTNAME, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn("opencode", ["serve", "--hostname", hostname, "--port", String(port)], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    shell: process.platform === "win32" ? process.env.SHELL || true : false
  });
  child.unref();
  fs.closeSync(logFd);

  if (pidFile && child.pid) {
    fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  }

  return child;
}

function killServerPid(pid, killProcess = null) {
  if (!Number.isFinite(pid)) {
    return;
  }

  if (killProcess) {
    killProcess(pid);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore already-exited processes.
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Ignore missing process groups.
    }
  }
}

export async function ensureServer(cwd, options = {}) {
  const overrideUrl = normalizeUrl(options.serverUrl ?? options.env?.[SERVER_URL_ENV] ?? process.env[SERVER_URL_ENV]);
  if (overrideUrl) {
    if (!(await isServerHealthy(overrideUrl, options.healthTimeoutMs ?? 1000))) {
      throw new Error(`Configured OpenCode server is not healthy: ${overrideUrl}`);
    }
    return {
      url: overrideUrl,
      pid: null,
      external: true
    };
  }

  const existing = await loadHealthyServerSession(cwd, options.healthTimeoutMs ?? 500);
  if (existing) {
    return existing;
  }

  const lock = await acquireServerLock(cwd, options);
  if (lock.session) {
    return lock.session;
  }

  try {
    const lockedExisting = await loadHealthyServerSession(cwd, options.healthTimeoutMs ?? 500);
    if (lockedExisting) {
      return lockedExisting;
    }

    const staleExisting = loadServerSession(cwd);
    if (staleExisting) {
      await teardownServerSession({
        ...staleExisting,
        killProcess: options.killProcess ?? null
      });
      clearServerSession(cwd);
    }

    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    const port = options.port ?? (await findOpenPort(hostname));
    const url = `http://${hostname}:${port}`;
    const sessionDir = createServerSessionDir();
    const pidFile = path.join(sessionDir, "opencode-server.pid");
    const logFile = path.join(sessionDir, "opencode-server.log");
    const child = spawnServerProcess({
      cwd,
      hostname,
      port,
      pidFile,
      logFile,
      env: options.env ?? process.env
    });

    const ready = await waitForServerHealth(url, options.timeoutMs ?? 10000);
    if (!ready) {
      await teardownServerSession({
        url,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      return null;
    }

    const session = {
      url,
      pid: child.pid ?? null,
      pidFile,
      logFile,
      sessionDir,
      external: false
    };
    saveServerSession(cwd, session);
    return session;
  } finally {
    lock.release?.();
  }
}

export async function teardownServerSession({
  url = null,
  pidFile = null,
  logFile = null,
  sessionDir = null,
  pid = null,
  external = false,
  killProcess = null
} = {}) {
  if (url && !external) {
    try {
      const client = new OpencodeServerClient(url);
      await withTimeout((signal) => client.dispose({ signal }), 1000);
    } catch {
      // Fall back to process termination below.
    }
  }

  if (!external && Number.isFinite(pid)) {
    try {
      killServerPid(pid, killProcess);
    } catch {
      // Ignore teardown failures during Claude session shutdown.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
