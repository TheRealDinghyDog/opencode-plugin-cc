import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { interruptServerTurn, runServerTurn } from "../plugins/opencode/scripts/lib/opencode.mjs";
import { loadServerSession, saveServerSession, SERVER_URL_ENV } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";
import { resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, writeJobFile } from "../plugins/opencode/scripts/lib/state.mjs";
import { buildEnv, installFakeOpencode, readFakeState, readServerBootCount } from "./fake-opencode-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

async function canListenLocalhost() {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    function finish(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }
    server.once("error", () => finish(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => finish(true));
    });
  });
}

const LOCAL_LISTEN_AVAILABLE = await canListenLocalhost();
const LOCAL_LISTEN_SKIP = LOCAL_LISTEN_AVAILABLE ? false : "local 127.0.0.1 listen is unavailable in this sandbox";

function buildTestEnv(binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: makeTempDir("opencode-plugin-data-"),
    OPENCODE_COMPANION_SESSION_ID: "sess-current",
    ...extra
  });
}

function cleanupServer(cwd, env) {
  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ cwd, session_id: env.OPENCODE_COMPANION_SESSION_ID ?? "sess-current" })
  });
}

async function withProcessEnv(patch, fn) {
  const previous = new Map();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runServerTurnEnv(env) {
  return {
    PATH: env.PATH,
    CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA,
    FAKE_OPENCODE_STATE_PATH: env.FAKE_OPENCODE_STATE_PATH,
    OPENCODE_COMPANION_SESSION_ID: env.OPENCODE_COMPANION_SESSION_ID
  };
}

function runWithTimeout(command, args, options = {}, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(options.input ?? "");
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("interruptServerTurn marks env-provided server urls as external", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  writeExecutable(
    path.join(binDir, "opencode"),
    `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  console.log("opencode test");
  process.exit(0);
}
if (process.argv[2] === "serve" && process.argv.includes("--help")) {
  console.log("serve help");
  process.exit(0);
}
process.exit(1);
`
  );
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (requestUrl, options = {}) => {
    const url = new URL(String(requestUrl));
    calls.push({ method: options.method ?? "GET", pathname: url.pathname });
    if (url.pathname === "/global/health") {
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/session/ses_external/abort") {
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/global/dispose") {
      throw new Error("external server should not be disposed");
    }
    return jsonResponse({ error: "not found" }, 404);
  };

  try {
    const result = await withProcessEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        [SERVER_URL_ENV]: "http://opencode.test"
      },
      () => interruptServerTurn(workspace, { threadId: "ses_external" })
    );

    assert.equal(result.interrupted, true);
    assert.equal(result.serverUrl, "http://opencode.test");
    assert.equal(result.serverExternal, true);
    assert.deepEqual(calls, [
      { method: "GET", pathname: "/global/health" },
      { method: "POST", pathname: "/session/ses_external/abort" }
    ]);

    const missingThreadResult = await withProcessEnv(
      {
        [SERVER_URL_ENV]: "http://opencode.test/"
      },
      () => interruptServerTurn(workspace, { threadId: null, serverUrl: "http://opencode.test" })
    );
    assert.equal(missingThreadResult.attempted, false);
    assert.equal(missingThreadResult.serverExternal, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("session end clears server session when job cleanup fails but teardown succeeds", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const sessionId = "sess-cleanup-throws";

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, async () => {
    saveServerSession(workspace, {
      url: "http://127.0.0.1:1",
      pid: null,
      pidFile: null,
      logFile: null,
      sessionDir: null,
      external: false,
      leases: []
    });
    fs.mkdirSync(resolveStateFile(workspace), { recursive: true });

    const result = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: workspace,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        OPENCODE_COMPANION_SESSION_ID: sessionId
      },
      input: JSON.stringify({ cwd: workspace, session_id: sessionId })
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /OpenCode session job cleanup failed/);
    assert.equal(loadServerSession(workspace), null);
  });
});

