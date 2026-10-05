import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { extractJsonObject } from "../plugins/opencode/scripts/lib/opencode.mjs";
import { saveState } from "../plugins/opencode/scripts/lib/state.mjs";
import { HEADLESS_PERMISSION_MESSAGE } from "../plugins/opencode/scripts/lib/turn-capture-v2.mjs";
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
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

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
    assert.equal(session.body.location.directory, fs.realpathSync.native(ctx.repo));
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

test("a 2.x question is handed back with its options, and resuming with the answer finishes the job", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("form");
  try {
    const asked = companion(ctx, ["task", "decide something"]);
    assert.notEqual(asked.status, 0);
    assert.equal(
      asked.stdout,
      [
        "OpenCode stopped to ask a question, which this run can't answer interactively:",
        "",
        "Which approach should I take?",
        "- Option A",
        "- Option B",
        "- (or another answer)",
        "",
        "To continue, resume this OpenCode session with the answer, for example:",
        "/opencode:rescue --resume <answer>",
        ""
      ].join("\n")
    );
    assert.deepEqual(readFakeState(ctx.binDir).formActions.map((action) => action.action), ["cancel"]);
    const status = JSON.parse(companion(ctx, ["status", "--all", "--json"]).stdout);
    assert.equal((status.latestFinished ?? status.recent[0]).phase, "awaiting-answer");

    const resumed = companion(ctx, ["task", "--resume-last", "Option B"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Handled the requested task/);
    const state = readFakeState(ctx.binDir);
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(state.prompts.map((prompt) => prompt.body.text), ["decide something", "Option B"]);
  } finally {
    cleanup(ctx);
  }
});

test("a 2.x question is in the --json payload", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("form");
  try {
    const payload = JSON.parse(companion(ctx, ["task", "--json", "decide something"]).stdout);
    assert.equal(payload.status, 1);
    assert.equal(payload.question.fields[0].question, "Which approach should I take?");
    assert.deepEqual(payload.question.fields[0].options.map((option) => option.label), ["Option A", "Option B"]);
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

// Issue #77: two background jobs share one server. On Windows, cancelling
// one tree-killed its worker, and the server the worker had started went with
// it. The fake ignores interrupts, so each worker is still alive when cancel
// ends it.
test("cancelling one background job leaves the server another job uses", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const ctx = setup("slow", { FAKE_OPENCODE_V2_IGNORE_INTERRUPT: "1" });
  const promptCount = () => (readFakeState(ctx.binDir)?.prompts ?? []).length;
  const waitForPrompts = async (count) => {
    for (let attempt = 0; attempt < 150 && promptCount() < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(promptCount(), count);
  };
  const startJob = (text) => {
    const started = companion(ctx, ["task", "--background", text]);
    assert.equal(started.status, 0, started.stderr);
    return started.stdout.match(/background as (\S+)\./)[1];
  };
  try {
    const first = startJob("count forever");
    await waitForPrompts(1);
    const second = startJob("count forever too");
    await waitForPrompts(2);
    const [firstSession, secondSession] = readFakeState(ctx.binDir).sessions.map((session) => session.id);

    const cancelFirst = companion(ctx, ["cancel", first, "--json"]);
    assert.equal(cancelFirst.status, 0, cancelFirst.stderr);
    // Interrupting the second job only works if the server survived.
    const cancelSecond = companion(ctx, ["cancel", second, "--json"]);
    assert.equal(cancelSecond.status, 0, cancelSecond.stderr);
    assert.deepEqual(readFakeState(ctx.binDir).interrupts, [firstSession, secondSession]);
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

const REVIEW = {
  verdict: "needs-attention",
  summary: "README changed without a test.",
  findings: [
    {
      severity: "low",
      title: "Untested change",
      body: "The README edit has no accompanying check.",
      file: "README.md",
      line_start: 1,
      line_end: 1,
      confidence: 0.6,
      recommendation: "Add a check."
    }
  ],
  next_steps: ["Add a check."]
};

function changeReadme(ctx) {
  fs.writeFileSync(path.join(ctx.repo, "README.md"), "changed\n");
}

test("extractJsonObject takes a bare object, a fenced block, or the first balanced object", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('Review:\n```json\n{"b":"}{"}\n```\nDone.'), { b: "}{" });
  assert.deepEqual(extractJsonObject('Sure: {"c":{"d":"x\\"}"}} trailing'), { c: { d: 'x"}' } });
  assert.equal(extractJsonObject("[1, 2]"), null);
  assert.equal(extractJsonObject("no json here"), null);
});

test("a 2.x review sends the schema in the prompt and reads JSON out of the reply", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("success", {
    FAKE_OPENCODE_V2_REPLY_SEQUENCE: JSON.stringify([`Here is the review:\n\`\`\`json\n${JSON.stringify(REVIEW)}\n\`\`\``])
  });
  try {
    changeReadme(ctx);
    const result = companion(ctx, ["review", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.result, REVIEW);
    const prompts = readFakeState(ctx.binDir).prompts;
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].body.text, /<output_schema>[\s\S]*"next_steps"[\s\S]*<\/output_schema>/);
  } finally {
    cleanup(ctx);
  }
});

test("a 2.x review that answers in prose gets one repair turn in the same session", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("success", {
    FAKE_OPENCODE_V2_REPLY_SEQUENCE: JSON.stringify(["The change looks fine to me.", JSON.stringify(REVIEW)])
  });
  try {
    changeReadme(ctx);
    const result = companion(ctx, ["review"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verdict: needs-attention/);
    assert.match(result.stdout, /Untested change/);
    assert.match(result.stderr, /not the requested JSON \(no JSON object found\); asking once more/);
    const state = readFakeState(ctx.binDir);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.prompts.length, 2);
    assert.equal(state.prompts[1].sessionID, state.prompts[0].sessionID);
    assert.match(state.prompts[1].body.text, /^Your previous reply was not a JSON object matching output_schema/);
  } finally {
    cleanup(ctx);
  }
});

