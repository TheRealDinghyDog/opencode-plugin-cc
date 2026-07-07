import http from "node:http";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { isServerHealthy } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";

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

test(
  "isServerHealthy checks the OpenCode global health endpoint",
  { skip: LOCAL_LISTEN_AVAILABLE ? false : "local 127.0.0.1 listen is unavailable in this sandbox" },
  async () => {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal(await isServerHealthy(url), true);
    assert.equal(await isServerHealthy(`${url}/missing`), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  }
);
