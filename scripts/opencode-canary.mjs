#!/usr/bin/env node
// Scheduled canary (issue #49). CI only runs the plugin against the fake
// OpenCode fixture, and the plugin directory's health score only counts plugin
// loads, so neither noticed when OpenCode 2.x broke every command. This runs
// the plugin and a real `opencode serve` from whatever build a channel
// installs, and compares the live API with the contracts the plugin pins.
//
//   node scripts/opencode-canary.mjs [--channel <name>] [--turn] [--report <json>] [--summary <md>]
//   node scripts/opencode-canary.mjs --file-issues <report.json> [--channel <name>] [--dry-run]
//
// The second form only talks to GitHub (via `gh`) and never starts OpenCode,
// so the workflow can give it a token without exposing that token to OpenCode.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseOpencodeVersionInfo } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "opencode", "scripts", "opencode-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "opencode", "scripts", "session-lifecycle-hook.mjs");
const CONTRACT_FILES = {
  1: path.join(ROOT, "tests", "opencode-event-contract.json"),
  2: path.join(ROOT, "tests", "opencode-v2-contract.json")
};
const TURN_PROMPT = "Reply with exactly the word PONG and nothing else. Do not use any tools.";
const TURN_TIMEOUT_MS = 3 * 60 * 1000;
const SERVER_READY_TIMEOUT_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

export function failingIssueTitle(channel) {
  return `OpenCode canary failing: ${channel}`;
}

export function newMajorIssueTitle(major, channel) {
  return `OpenCode canary: OpenCode ${major}.x detected (${channel})`;
}

// Rebuild the pinned shape of each event and object from a 1.x OpenAPI
// document, the same way tests/opencode-event-contract.json was produced.
export function extractV1Contract(doc, pinned) {
  const schemas = doc?.components?.schemas ?? {};
  const resolve = (schema) => (schema?.$ref ? schemas[schema.$ref.split("/").pop()] : schema);
  const eventsByType = new Map();
  for (const variant of schemas.Event?.anyOf ?? schemas.Event?.oneOf ?? []) {
    const schema = resolve(variant);
    const typeSchema = schema?.properties?.type;
    const type = typeSchema?.const ?? typeSchema?.enum?.[0];
    if (type) {
      eventsByType.set(type, schema);
    }
  }

  const events = {};
  for (const name of Object.keys(pinned.events ?? {})) {
    const schema = eventsByType.get(name);
    if (!schema) {
      continue;
    }
    const properties = resolve(schema.properties?.properties) ?? {};
    events[name] = {
      required: schema.required ?? [],
      properties: { required: properties.required ?? [], keys: Object.keys(properties.properties ?? {}) }
    };
  }

  const objects = {};
  for (const name of Object.keys(pinned.objects ?? {})) {
    const schema = schemas[name];
    if (schema) {
      objects[name] = { required: schema.required ?? [], keys: Object.keys(schema.properties ?? {}) };
    }
  }
  return { events, objects };
}

// The pinned shapes are emitted by the server. A key that disappeared or
// stopped being required can break the client; new keys, or keys that became
// required, only add data the client ignores.
function diffShape(label, pinned, live, findings) {
  const liveKeys = new Set(live.keys ?? []);
  const liveRequired = new Set(live.required ?? []);
  for (const key of pinned.keys ?? []) {
    if (!liveKeys.has(key)) {
      findings.breaking.push(`${label}: "${key}" was removed`);
    }
  }
  for (const key of pinned.required ?? []) {
    if (liveKeys.has(key) && !liveRequired.has(key)) {
      findings.breaking.push(`${label}: "${key}" is no longer required`);
    }
  }
  const pinnedKeys = new Set(pinned.keys ?? []);
  for (const key of live.keys ?? []) {
    if (!pinnedKeys.has(key)) {
      findings.additive.push(`${label}: new key "${key}"`);
    }
  }
}

export function diffV1Contract(pinned, live) {
  const findings = { breaking: [], additive: [] };
  for (const [name, spec] of Object.entries(pinned.events ?? {})) {
    const liveSpec = live.events?.[name];
    if (!liveSpec) {
      findings.breaking.push(`event ${name} no longer exists`);
      continue;
    }
    for (const key of spec.required ?? []) {
      if (!liveSpec.required.includes(key)) {
        findings.breaking.push(`event ${name}: envelope "${key}" is no longer required`);
      }
    }
    diffShape(`event ${name} properties`, spec.properties ?? {}, liveSpec.properties, findings);
  }
  for (const [name, spec] of Object.entries(pinned.objects ?? {})) {
    const liveSpec = live.objects?.[name];
    if (!liveSpec) {
      findings.breaking.push(`object ${name} no longer exists`);
      continue;
    }
    diffShape(`object ${name}`, spec, liveSpec, findings);
  }
  return findings;
}

