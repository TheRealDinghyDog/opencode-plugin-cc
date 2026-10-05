// Issue #87: turns have no time limit. A turn ends when OpenCode says so, on
// cancel, or with the Claude session; while the event stream is gone, recovery
// stops waiting only when it can no longer succeed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { OpencodeHttpError, OpencodeServerClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { captureTurnForTest } from "../plugins/opencode/scripts/lib/opencode.mjs";
import { captureV2Turn, resolveTurnTimeoutMs } from "../plugins/opencode/scripts/lib/turn-capture-v2.mjs";

const RECORDINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v2-recordings");
const FAST = { serverGoneMs: 300, streamDropPollIntervalMs: 50, streamDropGraceMs: 50, recoveryTimeoutMs: 200, eventOpenTimeoutMs: 1000 };

const unreachable = () => Object.assign(new Error("fetch failed (ECONNREFUSED)"), { code: "ECONNREFUSED" });
const rejected = (status) => new OpencodeHttpError(`OpenCode GET /message failed with HTTP ${status}.`, { status });

// A 2.x client whose event stream is gone at once and whose message list
// always fails with `listError`.
function droppedV2Client(listError) {
  return {
    subscribeEvents: async (onEvent, { onOpen }) => onOpen(),
    prompt: async () => ({ id: "msg_prompt" }),
    listMessages: async () => {
      throw listError();
    },
    listPermissions: async () => [],
    listForms: async () => []
  };
}

// The same for 1.x: the stream is gone at once, and so is the held-open
// response (a transport failure, as on long turns).
function droppedV1Client(listError) {
  return {
    subscribeEvents: async (onEvent, { onOpen }) => onOpen?.(),
    listMessages: async () => {
      throw listError();
    }
  };
}
const failedResponse = () => Promise.reject(unreachable());

test("turns have no time limit unless a test sets one", () => {
  assert.equal(resolveTurnTimeoutMs({}), 0);
  assert.equal(resolveTurnTimeoutMs({ turnTimeoutMs: 700 }), 700);
});

// Without mocked timers (node:test's mock.timers needs Node 20.4; the plugin
// supports 18.18): watch every timer the capture arms while a turn runs to
// its end. The old limit armed one for 30 minutes.
test("a 2.x turn arms no turn-length timer and finishes normally", async () => {
  const recording = JSON.parse(fs.readFileSync(path.join(RECORDINGS, "success.json"), "utf8"));
  const prompt = recording.events.find(
    (event) => event.type === "session.inbox.enqueued" && event.data.sessionID === recording.sid && event.data.item.type === "user"
  );
  let deliver;
  const client = {
    subscribeEvents: (onEvent, { onOpen, signal }) => {
      deliver = onEvent;
      onOpen();
      return new Promise((resolve) => signal.addEventListener("abort", resolve));
    },
    prompt: async () => {
      setImmediate(() => recording.events.forEach((event) => deliver(event)));
      return { id: prompt.data.inboxID };
    },
    listPermissions: async () => [],
    listForms: async () => []
  };

  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    delays.push(Number(ms) || 0);
    return originalSetTimeout(callback, ms, ...args);
  };
  let state;
  try {
    state = await captureV2Turn(client, recording.sid, "go");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(state.outcome, "succeeded");
  assert.equal(state.error, null);
  assert.ok(state.finalMessage);
  assert.ok(Math.max(0, ...delays) < 5 * 60 * 1000, `a timer of ${Math.max(...delays)} ms was armed`);
});

test("a 2.x turn stops waiting once the server is gone, and says so", async () => {
  const startedAt = Date.now();
  const state = await captureV2Turn(droppedV2Client(unreachable), "ses_gone", "go", FAST);
  assert.match(state.error?.message ?? "", /^Lost contact with the OpenCode server for \d+ s: fetch failed \(ECONNREFUSED\)/);
  assert.ok(Date.now() - startedAt < 5000);
});

test("a 2.x turn whose recovery is rejected for good says it may still be running", async () => {
  const state = await captureV2Turn(droppedV2Client(() => rejected(400)), "ses_rejected", "go", FAST);
  assert.match(
    state.error?.message ?? "",
    /^Can no longer observe this turn: OpenCode has rejected recovery requests \(HTTP 400\).*opencode --session ses_rejected/
  );
});

