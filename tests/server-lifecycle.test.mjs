import http from "node:http";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { ensureServer, isServerHealthy, loadServerSession, saveServerSession, teardownServerSession } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";

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

test("ensureServer keeps a single lease for repeated calls from the same process", async () => {
  const url = "http://127.0.0.1:1";
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousFetch = globalThis.fetch;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  globalThis.fetch = async (requestUrl) => {
    assert.equal(String(requestUrl), `${url}/global/health`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    saveServerSession(workspace, {
      url,
      pid: 123456,
      pidFile: null,
      logFile: null,
      sessionDir: null,
      external: false
    });

    const first = await ensureServer(workspace);
    const second = await ensureServer(workspace);
    const stored = loadServerSession(workspace);

    assert.equal(first.leases.length, 1);
    assert.equal(second.leases.length, 1);
    assert.equal(stored.leases.length, 1);
    assert.equal(stored.leases[0].pid, process.pid);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    globalThis.fetch = previousFetch;
  }
});

test("teardownServerSession skips local teardown while a server lease is active", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const session = {
      url: "http://127.0.0.1:1",
      pid: 123456,
      pidFile: null,
      logFile: null,
      sessionDir: null,
      external: false,
      leases: [
        {
          pid: process.pid,
          token: "test-lease",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString()
        }
      ]
    };
    saveServerSession(workspace, session);

    let killedPid = null;
    const result = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      }
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "active-leases");
    assert.equal(killedPid, null);
    assert.equal(loadServerSession(workspace).url, session.url);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