// Path parameter names are not part of the wire contract, so compare
// templates with the names blanked out.
function routeKey(method, routePath) {
  return `${String(method).toUpperCase()} ${String(routePath).replace(/\{[^}]+\}/g, "{}")}`;
}

export function diffRoutes(pinnedRoutes, doc) {
  const live = new Set();
  for (const [routePath, operations] of Object.entries(doc?.paths ?? {})) {
    for (const method of Object.keys(operations ?? {})) {
      live.add(routeKey(method, routePath));
    }
  }
  const breaking = (pinnedRoutes ?? [])
    .filter((route) => !live.has(routeKey(route.method, route.path)))
    .map((route) => `route ${route.method} ${route.path} is missing`);
  return { breaking, additive: [] };
}

export function rollupStatus(checks) {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  return checks.some((check) => check.status === "notice") ? "notice" : "pass";
}

// What --file-issues does for one report: open or update an issue while the
// channel fails, close it once the channel recovers, and open one issue per
// newly seen major. Only titles this canary produces are ever touched.
export function planIssueActions(report, openIssues) {
  const actions = [];
  const failingTitle = failingIssueTitle(report.channel);
  const failing = openIssues.find((issue) => issue.title === failingTitle);
  const body = renderMarkdown(report);
  if (report.status === "fail") {
    actions.push(
      failing
        ? { action: "comment", number: failing.number, title: failingTitle, body }
        : { action: "create", title: failingTitle, body }
    );
  } else if (failing) {
    actions.push({
      action: "close",
      number: failing.number,
      title: failingTitle,
      body: `The canary passes again on ${report.channel} (OpenCode ${report.opencodeVersion ?? "unknown"}).\n\n${body}`
    });
  }

  if (Number.isInteger(report.newMajor)) {
    const title = newMajorIssueTitle(report.newMajor, report.channel);
    if (!openIssues.some((issue) => issue.title === title)) {
      actions.push({ action: "create", title, body });
    }
  }
  return actions;
}

export function renderMarkdown(report) {
  const icon = { pass: "✅", notice: "⚠️", fail: "❌" };
  const lines = [
    `## OpenCode canary: ${report.channel} ${icon[report.status] ?? ""} ${report.status}`,
    "",
    `OpenCode ${report.opencodeVersion ?? "(unknown version)"}, checked ${report.checkedAt}.`
  ];
  if (report.runUrl) {
    lines.push(`Run: ${report.runUrl}`);
  }
  lines.push("", "| Check | Result | Detail |", "| --- | --- | --- |");
  for (const check of report.checks) {
    const detail = String(check.detail ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
    lines.push(`| ${check.name} | ${icon[check.status] ?? ""} ${check.status} | ${detail} |`);
  }
  return `${lines.join("\n")}\n`;
}

function summarizeFindings(findings, limit = 8) {
  const shown = findings.slice(0, limit);
  const more = findings.length > limit ? `\n(+${findings.length - limit} more)` : "";
  return `${shown.join("\n")}${more}`;
}

function contractCheck(record, name, findings) {
  if (findings.breaking.length > 0) {
    record(name, "fail", summarizeFindings(findings.breaking));
  } else if (findings.additive.length > 0) {
    record(name, "notice", `additive changes only:\n${summarizeFindings(findings.additive)}`);
  } else {
    record(name, "pass", "matches the pinned contract");
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// OpenCode and the plugin never see GitHub credentials. Nor do they inherit
// a surrounding Claude session's companion state (data dir, session id,
// transcript) when the canary runs inside one; the run sets its own.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENCODE_COMPANION_SERVER_URL",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_COMPANION_PLUGIN_DATA",
    "OPENCODE_COMPANION_SESSION_ID",
    "OPENCODE_COMPANION_TRANSCRIPT_PATH",
    "CLAUDE_PLUGIN_DATA"
  ]) {
    if (!(key in extra)) {
      delete env[key];
    }
  }
  return env;
}

