import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { installFakeOpencodeV2 } from "./fake-opencode-v2-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { readFakeState } from "./fake-opencode-fixture.mjs";

// Pinned from a real OpenCode 2.0.20 server (routes and request bodies from
// /openapi.json, events and message items from recorded runs). The fake 2.x
// fixture must emit only pinned events, in pinned shapes, so the 2.x client
// is never tested against invented ones (issue #50, as #28 did for 1.x).
const require = createRequire(import.meta.url);
const contract = require("./opencode-v2-contract.json");

async function canListenLocalhost() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const LOCAL_LISTEN_SKIP = (await canListenLocalhost()) ? false : "local 127.0.0.1 listen is unavailable in this sandbox";
const PASSWORD = "fixture-secret";
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;

async function startFixture(scenario) {
  const binDir = makeTempDir();
  installFakeOpencodeV2(binDir);
  const child = spawn("node", [path.join(binDir, "opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: {
      ...process.env,
      FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
      FAKE_OPENCODE_V2_SCENARIO: scenario,
      OPENCODE_SERVER_PASSWORD: PASSWORD
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
    child.once("exit", () => reject(new Error(`fixture exited before listening: ${output}`)));
    setTimeout(() => reject(new Error("fixture did not start")), 5000).unref();
  });
  return { binDir, child, url };
}

async function api(url, method, routePath, body) {
  const response = await fetch(`${url}${routePath}`, {
    method,
    headers: { authorization: AUTH, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function subscribe(url, onEvent) {
  const controller = new AbortController();
  const done = (async () => {
    const response = await fetch(`${url}/api/event`, { headers: { authorization: AUTH }, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          await onEvent(JSON.parse(data));
        }
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) {
      throw error;
    }
  });
  return { stop: () => controller.abort(), done };
}

function validateEvent(event, errors) {
  for (const key of contract.envelope.required) {
    if (!(key in event)) {
      errors.push(`${event.type}: missing envelope key "${key}"`);
    }
  }
  const spec = contract.events[event.type];
  if (!spec) {
    errors.push(`unpinned event type emitted by the fixture: ${event.type}`);
    return;
  }
  const data = event.data ?? {};
  const allowed = new Set([...spec.required, ...(spec.optional ?? [])]);
  for (const key of spec.required) {
    if (!(key in data)) {
      errors.push(`${event.type}: missing data key "${key}"`);
    }
  }
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      errors.push(`${event.type}: data key "${key}" is not in the pinned contract`);
    }
  }
  for (const [key, nested] of Object.entries(spec.nested ?? {})) {
    for (const nestedKey of nested) {
      if (!(nestedKey in (data[key] ?? {}))) {
        errors.push(`${event.type}: missing "${key}.${nestedKey}"`);
      }
    }
  }
}

function validateMessages(items, errors) {
  for (const item of items) {
    const keys = contract.messages[item.type];
    if (!keys) {
      errors.push(`unpinned message item type: ${item.type}`);
      continue;
    }
    for (const key of keys) {
      if (!(key in item)) {
        errors.push(`message ${item.type}: missing "${key}"`);
      }
    }
  }
}

// Runs one prompt against a fixture scenario and returns every event plus the
// stored messages. `react` answers asks or interrupts, like a client would.
async function runScenario(scenario, react = async () => {}) {
  const { binDir, child, url } = await startFixture(scenario);
  const events = [];
  let sessionID = null;
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const stream = subscribe(url, async (event) => {
    events.push(event);
    await react(event, { url, sessionID });
    if (event.data?.sessionID === sessionID && /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) {
      settle(event);
    }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const created = await api(url, "POST", "/api/session", {
      title: "OpenCode Companion Task: fixture",
      agent: "build",
      location: { directory: binDir }
    });
    sessionID = created.json.data.id;
    const prompt = await api(url, "POST", `/api/session/${sessionID}/prompt`, { text: "check the fixture" });
    assert.equal(prompt.status, 200);
    const outcome = await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${scenario}: no terminal event`)), 10000))
    ]);
    const stored = await api(url, "GET", `/api/session/${sessionID}/message`);
    return { binDir, events, outcome, sessionID, messages: stored.json.data };
  } finally {
    stream.stop();
    child.kill();
  }
}

function assertContract({ events, messages }) {
  const errors = [];
  for (const event of events) {
    validateEvent(event, errors);
  }
  validateMessages(messages, errors);
  assert.deepEqual(errors, []);
}

test("fixture success turn satisfies the pinned 2.x contract", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const run = await runScenario("success");
  assertContract(run);
  assert.equal(run.outcome.type, "session.execution.succeeded");
  const ended = run.events.find((event) => event.type === "session.text.ended");
  assert.match(ended.data.text, /Handled the requested task/);
  assert.deepEqual(
    run.messages.map((item) => item.type),
    ["idle", "assistant", "user"]
  );
});

test("fixture provider failure ends with session.execution.failed", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const run = await runScenario("provider-error");
  assertContract(run);
  assert.equal(run.outcome.type, "session.execution.failed");
  assert.equal(run.outcome.data.error.type, "provider.no-route");
});

test("fixture permission ask waits for a reply and honors a rejection", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const run = await runScenario("permission", async (event, { url }) => {
    if (event.type === "permission.asked") {
      const reply = await api(url, "POST", `/api/session/${event.data.sessionID}/permission/${event.data.id}/reply`, {
        decision: "reject",
        message: "Headless run: rejected."
      });
      assert.equal(reply.status, 204);
    }
  });
  assertContract(run);
  assert.equal(run.outcome.type, "session.execution.succeeded");
  const failed = run.events.find((event) => event.type === "session.tool.failed");
  assert.equal(failed.data.error.type, "permission.rejected");
  const state = readFakeState(run.binDir);
  assert.equal(state.outsideWrites, 0);
  assert.equal(state.permissionReplies[0].body.decision, "reject");
});

test("fixture form cancellation interrupts the turn like the real server", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const run = await runScenario("form", async (event, { url }) => {
    if (event.type === "form.created") {
      const cancelled = await api(url, "DELETE", `/api/session/${event.data.form.sessionID}/form/${event.data.form.id}`);
      assert.equal(cancelled.status, 204);
    }
  });
  assertContract(run);
  assert.equal(run.outcome.type, "session.execution.interrupted");
  assert.ok(run.events.some((event) => event.type === "form.cancelled"));
});

test("fixture subagent runs in a child session with a parentID", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const run = await runScenario("subagent");
  assertContract(run);
  const child = run.events.find((event) => event.type === "session.created" && event.data.parentID === run.sessionID);
  assert.ok(child, "child session.created with parentID");
  assert.ok(run.events.some((event) => event.type === "session.text.ended" && event.data.sessionID === child.data.sessionID));
  assert.equal(run.outcome.type, "session.execution.succeeded");
});

test("fixture interrupt stops a streaming turn", { skip: LOCAL_LISTEN_SKIP }, async () => {
  let sent = false;
  const run = await runScenario("slow", async (event, { url, sessionID }) => {
    if (!sent && event.type === "session.text.delta") {
      sent = true;
      const response = await api(url, "POST", `/api/session/${sessionID}/interrupt`);
      assert.deepEqual(response.json, { interrupted: true });
    }
  });
  assertContract(run);
  assert.equal(run.outcome.type, "session.execution.interrupted");
  assert.equal(run.outcome.data.reason, "user");
});

test("fixture answers retired 1.x routes like a real 2.x server", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const { child, url } = await startFixture("success");
  try {
    const health = await fetch(`${url}/global/health`, { headers: { authorization: AUTH } });
    assert.equal(health.status, 200);
    assert.match(health.headers.get("content-type"), /text\/html/);
    const session = await fetch(`${url}/session`, { method: "POST", headers: { authorization: AUTH } });
    assert.equal(session.status, 405);
    const unauthorized = await fetch(`${url}/api/info`);
    assert.equal(unauthorized.status, 401);
  } finally {
    child.kill();
  }
});

const RECORDINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v2-recordings");

test("real 2.0.20 recordings satisfy the pinned 2.x contract", () => {
  const files = fs.readdirSync(RECORDINGS).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 7);
  for (const name of files) {
    const recording = JSON.parse(fs.readFileSync(path.join(RECORDINGS, name), "utf8"));
    const errors = [];
    // Real servers emit more event types than the client consumes; only the
    // pinned ones are checked, and their shapes must match exactly.
    for (const event of recording.events.filter((candidate) => contract.events[candidate.type])) {
      validateEvent(event, errors);
    }
    validateMessages(recording.messages.data, errors);
    assert.deepEqual(errors, [], name);
  }
});
