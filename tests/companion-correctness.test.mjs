import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { listJobs, saveState } from "../plugins/opencode/scripts/lib/state.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "opencode", "scripts", "opencode-companion.mjs");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function withPluginData(pluginData, fn) {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn();
  } finally {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
}

function writeJobState(cwd, pluginData, jobs) {
  withPluginData(pluginData, () => {
    saveState(cwd, {
      version: 1,
      config: { stopReviewGate: false },
      jobs
    });
  });
}

function readJobState(cwd, pluginData) {
  return withPluginData(pluginData, () => listJobs(cwd));
}

function runTaskWithoutOpenCode(args) {
  const cwd = makeTempDir();
  const pluginData = makeTempDir("opencode-plugin-data-");
  const emptyPath = makeTempDir("opencode-plugin-empty-path-");
  const env = {
    ...process.env,
    PATH: emptyPath,
    CLAUDE_PLUGIN_DATA: pluginData,
    OPENCODE_COMPANION_SESSION_ID: ""
  };
  const result = run(process.execPath, [SCRIPT, "task", "--json", ...args], {
    cwd,
    env
  });

  return {
    result,
    jobs: readJobState(cwd, pluginData)
  };
}

test("task resume candidate ignores failed and cancelled task jobs", () => {
  const cwd = makeTempDir();
  const pluginData = makeTempDir("opencode-plugin-data-");
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    OPENCODE_COMPANION_SESSION_ID: ""
  };
  const jobs = [
    {
      id: "task-cancelled",
      jobClass: "task",
      status: "cancelled",
      title: "Cancelled task",
      threadId: "ses_cancelled",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z"
    },
    {
      id: "task-failed",
      jobClass: "task",
      status: "failed",
      title: "Failed task",
      threadId: "ses_failed",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    },
    {
      id: "task-completed",
      jobClass: "task",
      status: "completed",
      title: "Completed task",
      threadId: "ses_completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  writeJobState(cwd, pluginData, jobs);
  const result = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], {
    cwd,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.id, "task-completed");
  assert.equal(payload.candidate.threadId, "ses_completed");

  writeJobState(
    cwd,
    pluginData,
    jobs.filter((job) => job.status !== "completed")
  );
  const noCandidate = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], {
    cwd,
    env
  });

  assert.equal(noCandidate.status, 0, noCandidate.stderr);
  assert.equal(JSON.parse(noCandidate.stdout).available, false);
});

test("task prompt marker text does not classify as stop review without the explicit flag", () => {
  const { result, jobs } = runTaskWithoutOpenCode([`${STOP_REVIEW_TASK_MARKER} Please handle this normal task.`]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OpenCode CLI is not installed/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[0].title, "OpenCode Task");
  assert.match(jobs[0].summary, /Run a stop-gate review/);
});

test("task stop review classification comes from the explicit flag", () => {
  const { result, jobs } = runTaskWithoutOpenCode(["--stop-review", STOP_REVIEW_TASK_MARKER]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OpenCode CLI is not installed/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[0].title, "OpenCode Stop Gate Review");
  assert.equal(jobs[0].summary, "Stop-gate review of previous Claude turn");
});
