#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import {
  clearServerSession,
  LOG_FILE_ENV,
  PID_FILE_ENV,
  SERVER_URL_ENV,
  loadServerSession,
  teardownServerSession
} from "./lib/server-lifecycle.mjs";
import { COMPANION_PLUGIN_DATA_ENV, resolveStateFile, updateStateAsync } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SESSION_END_STATE_LOCK_ACQUIRE_TIMEOUT_MS = 500;
const SESSION_END_SERVER_LOCK_ACQUIRE_TIMEOUT_MS = 3000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  let removedJobs = [];
  await updateStateAsync(
    workspaceRoot,
    (state) => {
      removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
      state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
    },
    { lockAcquireTimeoutMs: SESSION_END_STATE_LOCK_ACQUIRE_TIMEOUT_MS }
  );
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      // The worker alone: on Windows its tree includes the OpenCode server it
      // started, which the server teardown below handles by its leases (#77).
      terminateProcessTree(job.pid ?? Number.NaN, { windowsTree: false });
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  // Claude Code gives each plugin's hooks that plugin's own CLAUDE_PLUGIN_DATA.
  // Re-export it under a name no other plugin writes, so the commands Claude
  // runs this session use our directory even when another plugin exports
  // CLAUDE_PLUGIN_DATA to the shared env file.
  appendEnvVar(COMPANION_PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const serverSession =
    loadServerSession(cwd) ??
    (process.env[SERVER_URL_ENV]
      ? {
          url: process.env[SERVER_URL_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null,
          external: true
        }
      : null);

  try {
    await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  } catch (error) {
    process.stderr.write(
      `OpenCode session job cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
  const teardown = await teardownServerSession({
    cwd,
    url: serverSession?.url ?? null,
    pidFile: serverSession?.pidFile ?? null,
    logFile: serverSession?.logFile ?? null,
    sessionDir: serverSession?.sessionDir ?? null,
    pid: serverSession?.pid ?? null,
    external: Boolean(serverSession?.external),
    killProcess: terminateProcessTree,
    lockAcquireTimeoutMs: SESSION_END_SERVER_LOCK_ACQUIRE_TIMEOUT_MS
  });
  if (teardown?.diagnostic) {
    process.stderr.write(`${teardown.diagnostic}\n`);
  }
  if (!teardown?.skipped) {
    clearServerSession(cwd);
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