test("session end leaves server session when teardown is skipped for active leases", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const timestamp = new Date().toISOString();

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, async () => {
    saveServerSession(workspace, {
      url: "http://127.0.0.1:1",
      pid: null,
      pidFile: null,
      logFile: null,
      sessionDir: null,
      external: false,
      leases: [
        {
          pid: process.pid,
          token: "parent-test-lease",
          createdAt: timestamp,
          expiresAt: new Date(Date.now() + 60000).toISOString()
        }
      ]
    });

    const result = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: workspace,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        OPENCODE_COMPANION_SESSION_ID: "sess-active-lease"
      },
      input: JSON.stringify({ cwd: workspace, session_id: "sess-active-lease" })
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(loadServerSession(workspace).url, "http://127.0.0.1:1");
  });
});

test("session end bounds a contended server teardown lock and reports a diagnostic", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir("opencode-plugin-data-");

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, async () => {
    saveServerSession(workspace, {
      url: "http://127.0.0.1:1",
      pid: null,
      pidFile: null,
      logFile: null,
      sessionDir: null,
      external: false,
      leases: []
    });
    const lockDir = path.join(resolveStateDir(workspace), "server.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "other-holder", createdAt: new Date().toISOString() })}\n`,
      "utf8"
    );

    try {
      const result = await runWithTimeout(
        "node",
        [SESSION_HOOK, "SessionEnd"],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: pluginDataDir,
            OPENCODE_COMPANION_SESSION_ID: "sess-server-lock-contention"
          },
          input: JSON.stringify({ cwd: workspace, session_id: "sess-server-lock-contention" })
        },
        4200
      );

      assert.equal(result.timedOut, false, "SessionEnd should finish within its five-second hook budget");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Timed out acquiring the OpenCode server lock for teardown/);
      assert.equal(loadServerSession(workspace).url, "http://127.0.0.1:1");
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

test("stop review gate blocks when the enabled OpenCode reviewer is unavailable", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const env = {
    ...process.env,
    PATH: binDir,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    OPENCODE_COMPANION_SESSION_ID: "sess-current"
  };

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () => {
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: true },
      jobs: []
    });

    const result = run(process.execPath, [STOP_HOOK], {
      cwd: workspace,
      env,
      input: JSON.stringify({
        cwd: workspace,
        session_id: env.OPENCODE_COMPANION_SESSION_ID
      })
    });

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /OpenCode reviewer is unavailable/);
    assert.match(decision.reason, /\/opencode:setup/);
    assert.match(decision.reason, /--disable-review-gate/);
    assert.match(result.stderr, /blocking this stop/);
  });
});

test("stop review gate tears down a server left by a failed stop review task", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_MESSAGE_FAIL: "empty-recovery"
  });

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, async () => {
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: true },
      jobs: []
    });

    const result = run("node", [STOP_HOOK], {
      cwd: workspace,
      env,
      input: JSON.stringify({
        cwd: workspace,
        session_id: env.OPENCODE_COMPANION_SESSION_ID,
        last_assistant_message: "Previous turn output."
      })
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, "block");
    assert.match(readFakeState(binDir).lastMessage.prompt, /Run a stop-gate review of the previous Claude turn/);
    assert.equal(loadServerSession(workspace), null);
  });
});

test("cancel tears down a server it starts to abort a job without a recorded server url", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const env = buildTestEnv(binDir);

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA }, async () => {
    const jobId = "job-cancel-starts-server";
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
      threadId: "ses_cancel_without_server_url",
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

    try {
      const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], {
        cwd: workspace,
        env
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.cancelled, true);
      assert.equal(payload.turnInterruptAttempted, true);
      assert.equal(payload.turnInterrupted, true);
      assert.equal(readFakeState(binDir).lastAbort, "ses_cancel_without_server_url");
      assert.equal(loadServerSession(workspace), null);
    } finally {
      cleanupServer(workspace, env);
    }
  });
});

