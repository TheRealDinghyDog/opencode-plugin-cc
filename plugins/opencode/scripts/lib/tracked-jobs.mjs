import fs from "node:fs";
import process from "node:process";

import {
  applyJobPatch,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateState,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      serverUrl: typeof value.serverUrl === "string" && value.serverUrl.trim() ? value.serverUrl.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    serverUrl: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastServerUrl = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.serverUrl && normalized.serverUrl !== lastServerUrl) {
      lastServerUrl = normalized.serverUrl;
      patch.serverUrl = normalized.serverUrl;
      changed = true;
    }

    if (!changed) {
      return;
    }

    patchIndexedJobFile(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[opencode] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function currentStoredStatus(stateJob, storedJob) {
  return storedJob?.status ?? stateJob?.status ?? null;
}

export function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function patchIndexedJobFile(workspaceRoot, jobId, patch) {
  updateState(workspaceRoot, (state) => {
    const stateJob = state.jobs.find((candidate) => candidate.id === jobId) ?? null;
    const currentJob = readStoredJobOrNull(workspaceRoot, jobId);
    if (isTerminalStatus(currentStoredStatus(stateJob, currentJob))) {
      return;
    }

    applyJobPatch(state, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  });
}

function writeIndexedJobFile(workspaceRoot, jobId, jobRecord, indexPatch = jobRecord, options = {}) {
  let committed = false;

  updateState(workspaceRoot, (state) => {
    if (options.skipTerminal) {
      const stateJob = state.jobs.find((candidate) => candidate.id === jobId) ?? null;
      const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
      if (isTerminalStatus(currentStoredStatus(stateJob, storedJob))) {
        return;
      }
    }

    writeJobFile(workspaceRoot, jobId, jobRecord);
    applyJobPatch(state, indexPatch);
    committed = true;
  });

  return committed;
}

function commitFinishedJob(workspaceRoot, jobId, buildUpdate) {
  let committed = false;
  let current = null;

  updateState(workspaceRoot, (state) => {
    const stateJob = state.jobs.find((candidate) => candidate.id === jobId) ?? null;
    const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
    current = storedJob ?? stateJob;
    if (isTerminalStatus(currentStoredStatus(stateJob, storedJob))) {
      return;
    }

    const update = buildUpdate(storedJob, stateJob);
    writeJobFile(workspaceRoot, jobId, update.jobRecord);
    applyJobPatch(state, update.indexPatch);
    current = update.jobRecord;
    committed = true;
  });

  return { committed, current };
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null,
    serverUrl: options.serverUrl ?? job.serverUrl ?? null
  };
  const started = writeIndexedJobFile(job.workspaceRoot, job.id, runningRecord, runningRecord, { skipTerminal: true });
  if (!started) {
    throw new Error(`Job ${job.id} is already finished.`);
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const finished = commitFinishedJob(job.workspaceRoot, job.id, (storedJob) => {
      const serverUrl = execution.serverUrl ?? runningRecord.serverUrl ?? storedJob?.serverUrl ?? null;
      const indexPatch = {
        id: job.id,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        serverUrl,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        completedAt
      };
      return {
        jobRecord: {
          ...runningRecord,
          ...(storedJob ?? {}),
          ...indexPatch,
          result: execution.payload,
          rendered: execution.rendered
        },
        indexPatch
      };
    });
    if (finished.committed) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    commitFinishedJob(job.workspaceRoot, job.id, (storedJob) => {
      const existing = storedJob ?? runningRecord;
      const indexPatch = {
        id: job.id,
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt
      };
      return {
        jobRecord: {
          ...existing,
          ...indexPatch,
          logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
        },
        indexPatch
      };
    });
    throw error;
  }
}
