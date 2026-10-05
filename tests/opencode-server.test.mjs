import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBasicAuthHeader,
  fetchWithCause,
  OpencodeServerClient,
  parseOpencodeVersionInfo
} from "../plugins/opencode/scripts/lib/opencode-server.mjs";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("buildBasicAuthHeader follows OpenCode's basic-auth convention", () => {
  assert.equal(buildBasicAuthHeader({ password: "pw" }), `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  assert.equal(
    buildBasicAuthHeader({ username: "custom", password: "pw" }),
    `Basic ${Buffer.from("custom:pw").toString("base64")}`
  );
  assert.equal(buildBasicAuthHeader({}), null);
  assert.equal(buildBasicAuthHeader({ password: "" }), null);
});

test("client scopes project routes to the configured directory but never /global routes", async () => {
  const seen = [];
  const client = new OpencodeServerClient("http://opencode.test", {
    directory: "/work/repo a",
    fetch: async (requestUrl) => {
      const url = new URL(String(requestUrl));
      seen.push(url);
      if (url.pathname === "/event") {
        return new Response(":ok\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
      const body = url.pathname === "/global/health" ? '{"healthy":true,"version":"1.17.15"}' : "{}";
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  await client.listSessions();
  await client.createSession({ agent: "plan" });
  await client.subscribeEvents(() => {});
  await client.health();
  await client.dispose();

  assert.equal(seen[0].pathname, "/session");
  assert.equal(seen[0].searchParams.get("directory"), "/work/repo a");
  assert.equal(seen[1].pathname, "/session");
  assert.equal(seen[1].searchParams.get("directory"), "/work/repo a");
  assert.equal(seen[2].pathname, "/event");
  assert.equal(seen[2].searchParams.get("directory"), "/work/repo a");
  assert.equal(seen[3].pathname, "/global/health");
  assert.equal(seen[3].searchParams.get("directory"), null);
  assert.equal(seen[4].pathname, "/global/dispose");
  assert.equal(seen[4].searchParams.get("directory"), null);
});

test("client sends Basic auth on requests, fresh connections, and the event stream", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const authorization = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"type\":\"noop\"}\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/global/health" ? '{"healthy":true,"version":"1.17.15"}' : "{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new OpencodeServerClient(`http://127.0.0.1:${server.address().port}`, { password: "secret" });

  try {
    await client.health();
    await client.listMessages("ses_auth", { freshConnection: true, requestTimeoutMs: 2000 });
    await client.subscribeEvents(() => {});

    assert.equal(seen.length, 3);
    for (const request of seen) {
      assert.equal(request.authorization, authorization, `missing auth on ${request.url}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

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

function healthClient(body, contentType = "application/json") {
  return new OpencodeServerClient("http://opencode.test", {
    fetch: async () => new Response(body, { status: 200, headers: { "content-type": contentType } })
  });
}

test("health accepts an OpenCode 1.x health response", async () => {
  const body = await healthClient('{"healthy":true,"version":"1.18.34"}').health();
  assert.deepEqual(body, { healthy: true, version: "1.18.34" });
});

test("health rejects the HTML an OpenCode 2.x server serves on the retired route", async () => {
  await assert.rejects(
    healthClient("<!doctype html><title>OpenCode</title>", "text/html").health(),
    /did not return an OpenCode 1\.x health response/
  );
});

test("health rejects a server that reports an unsupported major version", async () => {
  await assert.rejects(
    healthClient('{"healthy":true,"version":"2.0.20"}').health(),
    /OpenCode 2\.0\.20 is not supported yet/
  );
});

test("parseOpencodeVersionInfo reads both 1.x and 2.x --version output", () => {
  assert.deepEqual(parseOpencodeVersionInfo("1.18.34"), { version: "1.18.34", major: 1 });
  assert.deepEqual(parseOpencodeVersionInfo("opencode v2.0.20"), { version: "2.0.20", major: 2 });
  assert.equal(parseOpencodeVersionInfo("not a version"), null);
});

test("network failures name their cause instead of a bare \"fetch failed\"", async () => {
  const failing = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  };
  await assert.rejects(
    fetchWithCause(failing, "http://opencode.test/session", {}, "POST /session"),
    (error) => error.message === "OpenCode POST /session failed: fetch failed (ECONNRESET)" && error.code === "ECONNRESET"
  );
  // A port that was just free: nothing listens there.
  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const client = new OpencodeServerClient(`http://127.0.0.1:${closedPort}`);
  await assert.rejects(client.listSessions(), /OpenCode GET \/session failed: fetch failed \(ECONNREFUSED\)/);

  const aborted = async () => {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  };
  await assert.rejects(fetchWithCause(aborted, "http://opencode.test", {}, "GET /"), { name: "AbortError" });
});
