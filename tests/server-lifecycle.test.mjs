import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { ensureServer, isServerHealthy, loadServerSession, saveServerSession, teardownServerSession } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";
import { resolveStateDir } from "../plugins/opencode/scripts/lib/state.mjs";

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

test(
  "ensureServer handles password-protected external servers via OpenCode's auth variables (issue #27)",
  { skip: LOCAL_LISTEN_AVAILABLE ? false : "local 127.0.0.1 listen is unavailable in this sandbox" },
  async () => {
    const password = "external-secret";
    const expectedAuthorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    let authorizedRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== expectedAuthorization) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="opencode"' });
        res.end();
        return;
      }
      authorizedRequests += 1;
      if (req.method === "GET" && req.url === "/global/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const workspace = makeTempDir();

    try {
      await assert.rejects(
        () => ensureServer(workspace, { env: { OPENCODE_COMPANION_SERVER_URL: url } }),
        /requires authentication.*OPENCODE_SERVER_PASSWORD/s
      );
      await assert.rejects(
        () =>
          ensureServer(workspace, {
            env: { OPENCODE_COMPANION_SERVER_URL: url, OPENCODE_SERVER_PASSWORD: "wrong" }
          }),
        /rejected the provided credentials/
      );

      const result = await ensureServer(workspace, {
        env: { OPENCODE_COMPANION_SERVER_URL: url, OPENCODE_SERVER_PASSWORD: password }
      });
      assert.equal(result.external, true);
      assert.equal(result.password, password);
      assert.ok(authorizedRequests >= 1, "the health check must send Basic auth");
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

test("teardownServerSession can ignore only this process lease", async () => {
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
          token: "cancel-process-lease",
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
      ignoreCurrentProcessLease: true,
      killProcess: (pid) => {
        killedPid = pid;
      }
    });

    assert.equal(result.skipped, false);
    assert.equal(killedPid, session.pid);
    assert.equal(loadServerSession(workspace), null);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("teardownServerSession still skips ignored self lease when another process has a lease", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const otherLeaseHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
    windowsHide: true
  });

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
          token: "cancel-process-lease",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString()
        },
        {
          pid: otherLeaseHolder.pid,
          token: "other-live-lease",
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
      ignoreCurrentProcessLease: true,
      killProcess: (pid) => {
        killedPid = pid;
      }
    });
    const stored = loadServerSession(workspace);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "active-leases");
    assert.equal(killedPid, null);
    assert.deepEqual(
      stored.leases.map((lease) => lease.token),
      ["other-live-lease"]
    );
  } finally {
    otherLeaseHolder.kill();
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("teardownServerSession returns a bounded diagnostic when the server lock is contended", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const lockDir = path.join(resolveStateDir(workspace), "server.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: "other-holder", createdAt: new Date().toISOString() })}\n`,
    "utf8"
  );

  let teardownPromise;
  let testTimeout;
  try {
    const startedAt = Date.now();
    teardownPromise = teardownServerSession({
      cwd: workspace,
      lockAcquireTimeoutMs: 100,
      lockPollMs: 25
    });
    const result = await Promise.race([
      teardownPromise,
      new Promise((resolve) => {
        testTimeout = setTimeout(() => resolve({ testTimeout: true }), 500);
      })
    ]);

    assert.equal(result.testTimeout, undefined, "teardown should not wait indefinitely for a live lock holder");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "lock-timeout");
    assert.match(result.diagnostic, /Timed out acquiring the OpenCode server lock/);
    assert.ok(Date.now() - startedAt < 500, "teardown should honor its acquisition deadline");
  } finally {
    clearTimeout(testTimeout);
    fs.rmSync(lockDir, { recursive: true, force: true });
    await teardownPromise?.catch(() => {});
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("ensureServer rejects when its bounded server lock acquisition times out", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousFetch = globalThis.fetch;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const url = "http://127.0.0.1:1";
  const lockDir = path.join(resolveStateDir(workspace), "server.lock");
  saveServerSession(workspace, {
    url,
    pid: 123456,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    external: false
  });
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: "other-holder", createdAt: new Date().toISOString() })}\n`,
    "utf8"
  );
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  try {
    await assert.rejects(
      ensureServer(workspace, { lockAcquireTimeoutMs: 100, lockPollMs: 25 }),
      /Timed out acquiring the OpenCode server lock/
    );
    assert.equal(loadServerSession(workspace).url, url);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    globalThis.fetch = previousFetch;
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("teardownServerSession expires a lease whose pid reports EPERM", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const originalKill = process.kill;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
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
        token: "foreign-owner-pid",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
    ]
  };
  saveServerSession(workspace, session);
  process.kill = (pid, signal) => {
    if (pid === process.pid && signal === 0) {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalKill(pid, signal);
  };

  try {
    let killedPid = null;
    const result = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      }
    });

    assert.equal(result.skipped, false);
    assert.equal(killedPid, session.pid);
    assert.equal(loadServerSession(workspace), null);
  } finally {
    process.kill = originalKill;
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveServerSession preserves the existing session when its atomic rename fails", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const originalSession = {
    url: "http://127.0.0.1:1",
    pid: 123456,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    external: false
  };
  const replacementSession = { ...originalSession, url: "http://127.0.0.1:2" };
  const originalRename = fs.renameSync;

  try {
    saveServerSession(workspace, originalSession);
    fs.renameSync = () => {
      throw new Error("simulated rename failure");
    };

    assert.throws(() => saveServerSession(workspace, replacementSession), /simulated rename failure/);
    assert.deepEqual(loadServerSession(workspace), originalSession);
    assert.equal(
      fs.readdirSync(resolveStateDir(workspace)).some((name) => name.startsWith("server.json.tmp-")),
      false
    );
  } finally {
    fs.renameSync = originalRename;
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