test("cancel aborts but does not dispose an env-provided external server", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const fetchLog = path.join(pluginDataDir, "external-fetch.jsonl");
  const fetchPreload = path.join(pluginDataDir, "external-fetch-preload.mjs");
  fs.writeFileSync(
    fetchPreload,
    `
import fs from "node:fs";

const logFile = process.env.TEST_FETCH_LOG;
globalThis.fetch = async (requestUrl, options = {}) => {
  const url = new URL(String(requestUrl));
  const method = options.method ?? "GET";
  fs.appendFileSync(logFile, JSON.stringify({ method, pathname: url.pathname }) + "\\n", "utf8");
  if (method === "GET" && url.pathname === "/global/health") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (method === "POST" && url.pathname === "/session/ses_external_cancel/abort") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (method === "POST" && url.pathname === "/global/dispose") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" }
  });
};
`,
    "utf8"
  );
  writeExecutable(
    path.join(binDir, "opencode"),
    `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  console.log("opencode test");
  process.exit(0);
}
if (process.argv[2] === "serve" && process.argv.includes("--help")) {
  console.log("serve help");
  process.exit(0);
}
process.exit(1);
`
  );

  await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, async () => {
    const jobId = "job-cancel-external-server";
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
      title: "Running external task",
      threadId: "ses_external_cancel",
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

    const result = run(process.execPath, ["--import", fetchPreload, SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        OPENCODE_COMPANION_SESSION_ID: "sess-current",
        TEST_FETCH_LOG: fetchLog,
        [SERVER_URL_ENV]: "http://opencode.test"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.cancelled, true);
    assert.equal(payload.turnInterruptAttempted, true);
    assert.equal(payload.turnInterrupted, true);

    const calls = fs
      .readFileSync(fetchLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      { method: "GET", pathname: "/global/health" },
      { method: "POST", pathname: "/session/ses_external_cancel/abort" }
    ]);
    assert.equal(loadServerSession(workspace), null);
  });
});

function installFailingCaptureFetch(createdSessionId = "ses_created") {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (requestUrl, options = {}) => {
    const url = new URL(String(requestUrl));
    const method = options.method ?? "GET";
    calls.push({ method, pathname: url.pathname });

    if (method === "GET" && url.pathname === "/global/health") {
      return jsonResponse({ ok: true });
    }
    if (method === "POST" && url.pathname === "/session") {
      return jsonResponse({ id: createdSessionId });
    }
    if (method === "GET" && url.pathname === "/event") {
      return jsonResponse({ error: "event stream failed" }, 500);
    }
    if (method === "DELETE" && url.pathname === `/session/${createdSessionId}`) {
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "not found" }, 404);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
    }
  };
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
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

test("setup reports ready when fake opencode is installed and configurable", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const env = buildTestEnv(binDir);

  try {
    const result = run("node", [SCRIPT, "setup", "--json"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.opencode.available, true);
    assert.equal(payload.auth.loggedIn, true);
    assert.equal(payload.auth.provider, "openai");
    assert.equal(payload.sessionRuntime.mode, "shared");
  } finally {
    cleanupServer(repo, env);
  }
});

test("foreground task runs through opencode serve and stores a visible session", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildTestEnv(binDir);

  try {
    const result = run("node", [SCRIPT, "task", "--json", "check the fixture"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.threadId, /^ses_/);
    assert.match(payload.rawOutput, /Handled the requested task/);
    // Progress is streamed to stderr only in non-JSON mode (it goes to the job
    // log file under --json), so stderr progress is covered by the live smoke
    // test rather than asserted here.

    const list = run("opencode", ["session", "list"], { cwd: repo, env });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(payload.threadId));

    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.serverStarts, 1);
    assert.equal(fakeState.sessions.length, 1);
    assert.equal(fakeState.sessions[0].id, payload.threadId);
    assert.match(fakeState.sessions[0].title, /^OpenCode Companion Task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("write task auto-allows headless permission prompts and records touched files", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir);

  try {
    const result = run("node", [SCRIPT, "task", "--json", "--write", "create a small file"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.touchedFiles, ["generated.txt"]);

    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.sessions[0].agent, "build");
    assert.equal(fakeState.permissions.length, 1);
    assert.equal(fakeState.permissions[0].body.response, "always");
    assert.equal(fakeState.permissions[0].body.action, undefined);
    assert.deepEqual(
      fakeState.sessions[0].permission.filter((rule) => rule.action === "allow").map((rule) => rule.permission).sort(),
      ["*"]
    );
  } finally {
    cleanupServer(repo, env);
  }
});

