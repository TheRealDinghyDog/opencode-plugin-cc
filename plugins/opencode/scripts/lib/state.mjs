import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "opencode-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const STATE_LOCK_DIR_NAME = "state.lock";
const LOCK_INFO_FILE = "owner.json";
const MAX_JOBS = 50;
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_LOCK_POLL_MS = 25;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

function resolveStateLockDir(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
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

function readLockInfo(lockDir) {
  const infoFile = path.join(lockDir, LOCK_INFO_FILE);
  try {
    return JSON.parse(fs.readFileSync(infoFile, "utf8"));
  } catch {
    return {};
  }
}

function lockAgeMs(lockDir, info) {
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

function isStateLockStale(lockDir, staleMs) {
  if (!fs.existsSync(lockDir)) {
    return true;
  }

  const info = readLockInfo(lockDir);
  if (processIsAlive(Number(info?.pid)) === false) {
    return true;
  }

  return lockAgeMs(lockDir, info) > staleMs;
}

function removeStateLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Another process may have removed or replaced the lock.
  }
}

function stealStaleStateLock(lockDir) {
  const stalePath = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockDir, stalePath);
  } catch {
    return;
  }
  removeStateLock(stalePath);
}

function releaseStateLock(lockDir, token) {
  const info = readLockInfo(lockDir);
  if (info?.token !== token) {
    return;
  }
  removeStateLock(lockDir);
}

function stateLockOptions(cwd, options = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });

  return {
    lockDir: resolveStateLockDir(cwd),
    staleMs: Math.max(1000, Number(options.lockStaleMs) || DEFAULT_LOCK_STALE_MS),
    pollMs: Math.max(10, Number(options.lockPollMs) || DEFAULT_LOCK_POLL_MS),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  };
}

function lockAcquisitionDeadline(options) {
  if (options.lockAcquireTimeoutMs == null) {
    return null;
  }

  const timeoutMs = Number(options.lockAcquireTimeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Date.now() + timeoutMs : null;
}

function tryAcquireStateLock(lockDir, staleMs, token) {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    if (isStateLockStale(lockDir, staleMs)) {
      stealStaleStateLock(lockDir);
    }
    return null;
  }

  try {
    fs.writeFileSync(
      path.join(lockDir, LOCK_INFO_FILE),
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    removeStateLock(lockDir);
    throw error;
  }

  return () => releaseStateLock(lockDir, token);
}

function acquireStateLock(cwd, options = {}) {
  const { lockDir, staleMs, pollMs, token } = stateLockOptions(cwd, options);
  const deadline = lockAcquisitionDeadline(options);

  for (;;) {
    const release = tryAcquireStateLock(lockDir, staleMs, token);
    if (release) {
      return release;
    }
    if (deadline != null && Date.now() >= deadline) {
      throw new Error("Timed out acquiring the OpenCode state lock.");
    }
    Atomics.wait(sleepBuffer, 0, 0, deadline == null ? pollMs : Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

async function acquireStateLockAsync(cwd, options = {}) {
  const { lockDir, staleMs, pollMs, token } = stateLockOptions(cwd, options);
  const deadline = lockAcquisitionDeadline(options);

  for (;;) {
    const release = tryAcquireStateLock(lockDir, staleMs, token);
    if (release) {
      return release;
    }
    if (deadline != null && Date.now() >= deadline) {
      throw new Error("Timed out acquiring the OpenCode state lock.");
    }
    await sleep(deadline == null ? pollMs : Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

// The synchronous API remains for callers that need a synchronous return value.
// It waits for acquisition or stale-lock recovery unless callers opt into a
// lockAcquireTimeoutMs deadline. Async command and hook paths should use
// withStateLockAsync so lock contention yields the Node event loop.
export function withStateLock(cwd, fn, options = {}) {
  const release = acquireStateLock(cwd, options);
  try {
    return fn();
  } finally {
    release();
  }
}

export async function withStateLockAsync(cwd, fn, options = {}) {
  const release = await acquireStateLockAsync(cwd, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

function loadStateUnlocked(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function loadState(cwd) {
  return loadStateUnlocked(cwd);
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function atomicWriteFile(filePath, contents, options = {}) {
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(
      tempFile,
      contents,
      options.mode == null ? "utf8" : { encoding: "utf8", mode: options.mode }
    );
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Ignore cleanup failures for a best-effort temp file.
    }
    throw error;
  }
}

function saveStateUnlocked(cwd, state, previousJobs = loadStateUnlocked(cwd).jobs) {
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  atomicWriteFile(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function applyJobPatch(state, jobPatch, timestamp = nowIso()) {
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...jobPatch
    });
    return;
  }
  state.jobs[existingIndex] = {
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  };
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadStateUnlocked(cwd);
    const previousJobs = [...state.jobs];
    mutate(state);
    return saveStateUnlocked(cwd, state, previousJobs);
  });
}

export function updateStateAsync(cwd, mutate, options = {}) {
  return withStateLockAsync(cwd, () => {
    const state = loadStateUnlocked(cwd);
    const previousJobs = [...state.jobs];
    mutate(state);
    return saveStateUnlocked(cwd, state, previousJobs);
  }, options);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    applyJobPatch(state, jobPatch);
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFile(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
