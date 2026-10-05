import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Spawns the fake fixture directly as a user-managed external server (no
// plugin lifecycle, no password) and resolves its base URL from stdout.
function startExternalFixtureServer(binDir) {
  const child = spawn("node", [path.join(binDir, "opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: {
      ...process.env,
      FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
      OPENCODE_SERVER_PASSWORD: ""
    },
    windowsHide: true
  });

  const url = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) {
        resolve(match[1]);
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("external fixture server exited before listening")));
    setTimeout(() => reject(new Error("external fixture server did not start")), 5000).unref();
  });

  return { child, url };
}

// Hand-rolled availability-only opencode stub (no HTTP server). Mirrors
// installFakeOpencode's Windows shim: a bare shebang script is not executable
// via PATH on win32, so binaryAvailable() would report opencode missing there.
function installStubOpencodeBinary(binDir) {
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
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"), `@echo off\r\nnode "%~dp0opencode" %*\r\n`, {
      encoding: "utf8"
    });
  }
}

test("interruptServerTurn marks env-provided server urls as external", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installStubOpencodeBinary(binDir);
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (requestUrl, options = {}) => {
    const url = new URL(String(requestUrl));
    calls.push({ method: options.method ?? "GET", pathname: url.pathname });
    if (url.pathname === "/global/health") {
      return jsonResponse({ healthy: true, version: "1.17.15" });
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

    // Ownership comes from the job record, never from the current environment
    // (issue #29): without a persisted flag the result must not claim one.
    const missingThreadResult = await withProcessEnv(
      {
        [SERVER_URL_ENV]: "http://opencode.test/"
      },
      () => interruptServerTurn(workspace, { threadId: null, serverUrl: "http://opencode.test" })
    );
    assert.equal(missingThreadResult.attempted, false);
    assert.equal("serverExternal" in missingThreadResult, false);

    const persistedExternalResult = await interruptServerTurn(workspace, {
      threadId: null,
      serverUrl: "http://opencode.test",
      serverExternal: true
    });
    assert.equal(persistedExternalResult.attempted, false);
    assert.equal(persistedExternalResult.serverExternal, true);
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

test("stop review gate names the supported versions when OpenCode is an unsupported major", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const env = buildTestEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    OPENCODE_COMPANION_SESSION_ID: "sess-current",
    FAKE_OPENCODE_VERSION_OUTPUT: "opencode v3.0.0"
  });

  return withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () => {
    saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [] });
    const result = run(process.execPath, [STOP_HOOK], {
      cwd: workspace,
      env,
      input: JSON.stringify({ cwd: workspace, session_id: env.OPENCODE_COMPANION_SESSION_ID })
    });

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /OpenCode 3\.0\.0 is not supported yet: this plugin supports OpenCode 1\.x, and 2\.x/);
    assert.match(decision.reason, /--disable-review-gate/);
    assert.doesNotMatch(decision.reason, /ensure `opencode --version` works/);
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
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, "block");
    // When the review task never reached OpenCode, say why (the gate's reason).
    assert.ok(readFakeState(binDir)?.lastMessage, `the stop review never reached OpenCode: ${decision.reason}`);
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