test("task forwards spark model alias and effort as OpenCode variant", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir);

  try {
    const result = run("node", [SCRIPT, "task", "--json", "--model", "spark", "--effort", "high", "check model"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const fakeState = readFakeState(binDir);
    assert.deepEqual(fakeState.lastMessage.body.model, {
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark"
    });
    assert.equal(fakeState.lastMessage.body.variant, "high");
  } finally {
    cleanupServer(repo, env);
  }
});

test("commands reuse one shared opencode serve within the same plugin state", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir);

  try {
    const first = run("node", [SCRIPT, "task", "--json", "first task"], { cwd: repo, env });
    const second = run("node", [SCRIPT, "task", "--json", "second task"], { cwd: repo, env });

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.serverStarts, 1);
    assert.equal(fakeState.sessions.length, 2);
  } finally {
    cleanupServer(repo, env);
  }
});

test("concurrent commands share one opencode serve startup", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_HEALTH_DELAY_MS: "250"
  });

  try {
    const [first, second] = await Promise.all([
      runAsync("node", [SCRIPT, "task", "--json", "first concurrent task"], { cwd: repo, env }),
      runAsync("node", [SCRIPT, "task", "--json", "second concurrent task"], { cwd: repo, env })
    ]);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    // serverStarts is a racy read-modify-write; the boot-marker count is
    // race-safe and reliably fails if the lock let a second server start.
    assert.equal(readServerBootCount(binDir), 1);
    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.sessions.length, 2);
  } finally {
    cleanupServer(repo, env);
  }
});

test("review captures json_schema output from StructuredOutput tool input", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "after\n");
  const env = buildTestEnv(binDir);

  try {
    const result = run("node", [SCRIPT, "review", "--json"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const expected = {
      verdict: "approve",
      summary: "summary value",
      findings: [],
      next_steps: []
    };
    assert.equal(payload.parseError, null);
    assert.deepEqual(payload.result, expected);
    assert.equal(payload.opencode.stdout, JSON.stringify(expected));

    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.lastResponseParts.length, 1);
    assert.equal(fakeState.lastResponseParts[0].type, "tool");
    assert.equal(fakeState.lastResponseParts[0].tool, "StructuredOutput");
    assert.equal(fakeState.lastResponseParts[0].text, undefined);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task succeeds when the message transport drops after session.idle (issue #2)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  // Simulates a slow turn where the held-open /message POST dies (client fetch
  // timeout) but session.idle still arrives — the exact failure that reported a
  // completed review as `fetch failed`.
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "transport" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "long running task"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /Handled the requested task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task succeeds when the message transport drops before completion events (issue #2)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  // Reproduces the real ordering where the held-open /message POST fails first,
  // then the event stream later delivers the final message and session.idle.
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "delayed-events" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "long running task"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /Handled the requested task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task succeeds when the event stream drops before a successful message response (issue #15)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_MESSAGE_FAIL: "event-drop-before-message-response"
  });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "long running task"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /Handled the requested task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task recovers the final message over HTTP when only session.idle arrives (issue #2)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  // No message.updated event and a dropped POST response: the client must
  // re-fetch the finished assistant message from the server to complete.
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "recover" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "long running task"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /Handled the requested task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task fails closed when a resumed-session snapshot fails and only stale messages are recoverable (issue #15)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    path.join(binDir, "fake-opencode-state.json"),
    JSON.stringify(
      {
        serverStarts: 0,
        nextSessionId: 2,
        nextMessageId: 2,
        sessions: [
          {
            id: "ses_existing",
            directory: fs.realpathSync(repo),
            title: "OpenCode Companion Task: prior fixture task",
            agent: "plan",
            model: null,
            permission: []
          }
        ],
        messages: [],
        responses: [
          {
            sessionID: "ses_existing",
            info: { id: "msg_1", role: "assistant", sessionID: "ses_existing" },
            parts: [{ type: "text", text: "Prior stale assistant message." }]
          }
        ],
        imports: [],
        permissions: [],
        lastAbort: null
      },
      null,
      2
    )
  );
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_MESSAGE_FAIL: "snapshot-fails-empty-recovery",
    OPENCODE_COMPANION_SESSION_ID: ""
  });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "--resume-last", "follow up with no output"], {
      cwd: repo,
      env
    });

    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 1);
    assert.equal(payload.rawOutput, "");
  } finally {
    cleanupServer(repo, env);
  }
});

