import http from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { OpencodeServerClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRequestStub(onRequest) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  req.destroy = (error) => {
    if (error) {
      process.nextTick(() => req.emit("error", error));
    }
    process.nextTick(() => req.emit("close"));
  };
  req.setTimeout = (ms, onTimeout) => {
    req.timeoutMs = ms;
    req.timeout = setTimeout(onTimeout, ms);
    return req;
  };
  onRequest?.(req);
  return req;
}

function installHttpRequestStub(handler) {
  const original = http.request;
  http.request = handler;
  return () => {
    http.request = original;
  };
}

test("subscribeEvents cancels the response body if onOpen throws", async () => {
  let cancelled = false;
  const expectedError = new Error("open failed");
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    }
  });
  const client = new OpencodeServerClient("http://opencode.test", {
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
  });

  await assert.rejects(
    client.subscribeEvents(() => {}, {
      onOpen() {
        throw expectedError;
      }
    }),
    (error) => error === expectedError
  );
  assert.equal(cancelled, true);
});

test("fresh-connection requests reject when the response never ends", async () => {
  const restore = installHttpRequestStub((url, options, callback) =>
    createRequestStub(() => {
      assert.equal(url.pathname, "/session/ses_timeout/message");
      assert.equal(options.method, "GET");
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        callback(res);
        res.emit("data", Buffer.from('{"messages":['));
      });
    })
  );

  try {
    const client = new OpencodeServerClient("http://opencode.test");
    const result = await Promise.race([
      client
        .listMessages("ses_timeout", { freshConnection: true, requestTimeoutMs: 50 })
        .then(
          () => ({ status: "resolved" }),
          (error) => ({ status: "rejected", error })
        ),
      sleep(250).then(() => ({ status: "pending" }))
    ]);

    assert.equal(result.status, "rejected");
    assert.match(result.error.message, /timed out/i);
  } finally {
    restore();
  }
});

test("fresh-connection requests reject when the response aborts mid-body", async () => {
  const restore = installHttpRequestStub((url, options, callback) =>
    createRequestStub(() => {
      assert.equal(url.pathname, "/session/ses_aborted/message");
      assert.equal(options.method, "GET");
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        callback(res);
        res.emit("data", Buffer.from('{"messages":['));
        setTimeout(() => {
          res.emit("aborted");
          res.emit("close");
        }, 10);
      });
    })
  );

  try {
    const client = new OpencodeServerClient("http://opencode.test");
    const result = await Promise.race([
      client
        .listMessages("ses_aborted", { freshConnection: true, requestTimeoutMs: 500 })
        .then(
          () => ({ status: "resolved" }),
          (error) => ({ status: "rejected", error })
        ),
      sleep(250).then(() => ({ status: "pending" }))
    ]);

    assert.equal(result.status, "rejected");
    assert.match(result.error.message, /aborted|closed/i);
  } finally {
    restore();
  }
});
