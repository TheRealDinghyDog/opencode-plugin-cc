import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
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

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
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

export function readProcessCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result =
    platform === "win32"
      ? runCommandImpl(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`
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

  return terminateProcessTree(pid, options);
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
