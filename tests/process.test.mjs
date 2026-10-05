import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findListeningPid,
  quoteWindowsShellArgs,
  readProcessCommandLine,
  runCommand,
  runExecutable,
  terminateProcessTree,
  terminateTaskWorkerProcessTree
} from "../plugins/opencode/scripts/lib/process.mjs";

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

// Issue #77: a worker's Windows process tree includes the OpenCode server it
// started, which other jobs may share; cancel must end the worker alone.
test("terminateTaskWorkerProcessTree ends only the worker on Windows", () => {
  const calls = [];
  const outcome = terminateTaskWorkerProcessTree(1234, {
    jobId: "job-expected",
    platform: "win32",
    runCommandImpl(command, args) {
      calls.push({ command, args });
      const stdout =
        command === "powershell.exe"
          ? 'node C:/repo/plugins/opencode/scripts/opencode-companion.mjs task-worker --cwd C:/repo --job-id job-expected\r\n'
          : "SUCCESS: The process with PID 1234 has been terminated.\r\n";
      return { command, args, status: 0, signal: null, stdout, stderr: "", error: null };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(calls.map((call) => call.command), ["powershell.exe", "taskkill"]);
  assert.deepEqual(calls[1].args, ["/PID", "1234", "/F"]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

// Issue #77: taskkill fails a process that is already exiting with "The
// operation attempted is not supported". The target being gone is success.
test("terminateProcessTree accepts a failed taskkill once the target is gone", () => {
  const probes = [];
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr:
          "ERROR: The process with PID 6876 (child process of PID 1234) could not be terminated.\r\nReason: The operation attempted is not supported.\r\n",
        error: null
      };
    },
    killImpl(pid, signal) {
      probes.push({ pid, signal });
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
  });

  assert.deepEqual(probes, [{ pid: 1234, signal: 0 }]);
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.result.status, 128);
});

test("terminateProcessTree still fails when taskkill fails and the target lives on", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        exitWaitMs: 0,
        runCommandImpl(command, args) {
          return {
            command,
            args,
            status: 1,
            signal: null,
            stdout: "",
            stderr: "ERROR: The process with PID 1234 could not be terminated.\r\nReason: Access is denied.\r\n",
            error: null
          };
        },
        killImpl() {}
      }),
    /taskkill \/PID 1234 \/T \/F: exit=1: ERROR: .*Access is denied/s
  );
});

// Issue #81: Node joins shell arguments unquoted.
const TRICKY_ARGS = ["plain-1.0", "C:\\Users\\Jane Doe\\x.json", "C:\\Program Files\\", "it's", "", "HEAD^", "a&b|c<d>e"];
const PRINT_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

test("quoteWindowsShellArgs quotes for cmd.exe only where cmd would split or interpret", () => {
  const cmd = "C:\\Windows\\System32\\cmd.exe";
  assert.deepEqual(quoteWindowsShellArgs(["plain", "--format=%H", "C:\\a b\\c.json", "HEAD^", "", 'say "hi"'], cmd), [
    "plain",
    "--format=%H",
    '"C:\\a b\\c.json"',
    '"HEAD^"',
    '""',
    '"say \\"hi\\""'
  ]);
  assert.deepEqual(quoteWindowsShellArgs(["C:\\a b"], true), ['"C:\\a b"']);
  // Backslashes before the closing quote are doubled, or they would escape it.
  assert.deepEqual(quoteWindowsShellArgs(["C:\\Program Files\\", 'a\\"b c'], true), [
    '"C:\\Program Files\\\\"',
    '"a\\\\\\"b c"'
  ]);
});

test("quoteWindowsShellArgs single-quotes anything Git Bash would reinterpret", () => {
  const bash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
  assert.deepEqual(quoteWindowsShellArgs(["plain-1.0", "C:\\Users\\me\\x.json", "it's", ""], bash), [
    "plain-1.0",
    "'C:\\Users\\me\\x.json'",
    "'it'\\''s'",
    "''"
  ]);
});

const BASH = ["/bin/bash", "C:\\Program Files\\Git\\bin\\bash.exe"].find((candidate) => fs.existsSync(candidate));

test("Git Bash-quoted arguments survive bash -c intact", { skip: BASH ? false : "no bash here" }, () => {
  const line = ["node", ...quoteWindowsShellArgs(["-e", PRINT_ARGV, ...TRICKY_ARGS], BASH)].join(" ");
  const result = spawnSync(BASH, ["-c", line], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), TRICKY_ARGS);
});

test("runCommand passes arguments intact through cmd.exe and Git Bash on Windows", {
  skip: process.platform === "win32" ? false : "Windows only"
}, () => {
  const original = process.env.SHELL;
  try {
    for (const shell of [undefined, BASH].filter((value, index) => index === 0 || value)) {
      if (shell) {
        process.env.SHELL = shell;
      } else {
        delete process.env.SHELL;
      }
      const result = runCommand("node", ["-e", PRINT_ARGV, ...TRICKY_ARGS]);
      assert.equal(result.status, 0, `${shell ?? "cmd.exe"}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), TRICKY_ARGS, shell ?? "cmd.exe");
    }
  } finally {
    if (original === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = original;
    }
  }
});

test("runExecutable passes arguments through intact, with no shell to reinterpret them (issue #65)", () => {
  const tricky = `(Get-CimInstance Win32_Process -Filter 'ProcessId = 1').CommandLine "quoted"`;
  const result = runExecutable(process.execPath, ["-e", "process.stdout.write(process.argv[1])", tricky]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, tricky);
});

test("readProcessCommandLine asks PowerShell with a single-quoted filter on Windows", () => {
  let captured = null;
  const commandLine = readProcessCommandLine(4321, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return { command, args, status: 0, signal: null, stdout: "opencode serve --port 4096\r\n", stderr: "", error: null };
    }
  });
  assert.equal(commandLine, "opencode serve --port 4096");
  assert.deepEqual(captured, {
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId = 4321').CommandLine"]
  });
});

test("findListeningPid reads the port's owning process on Windows and is null elsewhere", () => {
  const runCommandImpl = (command, args) => {
    assert.equal(command, "powershell.exe");
    assert.match(args[2], /Get-NetTCPConnection -LocalPort 4096 -State Listen/);
    return { command, args, status: 0, signal: null, stdout: "6328\r\n", stderr: "", error: null };
  };
  assert.equal(findListeningPid(4096, { platform: "win32", runCommandImpl }), 6328);
  assert.equal(
    findListeningPid(4096, {
      platform: "win32",
      runCommandImpl: (command, args) => ({ command, args, status: 0, signal: null, stdout: "", stderr: "", error: null })
    }),
    null
  );
  assert.equal(findListeningPid(4096, { platform: "linux", runCommandImpl }), null);
});