test("a 2.x review that never returns valid JSON shows the last reply", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("success", {
    FAKE_OPENCODE_V2_REPLY_SEQUENCE: JSON.stringify(["prose one", '{"verdict":"approve"}'])
  });
  try {
    changeReadme(ctx);
    const result = companion(ctx, ["review"]);
    assert.match(result.stdout, /OpenCode did not return valid structured JSON|unexpected review shape/);
    assert.match(result.stdout, /"verdict":"approve"/);
    assert.equal(readFakeState(ctx.binDir).prompts.length, 2);
  } finally {
    cleanup(ctx);
  }
});

for (const [reply, decision] of [
  ["ALLOW: the last turn only edited docs.", undefined],
  ["BLOCK: the last turn removed a test.", "block"]
]) {
  test(`the stop-review gate reads a 2.x ${decision ?? "allow"} answer`, { skip: LOCAL_LISTEN_SKIP }, () => {
    const ctx = setup("success", { FAKE_OPENCODE_V2_REPLY_TEXT: reply });
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = ctx.env.CLAUDE_PLUGIN_DATA;
    try {
      saveState(ctx.repo, { version: 1, config: { stopReviewGate: true }, jobs: [] });
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
    }
    try {
      const result = run("node", [STOP_HOOK], {
        cwd: ctx.repo,
        env: ctx.env,
        input: JSON.stringify({
          cwd: ctx.repo,
          session_id: ctx.env.OPENCODE_COMPANION_SESSION_ID,
          last_assistant_message: "Previous turn output."
        })
      });
      assert.equal(result.status, 0, result.stderr);
      const output = result.stdout.trim() ? JSON.parse(result.stdout) : {};
      assert.equal(output.decision, decision);
      if (decision === "block") {
        assert.match(output.reason, /removed a test/);
      }
    } finally {
      cleanup(ctx);
    }
  });
}

test("a 2.x permission reply that finds the request gone does not fail the turn (#63)", { skip: LOCAL_LISTEN_SKIP }, () => {
  const ctx = setup("permission-twice");
  try {
    const result = companion(ctx, ["task", "--write", "write outside the workspace"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Handled the requested task/);
    assert.match(result.stderr, /was no longer pending \(HTTP 404\)/);
    assert.equal(readFakeState(ctx.binDir).permissionReplies.length, 2);
  } finally {
    cleanup(ctx);
  }
});
