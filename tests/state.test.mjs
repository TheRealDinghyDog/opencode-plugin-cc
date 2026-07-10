import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  withStateLock,
  withStateLockAsync
} from "../plugins/opencode/scripts/lib/state.mjs";

function withoutPluginData(fn) {
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    return fn();
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  withoutPluginData(() => {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  withoutPluginData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    const jobs = Array.from({ length: 51 }, (_, index) => {
      const jobId = `job-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
      return {
        id: jobId,
        status: "completed",
        logFile,
        updatedAt,
        createdAt: updatedAt
      };
    });

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify(
        {
          version: 1,
          config: { stopReviewGate: false },
          jobs
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs
    });

    const prunedJobFile = resolveJobFile(workspace, "job-0");
    const prunedLogFile = resolveJobLogFile(workspace, "job-0");
    const retainedJobFile = resolveJobFile(workspace, "job-50");
    const retainedLogFile = resolveJobLogFile(workspace, "job-50");
    const jobsDir = path.dirname(prunedJobFile);

    assert.equal(fs.existsSync(retainedJobFile), true);
    assert.equal(fs.existsSync(retainedLogFile), true);

    const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(savedState.jobs.length, 50);
    assert.deepEqual(
      savedState.jobs.map((job) => job.id),
      Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
    );
    assert.deepEqual(
      fs.readdirSync(jobsDir).sort(),
      Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
        .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
        .sort()
    );
  });
});

test("withStateLockAsync yields to timers while another process holds the lock", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: "other-holder", createdAt: new Date().toISOString() })}\n`,
    "utf8"
  );

  const startedAt = Date.now();
  const timerDelay = new Promise((resolve) => setTimeout(() => resolve(Date.now() - startedAt), 25));
  const releaseTimer = setTimeout(() => fs.rmSync(lockDir, { recursive: true, force: true }), 100);

  try {
    const lockPromise = withStateLockAsync(workspace, () => {}, { lockPollMs: 1000 });
    assert.ok((await timerDelay) < 500, "the event loop should process timers before the next lock poll");
    await lockPromise;
  } finally {
    clearTimeout(releaseTimer);
    fs.rmSync(lockDir, { recursive: true, force: true });
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("withStateLock waits for stale-lock takeover by default", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: "stuck-holder", createdAt: new Date().toISOString() })}\n`,
    "utf8"
  );

  try {
    const startedAt = Date.now();
    const acquired = withStateLock(workspace, () => true, { lockPollMs: 25, lockStaleMs: 5600 });

    assert.equal(acquired, true);
    assert.ok(Date.now() - startedAt >= 5500, "the lock should be acquired by stale takeover after the old five-second deadline");
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