test("external server requests are bound to each invoking workspace (issue #29)", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const repoA = makeTempDir();
  const repoB = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repoA);
  initGitRepo(repoB);
  const { child, url } = startExternalFixtureServer(binDir);

  try {
    const serverUrl = await url;
    const resultA = run("node", [SCRIPT, "task", "--json", "task in workspace A"], {
      cwd: repoA,
      env: buildTestEnv(binDir, { [SERVER_URL_ENV]: serverUrl })
    });
    assert.equal(resultA.status, 0, resultA.stderr);
    const resultB = run("node", [SCRIPT, "task", "--json", "task in workspace B"], {
      cwd: repoB,
      env: buildTestEnv(binDir, { [SERVER_URL_ENV]: serverUrl })
    });
    assert.equal(resultB.status, 0, resultB.stderr);

    // One shared external server, two workspaces: each session must be scoped
    // to the invoking repo, not the server process's launch directory.
    const fakeState = readFakeState(binDir);
    const directories = fakeState.sessions.map((session) => session.directory).sort();
    assert.deepEqual(directories, [fs.realpathSync.native(repoA), fs.realpathSync.native(repoB)].sort());

    // The event subscriptions carried the workspace scope too.
    const eventDirectories = (fakeState.eventDirectories || []).filter(Boolean);
    assert.ok(eventDirectories.includes(fs.realpathSync.native(repoA)), "event stream scoped to workspace A");
    assert.ok(eventDirectories.includes(fs.realpathSync.native(repoB)), "event stream scoped to workspace B");
  } finally {
    child.kill();
  }
});

