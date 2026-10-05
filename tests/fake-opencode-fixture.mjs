import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_OPENCODE_STATE_PATH: path.join(binDir, "fake-opencode-state.json"),
    ...extra
  };
}

export function readFakeState(binDir) {
  const statePath = path.join(binDir, "fake-opencode-state.json");
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
}

export function readServerBootCount(binDir) {
  const bootsDir = path.join(binDir, "boots");
  try {
    return fs.readdirSync(bootsDir).length;
  } catch {
    return 0;
  }
}

export function installFakeOpencode(binDir) {
  const statePath = path.join(binDir, "fake-opencode-state.json");
  const scriptPath = path.join(binDir, "opencode");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const STATE_PATH = process.env.FAKE_OPENCODE_STATE_PATH || ${JSON.stringify(statePath)};
const clients = new Set();
const pendingPermissions = new Map();
const pendingQuestions = new Map();

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      serverStarts: 0,
      nextSessionId: 1,
      nextMessageId: 1,
      sessions: [],
      messages: [],
      imports: [],
      permissions: [],
      lastAbort: null
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

// Real event envelope (pinned in tests/opencode-event-contract.json):
// { id: "evt_...", type, properties }.
let nextEventId = 1;
function emit(type, properties) {
  const line = "data: " + JSON.stringify({ id: "evt_" + nextEventId++, type, properties }) + "\\n\\n";
  for (const client of clients) {
    client.write(line);
  }
}

function sessionInfo(session, parentID) {
  return {
    id: session.id,
    slug: "fake-" + session.id,
    projectID: "prj_fake",
    directory: session.directory || process.cwd(),
    title: session.title || "",
    version: "1.17.15",
    time: { created: Date.now(), updated: Date.now() },
    ...(session.agent ? { agent: session.agent } : {}),
    ...(parentID ? { parentID } : {})
  };
}

function assistantInfo(sessionID, messageID, agent) {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: messageID + "_user",
    modelID: "fake-model",
    providerID: "fake",
    mode: "normal",
    agent: agent || "build",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  };
}

function textFromMessage(body) {
  return (body.parts || [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
}

function schemaType(schema) {
  const type = schema && schema.type;
  return Array.isArray(type) ? type[0] : type;
}

function exampleString(key) {
  return key ? key.replace(/_/g, " ") + " value" : "structured value";
}

function exampleForSchema(schema, key) {
  if (!schema || typeof schema !== "object") {
    return exampleString(key);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const type = schemaType(schema);
  if (type === "object" || schema.properties) {
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties).slice(0, 1);
    const result = {};
    for (const property of required) {
      result[property] = exampleForSchema(properties[property], property);
    }
    return result;
  }
  if (type === "array") {
    return [];
  }
  if (type === "integer") {
    return Number.isFinite(schema.minimum) ? schema.minimum : 1;
  }
  if (type === "number") {
    return Number.isFinite(schema.minimum) ? schema.minimum : 1;
  }
  if (type === "boolean") {
    return true;
  }
  return exampleString(key);
}

function structuredOutputParts(body) {
  if (body && body.format && body.format.type === "json_schema") {
    return [
      {
        type: "tool",
        tool: "StructuredOutput",
        callID: "call_structured_1",
        state: {
          status: "completed",
          input: exampleForSchema(body.format.schema, "result")
        }
      }
    ];
  }
  return null;
}

async function waitForPermission(permissionID) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 2000);
    pendingPermissions.set(permissionID, (reply) => {
      clearTimeout(timeout);
      resolve(reply ?? null);
    });
  });
}

