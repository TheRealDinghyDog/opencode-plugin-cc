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

function emit(event) {
  const line = "data: " + JSON.stringify(event) + "\\n\\n";
  for (const client of clients) {
    client.write(line);
  }
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
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    pendingPermissions.set(permissionID, () => {
      clearTimeout(timeout);
      resolve();
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

  emit({ type: "session.next.step.started", sessionID });
  if (session.agent === "build" || body.agent === "build") {
    const permissionID = "perm_" + messageID;
    emit({ type: "permission.asked", sessionID, permissionID, permission: { id: permissionID, tool: "edit" } });
    await waitForPermission(permissionID);
    emit({ type: "file.edited", sessionID, path: "generated.txt" });
  }

  const finalText = prompt.includes("follow up")
    ? "Resumed the prior OpenCode run.\\nFollow-up prompt accepted."
    : "Handled the requested task.\\nTask prompt accepted.";
  const parts = structuredOutputParts(body) || [{ type: "text", text: finalText }];
  const finalState = loadState();
  finalState.lastResponseParts = parts;
  saveState(finalState);
  emit({ type: "message.updated", sessionID, message: { id: messageID, parts } });
  emit({ type: "session.idle", sessionID });
  sendJson(res, { info: { id: messageID, sessionID }, parts });
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
  console.log("opencode 1.17.10-test");
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/global/health") {
    if (Date.now() - bootStartedAt < healthDelayMs) {
      sendJson(res, { ok: false }, 503);
      return;
    }
    sendJson(res, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/global/dispose") {
    sendJson(res, { ok: true });
    setTimeout(() => server.close(() => process.exit(0)), 10);
    return;
  }

  if (req.method === "GET" && url.pathname === "/config") {
    sendJson(res, { providerID: "openai", config: { model_provider: "openai" } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/provider") {
    sendJson(res, { id: "openai", name: "OpenAI" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.flushHeaders();
    res.write(":ok\\n\\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/session") {
    sendJson(res, loadState().sessions);
    return;
  }

  if (req.method === "POST" && url.pathname === "/session") {
    const body = await readJson(req);
    // Mirror the real server: create-session rejects \`directory\` and \`model\`
    // (additionalProperties:false / model belongs on the message) with 400.
    if ("directory" in body || "model" in body) {
      sendJson(res, { _tag: "BadRequest" }, 400);
      return;
    }
    const state = loadState();
    const session = {
      id: "ses_" + state.nextSessionId++,
      directory: body.directory || process.cwd(),
      title: body.title || null,
      agent: body.agent || null,
      model: body.model || null,
      permission: body.permission || []
    };
    state.sessions.unshift(session);
    state.lastCreateSession = body;
    saveState(state);
    emit({ type: "session.created", sessionID: session.id, session });
    sendJson(res, session);
    return;
  }

  const messageMatch = url.pathname.match(/^\\/session\\/([^/]+)\\/message$/);
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
    resolve?.();
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
