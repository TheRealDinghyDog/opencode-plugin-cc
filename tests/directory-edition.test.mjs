import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  ACCEPTED_FRONTMATTER_KEYS,
  checkCliContract,
  checkDirectoryPolicy,
  extractOpencodeInvocations,
  findInlineShell,
  loadCliContract,
  parseInvocation,
  readFrontmatter
} from "../scripts/check-directory-policy.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDITION = path.join(ROOT, "plugins", "opencode");
const FULL = path.join(ROOT, "plugins", "opencode-full");
const COMMANDS = ["adversarial-review", "cancel", "rescue", "result", "review", "setup", "status"];

function read(relativePath) {
  return fs.readFileSync(path.join(EDITION, relativePath), "utf8");
}

function codes(findings) {
  return [...new Set(findings.map((finding) => finding.code))].sort();
}

// A minimal plugin folder that passes, for the per-rule cases below.
function makePlugin(extraFiles = {}) {
  const root = makeTempDir("opencode-directory-policy-");
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", version: "1.0.0", license: "MIT" }),
    "README.md": `# Sample\n\n${"A sentence of plain words that describes the sample plugin. ".repeat(6)}\n`,
    "commands/hello.md": "---\ndescription: Say hello\n---\n\nSay hello.\n",
    ...extraFiles
  };
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test("the directory edition meets the directory's community-plugin rules", () => {
  assert.deepEqual(checkDirectoryPolicy(EDITION), []);
});

test("the directory edition holds only instruction files", () => {
  const extensions = new Set();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name));
      } else {
        extensions.add(path.extname(entry.name) || entry.name);
      }
    }
  };
  visit(EDITION);
  assert.deepEqual([...extensions].sort(), [".json", ".md", "LICENSE", "NOTICE"]);
  for (const gone of ["scripts", "hooks", "agents", "schemas", "prompts", "bin"]) {
    assert.equal(fs.existsSync(path.join(EDITION, gone)), false, `${gone}/ should not exist`);
  }
});

test("the policy check reports the five findings the portal gave the full plugin", () => {
  // The portal refused v1.1.1 (the full plugin) with exactly these five.
  const found = codes(checkDirectoryPolicy(FULL)).filter((code) => code.startsWith("LOCAL_CODE_"));
  assert.deepEqual(found, [
    "LOCAL_CODE_FILE_TYPE",
    "LOCAL_CODE_FRONTMATTER_KEY",
    "LOCAL_CODE_HOOK_COMMAND",
    "LOCAL_CODE_INLINE_SHELL",
    "LOCAL_CODE_TOOL_GRANT"
  ]);
});

test("a minimal instruction-only plugin passes", () => {
  assert.deepEqual(checkDirectoryPolicy(makePlugin()), []);
});

