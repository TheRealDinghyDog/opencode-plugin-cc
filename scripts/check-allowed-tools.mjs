#!/usr/bin/env node
// Runs real Claude Code headless against a copy of the plugin to prove that
// each command's allowed-tools rule auto-approves its inline `!` invocation.
//
// Claude Code checks and runs a command's inline shell before it calls the
// model, so no API key is needed: the API points at a closed local port and
// retries are off, and the run fails fast once the inline step is done. The
// copy's companion script is replaced with a probe that writes a marker file,
// and the copy lives under a path with a space in it, so the check covers the
// quoting that the rules depend on. A control command runs `node -e` under
// the same rules and must be denied, so a run that approves everything fails.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SOURCE = path.join(ROOT, "plugins", "opencode");
const DENIED = "Shell command permission check failed";
const TIMEOUT_MS = 90_000;

const PROBE = `import fs from "node:fs";
fs.writeFileSync(process.env.PROBE_MARKER, JSON.stringify(process.argv.slice(2)));
console.log("probe ran");
`;

function inlineCommands(pluginRoot) {
  return fs
    .readdirSync(path.join(pluginRoot, "commands"))
    .filter((name) => name.endsWith(".md"))
    .filter((name) => /^!`/m.test(fs.readFileSync(path.join(pluginRoot, "commands", name), "utf8")))
    .map((name) => name.replace(/\.md$/, ""));
}

function writeControl(pluginRoot) {
  const status = fs.readFileSync(path.join(pluginRoot, "commands", "status.md"), "utf8");
  const frontmatter = status.match(/^---\n[\s\S]*?\n---\n/)[0];
  const body = '!`node -e "require(\'fs\').writeFileSync(process.env.PROBE_MARKER, \'escaped\')"`\n';
  fs.writeFileSync(path.join(pluginRoot, "commands", "zz-control.md"), `${frontmatter}\n${body}`);
}

function runCommand(work, pluginRoot, name) {
  const marker = path.join(work, `marker-${name}.json`);
  const result = spawnSync(
    process.env.CLAUDE_BIN || "claude",
    [
      "-p",
      `/opencode:${name} probe-arg`,
      "--plugin-dir",
      pluginRoot,
      "--permission-mode",
      "default",
      "--output-format",
      "stream-json",
      "--verbose"
    ],
    {
      cwd: work,
      encoding: "utf8",
      input: "",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: path.join(work, "claude-config"),
        ANTHROPIC_API_KEY: "sk-ant-allowed-tools-check",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        CLAUDE_CODE_MAX_RETRIES: "0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        PROBE_MARKER: marker
      }
    }
  );
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return { ran: fs.existsSync(marker), denied: output.includes(DENIED), output };
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "opencode allowed-tools "));
  const pluginRoot = path.join(work, "opencode plugin");
  fs.cpSync(PLUGIN_SOURCE, pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "scripts", "opencode-companion.mjs"), PROBE);
  fs.mkdirSync(path.join(work, "claude-config"));

  const names = inlineCommands(pluginRoot);
  if (names.length === 0) {
    throw new Error("No commands with an inline `!` invocation were found.");
  }
  writeControl(pluginRoot);

  const failures = [];
  for (const name of [...names, "zz-control"]) {
    const expectRun = name !== "zz-control";
    const { ran, denied, output } = runCommand(work, pluginRoot, name);
    const ok = expectRun ? ran && !denied : !ran && denied;
    const outcome = ran ? "ran" : denied ? "denied" : "neither ran nor denied";
    console.log(`${ok ? "ok  " : "FAIL"} /opencode:${name}: ${outcome} (expected ${expectRun ? "ran" : "denied"})`);
    if (!ok) {
      failures.push(`/opencode:${name}\n${output.slice(-2000)}`);
    }
  }

  fs.rmSync(work, { recursive: true, force: true });
  if (failures.length > 0) {
    throw new Error(`allowed-tools check failed:\n\n${failures.join("\n\n")}`);
  }
  console.log("Every inline command ran under its own rule, and the control was denied.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
