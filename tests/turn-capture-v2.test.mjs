import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  HEADLESS_QUESTION_MESSAGE,
  applyV2Event,
  createV2TurnState,
  recoverV2Turn,
  setV2PromptID
} from "../plugins/opencode/scripts/lib/turn-capture-v2.mjs";

const RECORDINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v2-recordings");

// Replays a real 2.0.20 event stream (noise included) through the reducer.
function replay(name) {
  const recording = JSON.parse(fs.readFileSync(path.join(RECORDINGS, `${name}.json`), "utf8"));
  const state = createV2TurnState(recording.sid);
  const asks = [];
  for (const event of recording.events) {
    asks.push(...applyV2Event(state, event));
  }
  // The recorder did not keep the prompt response; its id is the user item's.
  const prompt = recording.events.find(
    (event) => event.type === "session.inbox.enqueued" && event.data.sessionID === recording.sid && event.data.item.type === "user"
  );
  setV2PromptID(state, prompt.data.inboxID);
  return { recording, state, asks };
}

test("a plain turn yields its text and succeeds", () => {
  const { state, asks } = replay("success");
  assert.equal(state.outcome, "succeeded");
  assert.equal(state.finalMessage, "PONG");
  assert.equal(state.error, null);
  assert.deepEqual(asks, []);
});

