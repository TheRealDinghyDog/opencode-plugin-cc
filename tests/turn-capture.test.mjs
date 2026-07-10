import http from "node:http";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { OpencodeServerClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { captureTurnForTest } from "../plugins/opencode/scripts/lib/opencode.mjs";

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

// A tiny OpenCode-shaped server whose event stream drops early while the
// held-open /message response resolves later. Behavior is tuned per test to
// reproduce the issue #30 timing precisely.
function startTurnServer({ eventDropMs, responseDelayMs, dropResponse = false }) {
  const sessionID = "ses_capture";
  const messageID = "msg_capture";
  const finalText = "Recovered final answer.";
  let stored = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(":ok\n\n");
      setTimeout(() => res.destroy(), eventDropMs);
      return;
    }

    if (req.method === "GET" && url.pathname === `/session/${sessionID}/message`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stored ? [stored] : []));
      return;
    }

    if (req.method === "POST" && url.pathname === `/session/${sessionID}/message`) {
      setTimeout(() => {
        stored = {
          info: { id: messageID, role: "assistant", sessionID },
          parts: [{ id: "prt_capture", sessionID, messageID, type: "text", text: finalText }]
        };
        if (dropResponse) {
          // The completed turn is only recoverable over HTTP GET now.
          res.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stored));
      }, responseDelayMs);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        sessionID,
        finalText,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

const FAST_CAPTURE_OPTIONS = {
  streamDropGraceMs: 100,
  streamDropPollIntervalMs: 80,
  recoveryTimeoutMs: 500,
  turnTimeoutMs: 4000,
  eventOpenTimeoutMs: 2000
};

test(
  "captureTurn keeps waiting when the stream drops before a slow but successful response (issue #30)",
  { skip: LOCAL_LISTEN_SKIP },
  async () => {
    // Stream drops at 40ms; the /message response succeeds at 500ms — well past
    // the 100ms stream-drop grace. Pre-#30 this failed at ~grace with an empty
    // recovery instead of waiting for the response.
    const fixture = await startTurnServer({ eventDropMs: 40, responseDelayMs: 500 });
    const client = new OpencodeServerClient(fixture.baseUrl);

    try {
      const state = await captureTurnForTest(
        client,
        fixture.sessionID,
        (signal) => client.sendMessage(fixture.sessionID, { parts: [{ type: "text", text: "go" }] }, { signal }),
        FAST_CAPTURE_OPTIONS
      );

      assert.equal(state.error, null, state.error?.message);
      assert.equal(state.finalMessage, fixture.finalText);
    } finally {
      await fixture.close();
    }
  }
);

test(
  "captureTurn recovers over HTTP when the stream drops and the response POST is lost (issue #30)",
  { skip: LOCAL_LISTEN_SKIP },
  async () => {
    // Stream drops at 40ms and the held-open POST is destroyed after the turn
    // completes server-side, so the answer is only reachable via GET. The poll
    // loop must keep trying until the message is stored and recover it.
    const fixture = await startTurnServer({ eventDropMs: 40, responseDelayMs: 400, dropResponse: true });
    const client = new OpencodeServerClient(fixture.baseUrl);

    try {
      const state = await captureTurnForTest(
        client,
        fixture.sessionID,
        (signal) => client.sendMessage(fixture.sessionID, { parts: [{ type: "text", text: "go" }] }, { signal }),
        FAST_CAPTURE_OPTIONS
      );

      assert.equal(state.error, null, state.error?.message);
      assert.equal(state.finalMessage, fixture.finalText);
      assert.equal(state.recovered, true);
    } finally {
      await fixture.close();
    }
  }
);

test(
  "captureTurn still times out when the stream drops and no result ever appears (issue #30)",
  { skip: LOCAL_LISTEN_SKIP },
  async () => {
    // Stream drops and the response never completes: the poll loop must be
    // bounded by the outer turn timeout, not spin forever.
    const fixture = await startTurnServer({ eventDropMs: 40, responseDelayMs: 60_000 });
    const client = new OpencodeServerClient(fixture.baseUrl);

    try {
      const startedAt = Date.now();
      const state = await captureTurnForTest(
        client,
        fixture.sessionID,
        (signal) => client.sendMessage(fixture.sessionID, { parts: [{ type: "text", text: "go" }] }, { signal }),
        { ...FAST_CAPTURE_OPTIONS, turnTimeoutMs: 700 }
      );

      assert.ok(state.error, "a stalled turn must surface an error");
      assert.equal(state.finalMessage, "");
      assert.ok(Date.now() - startedAt < 3000, "the turn must end near its timeout, not spin");
    } finally {
      await fixture.close();
    }
  }
);
