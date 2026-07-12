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