test("each rule fails on its own", () => {
  const cases = [
    ["a script", { "scripts/run.mjs": "console.log(1);\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["a shebang in a text file", { "notes.txt": "#!/bin/sh\necho hi\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["an extensionless file", { VERSION: "1.0.0\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["an SVG image", { "icon.svg": "<svg/>\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["a NUL byte", { "data.txt": "a\u0000b\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["a package manifest", { "package.json": "{}\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["an MCP configuration", { ".mcp.json": "{}\n" }, "LOCAL_CODE_FILE_TYPE"],
    ["a hooks file", { "hooks/hooks.json": '{"hooks":{}}\n' }, "LOCAL_CODE_HOOK_COMMAND"],
    ["hooks in frontmatter", { "commands/h.md": "---\ndescription: x\nhooks: yes\n---\n" }, "LOCAL_CODE_HOOK_COMMAND"],
    ["inline shell", { "commands/s.md": "---\ndescription: x\n---\n\n!`echo hi`\n" }, "LOCAL_CODE_INLINE_SHELL"],
    ["a fenced inline-shell block", { "commands/f.md": "---\ndescription: x\n---\n\n```!\necho hi\n```\n" }, "LOCAL_CODE_INLINE_SHELL"],
    ["a Bash grant", { "commands/t.md": "---\ndescription: x\nallowed-tools: Read, Bash(git status)\n---\n" }, "LOCAL_CODE_TOOL_GRANT"],
    ["a Read grant with a path", { "commands/p.md": "---\ndescription: x\nallowed-tools: Read(/etc/**)\n---\n" }, "LOCAL_CODE_TOOL_GRANT"],
    ["an unverified key", { "commands/k.md": "---\ndescription: x\ncontext: fork\n---\n" }, "LOCAL_CODE_FRONTMATTER_KEY"],
    ["a list value", { "agents/a.md": "---\nname: a\ndescription: x\nskills:\n  - one\n---\n" }, "LOCAL_CODE_FRONTMATTER_KEY"],
    ["no README", { "README.md": null }, "README_MISSING"],
    ["a short README", { "README.md": "# Sample\n\nToo short.\n" }, "README_TOO_SHORT"]
  ];
  for (const [label, files, expected] of cases) {
    const root = makePlugin(Object.fromEntries(Object.entries(files).filter(([, content]) => content !== null)));
    for (const [relative, content] of Object.entries(files)) {
      if (content === null) {
        fs.rmSync(path.join(root, relative));
      }
    }
    assert.ok(codes(checkDirectoryPolicy(root)).includes(expected), `${label} should raise ${expected}`);
  }
});

test("plain Read, Grep, Glob and LS grants are accepted", () => {
  const root = makePlugin({ "commands/r.md": "---\ndescription: x\nallowed-tools: Read, Grep, Glob, LS\n---\n" });
  assert.deepEqual(checkDirectoryPolicy(root), []);
});

test("inline shell is found in every form the portal names", () => {
  assert.deepEqual(findInlineShell("run !`ls` now"), [1]);
  assert.deepEqual(findInlineShell("text\n```!\nls\n```"), [2]);
  assert.deepEqual(findInlineShell("do !$1 here"), [1]);
  // An exclamation mark in prose, or inside a code span, is not inline shell.
  assert.deepEqual(findInlineShell("Stop! Then run `ls`.\nUse `a != b`."), []);
});

test("frontmatter is read as plain key: value lines", () => {
  assert.equal(readFrontmatter("# No frontmatter\n"), null);
  const parsed = readFrontmatter("---\nname: a\ndescription: b c\n---\nbody\n");
  assert.deepEqual(parsed.keys.map(({ key, value }) => [key, value]), [["name", "a"], ["description", "b c"]]);
  assert.match(readFrontmatter("---\nname: a\n  - x\n---\n").problem, /not a plain/);
  assert.match(readFrontmatter("---\nname: a\n").problem, /no closing/);
});

test("every frontmatter key in the edition was accepted by a portal validation", () => {
  const files = [...COMMANDS.map((name) => `commands/${name}.md`), ...fs.readdirSync(path.join(EDITION, "skills")).map((name) => `skills/${name}/SKILL.md`)];
  for (const file of files) {
    const frontmatter = readFrontmatter(read(file));
    assert.ok(frontmatter, `${file} has frontmatter`);
    assert.equal(frontmatter.problem, null, file);
    const keys = frontmatter.keys.map(({ key }) => key);
    assert.ok(keys.includes("description"), `${file} has a description`);
    for (const key of keys) {
      assert.ok(ACCEPTED_FRONTMATTER_KEYS.has(key), `${file}: ${key}`);
    }
  }
});

test("the edition has exactly the commands it documents", () => {
  const present = fs.readdirSync(path.join(EDITION, "commands")).map((name) => name.replace(/\.md$/, "")).sort();
  assert.deepEqual(present, COMMANDS);
  const readme = read("README.md");
  for (const name of COMMANDS) {
    assert.match(readme, new RegExp(`/opencode:${name}\\b`), `README lists ${name}`);
  }
});

test("commands that only read or cancel cannot be started by the model", () => {
  for (const name of ["review", "adversarial-review", "status", "result", "cancel"]) {
    assert.match(read(`commands/${name}.md`), /^disable-model-invocation: true$/m, name);
  }
  // rescue and setup stay available to the model, as in the full plugin.
  for (const name of ["rescue", "setup"]) {
    assert.doesNotMatch(read(`commands/${name}.md`), /^disable-model-invocation:/m, name);
  }
});

test("review commands are read-only by construction", () => {
  for (const name of ["review", "adversarial-review"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /^disallowed-tools: Edit, Write, NotebookEdit$/m, name);
    const runs = extractOpencodeInvocations(source).filter(({ text }) => text.startsWith("opencode run "));
    assert.ok(runs.length > 0, `${name} runs opencode`);
    for (const { text } of runs) {
      assert.match(text, /^opencode run --agent plan /, `${name}: ${text}`);
    }
  }
});

test("review commands check the working tree before and after the run", () => {
  // The plan agent's edit tools are blocked, but its shell is not (measured on
  // OpenCode 2.2.7), so a review is read-only by instruction only.
  for (const name of ["review", "adversarial-review"]) {
    const source = read(`commands/${name}.md`);
    assert.match(source, /^## Check that nothing changed$/m, name);
    assert.match(source, /read-only by instruction, not by force/, name);
    assert.match(source, /git status --short --untracked-files=all` and of `git diff --shortstat HEAD`/, name);
    assert.ok(source.indexOf("## Check that nothing changed") < source.indexOf("## Present the result"), name);
  }
  assert.match(read("commands/setup.md"), /read-only by instruction, not by force/);
  assert.match(read("README.md"), /read-only by instruction, not by force/);
});

test("every opencode run names its agent first, and never auto-approves", () => {
  for (const name of COMMANDS) {
    const source = read(`commands/${name}.md`);
    for (const { text } of extractOpencodeInvocations(source)) {
      assert.doesNotMatch(text, /--auto\b/, `${name}: ${text}`);
      if (text.startsWith("opencode run ")) {
        // The agent comes first so a user can allow read-only runs alone with
        // Bash(opencode run --agent plan *).
        assert.match(text, /^opencode run --agent (plan|build) /, `${name}: ${text}`);
      }
    }
  }
});

test("every command stops outside Claude Code on the user's own computer", () => {
  // Chat and Cowork load these commands too and have a sandboxed shell, so
  // "no shell tool" is not the right test, and setup must not install there.
  const guard =
    "This command works only in Claude Code running on the user's own computer, where their OpenCode is installed. In claude.ai chat, the Claude apps or Cowork, any shell you have is a sandbox that does not hold the user's OpenCode or their logins: say that this plugin needs Claude Code, and stop. Do not run or install anything there.";
  for (const name of COMMANDS) {
    const source = read(`commands/${name}.md`);
    assert.ok(source.includes(guard), name);
    // The guard comes before the first command line the file tells Claude to run.
    const firstFence = source.indexOf("```bash");
    assert.ok(firstFence === -1 || source.indexOf(guard) < firstFence, `${name}: guard comes first`);
  }
});

test("every command carries the stop rule for an unsupported CLI", () => {
  const rule =
    "- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.";
  for (const name of COMMANDS) {
    assert.ok(read(`commands/${name}.md`).includes(rule), name);
  }
});

test("no command puts the raw arguments inside a code span", () => {
  // An argument that ends in an exclamation mark would sit directly before
  // the closing backtick, which Claude Code can read as the start of inline
  // shell.
  for (const name of COMMANDS) {
    assert.doesNotMatch(read(`commands/${name}.md`), /`[^`\n]*\$ARGUMENTS[^`\n]*`/, name);
  }
});

test("status, result and cancel find the plugin's sessions by their full title prefixes", () => {
  const prefixes = "`Claude Code task:`, `Claude Code review:` or `Claude Code adversarial review:`";
  for (const name of ["status", "result", "cancel"]) {
    assert.ok(read(`commands/${name}.md`).includes(prefixes), name);
  }
  assert.match(read("commands/review.md"), /--title "Claude Code review: /);
  assert.match(read("commands/adversarial-review.md"), /--title "Claude Code adversarial review: /);
  assert.match(read("commands/rescue.md"), /--title "Claude Code task: /);
});

test("rescue never continues a review session and keeps the earlier agent", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /Never continue a session whose title starts with `Claude Code review:`/);
  assert.match(rescue, /keep the agent of the run you are continuing/);
  assert.match(rescue, /Skip a session whose background task in this conversation is still running/);
});

test("every opencode command line in the edition is in the CLI contract", () => {
  assert.deepEqual(checkCliContract(EDITION), []);
});

test("the CLI contract check catches an unlisted command, flag or operation", () => {
  const contract = loadCliContract();
  const root = makePlugin({
    "commands/x.md": [
      "---",
      "description: x",
      "---",
      "",
      "Run `opencode run --agent plan --auto` or `opencode serve`.",
      "",
      "```bash",
      "opencode api session.remove --param sessionID=<id>",
      "```",
      ""
    ].join("\n")
  });
  const messages = checkCliContract(root, contract).map((finding) => finding.message);
  assert.equal(messages.length, 3);
  assert.ok(messages.some((message) => message.includes("--auto")));
  assert.ok(messages.some((message) => message.includes('no contract entry for "opencode serve"')));
  assert.ok(messages.some((message) => message.includes("session.remove")));
});

test("command lines are parsed into a contract command and its flags", () => {
  const contract = loadCliContract();
  assert.deepEqual(parseInvocation(`opencode run --agent plan --title "A b: c" <<'OPENCODE_PROMPT'`, contract), {
    command: "opencode run",
    flags: ["--agent", "--title"],
    operation: null
  });
  assert.deepEqual(parseInvocation("opencode api session.get --param sessionID=<session id>", contract), {
    command: "opencode api",
    flags: ["--param"],
    operation: "session.get"
  });
  assert.deepEqual(parseInvocation("opencode session list -n 10", contract), {
    command: "opencode session list",
    flags: ["-n"],
    operation: null
  });
  assert.equal(parseInvocation("opencode --version", contract).command, "opencode");
});

test("each contract command is used by the edition, so the contract has no dead entries", () => {
  const contract = loadCliContract();
  const used = new Set();
  const usedFlags = new Set();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.endsWith(".md")) {
        for (const { text } of extractOpencodeInvocations(fs.readFileSync(full, "utf8"))) {
          const parsed = parseInvocation(text, contract);
          if (!parsed.problem) {
            used.add(parsed.command);
            parsed.flags.forEach((flag) => usedFlags.add(`${parsed.command} ${flag}`));
            if (parsed.operation) {
              used.add(`opencode api ${parsed.operation}`);
            }
          }
        }
      }
    }
  };
  visit(EDITION);
  for (const [command, entry] of Object.entries(contract.commands)) {
    assert.ok(used.has(command), `${command} is in the contract but not used`);
    for (const flag of Object.keys(entry.flags)) {
      assert.ok(usedFlags.has(`${command} ${flag}`), `${command} ${flag} is in the contract but not used`);
    }
    for (const operation of entry.operations ?? []) {
      assert.ok(used.has(`opencode api ${operation}`), `${operation} is in the contract but not used`);
    }
  }
});

test("both editions carry the same version", () => {
  const edition = JSON.parse(read(".claude-plugin/plugin.json"));
  const full = JSON.parse(fs.readFileSync(path.join(FULL, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(edition.name, "opencode");
  assert.equal(full.name, "opencode");
  assert.equal(edition.version, full.version);
});
