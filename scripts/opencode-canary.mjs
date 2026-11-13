#!/usr/bin/env node
// Scheduled canary (issue #49). This plugin has no code of its own: each
// command tells Claude which `opencode` command line to run, so OpenCode's CLI
// is its whole contract with OpenCode (issue #111). CI can only compare the
// plugin's Markdown with tests/opencode-cli-contract.json. This runs the real
// `opencode` a channel installs and compares that file with what the CLI
// actually accepts, so an upstream change shows up here before users hit it.
//
//   node scripts/opencode-canary.mjs [--channel <name>] [--turn] [--report <json>] [--summary <md>]
//   node scripts/opencode-canary.mjs --file-issues <report.json> [--channel <name>] [--dry-run]
//
// The second form only talks to GitHub (via `gh`) and never starts OpenCode,
// so the workflow can give it a token without exposing that token to OpenCode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_CONTRACT_FILE = path.join(ROOT, "tests", "opencode-cli-contract.json");
// `opencode` and `npm` are .cmd shims on Windows, which only a shell starts.
const ON_WINDOWS = process.platform === "win32";
const PLATFORM_NAMES = { linux: "Linux", darwin: "macOS", win32: "Windows" };

const TURN_PROMPT = "Reply with exactly the word PONG and nothing else. Do not use any tools.";
const TURN_TIMEOUT_MS = 3 * 60 * 1000;

// "opencode v2.2.7" on 2.x, a bare "1.19.5" on 1.x.
export function parseVersion(text) {
  const match = /(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(String(text ?? ""));
  return match ? { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) } : null;
}

// "npm-latest on Windows": a channel runs on several OSes, and each run
// needs its own issue.
export function reportLabel(channel, platform = process.platform) {
  return `${channel} on ${PLATFORM_NAMES[platform] ?? platform}`;
}

export function failingIssueTitle(label) {
  return `OpenCode canary failing: ${label}`;
}

export function newMajorIssueTitle(major, label) {
  return `OpenCode canary: OpenCode ${major}.x detected (${label})`;
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
  const label = report.label ?? report.channel;
  const failingTitle = failingIssueTitle(label);
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
      body: `The canary passes again on ${label} (OpenCode ${report.opencodeVersion ?? "unknown"}).\n\n${body}`
    });
  }

  if (Number.isInteger(report.newMajor)) {
    const title = newMajorIssueTitle(report.newMajor, label);
    if (!openIssues.some((issue) => issue.title === title)) {
      actions.push({ action: "create", title, body });
    }
  }
  return actions;
}