test("cancel without the job-start environment leaves an external server running (issue #29)", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const { child, url } = startExternalFixtureServer(binDir);

  try {
    const serverUrl = await url;
    await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, async () => {
      const jobId = "job-cancel-env-divergent";
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
        threadId: "ses_env_divergent",
        // Persisted at job start; the cancel environment below deliberately
        // lacks OPENCODE_COMPANION_SERVER_URL (the review's H-04 scenario).
        serverUrl,
        serverExternal: true,
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

      const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], {
        cwd: workspace,
        env: buildEnv(binDir, {
          CLAUDE_PLUGIN_DATA: pluginDataDir,
          OPENCODE_COMPANION_SESSION_ID: "sess-current"
        })
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.cancelled, true);
      assert.equal(payload.turnInterruptAttempted, true);
      assert.equal(payload.turnInterrupted, true);
      assert.equal(readFakeState(binDir).lastAbort, "ses_env_divergent");

      // The user-managed server must survive the cancel: no dispose (the
      // fixture exits on dispose), no process kill.
      const health = await fetch(`${serverUrl}/global/health`);
      assert.equal(health.status, 200);
      await health.text();
    });
  } finally {
    child.kill();
  }
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
    return new Response(JSON.stringify({ healthy: true, version: "1.17.15" }), {
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
  installStubOpencodeBinary(binDir);

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

    // --import requires a file:// URL on Windows (a bare D:\... path parses as
    // an unsupported "d:" URL scheme).
    const result = run(process.execPath, ["--import", pathToFileURL(fetchPreload).href, SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], {
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
      return jsonResponse({ healthy: true, version: "1.17.15" });
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

test("write task denies gated permission asks and keeps stock agent guards (issue #26)", { skip: LOCAL_LISTEN_SKIP }, () => {
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
    // Only the ungated workspace edit lands; the gated out-of-workspace edit
    // stays denied, so it never shows up in touched files.
    assert.deepEqual(payload.touchedFiles, ["generated.txt"]);

    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.sessions[0].agent, "build");
    // No session-level permission override: the stock build agent's ask-guards
    // (external_directory, .env reads, doom_loop) must stay in effect.
    assert.deepEqual(fakeState.sessions[0].permission, []);
    assert.equal(fakeState.permissions.length, 1);
    assert.equal(fakeState.permissions[0].body.response, "reject");
    assert.equal(fakeState.permissions[0].body.action, undefined);
  } finally {
    cleanupServer(repo, env);
  }
});

test("plugin-owned server requires auth for HTTP and SSE and never leaks the password (issue #27)", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const pluginDataDir = makeTempDir("opencode-plugin-data-");
  const env = buildTestEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  try {
    // The task completing at all proves the authenticated health, HTTP, and
    // SSE paths work: the fixture 401s every unauthenticated route once the
    // lifecycle passes it a generated password.
    const result = run("node", [SCRIPT, "task", "--json", "auth roundtrip"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);

    await withProcessEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, async () => {
      const session = loadServerSession(repo);
      assert.ok(session?.url, "server session persisted");
      assert.ok(
        typeof session.password === "string" && session.password.length >= 24,
        "owned server records a generated password"
      );
      assert.equal(session.username, "opencode");

      if (process.platform !== "win32") {
        const stateFile = path.join(resolveStateDir(repo), "server.json");
        assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, "server.json must be owner-only");
      }

      const unauthorizedHttp = await fetch(`${session.url}/session`);
      assert.equal(unauthorizedHttp.status, 401);
      await unauthorizedHttp.text().catch(() => {});
      const unauthorizedSse = await fetch(`${session.url}/event`, { headers: { accept: "text/event-stream" } });
      assert.equal(unauthorizedSse.status, 401);
      await unauthorizedSse.body?.cancel().catch(() => {});

      const authorization = `Basic ${Buffer.from(`${session.username}:${session.password}`).toString("base64")}`;
      const authorized = await fetch(`${session.url}/session`, { headers: { authorization } });
      assert.equal(authorized.status, 200);
      await authorized.text().catch(() => {});

      const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
      assert.equal(status.status, 0, status.stderr);
      assert.ok(!status.stdout.includes(session.password), "status output must not contain the server password");
    });
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
            directory: fs.realpathSync.native(repo),
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

test("task rejects headless question asks instead of stalling (issue #28)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_ASK_QUESTION: "1" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "task that provokes a question"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /Handled the requested task/);

    const fakeState = readFakeState(binDir);
    assert.equal(fakeState.questionRejections.length, 1);
    assert.match(fakeState.questionRejections[0].requestID, /^que_/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("task assembles the final message from part deltas without transport or recovery (issue #28)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  // The POST response is dropped and the message list withheld, so the final
  // text can only come from the message.part.updated + message.part.delta
  // stream — the exact channel the pre-#28 client ignored.
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_STREAM_DELTAS: "1" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "stream this answer"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /^Handled the requested task/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("subagent session output does not pollute the main final message (issue #28)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_SUBAGENT: "1" });

  try {
    const result = run("node", [SCRIPT, "task", "--json", "task with a subagent"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 0);
    assert.match(payload.rawOutput, /Handled the requested task/);
    assert.doesNotMatch(payload.rawOutput, /Child exploration output/);
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
            directory: fs.realpathSync.native(repo),
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

test("adversarial-review prompt uses the adversarial-review.md template", { skip: LOCAL_LISTEN_SKIP }, () => {
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
    const result = run("node", [SCRIPT, "adversarial-review", "--json"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const fakeState = readFakeState(binDir);
    const prompt = fakeState.lastMessage.prompt;
    assert.match(prompt, /adversarial software review/);
    assert.match(prompt, /break confidence/);
    assert.match(prompt, /Default to skepticism/);
  } finally {
    cleanupServer(repo, env);
  }
});

// Issue #90: a model that refuses OpenCode 1.x's forced structured-output
// tool call (DeepSeek's thinking mode) still gets a review, from the JSON in
// its reply.
test("a 1.x review falls back to JSON in the reply when the model refuses the forced tool call", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "after\n");
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_REJECT_STRUCTURED: "1" });

  try {
    const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.result, { verdict: "approve", summary: "summary value", findings: [], next_steps: [] });

    const messages = readFakeState(binDir).messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].body.format.type, "json_schema");
    assert.equal(messages[1].body.format, undefined);
    assert.match(messages[1].prompt, /<output_schema>[\s\S]*"next_steps"[\s\S]*<\/output_schema>/);
    assert.equal(messages[1].sessionID, messages[0].sessionID);

    // Without --json, the progress says why the review asked again.
    const rendered = run("node", [SCRIPT, "review"], { cwd: repo, env });
    assert.match(`${rendered.stdout}${rendered.stderr}`, /refused OpenCode's structured-output tool call \(Thinking mode does not support this tool_choice/);
    assert.match(rendered.stdout, /Verdict: approve|approve/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("a 1.x review failing for another reason gets no fallback", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "after\n");
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "provider-error" });

  try {
    const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result, null);
    assert.match(payload.parseError ?? "", /fake-model is not supported/);
    assert.equal(readFakeState(binDir).messages.length, 1);
  } finally {
    cleanupServer(repo, env);
  }
});

test("review prompt uses the neutral review.md template", { skip: LOCAL_LISTEN_SKIP }, () => {
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
    const fakeState = readFakeState(binDir);
    const prompt = fakeState.lastMessage.prompt;
    assert.doesNotMatch(prompt, /break confidence/);
    assert.doesNotMatch(prompt, /Default to skepticism/);
    assert.match(prompt, /balanced, high-signal software review/);
    assert.match(prompt, /find real bugs, correctness issues/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("review rejects positional focus text with a clear error", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "check auth paths"], {
    cwd: repo,
    env: process.env
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /does not accept positional focus text/);
  assert.match(result.stderr, /adversarial-review/);
});

test("setup reports not ready when no provider is connected", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_NO_PROVIDER: "1"
  });

  try {
    const result = run("node", [SCRIPT, "setup", "--json"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.opencode.available, true);
    assert.equal(payload.auth.loggedIn, false);
    assert.match(payload.auth.detail, /No OpenCode provider is connected/);
    assert.ok(payload.nextSteps.some((step) => /provider/i.test(step)), "nextSteps should include a provider config step");
  } finally {
    cleanupServer(repo, env);
  }
});

test("setup reports loggedIn false when /provider endpoint fails", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const env = buildTestEnv(binDir, {
    FAKE_OPENCODE_PROVIDER_FAIL: "1"
  });

  try {
    const result = run("node", [SCRIPT, "setup", "--json"], {
      cwd: repo,
      env
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.auth.loggedIn, false);
    assert.equal(payload.ready, false);
  } finally {
    cleanupServer(repo, env);
  }
});

function initCommittedRepo(repo) {
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

for (const userPartFirst of [false, true]) {
  test(
    `a provider error is reported instead of the echoed prompt${userPartFirst ? " (prompt part before its role)" : ""}`,
    { skip: LOCAL_LISTEN_SKIP },
    () => {
      const repo = makeTempDir();
      const binDir = makeTempDir();
      installFakeOpencode(binDir);
      initCommittedRepo(repo);
      const env = buildTestEnv(binDir, {
        FAKE_OPENCODE_MESSAGE_FAIL: "provider-error",
        ...(userPartFirst ? { FAKE_OPENCODE_USER_PART_FIRST: "1" } : {})
      });

      try {
        const rendered = run("node", [SCRIPT, "task", "summarize the secret plan"], { cwd: repo, env });
        assert.match(rendered.stdout, /OpenCode error: Bad Request: fake-model is not supported/);
        assert.doesNotMatch(rendered.stdout, /summarize the secret plan/);
        assert.doesNotMatch(rendered.stderr, /Assistant message captured: summarize the secret plan/);

        const json = run("node", [SCRIPT, "task", "--json", "summarize the secret plan"], { cwd: repo, env });
        const payload = JSON.parse(json.stdout);
        assert.equal(payload.status, 1);
        assert.equal(payload.rawOutput, "");
      } finally {
        cleanupServer(repo, env);
      }
    }
  );
}

test("a provider error after partial output keeps the output and reports the error", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initCommittedRepo(repo);
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "provider-error-after-text" });

  try {
    const result = run("node", [SCRIPT, "task", "summarize the secret plan"], { cwd: repo, env });
    assert.match(result.stdout, /Partial answer before the failure\./);
    assert.match(result.stdout, /OpenCode error: Bad Request: fake-model is not supported/);
    assert.doesNotMatch(result.stdout, /summarize the secret plan/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("a review whose provider fails reports the error, not the review prompt", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initCommittedRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "after\n");
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_MESSAGE_FAIL: "provider-error" });

  try {
    const result = run("node", [SCRIPT, "review"], { cwd: repo, env });
    assert.match(result.stdout, /OpenCode failed before returning a review\./);
    assert.match(result.stdout, /- Error: Bad Request: fake-model is not supported/);
    assert.doesNotMatch(result.stdout, /Raw final message/);
    assert.doesNotMatch(result.stdout, /<role>/);
  } finally {
    cleanupServer(repo, env);
  }
});