test("task recovery falls back to the newest assistant message when event message id is stale (issue #12)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "mismatched-recover" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "long running task"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    // The recovered text ("Handled the requested task") comes from the stored
    // assistant message, so status 0 + this rawOutput already prove the .pop()
    // fallback selected the right message despite the stale event id. (The
    // --json payload intentionally does not expose turnId.)
    assert.match(payload.rawOutput, /Handled the requested task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task fails when completion has no recoverable current-turn message (issue #2)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    path.join(binDir, "fake-opencode-state.json"),
    JSON.stringify(
      {
        serverStarts: 0,
        nextSessionId: 2,
        nextMessageId: 2,
        sessions: [
          {
            id: "ses_existing",
            // realpath: makeTempDir returns a symlinked /var path on macOS, but
            // findLatestTaskThread matches against the realpath'd workspace root.
            directory: fs.realpathSync(repo),
            title: "OpenCode Companion Task: prior fixture task",
            agent: "plan",
            model: null,
            permission: []
          }
        ],
        messages: [],
        responses: [
          {
            sessionID: "ses_existing",
            info: { id: "msg_1", role: "assistant", sessionID: "ses_existing" },
            parts: [{ type: "text", text: "Prior stale assistant message." }]
          }
        ],
        imports: [],
        permissions: [],
        lastAbort: null
      },
      null,
      2
    )
  );
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_MESSAGE_FAIL: "empty-recovery",
    OPENCODE_COMPANION_SESSION_ID: ""
  });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "--resume-last", "follow up with no output"], {
      cwd: repo,
      env
    });

    assert.notEqual(result.status, 0, result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 1);
    assert.equal(payload.rawOutput, "");
  } finally {
    cleanupServer(repo, env);
  }
});

test("runServerTurn deletes only sessions created by a failed captureTurn", async () => {
  const createdRepo = makeTempDir();
  const createdBinDir = makeTempDir();
  installFakeOpencode(createdBinDir);
  const createdEnv = buildTestEnv(createdBinDir);
  const createdFetch = installFailingCaptureFetch("ses_created");

  try {
    await withProcessEnv(runServerTurnEnv(createdEnv), async () => {
      saveServerSession(createdRepo, {
        url: "http://opencode.test",
        pid: null,
        pidFile: null,
        logFile: null,
        sessionDir: null,
        external: false,
        leases: []
      });
    });

    await withProcessEnv(runServerTurnEnv(createdEnv), async () => {
      await assert.rejects(
        runServerTurn(createdRepo, { prompt: "fail during event open" }),
        /OpenCode GET \/event failed with HTTP 500/
      );
    });

    assert.equal(createdFetch.calls.filter((call) => call.method === "POST" && call.pathname === "/session").length, 1);
    assert.equal(
      createdFetch.calls.filter((call) => call.method === "DELETE" && call.pathname === "/session/ses_created").length,
      1
    );
  } finally {
    createdFetch.restore();
  }

  const resumedRepo = makeTempDir();
  const resumedBinDir = makeTempDir();
  installFakeOpencode(resumedBinDir);
  const resumedEnv = buildTestEnv(resumedBinDir);
  const resumedFetch = installFailingCaptureFetch("ses_created");

  try {
    await withProcessEnv(runServerTurnEnv(resumedEnv), async () => {
      saveServerSession(resumedRepo, {
        url: "http://opencode.test",
        pid: null,
        pidFile: null,
        logFile: null,
        sessionDir: null,
        external: false,
        leases: []
      });
    });

    await withProcessEnv(runServerTurnEnv(resumedEnv), async () => {
      await assert.rejects(
        runServerTurn(resumedRepo, {
          prompt: "fail resumed event open",
          resumeThreadId: "ses_existing"
        }),
        /OpenCode GET \/event failed with HTTP 500/
      );
    });

    assert.equal(resumedFetch.calls.filter((call) => call.method === "POST" && call.pathname === "/session").length, 0);
    assert.equal(
      resumedFetch.calls.filter((call) => call.method === "DELETE" && call.pathname.startsWith("/session/")).length,
      0
    );
  } finally {
    resumedFetch.restore();
  }
});
