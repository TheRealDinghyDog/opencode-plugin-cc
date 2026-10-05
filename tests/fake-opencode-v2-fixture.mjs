// Fake OpenCode 2.x for tests (issue #50). It serves the /api/* routes and
// emits the event sequences recorded from a real 2.0.20 server, pinned in
// tests/opencode-v2-contract.json; tests/event-contract-v2.test.mjs keeps
// the two in sync. Retired 1.x routes answer like the real server does: GET
// falls through to the web UI (HTML, 200), anything else gets 405.
//
// FAKE_OPENCODE_V2_SCENARIO picks what a prompt does:
//   success (default)  one step that answers with text
//   provider-error     session.execution.failed before any step
//   permission         a write outside the workspace asks external_directory
//   permission-twice   the same, plus a second ask in the step that is gone
//                      by the time it is answered (404, like #63)
//   form               the question tool opens a form and waits for it (on
//                      the server's first prompt; later prompts answer)
//   subagent           a child session runs and answers before the parent
//   slow               streams text until interrupted (or 30s pass)
//   late-reminder      answers, then a plan-mode reminder is delivered in
//                      the same execution and answered too (a real race)
//
// The reply text is FAKE_OPENCODE_V2_REPLY_TEXT, or the Nth entry of the
// JSON array FAKE_OPENCODE_V2_REPLY_SEQUENCE for the server's Nth prompt.
//
// FAKE_OPENCODE_V2_IGNORE_INTERRUPT=1 records interrupts without stopping the
// turn, so a cancelled worker is still running when cancel ends it (#77).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeOpencodeV2(binDir) {
  const statePath = path.join(binDir, "fake-opencode-state.json");
  const moduleUrl = import.meta.url;
  writeExecutable(
    path.join(binDir, "opencode"),
    `#!/usr/bin/env node
process.env.FAKE_OPENCODE_STATE_PATH = process.env.FAKE_OPENCODE_STATE_PATH || ${JSON.stringify(statePath)};
import(${JSON.stringify(moduleUrl)})
  .then((fixture) => fixture.runFakeOpencodeV2(process.argv.slice(2)))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
`
  );
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"), `@echo off\r\nnode "%~dp0opencode" %*\r\n`, {
      encoding: "utf8"
    });
  }
}

const DEFAULT_REPLY = "Handled the requested task.\nTask prompt accepted.";
export const FAKE_SECRET = "sk-fake-secret-must-never-show";
const MODEL = { id: "fake-model", providerID: "fake", variant: "none" };

function statePath() {
  return process.env.FAKE_OPENCODE_STATE_PATH;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {
      serverStarts: 0,
      sessions: [],
      prompts: [],
      permissionReplies: [],
      formActions: [],
      interrupts: [],
      deletedSessions: [],
      outsideWrites: 0
    };
  }
}

function updateState(mutate) {
  const state = loadState();
  mutate(state);
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function runFakeOpencodeV2(args) {
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(process.env.FAKE_OPENCODE_VERSION_OUTPUT || "opencode v2.0.20");
    return;
  }
  if (args[0] === "serve" && args.includes("--help")) {
    console.log("Start the v2 API and web server");
    return;
  }
  if (args[0] === "models") {
    console.log(`${MODEL.providerID}/${MODEL.id}`);
    return;
  }
  if (args[0] === "session" && args[1] === "import") {
    importSession(args.slice(2));
    return;
  }
  if (args[0] !== "serve") {
    console.error(`fake opencode v2: unsupported command ${args.join(" ")}`);
    process.exitCode = 1;
    return;
  }
  startServer(args);
}

// Required and allowed keys of the import document's schemas, from the real
// 2.0.20 /openapi.json. Every one of them sets additionalProperties: false.
const IMPORT_SCHEMAS = {
  info: {
    required: ["id", "projectID", "cost", "tokens", "time", "location"],
    allowed: ["parentID", "fork", "agent", "model", "outcome", "title", "subpath", "metadata", "permissions", "revert"]
  },
  user: { required: ["id", "time", "text", "type"], allowed: ["metadata", "files", "agents", "skills"] },
  assistant: {
    required: ["id", "time", "type", "agent", "model", "content"],
    allowed: ["metadata", "snapshot", "finish", "rawFinish", "providerState", "cost", "tokens", "error", "retry"]
  },
  model: { required: ["id", "providerID"], allowed: ["variant"] },
  tokens: { required: ["input", "output", "reasoning", "cache"], allowed: [] },
  location: { required: ["directory"], allowed: [] },
  text: { required: ["type", "text"], allowed: ["state"] }
};

