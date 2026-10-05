import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { OpencodeV2Client } from "../plugins/opencode/scripts/lib/opencode-server-v2.mjs";
import { installFakeOpencodeV2 } from "./fake-opencode-v2-fixture.mjs";
import { readFakeState } from "./fake-opencode-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

async function canListenLocalhost() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const LOCAL_LISTEN_SKIP = (await canListenLocalhost()) ? false : "local 127.0.0.1 listen is unavailable in this sandbox";

function stubClient(respond, options = {}) {
  const seen = [];
  const client = new OpencodeV2Client("http://opencode.test", {
    directory: "/work/repo a",
    password: "secret",
    ...options,
    fetch: async (requestUrl, init = {}) => {
      const url = new URL(String(requestUrl));
      seen.push({ url, init });
      return respond(url, init);
    }
  });
  return { client, seen };
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("v2 client binds the workspace with location, in bodies and deepObject queries", async () => {
  const { client, seen } = stubClient((url) =>
    url.pathname === "/api/session" ? json({ data: url.search ? [] : { id: "ses_1" } }) : json({ data: [] })
  );
  const session = await client.createSession({ title: "OpenCode Companion Task: x", agent: "plan" });
  await client.listSessions();
  await client.listMessages("ses_1");

  assert.deepEqual(session, { id: "ses_1" });
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    title: "OpenCode Companion Task: x",
    agent: "plan",
    location: { directory: "/work/repo a" }
  });
  assert.equal(seen[1].url.searchParams.get("location[directory]"), "/work/repo a");
  assert.equal(seen[2].url.pathname, "/api/session/ses_1/message");
  assert.equal(seen[2].url.search, "");
  for (const { init } of seen) {
    assert.equal(init.headers.authorization, `Basic ${Buffer.from("opencode:secret").toString("base64")}`);
  }
});

test("v2 client refuses HTML from a server that is not 2.x", async () => {
  const { client } = stubClient(() => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
  await assert.rejects(client.listSessions(), /did not return JSON; is this an OpenCode 2\.x server\?/);
});

test("v2 client maps 204 to null and failures to OpencodeHttpError", async () => {
  const { client } = stubClient((url) =>
    url.pathname.endsWith("/reply") ? new Response(null, { status: 204 }) : json({ _tag: "SessionNotFoundError" }, 404)
  );
  assert.equal(await client.replyPermission("ses_1", "per_1", { decision: "reject", message: "no" }), null);
  await assert.rejects(client.prompt("ses_missing", "hi"), (error) => error.status === 404 && /HTTP 404/.test(error.message));
});

test("v2 client health accepts only a 2.x server", async () => {
  const version = { value: "2.0.20" };
  const { client } = stubClient(() => json({ version: version.value, pid: 1, urls: [], paths: {} }));
  assert.equal((await client.health()).version, "2.0.20");
  version.value = "3.0.0";
  await assert.rejects(client.health(), (error) => error.code === "OPENCODE_UNSUPPORTED_VERSION");
});

async function startFixture(scenario) {
  const binDir = makeTempDir();
  installFakeOpencodeV2(binDir);
  const child = spawn("node", [path.join(binDir, "opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: {
      ...process.env,
      FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
      FAKE_OPENCODE_V2_SCENARIO: scenario,
      OPENCODE_SERVER_PASSWORD: "fixture-secret"
    },
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
  return { binDir, child, client: new OpencodeV2Client(url, { password: "fixture-secret", directory: binDir }) };
}

test("v2 client drives a permission-asking turn on the 2.x fixture", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const { binDir, child, client } = await startFixture("permission");
  const controller = new AbortController();
  try {
    const session = await client.createSession({ title: "OpenCode Companion Task: fixture", agent: "build" });
    const outcome = new Promise((resolve) => {
      client
        .subscribeEvents(
          async (event) => {
            if (event.type === "permission.asked") {
              const pending = await client.listPermissions(event.data.sessionID);
              assert.deepEqual(pending.map((request) => request.id), [event.data.id]);
              await client.replyPermission(event.data.sessionID, event.data.id, { decision: "reject", message: "headless" });
            }
            if (event.data?.sessionID === session.id && event.type.startsWith("session.execution.") && event.type !== "session.execution.started") {
              resolve(event.type);
            }
          },
          { signal: controller.signal }
        )
        .catch(() => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.prompt(session.id, "write outside the workspace");
    assert.equal(await outcome, "session.execution.succeeded");

    const messages = await client.listMessages(session.id);
    assert.equal(messages[0].type, "idle");
    assert.equal(await client.deleteSession(session.id), null);
    const state = readFakeState(binDir);
    assert.equal(state.outsideWrites, 0);
    assert.deepEqual(state.permissionReplies[0].body, { decision: "reject", message: "headless" });
    assert.deepEqual(state.deletedSessions, [session.id]);
  } finally {
    controller.abort();
    child.kill();
  }
});

test("v2 client cancels forms and interrupts turns on the 2.x fixture", { skip: LOCAL_LISTEN_SKIP }, async () => {
  for (const scenario of ["form", "slow"]) {
    const { child, client } = await startFixture(scenario);
    const controller = new AbortController();
    try {
      const session = await client.createSession({ agent: "build" });
      let interrupted = false;
      const outcome = new Promise((resolve) => {
        client
          .subscribeEvents(
            async (event) => {
              if (event.type === "form.created") {
                const forms = await client.listForms(event.data.form.sessionID);
                await client.cancelForm(forms[0].sessionID, forms[0].id);
              }
              if (event.type === "session.text.delta" && !interrupted) {
                interrupted = true;
                assert.deepEqual(await client.interrupt(session.id), { interrupted: true });
              }
              if (event.type === "session.execution.interrupted") {
                resolve(event.data.reason);
              }
            },
            { signal: controller.signal }
          )
          .catch(() => {});
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.prompt(session.id, "go");
      assert.equal(await outcome, scenario === "form" ? "shutdown" : "user");
    } finally {
      controller.abort();
      child.kill();
    }
  }
});
