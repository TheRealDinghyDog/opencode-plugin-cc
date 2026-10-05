import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { HEADLESS_PERMISSION_MESSAGE, HEADLESS_QUESTION_MESSAGE } from "../plugins/opencode/scripts/lib/turn-capture-v2.mjs";
import { readFakeState } from "./fake-opencode-fixture.mjs";
import { installFakeOpencodeV2 } from "./fake-opencode-v2-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

// The companion's commands, end to end, against the fake OpenCode 2.x
// (issues #52, #53). 2.x is enabled through the development switch until
// #56 turns it on by default.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function canListenLocalhost() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const LOCAL_LISTEN_SKIP = (await canListenLocalhost()) ? false : "local 127.0.0.1 listen is unavailable in this sandbox";

function setup(scenario = "success", extra = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencodeV2(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
    FAKE_OPENCODE_V2_SCENARIO: scenario,
    CLAUDE_PLUGIN_DATA: makeTempDir("opencode-plugin-data-"),
    OPENCODE_COMPANION_SESSION_ID: "sess-v2",
    OPENCODE_COMPANION_EXPERIMENTAL_V2: "1",
    ...extra
  };
  delete env.OPENCODE_COMPANION_SERVER_URL;
  delete env.OPENCODE_SERVER_PASSWORD;
  return { repo, binDir, env };
}

function cleanup({ repo, env }) {
  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: env.OPENCODE_COMPANION_SESSION_ID })
  });
}

function companion(ctx, args) {
  return run("node", [SCRIPT, ...args], { cwd: ctx.repo, env: ctx.env });
}

test("a read-only task runs on OpenCode 2.x with the plan agent and no session permission rules", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup();
  try {
    const result = companion(ctx, ["task", "check the fixture"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");

    const [session] = readFakeState(ctx.binDir).sessions;
    assert.equal(session.body.agent, "plan");
    assert.match(session.body.title, /^OpenCode Companion Task/);
    assert.equal(session.body.location.directory, fs.realpathSync(ctx.repo));
    assert.ok(!("permissions" in session.body), "no session-wide permission rules (issue #26)");
    assert.ok(!("model" in session.body), "the server's default model is used");
  } finally {
    cleanup(ctx);
  }
});

test("a write task rejects a guarded permission ask and never writes outside the workspace", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("permission");
  try {
    const result = companion(ctx, ["task", "--write", "write outside the workspace"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Handled the requested task/);
    assert.match(result.stderr, /Denying OpenCode permission request per_\S+ \(external_directory: \/outside\/workspace\/\*\)/);

    const state = readFakeState(ctx.binDir);
    assert.equal(state.sessions[0].body.agent, "build");
    assert.ok(!("permissions" in state.sessions[0].body));
    assert.deepEqual(state.permissionReplies[0].body, { decision: "reject", message: HEADLESS_PERMISSION_MESSAGE });
    assert.equal(state.outsideWrites, 0);
  } finally {
    cleanup(ctx);
  }
});

test("a question ends the 2.x turn with an explanation instead of stalling", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("form");
  try {
    const result = companion(ctx, ["task", "decide something"]);
    assert.match(result.stdout, new RegExp(`OpenCode error: ${HEADLESS_QUESTION_MESSAGE.replace(/[.?()]/g, "\\$&")}`));
    assert.deepEqual(readFakeState(ctx.binDir).formActions.map((action) => action.action), ["cancel"]);
  } finally {
    cleanup(ctx);
  }
});

test("a 2.x provider failure is reported, not the prompt", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("provider-error");
  try {
    const result = companion(ctx, ["task", "summarize the secret plan"]);
    assert.equal(result.stdout, "OpenCode error: Model unavailable: fake fake-model/\n");
  } finally {
    cleanup(ctx);
  }
});

test("a subagent's output stays out of the 2.x answer", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("subagent");
  try {
    const result = companion(ctx, ["task", "explore"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Handled the requested task/);
    assert.doesNotMatch(result.stdout, /Child exploration output/);
    assert.match(result.stderr, /Subagent #1 \(explore\)/);
  } finally {
    cleanup(ctx);
  }
});

test("--model and --effort become a validated 2.x model reference", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup();
  try {
    const ok = companion(ctx, ["task", "--model", "fake/fake-model", "--effort", "high", "go"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(readFakeState(ctx.binDir).sessions[0].body.model, { providerID: "fake", id: "fake-model", variant: "high" });

    const badEffort = companion(ctx, ["task", "--model", "fake/fake-model", "--effort", "minimal", "go"]);
    assert.notEqual(badEffort.status, 0);
    assert.match(`${badEffort.stdout}${badEffort.stderr}`, /has no "minimal" effort\. Available: none, low, high\./);

    const badModel = companion(ctx, ["task", "--model", "nope/missing", "go"]);
    assert.match(`${badModel.stdout}${badModel.stderr}`, /OpenCode has no model nope\/missing/);
  } finally {
    cleanup(ctx);
  }
});

test("--resume-last continues the workspace's latest 2.x task session", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup();
  try {
    assert.equal(companion(ctx, ["task", "first"]).status, 0);
    const resumed = companion(ctx, ["task", "--resume-last", "follow up"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const state = readFakeState(ctx.binDir);
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(
      state.prompts.map((prompt) => prompt.sessionID),
      [state.sessions[0].id, state.sessions[0].id]
    );
  } finally {
    cleanup(ctx);
  }
});

test("cancel interrupts a running 2.x background task", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const ctx = setup("slow");
  try {
    const started = companion(ctx, ["task", "--background", "count forever"]);
    assert.equal(started.status, 0, started.stderr);
    const jobId = started.stdout.match(/background as (\S+)\./)[1];

    let interrupts = [];
    for (let attempt = 0; attempt < 50 && interrupts.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if ((readFakeState(ctx.binDir)?.prompts ?? []).length === 0) {
        continue;
      }
      const cancelled = companion(ctx, ["cancel", jobId, "--json"]);
      assert.equal(cancelled.status, 0, cancelled.stderr);
      interrupts = readFakeState(ctx.binDir).interrupts;
    }
    const state = readFakeState(ctx.binDir);
    assert.deepEqual(state.interrupts, [state.sessions[0].id]);
  } finally {
    cleanup(ctx);
  }
});

test("without the switch, a 2.x CLI is still reported unsupported", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("success", { OPENCODE_COMPANION_EXPERIMENTAL_V2: "" });
  try {
    const result = companion(ctx, ["task", "check"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /OpenCode 2\.0\.20 is not supported yet/);
    assert.equal(readFakeState(ctx.binDir)?.serverStarts ?? 0, 0);
  } finally {
    cleanup(ctx);
  }
});

test("a plan-mode reminder answered after our prompt does not become the answer", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("late-reminder");
  try {
    const result = companion(ctx, ["task", "Reply with PONG"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  } finally {
    cleanup(ctx);
  }
});