async function waitForQuestion(requestID) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    pendingQuestions.set(requestID, () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function handleMessage(req, res, sessionID) {
  const body = await readJson(req);
  const state = loadState();
  const session = state.sessions.find((candidate) => candidate.id === sessionID);
  if (!session) {
    sendJson(res, { error: "unknown session" }, 404);
    return;
  }

  const messageID = "msg_" + state.nextMessageId++;
  const prompt = textFromMessage(body);
  state.messages.push({ sessionID, messageID, body, prompt });
  state.lastMessage = { sessionID, messageID, body, prompt };
  saveState(state);

  const agent = session.agent || body.agent || "build";
  // A real server streams the user's prompt as its own message and text part
  // before the assistant turn starts. FAKE_OPENCODE_USER_PART_FIRST sends the
  // part before the message that reveals its user role.
  const userMessageID = messageID + "_user";
  const userInfo = {
    id: userMessageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent,
    model: { providerID: "fake", modelID: "fake-model" }
  };
  const userPart = { id: "prt_" + userMessageID, sessionID, messageID: userMessageID, type: "text", text: prompt };
  if (process.env.FAKE_OPENCODE_USER_PART_FIRST === "1") {
    emit("message.part.updated", { sessionID, part: userPart, time: Date.now() });
    emit("message.updated", { sessionID, info: userInfo });
  } else {
    emit("message.updated", { sessionID, info: userInfo });
    emit("message.part.updated", { sessionID, part: userPart, time: Date.now() });
  }

  const info = assistantInfo(sessionID, messageID, agent);
  emit("message.updated", { sessionID, info });
  emit("session.next.step.started", {
    timestamp: Date.now(),
    sessionID,
    assistantMessageID: messageID,
    agent,
    model: { providerID: "fake", modelID: "fake-model" }
  });

  // The provider rejects the request: session.error, then idle, with no
  // assistant text ("provider-error") or after partial text
  // ("provider-error-after-text"), like a real 1.18 server.
  const providerFailMode = process.env.FAKE_OPENCODE_MESSAGE_FAIL;
  if (providerFailMode === "provider-error" || providerFailMode === "provider-error-after-text") {
    if (providerFailMode === "provider-error-after-text") {
      emit("message.part.updated", {
        sessionID,
        part: {
          id: "prt_" + messageID + "_partial",
          sessionID,
          messageID,
          type: "text",
          text: "Partial answer before the failure.",
          time: { start: Date.now(), end: Date.now() }
        },
        time: Date.now()
      });
    }
    const error = { name: "APIError", data: { message: "Bad Request: fake-model is not supported for this account." } };
    emit("session.error", { sessionID, error });
    emit("session.idle", { sessionID });
    sendJson(res, { info: Object.assign({}, info, { error }), parts: [] });
    return;
  }

  if (agent === "build") {
    // Workspace edits are covered by the stock build agent's wildcard allow
    // and never produce a permission round-trip.
    emit("file.edited", { file: "generated.txt" });
    // A guard category (external_directory) reaches "ask". The companion must
    // deny it; only an (incorrect) approval lets the gated edit proceed.
    const permissionID = "perm_" + messageID;
    emit("permission.asked", {
      id: permissionID,
      sessionID,
      permission: "external_directory",
      patterns: ["/outside/workspace/secret.txt"],
      metadata: {},
      always: ["/outside/workspace/secret.txt"],
      tool: { messageID, callID: "call_edit_1" }
    });
    const reply = await waitForPermission(permissionID);
    if (reply && reply.response !== "reject") {
      emit("file.edited", { file: "/outside/workspace/secret.txt" });
    }
  }

  if (process.env.FAKE_OPENCODE_ASK_QUESTION === "1") {
    // The question tool blocks the session on a deferred reply; a headless
    // client must reject it via POST /question/{requestID}/reject.
    const questionID = "que_" + messageID;
    emit("question.asked", {
      id: questionID,
      sessionID,
      questions: [
        {
          question: "Which approach should I take?",
          header: "Approach",
          options: [{ label: "Option A" }, { label: "Option B" }]
        }
      ]
    });
    await waitForQuestion(questionID);
  }

  if (process.env.FAKE_OPENCODE_SUBAGENT === "1") {
    // A child session announces itself via session.created with parentID in
    // properties.info; its output must not pollute the parent final message.
    const childID = sessionID + "_child";
    const childMessageID = "msg_child_" + messageID;
    emit("session.created", {
      sessionID: childID,
      info: sessionInfo({ id: childID, directory: process.cwd(), title: "Subtask: explore", agent: "explore" }, sessionID)
    });
    emit("message.updated", { sessionID: childID, info: assistantInfo(childID, childMessageID, "explore") });
    emit("message.part.updated", {
      sessionID: childID,
      part: {
        id: "prt_" + childMessageID,
        sessionID: childID,
        messageID: childMessageID,
        type: "text",
        text: "Child exploration output.",
        time: { start: Date.now(), end: Date.now() }
      },
      time: Date.now()
    });
  }

  const finalText = prompt.includes("follow up")
    ? "Resumed the prior OpenCode run.\\nFollow-up prompt accepted."
    : "Handled the requested task.\\nTask prompt accepted.";
  const parts = (structuredOutputParts(body) || [{ type: "text", text: finalText }]).map((part, index) => ({
    id: "prt_" + messageID + "_" + index,
    sessionID,
    messageID,
    ...(part.type === "text" ? { time: { start: Date.now(), end: Date.now() } } : {}),
    ...part
  }));
  const failMode = process.env.FAKE_OPENCODE_MESSAGE_FAIL;
  if (failMode === "empty-recovery" || failMode === "snapshot-fails-empty-recovery") {
    emit("session.idle", { sessionID });
    res.destroy();
    return;
  }
  if (failMode === "event-drop-before-message-response") {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const finalState = loadState();
  finalState.lastResponseParts = parts;
  finalState.responses = finalState.responses || [];
  finalState.responses.push({ sessionID, info, parts });
  saveState(finalState);

  if (process.env.FAKE_OPENCODE_STREAM_DELTAS === "1" && parts[0].type === "text") {
    // Stream the text purely as an initial empty snapshot plus deltas, then
    // drop the POST and withhold recovery data: the client must assemble the
    // final message from the delta stream alone.
    const full = parts[0].text;
    emit("message.part.updated", {
      sessionID,
      part: Object.assign({}, parts[0], { text: "", time: { start: Date.now() } }),
      time: Date.now()
    });
    emit("message.part.delta", { sessionID, messageID, partID: parts[0].id, field: "text", delta: full.slice(0, 8) });
    emit("message.part.delta", { sessionID, messageID, partID: parts[0].id, field: "text", delta: full.slice(8) });
    const cleanState = loadState();
    cleanState.responses = (cleanState.responses || []).filter((entry) => entry.info.id !== messageID);
    saveState(cleanState);
    emit("session.idle", { sessionID });
    res.destroy();
    return;
  }

  // Issue #2 regression hooks. "transport": deliver the turn over the event
  // stream but drop the /message HTTP response mid-flight (like undici timing
  // out the held-open POST). "recover": additionally withhold the part events
  // so the client must re-fetch the finished message via GET /session/:id/message.
  // "delayed-events" drops the POST before completion events arrive, matching
  // the real failure ordering seen in issue #2 review. "mismatched-recover"
  // gives recovery a stale event-derived message id, then expects fallback to
  // the newest assistant message returned by GET /session/:id/message.
  if (failMode === "delayed-events") {
    res.destroy();
    setTimeout(() => {
      for (const part of parts) {
        emit("message.part.updated", { sessionID, part, time: Date.now() });
      }
      emit("session.idle", { sessionID });
    }, 25);
    return;
  }
  if (failMode === "mismatched-recover") {
    emit("message.updated", { sessionID, info: assistantInfo(sessionID, messageID + "_event_only", agent) });
    emit("session.idle", { sessionID });
    res.destroy();
    return;
  }
  if (failMode !== "recover") {
    for (const part of parts) {
      emit("message.part.updated", { sessionID, part, time: Date.now() });
    }
  }
  emit("session.idle", { sessionID });
  if (failMode === "transport" || failMode === "recover") {
    res.destroy();
    return;
  }
  sendJson(res, { info, parts });
}

function handleSessionListCli() {
  const state = loadState();
  for (const session of state.sessions) {
    console.log([session.id, session.title || "", session.directory || ""].filter(Boolean).join("  "));
  }
}

function handleImportCli(filePath) {
  if (!filePath) {
    console.error("missing import file");
    process.exit(1);
  }
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // Mirror the real importer's strict validation for the constraints confirmed
  // against a live server, so a converter schema regression fails the e2e test.
  if (!document.info || typeof document.info.slug !== "string" || !document.info.slug) {
    console.error("import validation failed: missing session slug");
    process.exit(1);
  }
  for (const message of document.messages || []) {
    if (message.info && message.info.role === "assistant" && typeof message.info.parentID !== "string") {
      console.error("import validation failed: assistant parentID must be a string");
      process.exit(1);
    }
  }
  const state = loadState();
  const sessionID = "ses_" + state.nextSessionId++;
  const session = {
    id: sessionID,
    directory: document.info && document.info.directory || process.cwd(),
    title: document.info && document.info.title || null,
    agent: document.info && document.info.agent || null,
    model: document.info && document.info.model || null,
    imported: true
  };
  const record = {
    sourcePath: path.resolve(filePath),
    sessionID,
    document
  };
  state.sessions.unshift(session);
  state.imports = state.imports || [];
  state.imports.push(record);
  state.lastImport = record;
  saveState(state);
  console.log("Imported session: " + sessionID);
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.FAKE_OPENCODE_VERSION_OUTPUT || "opencode 1.17.10-test");
  process.exit(0);
}
if (args[0] === "serve" && args.includes("--help")) {
  console.log("fake opencode serve help");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  handleSessionListCli();
  process.exit(0);
}
if (args[0] === "import") {
  handleImportCli(args[1]);
  process.exit(0);
}
if (args[0] !== "serve") {
  process.exit(1);
}

const hostname = args[args.indexOf("--hostname") + 1] || "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] || 0);
const bootState = loadState();
bootState.serverStarts = (bootState.serverStarts || 0) + 1;
saveState(bootState);
// Race-safe boot marker: each process writes a uniquely-named file, so counting
// files reliably reflects concurrent boots (unlike serverStarts' read-modify-
// write, where two concurrent boots can both persist the same incremented value).
try {
  const bootsDir = path.join(path.dirname(STATE_PATH), "boots");
  fs.mkdirSync(bootsDir, { recursive: true });
  fs.writeFileSync(path.join(bootsDir, process.pid + "-" + process.hrtime.bigint().toString()), "");
} catch {}
const bootStartedAt = Date.now();
const healthDelayMs = Math.max(0, Number(process.env.FAKE_OPENCODE_HEALTH_DELAY_MS || 0));
// Mirror the real server's auth: when OPENCODE_SERVER_PASSWORD is set, every
// route (including /global/health and /event) requires HTTP Basic auth.
const serverPassword = process.env.OPENCODE_SERVER_PASSWORD || "";
const serverUsername = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const expectedAuthorization = serverPassword
  ? "Basic " + Buffer.from(serverUsername + ":" + serverPassword).toString("base64")
  : null;

const server = http.createServer(async (req, res) => {
  if (expectedAuthorization && req.headers.authorization !== expectedAuthorization) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="opencode"' });
    res.end();
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/global/health") {
    if (Date.now() - bootStartedAt < healthDelayMs) {
      sendJson(res, { ok: false }, 503);
      return;
    }
    sendJson(res, { healthy: true, version: process.env.FAKE_OPENCODE_SERVER_VERSION || "1.17.15" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/global/dispose") {
    // Like a real 1.x server: dispose cleans up instance state but does NOT
    // stop the listener, so teardown has to stop the process itself. The
    // fixture used to exit here, which hid a Windows teardown leak (#65).
    sendJson(res, true);
    return;
  }

  if (req.method === "GET" && url.pathname === "/config") {
    sendJson(res, { providerID: "openai", config: { model_provider: "openai" } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/provider") {
    if (process.env.FAKE_OPENCODE_PROVIDER_FAIL === "1") {
      sendJson(res, { error: "provider endpoint failed" }, 500);
      return;
    }
    if (process.env.FAKE_OPENCODE_NO_PROVIDER === "1") {
      sendJson(res, { all: [], default: {}, connected: [] });
    } else {
      sendJson(res, { all: [{ id: "openai" }], default: {}, connected: ["openai"] });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/event") {
    // Record the workspace scope of each event subscription so tests can
    // assert the client binds its stream to the invoking directory.
    const eventState = loadState();
    eventState.eventDirectories = eventState.eventDirectories || [];
    eventState.eventDirectories.push(url.searchParams.get("directory"));
    saveState(eventState);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.flushHeaders();
    res.write(":ok\\n\\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    if (process.env.FAKE_OPENCODE_MESSAGE_FAIL === "event-drop-before-message-response") {
      setTimeout(() => res.destroy(), 30);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/session") {
    // Mirror the real server: a directory query scopes the listing to that
    // workspace.
    const directory = url.searchParams.get("directory");
    const sessions = loadState().sessions.filter(
      (session) => !directory || session.directory === directory
    );
    sendJson(res, sessions);
    return;
  }

  if (req.method === "POST" && url.pathname === "/session") {
    const body = await readJson(req);
    // Mirror the real server: create-session rejects \`directory\` and \`model\`
    // in the BODY (additionalProperties:false / model belongs on the message)
    // with 400; the workspace is scoped via the \`directory\` QUERY parameter
    // and otherwise inherits the server process launch directory.
    if ("directory" in body || "model" in body) {
      sendJson(res, { _tag: "BadRequest" }, 400);
      return;
    }
    const state = loadState();
    const session = {
      id: "ses_" + state.nextSessionId++,
      directory: url.searchParams.get("directory") || process.cwd(),
      title: body.title || null,
      agent: body.agent || null,
      model: body.model || null,
      permission: body.permission || []
    };
    state.sessions.unshift(session);
    state.lastCreateSession = body;
    saveState(state);
    emit("session.created", { sessionID: session.id, info: sessionInfo(session, body.parentID) });
    sendJson(res, session);
    return;
  }

  const messageMatch = url.pathname.match(/^\\/session\\/([^/]+)\\/message$/);
  if (req.method === "GET" && messageMatch) {
    const sessionID = decodeURIComponent(messageMatch[1]);
    const state = loadState();
    if (process.env.FAKE_OPENCODE_MESSAGE_FAIL === "snapshot-fails-empty-recovery") {
      state.messageListCalls = (state.messageListCalls || 0) + 1;
      saveState(state);
      if (state.messageListCalls === 1) {
        sendJson(res, { error: "snapshot failed" }, 503);
        return;
      }
    }
    const responses = (state.responses || []).filter((entry) => entry.sessionID === sessionID);
    sendJson(res, responses);
    return;
  }
  if (req.method === "POST" && messageMatch) {
    await handleMessage(req, res, decodeURIComponent(messageMatch[1]));
    return;
  }

  const abortMatch = url.pathname.match(/^\\/session\\/([^/]+)\\/abort$/);
  if (req.method === "POST" && abortMatch) {
    const state = loadState();
    state.lastAbort = decodeURIComponent(abortMatch[1]);
    saveState(state);
    sendJson(res, { ok: true });
    return;
  }

  const questionRejectMatch = url.pathname.match(/^\\/question\\/([^/]+)\\/reject$/);
  if (req.method === "POST" && questionRejectMatch) {
    const requestID = decodeURIComponent(questionRejectMatch[1]);
    const state = loadState();
    state.questionRejections = state.questionRejections || [];
    state.questionRejections.push({ requestID });
    saveState(state);
    const resolve = pendingQuestions.get(requestID);
    pendingQuestions.delete(requestID);
    resolve?.();
    sendJson(res, true);
    return;
  }

  const permissionMatch = url.pathname.match(/^\\/session\\/([^/]+)\\/permissions\\/([^/]+)$/);
  if (req.method === "POST" && permissionMatch) {
    const body = await readJson(req);
    // Mirror the real endpoint: body must be exactly { response: once|always|reject }.
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "response" || !["once", "always", "reject"].includes(body.response)) {
      sendJson(res, { _tag: "BadRequest" }, 400);
      return;
    }
    const sessionID = decodeURIComponent(permissionMatch[1]);
    const permissionID = decodeURIComponent(permissionMatch[2]);
    const state = loadState();
    state.permissions.push({ sessionID, permissionID, body });
    saveState(state);
    const resolve = pendingPermissions.get(permissionID);
    pendingPermissions.delete(permissionID);
    resolve?.(body);
    sendJson(res, { ok: true });
    return;
  }

  sendJson(res, { error: "not found" }, 404);
});

server.listen(port, hostname, () => {
  const address = server.address();
  console.log("opencode server listening on http://" + hostname + ":" + address.port);
});
`;

  writeExecutable(scriptPath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "opencode.cmd"), `@echo off\r\nnode "%~dp0opencode" %*\r\n`, {
      encoding: "utf8"
    });
  }
}
