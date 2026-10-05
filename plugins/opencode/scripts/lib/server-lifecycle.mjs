import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { lockIsStale, readLockOwner, releaseLock, stealStaleLock, tryCreateLock } from "./lock-dir.mjs";
import {
  OpencodeServerClient,
  isSupportedOpencodeMajor,
  unsupportedOpencodeVersionError
} from "./opencode-server.mjs";
import { OpencodeV2Client } from "./opencode-server-v2.mjs";
import {
  commandLineLooksLikeOpencodeServe,
  findListeningPid,
  readProcessCommandLine,
  terminateProcessTree
} from "./process.mjs";
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

// Which server API a running server speaks: 1.x answers /global/health with
// JSON, 2.x serves its web UI there and reports itself on /api/info. Throws
// when neither answers, keeping the 1.x error unless /api/info rejected the
// credentials or named an unsupported version.
async function probeServerApi(url, credentials, signal) {
  let v1Error;
  try {
    await new OpencodeServerClient(url, credentials).health({ signal });
    return 1;
  } catch (error) {
    if (error?.status === 401 || error?.code === "OPENCODE_UNSUPPORTED_VERSION") {
      throw error;
    }
    v1Error = error;
  }
  try {
    await new OpencodeV2Client(url, credentials).health({ signal });
    return 2;
  } catch (error) {
    // 2.x serves its retired 1.x routes without auth, so a missing or wrong
    // password only shows up here.
    throw error?.status === 401 || error?.code === "OPENCODE_UNSUPPORTED_VERSION" ? error : v1Error;
  }
}

export async function detectServerApi(url, timeoutMs = 500, credentials = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return null;
  }
  try {
    return await withTimeout((signal) => probeServerApi(normalized, credentials, signal), timeoutMs);
  } catch {
    return null;
  }
}

export async function isServerHealthy(url, timeoutMs = 500, credentials = {}) {
  return (await detectServerApi(url, timeoutMs, credentials)) !== null;
}

async function waitForServerHealth(url, timeoutMs = 10000, credentials = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const api = await detectServerApi(url, 500, credentials);
    if (api !== null) {
      return api;
    }
    await sleep(100);
  }
  return null;
}

function assertSupportedServerApi(api, env) {
  if (!isSupportedOpencodeMajor(api, env)) {
    throw unsupportedOpencodeVersionError(`${api}.x`);
  }
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

async function loadHealthyServerSession(cwd, healthTimeoutMs) {
  const existing = loadServerSession(cwd);
  if (!existing?.url) {
    return null;
  }
  // Records written before 2.x support carry no `api`; the probe fills it in.
  const api = await detectServerApi(existing.url, healthTimeoutMs, serverSessionCredentials(existing));
  return api === null ? null : { ...existing, api };
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
    if (tryCreateLock(lockDir, token)) {
      return {
        release: () => releaseLock(lockDir, token)
      };
    }
    // Steal only the lock that was judged stale; a lock taken again after we
    // looked is put back, never deleted (issue #68).
    const owner = readLockOwner(lockDir);
    if (lockIsStale(lockDir, owner, staleMs)) {
      stealStaleLock(lockDir, owner.token);
    }
    if (deadline != null && Date.now() >= deadline) {
      return null;
    }
    await sleep(deadline == null ? pollMs : Math.min(pollMs, Math.max(1, deadline - Date.now())));
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

  if (process.platform === "win32") {
    // The server's own tree: OpenCode can run helpers below it.
    try {
      terminateProcessTree(pid);
    } catch {
      // Ignore already-exited processes.
    }
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore already-exited processes.
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Ignore missing process groups.
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
    let api;
    try {
      api = await withTimeout(
        (signal) => probeServerApi(overrideUrl, credentials, signal),
        options.healthTimeoutMs ?? 1000
      );
      assertSupportedServerApi(api, envSource);
    } catch (error) {
      if (error?.status === 401) {
        throw new Error(
          credentials.password
            ? `Configured OpenCode server rejected the provided credentials (HTTP 401): ${overrideUrl}. Check ${SERVER_PASSWORD_ENV} and ${SERVER_USERNAME_ENV}.`
            : `Configured OpenCode server requires authentication: ${overrideUrl}. Export ${SERVER_PASSWORD_ENV} (and ${SERVER_USERNAME_ENV} unless it is "opencode") so the plugin can connect.`
        );
      }
      const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
      throw new Error(`Configured OpenCode server is not healthy: ${overrideUrl}${reason}`);
    }
    return {
      url: overrideUrl,
      pid: null,
      external: true,
      api,
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
    if (lockedExisting && isSupportedOpencodeMajor(lockedExisting.api, options.env ?? process.env)) {
      const leasedExisting = addServerLease(lockedExisting, options);
      saveServerSession(cwd, leasedExisting);
      return leasedExisting;
    }

    const staleExisting = loadServerSession(cwd);
    if (staleExisting) {
      const { url, pidFile, logFile, sessionDir, pid, external, password, username, port, api } = staleExisting;
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
        api,
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
    const api = await waitForServerHealth(url, options.timeoutMs ?? 10000, {
      password,
      username: OWNED_SERVER_USERNAME
    });
    // On Windows the server starts behind a shell (its .cmd shim needs one), so
    // the child is the shell, and under Git Bash that shell is gone once the
    // server runs. Record the process listening on the port instead: teardown
    // verifies and stops that one (issue #65).
    const serverPid = (api !== null ? findListeningPid(port, options) : null) ?? child.pid ?? null;
    if (pidFile && serverPid && serverPid !== child.pid) {
      fs.writeFileSync(pidFile, `${serverPid}\n`, "utf8");
    }
    // Recorded for forensics (compare against the live command line when an
    // identity-mismatch teardown skip is investigated); verification itself
    // matches the LIVE command line against `opencode serve --port <port>`.
    const pidCommandLine = readProcessCommandLine(serverPid, options);
    // A server the plugin cannot drive is torn down like one that never came up.
    const ready = api !== null && isSupportedOpencodeMajor(api, options.env ?? process.env);
    if (!ready) {
      await teardownServerSession({
        url,
        pidFile,
        logFile,
        sessionDir,
        pid: serverPid,
        password,
        username: OWNED_SERVER_USERNAME,
        port,
        api,
        killProcess: options.killProcess ?? null,
        readProcessCommandLineImpl: options.readProcessCommandLineImpl ?? null
      });
      if (api !== null) {
        throw unsupportedOpencodeVersionError(`${api}.x`);
      }
      return null;
    }

    const session = {
      url,
      pid: serverPid,
      ...(serverPid !== child.pid ? { spawnPid: child.pid ?? null } : {}),
      pidFile,
      logFile,
      sessionDir,
      external: false,
      api,
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
  api = null,
  readProcessCommandLineImpl = null
} = {}) {
  // 2.x has no /global routes; its teardown is the PID kill alone.
  if (url && !external && api !== 2) {
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
  api = null,
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
      api,
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
      api: session?.api ?? api,
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
