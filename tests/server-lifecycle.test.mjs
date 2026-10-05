import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { ensureServer, isServerHealthy, loadServerSession, saveServerSession, teardownServerSession } from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";
import { installFakeOpencode } from "./fake-opencode-fixture.mjs";
import { resolveStateDir } from "../plugins/opencode/scripts/lib/state.mjs";
import { commandLineLooksLikeOpencodeServe, readProcessCommandLine } from "../plugins/opencode/scripts/lib/process.mjs";

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
      res.end(JSON.stringify({ healthy: true, version: "1.17.15" }));
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
        res.end(JSON.stringify({ healthy: true, version: "1.17.15" }));
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
    return new Response(JSON.stringify({ healthy: true, version: "1.17.15" }), {
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
      },
      readProcessCommandLineImpl: () => "opencode serve --hostname 127.0.0.1 --port 1"
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
    new Response(JSON.stringify({ healthy: true, version: "1.17.15" }), {
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
      },
      readProcessCommandLineImpl: () => "opencode serve --hostname 127.0.0.1 --port 1"
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

test("teardownServerSession signals the process when the persisted identity matches the live command line", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const session = {
    url: "http://127.0.0.1:1",
    pid: 123456,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    external: false,
    port: 8080,
    pidCommandLine: "opencode serve --hostname 127.0.0.1 --port 8080",
    leases: []
  };
  saveServerSession(workspace, session);

  let killedPid = null;
  try {
    const result = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      },
      readProcessCommandLineImpl: () => "opencode serve --hostname 127.0.0.1 --port 8080"
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

test("teardownServerSession does NOT signal and clears the record when the live command line differs (PID reused)", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const session = {
    url: "http://127.0.0.1:1",
    pid: 123456,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    external: false,
    port: 8080,
    pidCommandLine: "opencode serve --hostname 127.0.0.1 --port 8080",
    leases: []
  };
  saveServerSession(workspace, session);

  let killedPid = null;
  try {
    const result = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      },
      readProcessCommandLineImpl: () => "node /opt/unrelated/server.js --port 3000"
    });

    // The teardown itself ran (metadata cleared, record removed); only the
    // kill was withheld — `skipped` keeps meaning "teardown did not run".
    assert.equal(result.skipped, false);
    assert.equal(result.killSkipped, true);
    assert.equal(result.reason, "identity-mismatch");
    assert.match(result.diagnostic, /Left PID 123456 untouched/);
    assert.equal(killedPid, null);
    assert.equal(loadServerSession(workspace), null);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("teardownServerSession does NOT signal when the command line cannot be read", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  const session = {
    url: "http://127.0.0.1:1",
    pid: 123456,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    external: false,
    port: 8080,
    pidCommandLine: "opencode serve --hostname 127.0.0.1 --port 8080",
    leases: []
  };
  saveServerSession(workspace, session);

  let killedPid = null;
  try {
    const result = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      },
      readProcessCommandLineImpl: () => null
    });

    assert.equal(result.skipped, false);
    assert.equal(result.killSkipped, true);
    assert.equal(result.reason, "identity-unverified");
    assert.equal(killedPid, null);
    assert.equal(loadServerSession(workspace), null);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("teardownServerSession verifies legacy records via the port derived from the persisted url", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  // A record written before the identity fields existed: no `port`, no
  // `pidCommandLine`. Verification must still work (the URL carries the port)
  // instead of falling open and killing blind.
  const session = {
    url: "http://127.0.0.1:43117",
    pid: 123456,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    external: false,
    leases: []
  };
  saveServerSession(workspace, session);

  try {
    let killedPid = null;
    const matched = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      },
      readProcessCommandLineImpl: () => "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 43117"
    });
    assert.equal(matched.skipped, false);
    assert.equal(matched.killSkipped, undefined);
    assert.equal(killedPid, session.pid);
    assert.equal(loadServerSession(workspace), null);

    // Same legacy record, but the PID now belongs to something else: no kill.
    saveServerSession(workspace, session);
    killedPid = null;
    const reused = await teardownServerSession({
      cwd: workspace,
      url: session.url,
      pid: session.pid,
      killProcess: (pid) => {
        killedPid = pid;
      },
      readProcessCommandLineImpl: () => "postgres: writer process"
    });
    assert.equal(reused.killSkipped, true);
    assert.equal(reused.reason, "identity-mismatch");
    assert.equal(killedPid, null);
    assert.equal(loadServerSession(workspace), null);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("commandLineLooksLikeOpencodeServe matches shell-wrapped Windows command lines", () => {
  assert.equal(
    commandLineLooksLikeOpencodeServe('C:\\Windows\\system32\\cmd.exe /c "opencode serve --hostname 127.0.0.1 --port 5150"', {
      port: 5150
    }),
    true
  );
  assert.equal(
    commandLineLooksLikeOpencodeServe("/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 5150", { port: 5150 }),
    true
  );
  // Same port, different program: must not match.
  assert.equal(
    commandLineLooksLikeOpencodeServe("node /srv/other-tool serve --port 5150", { port: 5150 }),
    false
  );
  // Right program, wrong port: must not match.
  assert.equal(
    commandLineLooksLikeOpencodeServe("/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 5151", { port: 5150 }),
    false
  );
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

test(
  "ensureServer rejects an external OpenCode 2.x server that serves its web UI on the health route",
  { skip: LOCAL_LISTEN_AVAILABLE ? false : "local 127.0.0.1 listen is unavailable in this sandbox" },
  async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>OpenCode</title>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const workspace = makeTempDir();

    try {
      await assert.rejects(
        () => ensureServer(workspace, { env: { OPENCODE_COMPANION_SERVER_URL: url } }),
        /Configured OpenCode server is not healthy: .*did not return an OpenCode 1\.x health response/
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

// Claude Code runs commands through Git Bash on Windows, which sets SHELL;
// the PR workflow's Windows job does not, so this recreates it (issue #65).
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

test(
  "on Windows under Git Bash, session teardown stops the server it started (issue #65)",
  {
    skip:
      process.platform !== "win32"
        ? "Windows only"
        : !fs.existsSync(GIT_BASH)
          ? "Git Bash is not installed"
          : LOCAL_LISTEN_AVAILABLE
            ? false
            : "local 127.0.0.1 listen is unavailable in this sandbox"
  },
  async () => {
    const previous = { SHELL: process.env.SHELL, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
    process.env.SHELL = GIT_BASH;
    process.env.CLAUDE_PLUGIN_DATA = makeTempDir("opencode-plugin-data-");
    try {
      const binDir = makeTempDir();
      installFakeOpencode(binDir);
      const workspace = makeTempDir();
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json")
      };

      const server = await ensureServer(workspace, { env });
      assert.ok(server?.url, "server started");
      // The recorded PID is the server listening on the port, not the shell.
      assert.match(readProcessCommandLine(server.pid) ?? "", /serve/);

      const result = await teardownServerSession({ cwd: workspace, force: true });
      assert.equal(result.killSkipped, undefined, result.diagnostic);
      const credentials = { password: server.password, username: server.username };
      let alive = true;
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        alive = await isServerHealthy(server.url, 300, credentials);
        if (alive) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(alive, false, "the server stops at teardown");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }
);