function checkKeys(value, schema, where) {
  const keys = Object.keys(value ?? {});
  const missing = IMPORT_SCHEMAS[schema].required.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    // The real CLI names no key: "SchemaError: Missing key".
    throw new Error(`SchemaError: Missing key (${where}.${missing[0]})`);
  }
  const known = [...IMPORT_SCHEMAS[schema].required, ...IMPORT_SCHEMAS[schema].allowed];
  const unknown = keys.find((key) => !known.includes(key));
  if (unknown) {
    throw new Error(`SchemaError: Unexpected key (${where}.${unknown})`);
  }
}

// `opencode session import [--standalone] [--directory <dir>] <file>`. Like
// the real 2.x CLI it keeps the document's session id. Without --standalone
// the real CLI goes through OpenCode's background service, which the plugin
// must never start, so the fake refuses.
function importSession(args) {
  const file = args.filter((arg) => !arg.startsWith("--")).pop();
  try {
    if (!args.includes("--standalone")) {
      throw new Error("fake opencode v2: session import without --standalone would start the background service");
    }
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    checkKeys(document.info, "info", "info");
    checkKeys(document.info.model ?? { id: "", providerID: "" }, "model", "info.model");
    checkKeys(document.info.tokens, "tokens", "info.tokens");
    checkKeys(document.info.location, "location", "info.location");
    for (const [index, message] of (document.messages ?? []).entries()) {
      if (message.type !== "user" && message.type !== "assistant") {
        throw new Error(`fake opencode v2: unexpected message type ${message.type}`);
      }
      checkKeys(message, message.type, `messages[${index}]`);
      if (message.type === "assistant") {
        checkKeys(message.model, "model", `messages[${index}].model`);
        message.content.forEach((part, partIndex) => checkKeys(part, "text", `messages[${index}].content[${partIndex}]`));
      }
    }
    const sessionID = document.info.id;
    updateState((state) => {
      state.imports = state.imports ?? [];
      if (state.imports.some((entry) => entry.sessionID === sessionID)) {
        throw new Error("Session already exists");
      }
      state.imports.push({ args, cwd: process.cwd(), sessionID, document });
    });
    console.log(`Imported session: ${sessionID}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function startServer(args) {
  const startedAt = Date.now();
  const hostname = args[args.indexOf("--hostname") + 1] || "127.0.0.1";
  const port = Number(args[args.indexOf("--port") + 1] || 0);
  updateState((state) => {
    state.serverStarts += 1;
  });

  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const expectedAuthorization = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : null;

  const clients = new Set();
  const sessions = new Map();
  const messages = new Map();
  const turns = new Map();
  let nextId = 1;
  let seq = 0;
  const id = (prefix) => `${prefix}_fake${String(nextId++).padStart(6, "0")}`;

  function emit(type, data, sessionID = data?.sessionID) {
    const session = sessions.get(sessionID);
    const event = {
      id: id("evt"),
      created: Date.now(),
      type,
      ...(session ? { location: session.location } : {}),
      data,
      ...(sessionID ? { durable: { aggregateID: sessionID, seq: ++seq, version: 1 } } : {})
    };
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      client.write(line);
    }
  }

  function sendJson(res, value, status = 200) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }

  async function readJson(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    return raw ? JSON.parse(raw) : {};
  }

  function createSession(body, parentID = null) {
    const session = {
      id: id("ses"),
      projectID: "global",
      ...(parentID ? { parentID } : {}),
      agent: body.agent || "build",
      model: body.model || MODEL,
      title: body.title || "New session",
      location: body.location || { directory: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() }
    };
    sessions.set(session.id, session);
    messages.set(session.id, []);
    emit("session.created", {
      sessionID: session.id,
      slug: `fake-${session.id}`,
      version: "2.0.20",
      projectID: session.projectID,
      ...(parentID ? { parentID } : {}),
      location: session.location,
      subpath: "",
      title: session.title,
      agent: session.agent,
      model: session.model
    });
    return session;
  }

  function waitFor(turn, key) {
    return new Promise((resolve) => {
      turn.waiters.set(key, resolve);
    });
  }

  function recordAssistant(sessionID, assistantMessageID, text, agent) {
    messages.get(sessionID).push({
      id: assistantMessageID,
      type: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      agent,
      model: MODEL,
      content: text ? [{ type: "text", text }] : [],
      finish: "stop"
    });
  }

  function finish(sessionID, outcome, extra = {}) {
    messages.get(sessionID).push({ id: id("msg"), type: "idle", time: { created: Date.now() }, outcome });
    const type = { succeeded: "session.execution.succeeded", failed: "session.execution.failed", interrupted: "session.execution.interrupted" }[outcome];
    emit(type, { sessionID, ...extra });
    turns.delete(sessionID);
  }

  function step(sessionID, agent, assistantMessageID) {
    emit("session.step.started", {
      sessionID,
      agent,
      model: MODEL,
      assistantMessageID,
      snapshot: "fake-snapshot",
      started: Date.now()
    });
  }

  function stepEnded(sessionID, assistantMessageID, files = [], finish = "stop") {
    emit("session.step.ended", {
      sessionID,
      assistantMessageID,
      finish,
      rawFinish: finish === "stop" ? "stop" : "tool_calls",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      snapshot: "fake-snapshot",
      files
    });
  }

  function text(sessionID, assistantMessageID, value, ordinal = 0) {
    emit("session.text.started", { sessionID, assistantMessageID, ordinal });
    const middle = Math.ceil(value.length / 2);
    for (const delta of [value.slice(0, middle), value.slice(middle)]) {
      if (delta) {
        emit("session.text.delta", { sessionID, assistantMessageID, ordinal, delta });
      }
    }
    emit("session.text.ended", { sessionID, assistantMessageID, ordinal, text: value });
  }

  function interrupted(sessionID, assistantMessageID, reason) {
    emit("session.step.failed", {
      sessionID,
      assistantMessageID,
      error: { type: "aborted", message: "Step interrupted" },
      snapshot: "fake-snapshot",
      files: []
    });
    recordAssistant(sessionID, assistantMessageID, "", sessions.get(sessionID).agent);
    finish(sessionID, "interrupted", { reason });
  }

  async function runTurn(session, prompt, inboxID) {
    const sessionID = session.id;
    const agent = session.agent;
    const promptIndex = loadState().prompts.length - 1;
    const configured = process.env.FAKE_OPENCODE_V2_SCENARIO || "success";
    const scenario = configured === "form" && promptIndex > 0 ? "success" : configured;
    const sequence = JSON.parse(process.env.FAKE_OPENCODE_V2_REPLY_SEQUENCE || "null");
    const reply =
      (Array.isArray(sequence) && sequence.length > 0 ? sequence[Math.min(promptIndex, sequence.length - 1)] : null) ||
      process.env.FAKE_OPENCODE_V2_REPLY_TEXT ||
      DEFAULT_REPLY;
    const turn = { interrupted: false, waiters: new Map() };
    turns.set(sessionID, turn);

    emit("session.execution.started", { sessionID });
    emit("session.inbox.delivered", { sessionID, inboxID });
    messages.get(sessionID).push({ id: inboxID, type: "user", time: { created: Date.now() }, text: prompt });

    if (scenario === "provider-error") {
      finish(sessionID, "failed", { error: { type: "provider.no-route", message: "Model unavailable: fake fake-model/" } });
      return;
    }

    const first = id("msg");
    step(sessionID, agent, first);

    if (scenario === "slow") {
      emit("session.text.started", { sessionID, assistantMessageID: first, ordinal: 0 });
      const deadline = Date.now() + (process.env.FAKE_OPENCODE_V2_IGNORE_INTERRUPT === "1" ? 90000 : 30000);
      while (!turn.interrupted && Date.now() < deadline) {
        emit("session.text.delta", { sessionID, assistantMessageID: first, ordinal: 0, delta: "counting... " });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (turn.interrupted) {
        interrupted(sessionID, first, "user");
        return;
      }
    }

    const permissionScenario = scenario === "permission" || scenario === "permission-twice";
    if (permissionScenario || scenario === "form" || scenario === "subagent") {
      const callID = id("call");
      const tool = permissionScenario ? "write" : { form: "question", subagent: "task" }[scenario];
      emit("session.tool.called", {
        sessionID,
        assistantMessageID: first,
        id: callID,
        input: { tool },
        executed: false
      });

      if (permissionScenario) {
        const requestID = id("per");
        const request = {
          id: requestID,
          sessionID,
          action: "external_directory",
          resources: ["/outside/workspace/*"],
          save: ["/outside/workspace/*"],
          source: { type: "tool", messageID: first, id: callID }
        };
        turn.pendingPermission = request;
        emit("permission.asked", request);
        if (scenario === "permission-twice") {
          // Nothing waits on this one, so a reply to it gets 404.
          emit("permission.asked", { ...request, id: id("per"), resources: ["/outside/other/*"], save: ["/outside/other/*"] });
        }
        const decision = await waitFor(turn, requestID);
        turn.pendingPermission = null;
        emit("permission.replied", { sessionID, requestID, reply: decision.decision });
        if (decision.decision === "reject") {
          emit("session.tool.failed", {
            sessionID,
            assistantMessageID: first,
            id: callID,
            error: { type: "permission.rejected", message: decision.message || "Permission rejected" },
            executed: true
          });
        } else {
          updateState((state) => {
            state.outsideWrites += 1;
          });
          emit("session.tool.success", {
            sessionID,
            assistantMessageID: first,
            id: callID,
            content: [{ type: "text", text: "Wrote /outside/workspace/secret.txt" }],
            metadata: {},
            executed: true
          });
        }
      }

      if (scenario === "form") {
        const formID = id("frm");
        const form = {
          id: formID,
          sessionID,
          title: "Questions",
          metadata: { kind: "question", tool: { messageID: first, id: callID } },
          fields: [
            {
              key: "q0",
              title: "Approach",
              description: "Which approach should I take?",
              type: "string",
              options: [
                { value: "A", label: "Option A" },
                { value: "B", label: "Option B" }
              ],
              custom: true
            }
          ]
        };
        turn.pendingForm = form;
        emit("form.created", { form });
        const action = await waitFor(turn, formID);
        turn.pendingForm = null;
        if (action.cancelled) {
          emit("form.cancelled", { id: formID, sessionID });
          emit("session.tool.failed", {
            sessionID,
            assistantMessageID: first,
            id: callID,
            error: { type: "aborted", message: "The user dismissed this question" },
            executed: true
          });
          interrupted(sessionID, first, "shutdown");
          return;
        }
      }

      if (scenario === "subagent") {
        const child = createSession({ agent: "explore", title: "Subtask: explore", location: session.location }, sessionID);
        const childMessage = id("msg");
        emit("session.execution.started", { sessionID: child.id });
        step(child.id, "explore", childMessage);
        text(child.id, childMessage, "Child exploration output.");
        stepEnded(child.id, childMessage);
        recordAssistant(child.id, childMessage, "Child exploration output.", "explore");
        finish(child.id, "succeeded");
        emit("session.tool.success", {
          sessionID,
          assistantMessageID: first,
          id: callID,
          content: [{ type: "text", text: "Child exploration output." }],
          metadata: { sessionID: child.id },
          executed: true
        });
      }

      stepEnded(sessionID, first, [], "tool-calls");
      recordAssistant(sessionID, first, "", agent);
      const second = id("msg");
      step(sessionID, agent, second);
      text(sessionID, second, reply);
      stepEnded(sessionID, second);
      recordAssistant(sessionID, second, reply, agent);
      finish(sessionID, "succeeded");
      return;
    }

    text(sessionID, first, reply);
    stepEnded(sessionID, first);
    recordAssistant(sessionID, first, reply, agent);
    if (scenario === "late-reminder") {
      const reminderID = id("msg");
      emit("session.inbox.delivered", { sessionID, inboxID: reminderID });
      messages.get(sessionID).push({
        id: reminderID,
        type: "synthetic",
        time: { created: Date.now() },
        text: "<system-reminder>\nYou are in Plan mode.\n</system-reminder>"
      });
      const reminderReply = id("msg");
      step(sessionID, agent, reminderReply);
      text(sessionID, reminderReply, "I'm ready to help. What would you like to plan?");
      stepEnded(sessionID, reminderReply);
      recordAssistant(sessionID, reminderReply, "I'm ready to help. What would you like to plan?", agent);
    }
    finish(sessionID, "succeeded");
  }

  const routes = [
    [
      "GET",
      /^\/api\/info$/,
      (req, res) =>
        sendJson(res, { version: process.env.FAKE_OPENCODE_V2_VERSION || "2.0.20", pid: process.pid, urls: [], paths: {} })
    ],
    [
      "GET",
      /^\/api\/event$/,
      (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", data: {} })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      }
    ],
    [
      "GET",
      /^\/api\/agent$/,
      (req, res) =>
        sendJson(res, {
          data: ["build", "plan", "explore"].map((agentID) => ({
            id: agentID,
            name: agentID,
            mode: agentID === "explore" ? "subagent" : "primary",
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "external_directory", resource: "*", effect: "ask" },
              { action: "read", resource: "*.env", effect: "ask" }
            ]
          }))
        })
    ],
    [
      "GET",
      /^\/api\/model$/,
      (req, res) =>
        sendJson(res, {
          // Like a real 2.x server just after it starts, list nothing for a while (#82).
          data:
            Date.now() - startedAt < Number(process.env.FAKE_OPENCODE_V2_MODELS_SETTLE_MS || 0)
              ? []
              : [{ ...MODEL, modelID: MODEL.id, variants: [{ id: "none" }, { id: "low" }, { id: "high" }] }]
        })
    ],
    ["GET", /^\/api\/model\/default$/, (req, res) => sendJson(res, { data: { ...MODEL, modelID: MODEL.id } })],
    [
      "POST",
      /^\/api\/session\/([^/]+)\/model$/,
      async (req, res, [sessionID]) => {
        const body = await readJson(req);
        const session = sessions.get(sessionID);
        if (session) {
          session.model = body.model;
        }
        updateState((state) => {
          state.modelChanges = [...(state.modelChanges ?? []), { sessionID, model: body.model }];
        });
        sendJson(res, { data: session ?? null });
      }
    ],
    [
      "POST",
      /^\/api\/session\/([^/]+)\/agent$/,
      async (req, res, [sessionID]) => {
        const body = await readJson(req);
        const session = sessions.get(sessionID);
        if (session) {
          session.agent = body.agent;
        }
        updateState((state) => {
          state.agentChanges = [...(state.agentChanges ?? []), { sessionID, agent: body.agent }];
        });
        sendJson(res, { data: session ?? null });
      }
    ],
    ["GET", /^\/api\/provider$/, (req, res) => sendJson(res, { data: [{ id: "fake", name: "Fake" }] })],
    [
      "GET",
      /^\/api\/credential$/,
      (req, res) =>
        sendJson(res, {
          // Like the real route, each entry carries the secret; the plugin must never show it.
          data:
            process.env.FAKE_OPENCODE_V2_NO_CREDENTIALS === "1"
              ? []
              : [
                  { id: "cred_fake", integrationID: "fake", label: "API key", active: true, value: { type: "key", key: FAKE_SECRET } },
                  { id: "cred_old", integrationID: "stale", label: "API key", active: false, value: { type: "key", key: FAKE_SECRET } }
                ]
        })
    ],
    // Like the real 2.0.20 server, the list ignores the location filter.
    ["GET", /^\/api\/session$/, (req, res) => sendJson(res, { data: [...sessions.values()].reverse() })],
    [
      "POST",
      /^\/api\/session$/,
      async (req, res) => {
        const body = await readJson(req);
        const session = createSession(body);
        updateState((state) => {
          state.sessions.push({ id: session.id, body });
        });
        sendJson(res, { data: session });
      }
    ],
    [
      "DELETE",
      /^\/api\/session\/([^/]+)$/,
      (req, res, [sessionID]) => {
        sessions.delete(sessionID);
        updateState((state) => {
          state.deletedSessions.push(sessionID);
        });
        res.writeHead(204);
        res.end();
      }
    ],
    [
      "POST",
      /^\/api\/session\/([^/]+)\/prompt$/,
      async (req, res, [sessionID]) => {
        const session = sessions.get(sessionID);
        if (!session) {
          sendJson(res, { _tag: "SessionNotFoundError", message: `Session not found: ${sessionID}` }, 404);
          return;
        }
        const body = await readJson(req);
        updateState((state) => {
          state.prompts.push({ sessionID, body, agent: session.agent });
        });
        const inbox = { id: id("msg"), sessionID, time: { created: Date.now() }, type: "user", payload: { text: body.text }, delivery: "steer" };
        sendJson(res, { data: inbox });
        setTimeout(() => runTurn(session, body.text, inbox.id), 10);
      }
    ],
    [
      "GET",
      /^\/api\/session\/([^/]+)\/message$/,
      (req, res, [sessionID]) => sendJson(res, { data: [...(messages.get(sessionID) ?? [])].reverse() })
    ],
    [
      "POST",
      /^\/api\/session\/([^/]+)\/interrupt$/,
      (req, res, [sessionID]) => {
        const turn = turns.get(sessionID);
        updateState((state) => {
          state.interrupts.push(sessionID);
        });
        if (turn && process.env.FAKE_OPENCODE_V2_IGNORE_INTERRUPT !== "1") {
          turn.interrupted = true;
        }
        sendJson(res, { interrupted: Boolean(turn) });
      }
    ],
    [
      "GET",
      /^\/api\/session\/([^/]+)\/permission$/,
      (req, res, [sessionID]) => {
        const pending = turns.get(sessionID)?.pendingPermission;
        sendJson(res, { data: pending ? [pending] : [] });
      }
    ],
    [
      "POST",
      /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/,
      async (req, res, [sessionID, requestID]) => {
        const body = await readJson(req);
        updateState((state) => {
          state.permissionReplies.push({ sessionID, requestID, body });
        });
        const waiter = turns.get(sessionID)?.waiters.get(requestID);
        if (!waiter) {
          sendJson(res, { _tag: "PermissionNotFoundError", message: `Permission not found: ${requestID}` }, 404);
          return;
        }
        waiter(body);
        res.writeHead(204);
        res.end();
      }
    ],
    [
      "GET",
      /^\/api\/session\/([^/]+)\/form$/,
      (req, res, [sessionID]) => {
        const pending = turns.get(sessionID)?.pendingForm;
        sendJson(res, { data: pending ? [pending] : [] });
      }
    ],
    [
      "DELETE",
      /^\/api\/session\/([^/]+)\/form\/([^/]+)$/,
      (req, res, [sessionID, formID]) => {
        updateState((state) => {
          state.formActions.push({ sessionID, formID, action: "cancel" });
        });
        const waiter = turns.get(sessionID)?.waiters.get(formID);
        if (!waiter) {
          sendJson(res, { _tag: "FormNotFoundError", message: `Form not found: ${formID}` }, 404);
          return;
        }
        waiter({ cancelled: true });
        res.writeHead(204);
        res.end();
      }
    ]
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // Like 2.0.20: only /api/* requires auth; the web UI fallback does not.
    if (expectedAuthorization && url.pathname.startsWith("/api/") && req.headers.authorization !== expectedAuthorization) {
      sendJson(res, { _tag: "UnauthorizedError", message: "Unauthorized" }, 401);
      return;
    }
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method ? pattern.exec(url.pathname) : null;
      if (match) {
        try {
          await handler(req, res, match.slice(1).map(decodeURIComponent));
        } catch (error) {
          sendJson(res, { _tag: "UnknownError", message: String(error) }, 500);
        }
        return;
      }
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, { _tag: "NotFound", message: `No route for ${req.method} ${url.pathname}` }, 404);
    } else if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>OpenCode</title>");
    } else {
      res.writeHead(405);
      res.end();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`server listening on http://${hostname}:${server.address().port}`);
  });
}
