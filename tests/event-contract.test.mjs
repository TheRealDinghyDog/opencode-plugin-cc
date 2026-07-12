import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { installFakeOpencode } from "./fake-opencode-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

// Pinned from a real `opencode serve` /doc (see contract.version). The fake
// fixture must emit events that satisfy this contract so the suite cannot
// drift back to invented event shapes (issue #28 / review H-03).
const require = createRequire(import.meta.url);
const contract = require("./opencode-event-contract.json");

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

function startFixtureServer(binDir, env = {}) {
  const child = spawn("node", [path.join(binDir, "opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: {
      ...process.env,
      FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
      // The raw-HTTP contract run talks to the fixture without credentials.
      OPENCODE_SERVER_PASSWORD: "",
      ...env
    },
    windowsHide: true
  });

  const url = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) {
        resolve(match[1]);
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("fixture server exited before listening")));
    setTimeout(() => reject(new Error("fixture server did not start")), 5000).unref();
  });

  return { child, url };
}

function collectSseEvents(baseUrl, onEvent) {
  const controller = new AbortController();
  const done = (async () => {
    const response = await fetch(`${baseUrl}/event`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const blockEnd = buffer.indexOf("\n\n");
        if (blockEnd === -1) {
          break;
        }
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);
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

function validatePinnedEvent(event, errors) {
  const spec = contract.events[event?.type];
  if (!spec) {
    errors.push(`unpinned event type emitted by fixture: ${event?.type}`);
    return;
  }

  for (const key of spec.required) {
    if (!(key in event)) {
      errors.push(`${event.type}: missing envelope key "${key}"`);
    }
  }
  if (typeof event.id !== "string" || !event.id.startsWith("evt_")) {
    errors.push(`${event.type}: envelope id must match ^evt_ (got ${event.id})`);
  }
  const properties = event.properties ?? {};
  for (const key of spec.properties.required) {
    if (!(key in properties)) {
      errors.push(`${event.type}: missing properties key "${key}"`);
    }
  }
  for (const key of Object.keys(properties)) {
    if (!spec.properties.keys.includes(key)) {
      errors.push(`${event.type}: unexpected properties key "${key}" (additionalProperties: false upstream)`);
    }
  }

  const objectErrors = (objectName, value, label) => {
    for (const key of contract.objects[objectName].required) {
      if (!value || !(key in value)) {
        errors.push(`${event.type}: ${label} missing required "${key}" (${objectName})`);
      }
    }
  };

  if (event.type === "session.created" || event.type === "session.updated") {
    objectErrors("Session", properties.info, "properties.info");
  }
  if (event.type === "message.updated") {
    const role = properties.info?.role;
    objectErrors(role === "user" ? "UserMessage" : "AssistantMessage", properties.info, "properties.info");
  }
  if (event.type === "message.part.updated") {
    const type = properties.part?.type;
    const objectName = type === "reasoning" ? "ReasoningPart" : type === "tool" ? "ToolPart" : "TextPart";
    objectErrors(objectName, properties.part, "properties.part");
  }
}

test("fake fixture events satisfy the pinned OpenCode event contract", { skip: LOCAL_LISTEN_SKIP }, async () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const { child, url } = startFixtureServer(binDir, {
    FAKE_OPENCODE_ASK_QUESTION: "1",
    FAKE_OPENCODE_SUBAGENT: "1",
    FAKE_OPENCODE_STREAM_DELTAS: "1"
  });

  const events = [];
  const errors = [];
  let sawIdle;
  const idle = new Promise((resolve) => {
    sawIdle = resolve;
  });
  let stream = null;

  try {
    const baseUrl = await url;
    stream = collectSseEvents(baseUrl, async (event) => {
      events.push(event);
      validatePinnedEvent(event, errors);
      // Answer the interactive flows the way the real client must: deny the
      // gated permission, reject the question.
      if (event.type === "permission.asked") {
        await fetch(`${baseUrl}/session/${event.properties.sessionID}/permissions/${event.properties.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: "reject" })
        });
      }
      if (event.type === "question.asked") {
        await fetch(`${baseUrl}/question/${event.properties.id}/reject`, { method: "POST" });
      }
      if (event.type === "session.idle") {
        sawIdle();
      }
    });

    const session = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build" })
    }).then((response) => response.json());
    assert.ok(session.id, "fixture session created");

    const message = fetch(`${baseUrl}/session/${session.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", parts: [{ type: "text", text: "contract run" }] })
    }).catch(() => null);

    await Promise.race([
      idle,
      new Promise((_, reject) => setTimeout(() => reject(new Error("session.idle never arrived")), 8000).unref())
    ]);
    await message;

    assert.deepEqual(errors, [], errors.join("\n"));
    const seenTypes = new Set(events.map((event) => event.type));
    for (const expected of [
      "session.created",
      "message.updated",
      "session.next.step.started",
      "file.edited",
      "permission.asked",
      "question.asked",
      "message.part.updated",
      "message.part.delta",
      "session.idle"
    ]) {
      assert.ok(seenTypes.has(expected), `expected fixture to emit ${expected}; saw ${[...seenTypes].join(", ")}`);
    }
    assert.equal(contract.version, "1.17.15");
  } finally {
    stream?.stop();
    await stream?.done.catch(() => {});
    child.kill();
  }
});
