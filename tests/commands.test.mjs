import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("commands invoke the opencode companion entrypoint", () => {
  const expectations = new Map([
    ["commands/review.md", /opencode-companion\.mjs" review "\$ARGUMENTS"/],
    ["commands/adversarial-review.md", /opencode-companion\.mjs" adversarial-review "\$ARGUMENTS"/],
    ["commands/setup.md", /opencode-companion\.mjs" setup --json \$ARGUMENTS/],
    ["commands/transfer.md", /opencode-companion\.mjs" transfer "\$ARGUMENTS"/],
    ["commands/status.md", /opencode-companion\.mjs" status "\$ARGUMENTS"/],
    ["commands/result.md", /opencode-companion\.mjs" result "\$ARGUMENTS"/],
    ["commands/cancel.md", /opencode-companion\.mjs" cancel "\$ARGUMENTS"/]
  ]);

  for (const [file, pattern] of expectations) {
    const source = read(file);
    assert.match(source, pattern, file);
    assert.doesNotMatch(source, /codex-companion\.mjs/, file);
  }
});

test("rescue command routes through the renamed OpenCode subagent", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/opencode-rescue.md");
  const runtimeSkill = read("skills/opencode-cli-runtime/SKILL.md");

  assert.match(rescue, /subagent_type: "opencode:opencode-rescue"/);
  assert.match(rescue, /do not call `Skill\(opencode:opencode-rescue\)`/i);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /openai\/gpt-5\.3-codex-spark/);
  assert.match(agent, /name: opencode-rescue/);
  assert.match(agent, /opencode-companion\.mjs" task/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(runtimeSkill, /name: opencode-cli-runtime/);
  assert.match(runtimeSkill, /opencode-companion\.mjs" task "<raw arguments>"/);
});

test("command and skill filenames use OpenCode identity", () => {
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort(), [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents", "opencode-rescue.md")), true);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "skills", "opencode-cli-runtime", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "skills", "opencode-result-handling", "SKILL.md")), true);
});

test("setup command offers OpenCode installation guidance", () => {
  const setup = read("commands/setup.md");
  const companion = read("scripts/opencode-companion.mjs");
  assert.match(setup, /description: Check whether the local OpenCode CLI is ready/);
  assert.match(setup, /fail-closed stop-time review gate/);
  assert.match(setup, /npm install -g opencode-ai/);
  assert.doesNotMatch(setup, /@openai\/codex/);
  assert.match(companion, /OpenCode reviewer is unavailable/);
  assert.match(companion, /--disable-review-gate/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
  assert.match(source, /OpenCode Companion/);
});

test("stop review hook passes an explicit task classification flag", () => {
  const source = read("scripts/stop-review-gate-hook.mjs");
  assert.match(source, /"task", "--json", "--stop-review", prompt/);
});

// The directory holds any version whose allowed-tools pre-approve a wildcard
// right after an interpreter or package manager, such as Bash(node:*). Each
// Bash rule has to name the exact script or command instead. Bash rules match
// the literal command text, so the companion rule keeps the quotes that every
// invocation puts around the script path.
const COMPANION_PREFIX = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" ';
const COMPANION_RULE = `Bash(${COMPANION_PREFIX}*)`;
const NPM_INSTALL = "npm install -g opencode-ai";

function commandFiles() {
  return fs
    .readdirSync(path.join(PLUGIN_ROOT, "commands"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `commands/${name}`);
}

function allowedTools(source) {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const line = frontmatter.split("\n").find((entry) => entry.startsWith("allowed-tools:"));
  if (!line) {
    return [];
  }
  // Split on commas outside parentheses; a rule's text may contain commas.
  const tools = [];
  let depth = 0;
  let current = "";
  for (const char of line.slice("allowed-tools:".length)) {
    if (char === "," && depth === 0) {
      tools.push(current.trim());
      current = "";
      continue;
    }
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    current += char;
  }
  tools.push(current.trim());
  return tools.filter(Boolean);
}

test("commands pre-approve only the companion script and exact commands", () => {
  for (const file of commandFiles()) {
    const bashRules = allowedTools(read(file)).filter((tool) => tool === "Bash" || tool.startsWith("Bash("));
    for (const rule of bashRules) {
      const allowed = rule === COMPANION_RULE || (file === "commands/setup.md" && rule === `Bash(${NPM_INSTALL})`);
      assert.ok(allowed, `${file} pre-approves ${rule}`);
    }
  }
});

test("every node and npm invocation in a command matches its allowed-tools rule", () => {
  for (const file of commandFiles()) {
    const source = read(file);
    const tools = allowedTools(source);
    const invocations = [...source.matchAll(/\bnode "[^\n`]*/g)].map((match) => match[0]);
    for (const invocation of invocations) {
      assert.ok(invocation.startsWith(COMPANION_PREFIX), `${file}: ${invocation}`);
      assert.ok(tools.includes(COMPANION_RULE), `${file} runs the companion without ${COMPANION_RULE}`);
    }
    for (const line of source.split("\n").filter((entry) => /^\s*npm /.test(entry))) {
      assert.equal(line.trim(), NPM_INSTALL, file);
      assert.ok(tools.includes(`Bash(${NPM_INSTALL})`), `${file} runs npm without its exact rule`);
    }
  }
});

test("review commands rely on Claude Code's built-in read-only git approval", () => {
  for (const file of ["commands/review.md", "commands/adversarial-review.md"]) {
    const source = read(file);
    assert.match(source, /git status --short --untracked-files=all/, file);
    assert.ok(!allowedTools(source).some((tool) => tool.startsWith("Bash(git")), file);
  }
});