export function renderMarkdown(report) {
  const icon = { pass: "✅", notice: "⚠️", fail: "❌" };
  const lines = [
    `## OpenCode canary: ${report.label ?? report.channel} ${icon[report.status] ?? ""} ${report.status}`,
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure part of the CLI check: given a command's --help text, list what the
// contract expects for this major version and the help does not show.
export function diffCliHelp(command, entry, major, helpText) {
  const missing = [];
  const usage = new RegExp(`(^|\\s)${escapeRegExp(command)}(\\s|$)`, "m");
  if (command !== "opencode" && !usage.test(helpText)) {
    missing.push(`${command}: --help does not describe this command`);
    return missing;
  }
  for (const [flag, majors] of Object.entries(entry.flags ?? {})) {
    if (!majors.includes(major)) {
      continue;
    }
    if (!new RegExp(`(^|[\\s,])${escapeRegExp(flag)}([\\s,=]|$)`, "m").test(helpText)) {
      missing.push(`${command}: no ${flag} option`);
    }
  }
  return missing;
}

// OpenCode never sees GitHub credentials.
function childEnv() {
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    delete env[key];
  }
  return env;
}

// Runs `opencode` with its output in files, not pipes. On 2.x the first
// command starts OpenCode's background service, and a service that inherited
// a pipe would keep this call waiting after the command itself has exited.
function runOpencode(args, { cwd, env, input, timeout }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-canary-out-"));
  const outFile = path.join(dir, "stdout");
  const errFile = path.join(dir, "stderr");
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  let result;
  try {
    result = spawnSync("opencode", args, {
      cwd,
      env,
      input: input ?? "",
      stdio: ["pipe", out, err],
      timeout,
      shell: ON_WINDOWS,
      windowsHide: true
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const stdout = fs.readFileSync(outFile, "utf8");
  const stderr = fs.readFileSync(errFile, "utf8");
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return { status: result.status, signal: result.signal, error: result.error, stdout, stderr };
}

// Asks the installed CLI for the help of every command the plugin uses and
// compares it with the contract.
function checkCliHelp(contract, versionInfo, workspace, env, record) {
  const missing = [];
  let checked = 0;
  for (const [command, entry] of Object.entries(contract.commands)) {
    if (!entry.majors.includes(versionInfo.major)) {
      continue;
    }
    const help = runOpencode([...command.split(" ").slice(1), "--help"], { cwd: workspace, env, timeout: 30 * 1000 });
    checked += 1;
    if (help.error || help.status !== 0) {
      missing.push(`${command}: --help failed (${help.error?.message ?? `exit ${help.status}`})`);
      continue;
    }
    missing.push(...diffCliHelp(command, entry, versionInfo.major, `${help.stdout}${help.stderr}`));
  }
  if (missing.length > 0) {
    record("CLI options", "fail", summarizeFindings(missing));
  } else {
    record("CLI options", "pass", `${checked} commands match the pinned options`);
  }
}

// `opencode api <operation>` takes an OpenAPI operation ID, so the status and
// cancel commands depend on these names.
export function missingApiOperations(cliContract, openapi) {
  const live = new Set();
  for (const methods of Object.values(openapi?.paths ?? {})) {
    for (const operation of Object.values(methods ?? {})) {
      if (operation && typeof operation.operationId === "string") {
        live.add(operation.operationId);
      }
    }
  }
  return (cliContract?.commands?.["opencode api"]?.operations ?? []).filter((operation) => !live.has(operation));
}

// Reads the OpenAPI document the way the plugin's commands reach OpenCode:
// through `opencode api` and OpenCode's own background service.
function checkApiOperations(contract, workspace, env, record) {
  const name = "API operations";
  const result = runOpencode(["api", "GET", "/openapi.json"], { cwd: workspace, env, timeout: 2 * 60 * 1000 });
  let openapi = null;
  try {
    openapi = JSON.parse(result.stdout);
  } catch {
    // Reported below.
  }
  if (!openapi?.paths) {
    const detail = result.error?.message ?? (result.stderr.trim().split(/\r?\n/).slice(0, 3).join("\n") || `exit ${result.status}`);
    record(name, "fail", `\`opencode api GET /openapi.json\` did not return an OpenAPI document: ${detail}`);
    return;
  }
  const gone = missingApiOperations(contract, openapi);
  record(name, gone.length > 0 ? "fail" : "pass", gone.length > 0 ? `no longer offered: ${gone.join(", ")}` : "all present in /openapi.json");
}

// A channel is only worth testing at its current release: GitHub's macOS
// images ship with Homebrew auto-update off, and a stale formula once made
// the "homebrew" job test 1.18.20 while users were getting 2.0.20.
const CHANNEL_LATEST = {
  "npm-latest": () => {
    const result = spawnSync("npm", ["view", "opencode-ai", "version"], {
      encoding: "utf8",
      timeout: 60 * 1000,
      shell: ON_WINDOWS
    });
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
  } else if (parseVersion(latest)?.version !== installedVersion) {
    record("channel is current", "fail", `installed ${installedVersion}, but ${channel} currently ships ${latest}`);
  } else {
    record("channel is current", "pass", `${channel} currently ships ${latest}`);
  }
}

// What a run's output says about the command line itself. OpenCode answers an
// option or command it does not know with its help text or an "unknown" /
// "unexpected" message; anything else that goes wrong is the provider's or the
// model's trouble.
export function classifyRun({ status, signal, timedOut, stdout, stderr }) {
  const output = `${stdout ?? ""}\n${stderr ?? ""}`;
  if (timedOut || signal) {
    return "no-answer";
  }
  if (/\bPONG\b/.test(stdout ?? "") && !String(stdout).includes(TURN_PROMPT)) {
    return "answered";
  }
  if (/\b(unknown|unexpected|unrecognized|invalid) (option|argument|flag|command|positional)/i.test(output)) {
    return "rejected";
  }
  if (/^\s*(USAGE|Usage:|Options:|FLAGS|Commands:)/m.test(output)) {
    return "rejected";
  }
  return status === 0 ? "no-answer" : "provider";
}

// Sends one prompt the way the plugin's commands do: `opencode run` with the
// agent first, a title, and the prompt on standard input. Free models need no
// credentials, but they rotate and can be region-locked, so provider-side
// trouble is a notice; only a command line OpenCode rejects fails.
function checkRun(workspace, env, record) {
  const name = "free-model run";
  const models = runOpencode(["models"], { cwd: workspace, env, timeout: 60 * 1000 });
  const model = models.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^opencode\/\S+-free$/.test(line));
  if (!model) {
    record(name, "notice", "no free OpenCode model is listed; skipped");
    return;
  }

  const result = runOpencode(["run", "--agent", "plan", "--model", model, "--title", "Claude-Code-canary"], {
    cwd: workspace,
    env,
    input: `${TURN_PROMPT}\n`,
    timeout: TURN_TIMEOUT_MS
  });
  const outcome = classifyRun({ ...result, timedOut: result.error?.code === "ETIMEDOUT" });
  const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-5).join("\n").slice(0, 400);
  if (outcome === "answered") {
    record(name, "pass", `${model} answered`);
  } else if (outcome === "rejected") {
    record(name, "fail", `OpenCode rejected the command line (exit ${result.status}):\n${tail}`);
  } else if (outcome === "no-answer") {
    record(name, "notice", `${model}: no answer within ${TURN_TIMEOUT_MS / 60000} minutes or an empty one`);
  } else {
    record(name, "notice", `${model}: exit ${result.status}; ${tail}`);
  }
}

export async function runCanary(options = {}) {
  const channel = options.channel ?? "local";
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail: String(detail ?? "") });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-canary-"));
  const env = childEnv();
  spawnSync("git", ["init", "-q"], { cwd: workspace });

  let versionInfo = null;
  let knownMajor = false;
  try {
    const version = runOpencode(["--version"], { cwd: workspace, env, timeout: 30 * 1000 });
    versionInfo = parseVersion(`${version.stdout}${version.stderr}`);
    if (!versionInfo) {
      record("opencode --version", "fail", version.error?.message ?? (`${version.stdout}${version.stderr}`.trim() || `exit ${version.status}`));
    } else {
      record("opencode --version", "pass", versionInfo.version);
      checkChannelFreshness(channel, versionInfo.version, record);
      const contract = JSON.parse(fs.readFileSync(CLI_CONTRACT_FILE, "utf8"));
      knownMajor = Object.values(contract.commands).some((entry) => entry.majors.includes(versionInfo.major));
      if (!knownMajor) {
        record("CLI options", "notice", `OpenCode ${versionInfo.major}.x is a new major; the CLI contract lists no commands for it`);
      } else {
        checkCliHelp(contract, versionInfo, workspace, env, record);
        if (contract.commands["opencode api"]?.majors.includes(versionInfo.major)) {
          checkApiOperations(contract, workspace, env, record);
        }
        if (options.turn) {
          checkRun(workspace, env, record);
        }
      }
    }
  } catch (error) {
    record("canary run", "fail", error instanceof Error ? error.stack ?? error.message : String(error));
  }

  try {
    // Windows can hold files for a moment after a process exits.
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    record("cleanup", "notice", `could not remove ${workspace}: ${error.code ?? error.message}`);
  }
  return finishReport({ channel, checks, versionInfo, knownMajor });
}

function finishReport({ channel, checks, versionInfo, knownMajor }) {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  return {
    channel,
    platform: process.platform,
    label: reportLabel(channel),
    opencodeVersion: versionInfo?.version ?? null,
    major: versionInfo?.major ?? null,
    newMajor: versionInfo && !knownMajor ? versionInfo.major : null,
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
      knownMajor: false
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