async function request(server, method, routePath, body) {
  const response = await fetch(`${server.url}${routePath}`, {
    method,
    headers: {
      authorization: server.authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: 2.x answers retired 1.x routes with its web UI.
  }
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", json, text };
}

async function firstEvent(server, routePath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${server.url}${routePath}`, {
      headers: { authorization: server.authorization, accept: "text/event-stream" },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return { ok: false, detail: "stream ended before the first event" };
      }
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n").find((candidate) => candidate.startsWith("data:"));
      if (line) {
        const event = JSON.parse(line.slice(5).trim());
        return { ok: true, detail: `first event: ${event.type ?? "(untyped)"}` };
      }
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function startServer(cwd) {
  const port = await freePort();
  const password = crypto.randomBytes(24).toString("base64url");
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: childEnv({ OPENCODE_SERVER_PASSWORD: password }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const server = {
    child,
    url: `http://127.0.0.1:${port}`,
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    output: () => output.slice(-2000)
  };

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`opencode serve exited with ${child.exitCode}: ${server.output()}`);
    }
    for (const probe of ["/global/health", "/api/info"]) {
      try {
        const result = await request(server, "GET", probe);
        if (result.status === 200 && result.json) {
          return server;
        }
      } catch {
        // Not listening yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopServer(server);
  throw new Error(`opencode serve did not become ready within ${SERVER_READY_TIMEOUT_MS / 1000}s: ${server.output()}`);
}

function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) {
    return;
  }
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (server.child.exitCode === null) {
      server.child.kill("SIGKILL");
    }
  }, 3000);
  timer.unref();
}

async function checkV1Server(server, contract, workspace, record) {
  const health = await request(server, "GET", "/global/health");
  if (health.json?.healthy === true && typeof health.json.version === "string") {
    record("1.x health", "pass", `{"healthy":true,"version":"${health.json.version}"}`);
  } else {
    record("1.x health", "fail", `unexpected response (HTTP ${health.status}, ${health.contentType})`);
  }

  const doc = await request(server, "GET", "/doc");
  if (!doc.json?.components?.schemas) {
    record("1.x contract", "fail", `/doc is not an OpenAPI document (HTTP ${doc.status}, ${doc.contentType})`);
  } else {
    contractCheck(record, "1.x event contract", diffV1Contract(contract, extractV1Contract(doc.json, contract)));
    contractCheck(record, "1.x routes", diffRoutes(contract.routes, doc.json));
  }

  const directory = encodeURIComponent(fs.realpathSync(workspace));
  const created = await request(server, "POST", `/session?directory=${directory}`, {});
  if (typeof created.json?.id === "string") {
    const removed = await request(server, "DELETE", `/session/${encodeURIComponent(created.json.id)}?directory=${directory}`);
    const deleted = removed.status >= 200 && removed.status < 300;
    record("1.x session", deleted ? "pass" : "fail", deleted ? "created and deleted" : `created, but DELETE returned HTTP ${removed.status}`);
  } else {
    record("1.x session", "fail", `POST /session returned HTTP ${created.status}`);
  }

  const event = await firstEvent(server, "/event");
  record("1.x event stream", event.ok ? "pass" : "fail", event.detail);
}

async function checkV2Server(server, contract, workspace, record) {
  const info = await request(server, "GET", "/api/info");
  if (typeof info.json?.version === "string") {
    record("2.x info", "pass", `version ${info.json.version}`);
  } else {
    record("2.x info", "fail", `unexpected response (HTTP ${info.status}, ${info.contentType})`);
  }

  const openapi = await request(server, "GET", "/openapi.json");
  if (!openapi.json?.paths) {
    record("2.x routes", "fail", `/openapi.json is not an OpenAPI document (HTTP ${openapi.status})`);
  } else {
    contractCheck(record, "2.x routes", diffRoutes(contract.routes, openapi.json));
  }

  const created = await request(server, "POST", "/api/session", { location: { directory: fs.realpathSync(workspace) } });
  const sessionID = created.json?.data?.id;
  if (typeof sessionID === "string") {
    const removed = await request(server, "DELETE", `/api/session/${encodeURIComponent(sessionID)}`);
    const deleted = removed.status >= 200 && removed.status < 300;
    record("2.x session", deleted ? "pass" : "fail", deleted ? "created and deleted" : `created, but DELETE returned HTTP ${removed.status}`);
  } else {
    record("2.x session", "fail", `POST /api/session returned HTTP ${created.status}`);
  }

  const event = await firstEvent(server, "/api/event");
  record("2.x event stream", event.ok ? "pass" : "fail", event.detail);
}