test("a 2.x server that answers with a transient error is left alone", async () => {
  const startedAt = Date.now();
  const state = await captureV2Turn(droppedV2Client(() => rejected(503)), "ses_busy", "go", { ...FAST, turnTimeoutMs: 1200 });
  assert.ok(Date.now() - startedAt >= 1100, "only the test's explicit limit may end this turn");
  assert.doesNotMatch(state.error?.message ?? "", /Lost contact|Can no longer observe/);
});

test("a 1.x turn stops waiting once the server is gone, and says so", async () => {
  const state = await captureTurnForTest(droppedV1Client(unreachable), "ses_gone", failedResponse, FAST);
  assert.match(state.error?.message ?? "", /^Lost contact with the OpenCode server for \d+ s: fetch failed \(ECONNREFUSED\)/);
});

test("a 1.x turn whose recovery is rejected for good says it may still be running", async () => {
  const state = await captureTurnForTest(droppedV1Client(() => rejected(400)), "ses_rejected", failedResponse, FAST);
  assert.match(state.error?.message ?? "", /^Can no longer observe this turn: .*HTTP 400.*opencode --session ses_rejected/);
});

// Issue #92: OpenCode 1.18 can't list a session's messages once it ran a
// structured review. That 400 never recovers, so once the held-open response
// is gone too, stop at once and name the cause.
const unlistable = () =>
  new OpencodeHttpError("OpenCode GET /session/ses_review/message failed with HTTP 400.", {
    status: 400,
    body: '{"name":"BadRequest","data":{"message":"Expected OutputFormatJsonSchema, got {\\"type\\":\\"json_schema\\",\\"retryCount\\":2}"}}'
  });

test("a 1.x review whose session can't be listed (#92) stops at once and names the cause", async () => {
  const startedAt = Date.now();
  const state = await captureTurnForTest(droppedV1Client(unlistable), "ses_review", failedResponse, {
    ...FAST,
    serverGoneMs: 60_000
  });
  assert.match(state.error?.message ?? "", /can't list the messages of a session that ran a structured review.*opencode --session ses_review/);
  assert.ok(Date.now() - startedAt < 5000, "a known-permanent error needs no waiting window");
});

test("while the 1.x held-open response is still open, rejected recovery doesn't end the turn", async () => {
  const delivered = () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            info: { id: "msg_answer", role: "assistant", sessionID: "ses_review" },
            parts: [{ id: "prt_answer", sessionID: "ses_review", messageID: "msg_answer", type: "text", text: "Delivered by the response." }]
          }),
        1000
      )
    );
  const state = await captureTurnForTest(droppedV1Client(unlistable), "ses_review", delivered, FAST);
  assert.equal(state.error ?? null, null);
  assert.equal(state.finalMessage, "Delivered by the response.");
});

// 1.x with text already streamed, then both the event stream and the held-open
// response gone: only the finished message on the server can end the turn. On
// 1.18 a turn stores one assistant message per step; the turn is done when the
// latest one finished with something other than tool calls.
test("a 1.x turn with streamed text ends when the server's latest step finishes", async () => {
  const sessionID = "ses_long";
  let polls = 0;
  const step = (id, finish, text) => ({
    info: { id, role: "assistant", sessionID, finish, time: { created: 1, completed: 2 } },
    parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }]
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          type: "message.part.updated",
          properties: { sessionID, part: { id: "prt_s1", sessionID, messageID: "msg_s1", type: "text", text: "Let me look into it." } }
        })}\n\n`
      );
      setTimeout(() => res.destroy(), 100);
      return;
    }
    if (req.method === "GET" && url.pathname === `/session/${sessionID}/message`) {
      polls += 1;
      const messages = polls <= 3 ? [step("msg_s1", "tool-calls", "Let me look into it.")] : [
        step("msg_s1", "tool-calls", "Let me look into it."),
        step("msg_s2", "stop", "The final answer.")
      ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(messages));
      return;
    }
    if (req.method === "POST" && url.pathname === `/session/${sessionID}/message`) {
      // The held-open response fails, as it does on long turns.
      setTimeout(() => res.destroy(), 150);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new OpencodeServerClient(`http://127.0.0.1:${server.address().port}`);
  try {
    const state = await Promise.race([
      captureTurnForTest(
        client,
        sessionID,
        (signal) => client.sendMessage(sessionID, { parts: [{ type: "text", text: "go" }] }, { signal }),
        FAST
      ),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("the turn never ended")), 10_000).unref())
    ]);
    assert.equal(state.error ?? null, null);
    assert.equal(state.finalMessage, "The final answer.");
    assert.ok(polls >= 4, "it must wait through the tool-calls step");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
