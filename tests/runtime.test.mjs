import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeOpencode, readFakeState } from "./fake-opencode-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

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
