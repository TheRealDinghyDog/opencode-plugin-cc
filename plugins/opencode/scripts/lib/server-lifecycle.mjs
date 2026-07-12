import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { OpencodeServerClient } from "./opencode-server.mjs";
import { commandLineLooksLikeOpencodeServe, readProcessCommandLine } from "./process.mjs";
import { atomicWriteFile, resolveStateDir } from "./state.mjs";

export const SERVER_URL_ENV = "OPENCODE_COMPANION_SERVER_URL";
export const PID_FILE_ENV = "OPENCODE_COMPANION_SERVER_PID_FILE";
export const LOG_FILE_ENV = "OPENCODE_COMPANION_SERVER_LOG_FILE";
// OpenCode's own server-auth variables (not plugin-specific): when the
// password is set, `opencode serve` requires HTTP Basic auth on every route.
export const SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
export const SERVER_USERNAME_ENV = "OPENCODE_SERVER_USERNAME";

const OWNED_SERVER_USERNAME = "opencode";

const SERVER_STATE_FILE = "server.json";
const SERVER_LOCK_DIR = "server.lock";
const SERVER_LOCK_INFO_FILE = "owner.json";
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

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
  // server.json carries the owned server's password; keep it owner-only.
  atomicWriteFile(resolveServerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export function serverSessionCredentials(session) {
  return {
    password: typeof session?.password === "string" && session.password ? session.password : null,
    username: typeof session?.username === "string" && session.username ? session.username : undefined
  };
}

function generateServerPassword() {
  return crypto.randomBytes(24).toString("base64url");
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

export async function isServerHealthy(url, timeoutMs = 500, credentials = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return false;
  }

  try {
    const client = new OpencodeServerClient(normalized, credentials);
    await withTimeout((signal) => client.health({ signal }), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForServerHealth(url, timeoutMs = 10000, credentials = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerHealthy(url, 500, credentials)) {
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
    return error?.code === "EPERM" ? null : false;
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
  if (existing?.url && (await isServerHealthy(existing.url, healthTimeoutMs, serverSessionCredentials(existing)))) {
    return existing;
  }
  return null;
}

function createServerLease(options = {}) {
  const createdAt = new Date();
  const ttlMs = Math.max(1000, Number(options.leaseTtlMs) || DEFAULT_LEASE_TTL_MS);
  return {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString()
  };
}

function isLeaseActive(lease, nowMs = Date.now()) {
  const expiresAt = Date.parse(lease?.expiresAt ?? "");
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    return false;
  }

  // Leases are created by this plugin, so an EPERM response cannot prove that
  // the pid still belongs to the lease owner. Keep the long TTL for legitimate
  // sessions, but do not let an inaccessible, reused foreign pid hold teardown.
  return processIsAlive(Number(lease?.pid)) === true;
}

function pruneServerLeases(session) {
  const leases = Array.isArray(session?.leases) ? session.leases.filter((lease) => isLeaseActive(lease)) : [];
  return {
    ...session,
    leases
  };
}

function hasActiveServerLeases(session) {
  return Array.isArray(session?.leases) && session.leases.some((lease) => isLeaseActive(lease));
}

function removeServerLeaseForPid(session, pid) {
  return {
    ...session,
    leases: Array.isArray(session?.leases)
      ? session.leases.filter((lease) => Number(lease?.pid) !== pid)
      : []
  };
}

function addServerLease(session, options = {}) {
  const pruned = pruneServerLeases(session);
  const withoutSelf = pruned.leases.filter((lease) => Number(lease?.pid) !== process.pid);
  return {
    ...pruned,
    leases: [...withoutSelf, createServerLease(options)]
  };
}

async function acquireServerLock(cwd, options = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });

  const lockDir = resolveServerLockDir(cwd);
  const staleMs = Math.max(1000, Number(options.lockStaleMs) || DEFAULT_LOCK_STALE_MS);
  const pollMs = Math.max(25, Number(options.lockPollMs) || DEFAULT_LOCK_POLL_MS);
  const requestedTimeoutMs = options.lockAcquireTimeoutMs == null ? Number.NaN : Number(options.lockAcquireTimeoutMs);
  const deadline = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs >= 0 ? Date.now() + requestedTimeoutMs : null;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      // If the holder looks stale, clear it via an atomic single-winner steal
      // (never a blind remove), then re-race the mkdir.
      if (isServerLockStale(lockDir, staleMs)) {
        stealStaleServerLock(lockDir);
      }
      if (deadline != null && Date.now() >= deadline) {
        return null;
      }
      await sleep(deadline == null ? pollMs : Math.min(pollMs, Math.max(1, deadline - Date.now())));
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

export function spawnServerProcess({ cwd, port, hostname = DEFAULT_HOSTNAME, pidFile, logFile, env = process.env, password = null }) {
  // Pass the generated password via the child environment only — never argv,
  // which any local user could read from the process list. Pin the username so
  // an ambient OPENCODE_SERVER_USERNAME cannot desynchronize server and client.
  const childEnv = password
    ? { ...env, [SERVER_PASSWORD_ENV]: password, [SERVER_USERNAME_ENV]: OWNED_SERVER_USERNAME }
    : env;
  const logFd = fs.openSync(logFile, "a");
  const child = spawn("opencode", ["serve", "--hostname", hostname, "--port", String(port)], {
    cwd,
    env: childEnv,
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
  const envSource = options.env ?? process.env;
  const overrideUrl = normalizeUrl(options.serverUrl ?? envSource[SERVER_URL_ENV] ?? process.env[SERVER_URL_ENV]);
  if (overrideUrl) {
    // A password-protected external server uses the same variables OpenCode's
    // own tooling reads, so a user who secured their server has already
    // exported them.
    const credentials = {
      password: envSource[SERVER_PASSWORD_ENV] || null,
      username: envSource[SERVER_USERNAME_ENV] || undefined
    };
    try {
      const client = new OpencodeServerClient(overrideUrl, credentials);
      await withTimeout((signal) => client.health({ signal }), options.healthTimeoutMs ?? 1000);
    } catch (error) {
      if (error?.status === 401) {
        throw new Error(
          credentials.password
            ? `Configured OpenCode server rejected the provided credentials (HTTP 401): ${overrideUrl}. Check ${SERVER_PASSWORD_ENV} and ${SERVER_USERNAME_ENV}.`
            : `Configured OpenCode server requires authentication: ${overrideUrl}. Export ${SERVER_PASSWORD_ENV} (and ${SERVER_USERNAME_ENV} unless it is "opencode") so the plugin can connect.`
        );
      }
      throw new Error(`Configured OpenCode server is not healthy: ${overrideUrl}`);
    }
    return {
      url: overrideUrl,
      pid: null,
      external: true,
      password: credentials.password,
      username: credentials.username ?? null
    };
  }

  const lock = await acquireServerLock(cwd, options);
  if (!lock) {
    throw new Error("Timed out acquiring the OpenCode server lock.");
  }

  try {
    const lockedExisting = await loadHealthyServerSession(cwd, options.healthTimeoutMs ?? 500);
    if (lockedExisting) {
      const leasedExisting = addServerLease(lockedExisting, options);
      saveServerSession(cwd, leasedExisting);
      return leasedExisting;
    }

    const staleExisting = loadServerSession(cwd);
    if (staleExisting) {
      const { url, pidFile, logFile, sessionDir, pid, external, password, username, port } = staleExisting;
      // The server lock is already held here; intentionally omit cwd so teardown
      // uses the unlocked path even if the persisted session schema grows.
      await teardownServerSession({
        url,
        pidFile,
        logFile,
        sessionDir,
        pid,
        external,
        password,
        username,
        port,
        killProcess: options.killProcess ?? null,
        readProcessCommandLineImpl: options.readProcessCommandLineImpl ?? null
      });
      clearServerSession(cwd);
    }

    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    const port = options.port ?? (await findOpenPort(hostname));
    const url = `http://${hostname}:${port}`;
    const sessionDir = createServerSessionDir();
    const pidFile = path.join(sessionDir, "opencode-server.pid");
    const logFile = path.join(sessionDir, "opencode-server.log");
    // Every plugin-owned server gets its own random password so no other local
    // process can reach the API on the loopback port (issue #27).
    const password = generateServerPassword();
    const child = spawnServerProcess({
      cwd,
      hostname,
      port,
      pidFile,
      logFile,
      env: options.env ?? process.env,
      password
    });
    // Recorded for forensics (compare against the live command line when an
    // identity-mismatch teardown skip is investigated); verification itself
    // matches the LIVE command line against `opencode serve --port <port>`.
    const pidCommandLine = readProcessCommandLine(child.pid, options);

    const ready = await waitForServerHealth(url, options.timeoutMs ?? 10000, {
      password,
      username: OWNED_SERVER_USERNAME
    });
    if (!ready) {
      await teardownServerSession({
        url,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        password,
        username: OWNED_SERVER_USERNAME,
        port,
        killProcess: options.killProcess ?? null,
        readProcessCommandLineImpl: options.readProcessCommandLineImpl ?? null
      });
      return null;
    }

    const session = {
      url,
      pid: child.pid ?? null,
      pidFile,
      logFile,
      sessionDir,
      external: false,
      password,
      username: OWNED_SERVER_USERNAME,
      port,
      pidCommandLine
    };
    const leasedSession = addServerLease(session, options);
    saveServerSession(cwd, leasedSession);
    return leasedSession;
  } finally {
    lock.release?.();
  }
}

function parseServerUrlPort(url) {
  try {
    const port = Number(new URL(String(url ?? "")).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

// Fail-closed PID identity check (issue #31): only signal a PID when its live
// command line still looks like the plugin-owned `opencode serve` instance for
// this session's port. The port always exists for owned sessions — it is part
// of the persisted URL — so records written before the explicit identity
// fields existed remain verifiable. Anything unverifiable is left untouched;
// only the stale metadata is cleared.
function verifyServerPidIdentity(pid, { url = null, port = null, readProcessCommandLineImpl = null } = {}) {
  const expectedPort = Number.isFinite(port) ? Number(port) : parseServerUrlPort(url);
  if (!Number.isFinite(expectedPort)) {
    return { verified: false, reason: "identity-unverified" };
  }
  const readCommandLine = readProcessCommandLineImpl ?? readProcessCommandLine;
  const commandLine = readCommandLine(pid);
  if (!commandLine) {
    return { verified: false, reason: "identity-unverified" };
  }
  if (!commandLineLooksLikeOpencodeServe(commandLine, { port: expectedPort })) {
    return { verified: false, reason: "identity-mismatch" };
  }
  return { verified: true, reason: null };
}

async function teardownServerSessionUnlocked({
  url = null,
  pidFile = null,
  logFile = null,
  sessionDir = null,
  pid = null,
  external = false,
  password = null,
  username = null,
  killProcess = null,
  port = null,
  readProcessCommandLineImpl = null
} = {}) {
  if (url && !external) {
    try {
      const client = new OpencodeServerClient(url, { password, username: username ?? undefined });
      // Dispose only cleans up instance state; on 1.17.15 it does NOT stop the
      // HTTP listener, so the PID termination below is the actual shutdown.
      await withTimeout((signal) => client.dispose({ signal }), 1000);
    } catch {
      // Instance cleanup is best-effort; process termination below still runs.
    }
  }

  let killSkippedReason = null;
  if (!external && Number.isFinite(pid)) {
    const identity = verifyServerPidIdentity(pid, { url, port, readProcessCommandLineImpl });
    if (identity.verified) {
      try {
        killServerPid(pid, killProcess);
      } catch {
        // Ignore teardown failures during Claude session shutdown.
      }
    } else {
      killSkippedReason = identity.reason;
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

  if (killSkippedReason) {
    // Metadata is cleared (so callers still clear the session record), but the
    // process was deliberately left untouched. `skipped` keeps its existing
    // meaning of "teardown did not run at all" (leases / lock timeouts).
    return {
      skipped: false,
      killSkipped: true,
      reason: killSkippedReason,
      diagnostic: `Left PID ${pid} untouched (${killSkippedReason}); cleared stale OpenCode server metadata only.`
    };
  }

  return { skipped: false };
}

export async function teardownServerSession({
  cwd = null,
  force = false,
  ignoreCurrentProcessLease = false,
  lockAcquireTimeoutMs = null,
  lockPollMs = null,
  lockStaleMs = null,
  url = null,
  pidFile = null,
  logFile = null,
  sessionDir = null,
  pid = null,
  external = false,
  password = null,
  username = null,
  killProcess = null,
  port = null,
  readProcessCommandLineImpl = null
} = {}) {
  if (!cwd) {
    return teardownServerSessionUnlocked({
      url,
      pidFile,
      logFile,
      sessionDir,
      pid,
      external,
      password,
      username,
      killProcess,
      port,
      readProcessCommandLineImpl
    });
  }

  const lock = await acquireServerLock(cwd, { lockAcquireTimeoutMs, lockPollMs, lockStaleMs });
  if (!lock) {
    return {
      skipped: true,
      reason: "lock-timeout",
      diagnostic: "Timed out acquiring the OpenCode server lock for teardown."
    };
  }
  try {
    const current = loadServerSession(cwd);
    const currentUrl = normalizeUrl(current?.url);
    const requestedUrl = normalizeUrl(url);
    const session = current && (!requestedUrl || currentUrl === requestedUrl) ? current : null;
    if (session && !force) {
      const pruned = pruneServerLeases(session);
      const leaseChecked = ignoreCurrentProcessLease ? removeServerLeaseForPid(pruned, process.pid) : pruned;
      if (hasActiveServerLeases(leaseChecked)) {
        saveServerSession(cwd, leaseChecked);
        return { skipped: true, reason: "active-leases" };
      }
    }

    const teardownTarget = {
      url: session?.url ?? url,
      pidFile: session?.pidFile ?? pidFile,
      logFile: session?.logFile ?? logFile,
      sessionDir: session?.sessionDir ?? sessionDir,
      pid: session?.pid ?? pid,
      external: Boolean(session?.external ?? external),
      password: session?.password ?? password,
      username: session?.username ?? username,
      killProcess,
      port: session?.port ?? port,
      readProcessCommandLineImpl
    };
    const result = await teardownServerSessionUnlocked(teardownTarget);
    if (session) {
      clearServerSession(cwd);
    }
    return result;
  } finally {
    lock.release?.();
  }
}