test("setup rejects an unsupported OpenCode major without starting a server", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_VERSION_OUTPUT: "opencode v3.0.0" });

  try {
    const result = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, false);
    assert.equal(payload.opencode.available, false);
    assert.equal(payload.opencode.unsupported, true);
    assert.equal(payload.opencode.version, "3.0.0");
    assert.match(payload.opencode.detail, /OpenCode 3\.0\.0 is not supported yet/);
    assert.match(payload.opencode.detail, /npm install -g opencode-ai/);
    assert.ok(payload.nextSteps.some((step) => /not supported yet/.test(step)));
    assert.equal(readServerBootCount(binDir), 0);
  } finally {
    cleanupServer(repo, env);
  }
});

test("a task on an unsupported OpenCode major fails with the unsupported-version message", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initCommittedRepo(repo);
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_VERSION_OUTPUT: "opencode v3.0.0" });

  try {
    const result = run("node", [SCRIPT, "task", "check the fixture"], { cwd: repo, env });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /OpenCode 3\.0\.0 is not supported yet/);
    assert.equal(readServerBootCount(binDir), 0);
  } finally {
    cleanupServer(repo, env);
  }
});

test("an external server bypasses the local CLI's unsupported-major gate", async () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const workspace = makeTempDir();
  await withProcessEnv(
    { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_OPENCODE_VERSION_OUTPUT: "opencode v3.0.0" },
    async () => {
      const { getOpencodeAvailability } = await import("../plugins/opencode/scripts/lib/opencode.mjs");
      const local = getOpencodeAvailability(workspace, {});
      assert.equal(local.available, false);
      assert.equal(local.unsupported, true);
      const external = getOpencodeAvailability(workspace, { [SERVER_URL_ENV]: "http://127.0.0.1:1" });
      assert.equal(external.available, true);
    }
  );
});