// A channel is only worth testing at its current release: GitHub's macOS
// images ship with Homebrew auto-update off, and a stale formula once made
// the "homebrew" job test 1.18.20 while users were getting 2.0.20.
const CHANNEL_LATEST = {
  "npm-latest": () => {
    const result = spawnSync("npm", ["view", "opencode-ai", "version"], { encoding: "utf8", timeout: 60 * 1000 });
    return String(result.stdout ?? "").trim() || null;
  },
  homebrew: () => {
    const result = spawnSync("brew", ["info", "--json=v2", "opencode"], { encoding: "utf8", timeout: 60 * 1000 });
    try {
      return JSON.parse(result.stdout).formulae[0].versions.stable ?? null;
    } catch {
      return null;
    }
  }
};

function checkChannelFreshness(channel, installedVersion, record) {
  const latest = CHANNEL_LATEST[channel]?.();
  if (latest === undefined) {
    return;
  }
  if (!latest) {
    record("channel is current", "notice", `could not look up the latest ${channel} version`);
  } else if (parseOpencodeVersionInfo(latest)?.version !== installedVersion) {
    record("channel is current", "fail", `installed ${installedVersion}, but ${channel} currently ships ${latest}`);
  } else {
    record("channel is current", "pass", `${channel} currently ships ${latest}`);
  }
}

function runCompanion(args, workspace, env, timeout) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024
  });
}

function checkSetup(setup, versionInfo, contract, record) {
  const major = versionInfo.major;
  if (!setup) {
    record("plugin setup", "fail", "setup --json did not return JSON");
    return false;
  }
  if (setup.opencode?.unsupported) {
    if (!contract) {
      record("plugin setup", "notice", `OpenCode ${major}.x is a new major; the plugin reports it unsupported`);
    } else if (major === 1) {
      record("plugin setup", "fail", setup.opencode.detail);
    } else {
      record("plugin setup", "notice", `the plugin still reports OpenCode ${major}.x unsupported`);
    }
    return false;
  }
  if (!contract) {
    record("plugin setup", "fail", `the plugin accepts OpenCode ${major}.x, which has no pinned contract`);
    return false;
  }
  if (!setup.opencode?.available) {
    record("plugin setup", "fail", setup.opencode?.detail ?? "OpenCode reported unavailable");
    return false;
  }
  // No provider is the expected state on a clean CI machine; what matters is
  // that the plugin reached the server it started.
  if (setup.auth?.source !== "server") {
    record("plugin setup", "fail", `the plugin did not reach its server: ${setup.auth?.detail ?? "no detail"}`);
    return false;
  }
  record("plugin setup", "pass", `ready=${setup.ready}; ${setup.auth.detail}`);
  return true;
}

// Free models need no credentials, but they rotate and can be region-locked,
// so provider-side trouble is a notice; only plugin-side breakage fails.
function checkTurn(workspace, env, record) {
  const models = spawnSync("opencode", ["models", "opencode"], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 60 * 1000
  });
  const model = String(models.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^opencode\/\S+-free$/.test(line));
  if (!model) {
    record("free-model turn", "notice", "no free OpenCode model is listed; skipped");
    return;
  }

  const result = runCompanion(["task", "--model", model, TURN_PROMPT], workspace, env, TURN_TIMEOUT_MS);
  const output = String(result.stdout ?? "").trim();
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    record("free-model turn", "notice", `${model}: no result within ${TURN_TIMEOUT_MS / 60000} minutes`);
  } else if (/\bPONG\b/.test(output) && !output.includes(TURN_PROMPT)) {
    record("free-model turn", "pass", `${model} answered`);
  } else if (/^OpenCode error:/m.test(output)) {
    record("free-model turn", "notice", `${model}: ${output.slice(0, 300)}`);
  } else {
    const stderr = String(result.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n");
    record("free-model turn", "fail", `${model}: exit ${result.status}; ${output.slice(0, 300) || stderr}`);
  }
}

