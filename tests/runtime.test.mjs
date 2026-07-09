import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { runServerTurn } from "../plugins/opencode/scripts/lib/opencode.mjs";
import { loadServerSession, saveServerSession } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";
import { resolveStateFile, saveState } from "../plugins/opencode/scripts/lib/state.mjs";
import { buildEnv, installFakeOpencode, readFakeState, readServerBootCount } from "./fake-opencode-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

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
    assert.match(payload.rawOutput, /Handled the requested task/);
    const fakeState = readFakeState(binDir);
    assert.equal(payload.turnId, fakeState.responses[fakeState.responses.length - 1].info.id);
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
