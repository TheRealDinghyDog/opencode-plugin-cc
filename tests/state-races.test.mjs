import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { runTrackedJob } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";
import { loadServerSession, saveServerSession } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";
import {
  applyJobPatch,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  saveState,
  updateState,
  writeJobFile
} from "../plugins/opencode/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_MODULE_URL = pathToFileURL(path.join(ROOT, "plugins", "opencode", "scripts", "lib", "state.mjs")).href;
const COMPANION = path.join(ROOT, "plugins", "opencode", "scripts", "opencode-companion.mjs");

async function withPluginData(pluginDataDir, fn) {
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return await fn();
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
}

function spawnUpsert({ workspace, pluginDataDir, jobId }) {
  const childScript = `
    import { upsertJob } from ${JSON.stringify(STATE_MODULE_URL)};
    upsertJob(process.env.TEST_WORKSPACE, {
      id: process.env.TEST_JOB_ID,
      status: "running",
      title: process.env.TEST_JOB_ID
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      TEST_WORKSPACE: workspace,
      TEST_JOB_ID: jobId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test("concurrent upsertJob calls preserve independent job records", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const jobIds = Array.from({ length: 12 }, (_, index) => `job-${index}`);

  const results = await Promise.all(jobIds.map((jobId) => spawnUpsert({ workspace, pluginDataDir, jobId })));
  assert.deepEqual(
    results.map((result) => result.status),
    jobIds.map(() => 0),
    results.map((result) => result.stderr).join("\n")
  );

  await withPluginData(pluginDataDir, async () => {
    const indexedIds = loadState(workspace)
      .jobs.map((job) => job.id)
      .sort();
    assert.deepEqual(indexedIds, [...jobIds].sort());
  });
});

test("runTrackedJob completion does not overwrite a cancelled job", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const jobId = "job-cancelled-before-completion";
    const logFile = resolveJobLogFile(workspace, jobId);
    const job = {
      id: jobId,
      workspaceRoot: workspace,
      title: "Race task",
      status: "queued",
      logFile
    };

    await runTrackedJob(
      job,
      async () => {
        const completedAt = new Date().toISOString();
        const cancelledRecord = {
          ...job,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          completedAt,
          errorMessage: "Cancelled by user."
        };
        updateState(workspace, (state) => {
          writeJobFile(workspace, jobId, cancelledRecord);
          applyJobPatch(state, {
            id: jobId,
            status: "cancelled",
            phase: "cancelled",
            pid: null,
            errorMessage: "Cancelled by user.",
            completedAt
          });
        });
        return {
          exitStatus: 0,
          payload: { late: true },
          rendered: "late result\n",
          summary: "late result"
        };
      },
      { logFile }
    );

    const storedJob = readJobFile(resolveJobFile(workspace, jobId));
    const indexedJob = loadState(workspace).jobs.find((candidate) => candidate.id === jobId);
    assert.equal(storedJob.status, "cancelled");
    assert.equal(storedJob.result, undefined);
    assert.equal(indexedJob.status, "cancelled");
    assert.equal(indexedJob.summary, undefined);
  });
});

test("cancel does not clobber a completed stored job when the state index is stale active", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const jobId = "job-completed-on-disk";
    const timestamp = new Date().toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: jobId,
          status: "running",
          phase: "running",
          pid: process.pid,
          title: "Completed on disk",
          logFile,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ]
    });
    writeJobFile(workspace, jobId, {
      id: jobId,
      workspaceRoot: workspace,
      status: "completed",
      phase: "done",
      pid: null,
      title: "Completed on disk",
      logFile,
      completedAt: timestamp,
      result: { ok: true },
      rendered: "done\n"
    });

    const result = run(process.execPath, [COMPANION, "cancel", jobId, "--cwd", workspace, "--json"], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataDir
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.cancelled, false);

    const storedJob = readJobFile(resolveJobFile(workspace, jobId));
    const indexedJob = loadState(workspace).jobs.find((candidate) => candidate.id === jobId);
    assert.equal(storedJob.status, "completed");
    assert.deepEqual(storedJob.result, { ok: true });
    assert.equal(indexedJob.status, "completed");
    assert.equal(indexedJob.phase, "done");
  });
});

test("cancel tears down the shared server session when only dead leases remain", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  await withPluginData(pluginDataDir, async () => {
    const jobId = "job-cancel-teardown";
    const timestamp = new Date().toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const runningJob = {
      id: jobId,
      workspaceRoot: workspace,
      jobClass: "task",
      kind: "task",
      status: "running",
      phase: "running",
      pid: null,
      title: "Running task",
      logFile,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [runningJob]
    });
    writeJobFile(workspace, jobId, runningJob);
    saveServerSession(workspace, {
      url: "http://127.0.0.1:1",
      pid: null,
      pidFile: null,
      logFile: null,
      sessionDir: null,
      external: false,
      leases: [
        {
          pid: 999999999,
          token: "dead-worker",
          createdAt: timestamp,
          expiresAt: new Date(Date.now() + 60000).toISOString()
        }
      ]
    });

    const result = run(process.execPath, [COMPANION, "cancel", jobId, "--cwd", workspace, "--json"], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        OPENCODE_COMPANION_SESSION_ID: ""
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.cancelled, true);
    assert.equal(payload.status, "cancelled");
    assert.equal(loadServerSession(workspace), null);

    const storedJob = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(storedJob.status, "cancelled");
  });
});
