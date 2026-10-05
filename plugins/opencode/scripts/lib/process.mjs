import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function spawnCommand(command, args, options, shell) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

// On Windows, commands like `opencode` and `npm` are .cmd shims that only a
// shell can start.
export function runCommand(command, args = [], options = {}) {
  return spawnCommand(command, args, options, process.platform === "win32" ? process.env.SHELL || true : false);
}

// Real executables (powershell.exe, taskkill.exe) start without a shell. With
// one, Node joins the arguments into a single unquoted string, and under Git
// Bash (Windows' SHELL in Claude Code) the parentheses and quotes of a
// PowerShell command break it (issue #65).
export function runExecutable(command, args = [], options = {}) {
  return spawnCommand(command, args, options, false);
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// Whether pid is gone within timeoutMs. taskkill fails a process that is
// already exiting ("The operation attempted is not supported"), so a failed
// taskkill whose target is gone anyway still stopped it (issue #77).
function processExitsWithin(pid, killImpl, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      killImpl(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return true;
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

// On Windows, `windowsTree: false` ends the process alone instead of its whole
// tree. POSIX always signals the process group, which already spares children
// started detached, like the plugin's shared OpenCode server.
export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runExecutable;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const treeArgs = options.windowsTree === false ? [] : ["/T"];
    const result = runCommandImpl("taskkill", ["/PID", String(pid), ...treeArgs, "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    if (processExitsWithin(pid, killImpl, options.exitWaitMs)) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

function commandLineTokens(commandLine) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (const char of String(commandLine ?? "")) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function tokenLooksLikeCompanionScript(token) {
  return path.basename(token) === "opencode-companion.mjs";
}

function tokensContainJobId(tokens, jobId) {
  const expected = String(jobId ?? "");
  if (!expected) {
    return false;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "--job-id" && tokens[index + 1] === expected) {
      return true;
    }
    if (tokens[index] === `--job-id=${expected}`) {
      return true;
    }
  }
  return false;
}

export function commandLineLooksLikeTaskWorker(commandLine, { jobId } = {}) {
  const tokens = commandLineTokens(commandLine);
  return (
    tokens.some(tokenLooksLikeCompanionScript) &&
    tokens.includes("task-worker") &&
    tokensContainJobId(tokens, jobId)
  );
}

function tokensContainPort(tokens, port) {
  const expected = String(port ?? "");
  if (!expected) {
    return false;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "--port" && tokens[index + 1] === expected) {
      return true;
    }
    if (tokens[index] === `--port=${expected}`) {
      return true;
    }
  }
  return false;
}

export function commandLineLooksLikeOpencodeServe(commandLine, { port } = {}) {
  // On win32 the server is spawned through a shell, so `ps`/PowerShell can
  // report the whole invocation as one quoted blob (`cmd.exe /c "opencode
  // serve --port N"`). Re-split compound tokens so the matcher sees the real
  // arguments on every platform.
  const tokens = commandLineTokens(commandLine).flatMap((token) =>
    /\s/.test(token) ? token.split(/\s+/).filter(Boolean) : [token]
  );
  // Require an opencode-ish executable token in addition to `serve --port N`.
  // Matches the real binary (/opt/homebrew/bin/opencode), test fixtures
  // (<tmp>/opencode), and Windows shims (opencode.cmd).
  if (!tokens.some((token) => path.basename(token).toLowerCase().startsWith("opencode"))) {
    return false;
  }
  if (!tokens.includes("serve")) {
    return false;
  }
  if (!tokensContainPort(tokens, port)) {
    return false;
  }
  return true;
}

export function readProcessCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runExecutable;
  const result =
    platform === "win32"
      ? runCommandImpl(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`
          ],
          {
            cwd: options.cwd,
            env: options.env
          }
        )
      : runCommandImpl("ps", ["-ww", "-p", String(pid), "-o", "args="], {
          cwd: options.cwd,
          env: options.env
        });

  if (result.error || result.status !== 0) {
    return null;
  }

  return String(result.stdout ?? "").trim() || null;
}

// The PID that listens on a local TCP port, on Windows; elsewhere null. A
// server started through a shell is not the shell's PID there (issue #65).
export function findListeningPid(port, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !Number.isInteger(Number(port))) {
    return null;
  }
  const runCommandImpl = options.runCommandImpl ?? runExecutable;
  const result = runCommandImpl(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    ],
    { cwd: options.cwd, env: options.env }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const pid = Number(String(result.stdout ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function terminateTaskWorkerProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const commandLine = readProcessCommandLine(pid, options);
  if (!commandLine) {
    return {
      attempted: false,
      delivered: false,
      method: null,
      reason: "identity-unverified",
      commandLine: null
    };
  }

  if (!commandLineLooksLikeTaskWorker(commandLine, { jobId: options.jobId })) {
    return {
      attempted: false,
      delivered: false,
      method: null,
      reason: "identity-mismatch",
      commandLine
    };
  }

  // A worker's only long-lived child is the OpenCode server it may have
  // started, which other jobs can share. On Windows that server stays in the
  // worker's process tree even though it was started detached, so end the
  // worker alone; teardown decides the server's fate by its leases (#77).
  return terminateProcessTree(pid, { ...options, windowsTree: false });
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