test("SessionStart exports this plugin's data directory under its own name, not CLAUDE_PLUGIN_DATA", () => {
  const envFile = path.join(makeTempDir(), "claude-env");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir("opencode-plugin-data-");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginDataDir },
    input: JSON.stringify({ session_id: "sess-start", transcript_path: path.join(pluginDataDir, "t.jsonl") })
  });

  assert.equal(result.status, 0, result.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.ok(exported.includes(`export OPENCODE_COMPANION_PLUGIN_DATA='${pluginDataDir}'\n`), exported);
  assert.ok(exported.includes("export OPENCODE_COMPANION_SESSION_ID='sess-start'\n"), exported);
  // Other plugins' hooks write CLAUDE_PLUGIN_DATA to the same file; this hook
  // must not overwrite theirs.
  assert.doesNotMatch(exported, /^export CLAUDE_PLUGIN_DATA=/m);
});

// Issue #63: once one permission request of a step is rejected, OpenCode
// drops the others, and rejecting those too gets 404. That must not fail
// the turn.
test("a permission reply that finds the request gone does not fail the turn", { skip: LOCAL_LISTEN_SKIP }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildTestEnv(binDir, { FAKE_OPENCODE_SECOND_PERMISSION_GONE: "1" });

  try {
    const result = run("node", [SCRIPT, "task", "--write", "check the fixture"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Handled the requested task/);
    assert.match(result.stderr, /was no longer pending \(HTTP 404\); nothing left to reject/);
    const replies = readFakeState(binDir).permissions.map((entry) => entry.body.response);
    assert.deepEqual(replies, ["reject", "reject"]);
  } finally {
    cleanupServer(repo, env);
  }
});
