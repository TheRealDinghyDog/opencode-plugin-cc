import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectServerApi,
  ensureServer,
  loadServerSession,
  saveServerSession,
  teardownServerSession
} from "../plugins/opencode/scripts/lib/server-lifecycle.mjs";
import { installFakeOpencode } from "./fake-opencode-fixture.mjs";
import { installFakeOpencodeV2 } from "./fake-opencode-v2-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

async function canListenLocalhost() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const LOCAL_LISTEN_SKIP = (await canListenLocalhost()) ? false : "local 127.0.0.1 listen is unavailable in this sandbox";

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

// ensureServer keeps its state under CLAUDE_PLUGIN_DATA and spawns `opencode`
// from the PATH in options.env.
async function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("opencode-plugin-data-");
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function fixtureEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
    ...extra
  };
  delete env.OPENCODE_COMPANION_SERVER_URL;
  return { ...env, ...extra };
}

async function startExternal(install, extra = {}) {
  const binDir = makeTempDir();
  install(binDir);
  const child = spawn("node", [path.join(binDir, "opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: { ...fixtureEnv(binDir), OPENCODE_SERVER_PASSWORD: "", ...extra },
    windowsHide: true
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) {
        resolve(match[1]);
      }
    });
    child.once("exit", () => reject(new Error(`fixture exited: ${output}`)));
  });
  return { child, url };
}

test("detectServerApi tells a 1.x server from a 2.x server", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const v1 = await startExternal(installFakeOpencode);
  const v2 = await startExternal(installFakeOpencodeV2);
  try {
    assert.equal(await detectServerApi(v1.url, 2000), 1);
    assert.equal(await detectServerApi(v2.url, 2000), 2);
    assert.equal(await detectServerApi("http://127.0.0.1:1", 500), null);
  } finally {
    v1.child.kill();
    v2.child.kill();
  }
});

test("ensureServer runs a plugin-owned 2.x server when 2.x is enabled, and tears it down", { skip: LOCAL_LISTEN_SKIP }, async () => {
  await withPluginData(async () => {
    const binDir = makeTempDir();
    installFakeOpencodeV2(binDir);
    const workspace = makeTempDir();
    const env = fixtureEnv(binDir);

    const server = await ensureServer(workspace, { env });
    assert.equal(server.api, 2);
    assert.equal(server.external, false);
    assert.equal(loadServerSession(workspace).api, 2);
    assert.ok(processAlive(server.pid));

    const result = await teardownServerSession({ cwd: workspace, force: true });
    assert.equal(result.skipped, false);
    assert.ok(await waitForExit(server.pid), "2.x server process exits on teardown");
    assert.equal(loadServerSession(workspace), null);
  });
});

test("ensureServer refuses a server of an unsupported major and leaves nothing running", { skip: LOCAL_LISTEN_SKIP }, async () => {
  await withPluginData(async () => {
    const binDir = makeTempDir();
    installFakeOpencodeV2(binDir);
    const workspace = makeTempDir();

    await assert.rejects(
      ensureServer(workspace, { env: fixtureEnv(binDir, { FAKE_OPENCODE_V2_VERSION: "3.0.0" }) }),
      /OpenCode 3\.x is not supported yet/
    );
    assert.equal(loadServerSession(workspace), null);
  });
});

test("an external 2.x server is used, and one of an unsupported major is refused", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const external = await startExternal(installFakeOpencodeV2);
  const future = await startExternal(installFakeOpencodeV2, { FAKE_OPENCODE_V2_VERSION: "3.0.0" });
  const workspace = makeTempDir();
  try {
    const server = await ensureServer(workspace, { env: { OPENCODE_COMPANION_SERVER_URL: external.url } });
    assert.equal(server.api, 2);
    assert.equal(server.external, true);
    await assert.rejects(
      ensureServer(makeTempDir(), { env: { OPENCODE_COMPANION_SERVER_URL: future.url } }),
      /OpenCode 3\.x is not supported yet/
    );
  } finally {
    external.child.kill();
    future.child.kill();
  }
});

test("a server record from before 2.x support is reused and stamped as 1.x", { skip: LOCAL_LISTEN_SKIP }, async () => {
  await withPluginData(async () => {
    const external = await startExternal(installFakeOpencode);
    const workspace = makeTempDir();
    try {
      // A plugin-owned record as 1.0.x wrote it: no `api` field.
      saveServerSession(workspace, { url: external.url, pid: external.child.pid, external: false, leases: [] });
      const server = await ensureServer(workspace, { env: fixtureEnv(makeTempDir()) });
      assert.equal(server.url, external.url);
      assert.equal(server.api, 1);
      assert.equal(loadServerSession(workspace).api, 1);
    } finally {
      external.child.kill();
    }
  });
});

test("an external 2.x server with a missing or wrong password gets the credentials message", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const external = await startExternal(installFakeOpencodeV2, { OPENCODE_SERVER_PASSWORD: "right" });
  const workspace = makeTempDir();
  const base = { OPENCODE_COMPANION_SERVER_URL: external.url };
  try {
    await assert.rejects(ensureServer(workspace, { env: base }), /requires authentication/);
    await assert.rejects(
      ensureServer(workspace, { env: { ...base, OPENCODE_SERVER_PASSWORD: "wrong" } }),
      /rejected the provided credentials/
    );
    const server = await ensureServer(workspace, { env: { ...base, OPENCODE_SERVER_PASSWORD: "right" } });
    assert.equal(server.api, 2);
  } finally {
    external.child.kill();
  }
});