export async function runCanary(options = {}) {
  const channel = options.channel ?? "local";
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail: String(detail ?? "") });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-canary-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-canary-data-"));
  const sessionId = `canary-${crypto.randomBytes(6).toString("hex")}`;
  // OPENCODE_COMPANION_PLUGIN_DATA wins over CLAUDE_PLUGIN_DATA (issue #61).
  const env = childEnv({
    OPENCODE_COMPANION_PLUGIN_DATA: pluginData,
    CLAUDE_PLUGIN_DATA: pluginData,
    OPENCODE_COMPANION_SESSION_ID: sessionId
  });
  spawnSync("git", ["init", "-q"], { cwd: workspace });

  let versionInfo = null;
  let contract = null;
  let server = null;
  try {
    const version = spawnSync("opencode", ["--version"], { cwd: workspace, env, encoding: "utf8", timeout: 30 * 1000 });
    versionInfo = parseOpencodeVersionInfo(`${version.stdout ?? ""}${version.stderr ?? ""}`);
    if (!versionInfo) {
      record("opencode --version", "fail", version.error?.message ?? (`${version.stdout}${version.stderr}`.trim() || `exit ${version.status}`));
      return finishReport({ channel, checks, versionInfo, contract });
    }
    record("opencode --version", "pass", versionInfo.version);
    checkChannelFreshness(channel, versionInfo.version, record);
    const contractFile = CONTRACT_FILES[versionInfo.major];
    contract = contractFile ? JSON.parse(fs.readFileSync(contractFile, "utf8")) : null;

    const setupRun = runCompanion(["setup", "--json"], workspace, env, 2 * 60 * 1000);
    let setup = null;
    try {
      setup = JSON.parse(setupRun.stdout);
    } catch {
      // Recorded as a failure below.
    }
    const pluginReady = checkSetup(setup, versionInfo, contract, record);

    if (contract) {
      try {
        server = await startServer(workspace);
        if (versionInfo.major === 1) {
          await checkV1Server(server, contract, workspace, record);
        } else {
          await checkV2Server(server, contract, workspace, record);
        }
      } catch (error) {
        record("opencode serve", "fail", error instanceof Error ? error.message : String(error));
      }
    }

    if (options.turn && pluginReady) {
      checkTurn(workspace, env, record);
    }
  } finally {
    stopServer(server);
    spawnSync(process.execPath, [SESSION_HOOK, "SessionEnd"], {
      cwd: workspace,
      env,
      input: JSON.stringify({ cwd: workspace, session_id: sessionId }),
      encoding: "utf8",
      timeout: 30 * 1000
    });
    for (const dir of [workspace, pluginData]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return finishReport({ channel, checks, versionInfo, contract });
}

function finishReport({ channel, checks, versionInfo, contract }) {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  return {
    channel,
    opencodeVersion: versionInfo?.version ?? null,
    major: versionInfo?.major ?? null,
    newMajor: versionInfo && !contract ? versionInfo.major : null,
    status: rollupStatus(checks),
    checkedAt: new Date().toISOString(),
    runUrl,
    checks
  };
}

function gh(args, input) {
  const result = spawnSync("gh", args, { encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function fileIssues(reportPath, options) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    // The canary step died before writing its report; that is a failure too.
    report = finishReport({
      channel: options.channel ?? "unknown",
      checks: [{ name: "canary run", status: "fail", detail: `no report at ${reportPath}: ${error.message}` }],
      versionInfo: null,
      contract: null
    });
  }
  const openIssues = options.dryRun
    ? []
    : JSON.parse(gh(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title"]));
  for (const action of planIssueActions(report, openIssues)) {
    if (options.dryRun) {
      console.log(`[dry run] would ${action.action}${action.number ? ` #${action.number}` : ""}: ${action.title}`);
      continue;
    }
    if (action.action === "create") {
      console.log(gh(["issue", "create", "--title", action.title, "--body-file", "-"], action.body).trim());
    } else if (action.action === "comment") {
      gh(["issue", "comment", String(action.number), "--body-file", "-"], action.body);
      console.log(`Commented on #${action.number}: ${action.title}`);
    } else if (action.action === "close") {
      gh(["issue", "close", String(action.number), "--comment", action.body]);
      console.log(`Closed #${action.number}: ${action.title}`);
    }
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--turn" || arg === "--dry-run") {
      options[arg === "--turn" ? "turn" : "dryRun"] = true;
    } else if (["--channel", "--report", "--summary", "--file-issues"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value.`);
      }
      options[{ "--channel": "channel", "--report": "report", "--summary": "summary", "--file-issues": "fileIssues" }[arg]] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.fileIssues) {
    fileIssues(options.fileIssues, options);
    return;
  }
  const report = await runCanary(options);
  const markdown = renderMarkdown(report);
  process.stdout.write(markdown);
  if (options.report) {
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.summary) {
    fs.appendFileSync(options.summary, markdown);
  }
  if (report.status === "fail") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