test("a guarded write outside the workspace is rejected and the last step is the answer", () => {
  const { recording, state, asks } = replay("external-write");
  assert.deepEqual(
    asks.map(({ type, sessionID }) => ({ type, sessionID })),
    [{ type: "reject-permission", sessionID: recording.sid }]
  );
  assert.match(asks[0].requestID, /^per_/);
  assert.equal(state.outcome, "succeeded");
  // The first step said what it was about to do; the answer came after.
  assert.ok(state.steps.length >= 2);
  assert.match(state.finalMessage, /^I wasn't able to create the file/);
});

test("a .env read by the plan agent is rejected", () => {
  const { state, asks } = replay("env-read");
  assert.equal(asks.length, 1);
  assert.equal(asks[0].type, "reject-permission");
  assert.equal(state.outcome, "succeeded");
  assert.ok(state.finalMessage.length > 0);
});

test("files a step wrote become touched files", () => {
  const { state } = replay("write");
  assert.deepEqual([...state.touchedFiles], ["hello.txt"]);
  assert.equal(state.finalMessage, "DONE");
});

test("a question form is dismissed and the interrupted turn explains why", () => {
  const { recording, state, asks } = replay("form");
  assert.deepEqual(asks.map((ask) => ask.type), ["cancel-form"]);
  assert.equal(asks[0].sessionID, recording.sid);
  assert.equal(state.outcome, "interrupted");
  assert.equal(state.error.message, HEADLESS_QUESTION_MESSAGE);
  // Partial text from before the question is kept.
  assert.equal(state.finalMessage, "I'll ask you that question now.");
});

test("an interrupted turn keeps its partial text and reports the reason", () => {
  const { state } = replay("interrupt");
  assert.equal(state.outcome, "interrupted");
  assert.equal(state.error.message, "OpenCode stopped the turn (user).");
  assert.match(state.finalMessage, /^1\. one\n2\. two/);
});

test("a subagent's asks are answered in its own session and its text stays out of the answer", () => {
  const { recording, state, asks } = replay("subagent");
  const [child] = state.childLabels.keys();
  assert.ok(child && child !== recording.sid);
  assert.deepEqual(asks.map(({ type, sessionID }) => ({ type, sessionID })), [{ type: "reject-permission", sessionID: child }]);
  assert.equal(state.outcome, "succeeded");
  assert.match(state.finalMessage, /^The directory is a Git repository/);
  assert.doesNotMatch(state.finalMessage, /Here is what I found/);
});

test("replayed events are applied once", () => {
  const recording = JSON.parse(fs.readFileSync(path.join(RECORDINGS, "external-write.json"), "utf8"));
  const state = createV2TurnState(recording.sid);
  const asks = [];
  for (const event of [...recording.events, ...recording.events]) {
    asks.push(...applyV2Event(state, event));
  }
  assert.equal(asks.length, 1);
});

test("events of other sessions on the same server are ignored", () => {
  const state = createV2TurnState("ses_mine");
  const asks = applyV2Event(state, {
    id: "evt_1",
    type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_other", action: "read", resources: [".env"], save: [], source: {} }
  });
  applyV2Event(state, { id: "evt_2", type: "session.execution.succeeded", data: { sessionID: "ses_other" } });
  assert.deepEqual(asks, []);
  assert.equal(state.completed, false);
});

function recoveryClient(items) {
  return { listMessages: async () => items };
}

test("recovery reads how the turn ended from the message list", async () => {
  const state = createV2TurnState("ses_1");
  state.promptID = "msg_prompt";
  const recovered = await recoverV2Turn(
    recoveryClient([
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
      { id: "msg_a2", type: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Answer." }] },
      { id: "msg_prompt", type: "user", text: "question" },
      { id: "msg_old_idle", type: "idle", outcome: "failed" }
    ]),
    state
  );
  assert.equal(recovered, true);
  assert.equal(state.outcome, "succeeded");
  assert.equal(state.finalMessage, "Answer.");
});

test("recovery waits while the turn has no idle item yet, and never reads older turns", async () => {
  const state = createV2TurnState("ses_1");
  state.promptID = "msg_prompt";
  assert.equal(
    await recoverV2Turn(
      recoveryClient([
        { id: "msg_prompt", type: "user", text: "question" },
        { id: "msg_old_idle", type: "idle", outcome: "succeeded" },
        { id: "msg_old", type: "assistant", content: [{ type: "text", text: "Old answer." }] }
      ]),
      state
    ),
    false
  );
  assert.equal(state.completed, false);
  assert.equal(state.finalMessage, "");
});

test("recovery reports a failed turn as an error", async () => {
  const state = createV2TurnState("ses_1");
  state.promptID = "msg_prompt";
  await recoverV2Turn(
    recoveryClient([
      { id: "msg_idle", type: "idle", outcome: "failed" },
      { id: "msg_prompt", type: "user", text: "question" }
    ]),
    state
  );
  assert.equal(state.outcome, "failed");
  assert.equal(state.error.message, "OpenCode turn failed.");
});

// Observed on 2.0.20: the plan agent's reminder was queued after our prompt,
// delivered mid-execution, and answered; the reply to it is not our answer.
function lateReminderEvents() {
  let n = 0;
  const event = (type, data) => ({ id: `evt_${++n}`, type, data: { sessionID: "ses_1", ...data } });
  return [
    event("session.execution.started", {}),
    event("session.inbox.delivered", { inboxID: "msg_prompt" }),
    event("session.step.started", { assistantMessageID: "msg_a1" }),
    event("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "PONG" }),
    event("session.inbox.delivered", { inboxID: "msg_reminder" }),
    event("session.step.started", { assistantMessageID: "msg_a2" }),
    event("session.text.ended", { assistantMessageID: "msg_a2", ordinal: 0, text: "What would you like to plan?" }),
    event("session.execution.succeeded", {})
  ];
}

test("a reminder delivered after our prompt does not replace the answer", () => {
  for (const promptKnownFirst of [true, false]) {
    const state = createV2TurnState("ses_1");
    if (promptKnownFirst) {
      setV2PromptID(state, "msg_prompt");
    }
    for (const event of lateReminderEvents()) {
      applyV2Event(state, event);
    }
    if (!promptKnownFirst) {
      setV2PromptID(state, "msg_prompt");
    }
    assert.equal(state.finalMessage, "PONG");
  }
});

test("recovery stops at the next input after our prompt", async () => {
  const state = createV2TurnState("ses_1");
  state.promptID = "msg_prompt";
  await recoverV2Turn(
    recoveryClient([
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
      { id: "msg_a2", type: "assistant", content: [{ type: "text", text: "What would you like to plan?" }] },
      { id: "msg_reminder", type: "synthetic", text: "<system-reminder>Plan mode</system-reminder>" },
      { id: "msg_a1", type: "assistant", content: [{ type: "text", text: "PONG" }] },
      { id: "msg_prompt", type: "user", text: "Reply with PONG" }
    ]),
    state
  );
  assert.equal(state.finalMessage, "PONG");
});
