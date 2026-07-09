import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree, terminateTaskWorkerProcessTree } from "../plugins/opencode/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateTaskWorkerProcessTree skips pid when command line is not the expected worker", () => {
  const outcome = terminateTaskWorkerProcessTree(1234, {
    jobId: "job-expected",
    platform: "linux",
    runCommandImpl(command, args) {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-ww", "-p", "1234", "-o", "args="]);
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "node unrelated-script.mjs --job-id job-expected\n",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill should not run for a mismatched pid");
    }
  });

  assert.equal(outcome.attempted, false);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.reason, "identity-mismatch");
});

test("terminateTaskWorkerProcessTree keeps process-group termination for matching worker", () => {
  const kills = [];
  const outcome = terminateTaskWorkerProcessTree(1234, {
    jobId: "job-expected",
    platform: "linux",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout:
          'node /repo/plugins/opencode/scripts/opencode-companion.mjs task-worker --cwd /repo --job-id "job-expected"\n',
        stderr: "",
        error: null
      };
    },
    killImpl(pid, signal) {
      kills.push({ pid, signal });
    }
  });

  assert.deepEqual(kills, [{ pid: -1234, signal: "SIGTERM" }]);
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process-group");
});
