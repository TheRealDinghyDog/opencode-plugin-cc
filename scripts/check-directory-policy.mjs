#!/usr/bin/env node
// Replays the plugin directory's rules for community publishers on a plugin
// folder, so a release is not refused for a rule we already know (issue #110).
//
// The directory accepts local code only from "Verified organizations". From
// everyone else a plugin folder may hold Markdown, text, JSON, YAML and images,
// and nothing that runs on the user's computer without Claude Code asking. The
// rules below are the portal's own findings for v1.1.1 (LOCAL_CODE_*), plus
// the pre-submission checklist items that block or hold a version.
//
// The directory runs more checks than this, and it changes them without
// notice: a pass here is necessary, not sufficient.
//
// Usage: node scripts/check-directory-policy.mjs [plugin-folder]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIRECTORY_PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const IMAGE_SIGNATURES = {
  ".png": [[0x89, 0x50, 0x4e, 0x47]],
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".gif": [[0x47, 0x49, 0x46, 0x38]],
  ".webp": [[0x52, 0x49, 0x46, 0x46]],
  ".ico": [[0x00, 0x00, 0x01, 0x00]]
};
// Files the rule names as allowed without one of the extensions above.
// NOTICE is not named by the rule; a portal validation on 2026-11-13 accepted
// it. Another project had an extensionless VERSION file refused, so nothing
// else is assumed.
const EXTENSIONLESS_TEXT = /^(LICENSE|LICENCE|NOTICE|README)([.-][A-Za-z0-9.-]+)?$|^\.gitignore$/;
const PACKAGE_MANAGER_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "bun.lock",
  "bun.lockb",
  "uv.toml",
  "uv.lock",
  "pyproject.toml",
  "requirements.txt"
]);
const RUNTIME_CONFIG_FILES = new Set(["hooks.json", ".mcp.json", ".lsp.json", "monitors.json"]);
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_FILES = 512;
const README_MIN_WORDS = 40;

// Frontmatter keys a portal validation accepted from this organization on
// 2026-11-13 (issue #109). The directory doesn't publish its list, so a key
// that is not here is unverified, not known-bad: validate it in the portal
// before adding it. `skills` (an agent's preload list) is known to be refused.
export const ACCEPTED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "argument-hint",
  "when_to_use",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "disallowed-tools",
  "model",
  "tools",
  "license",
  "compatibility"
]);
const PLAIN_TOOL_GRANTS = new Set(["Read", "Grep", "Glob", "LS"]);

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else {
      out.push({ full, relative: path.relative(base, full).split(path.sep).join("/"), entry });
    }
  }
  return out;
}

function isUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

// Returns { keys: [{ key, value, line }], problem } for a Markdown file's
// frontmatter, or null when the file has none.
export function readFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return { keys: [], problem: "frontmatter has no closing --- line" };
  }
  const keys = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line);
    if (!match) {
      return { keys, problem: `line ${index + 1} is not a plain "key: value" line: ${line}` };
    }
    keys.push({ key: match[1], value: (match[2] ?? "").trim(), line: index + 1 });
  }
  return { keys, problem: null };
}

function unquote(value) {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

// Splits an allowed-tools value on commas and spaces, keeping a rule such as
// Bash(node "x" *) in one piece.
function splitToolList(value) {
  const tools = [];
  let current = "";
  let depth = 0;
  for (const char of unquote(value)) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && (char === "," || /\s/.test(char))) {
      if (current) {
        tools.push(current);
      }
      current = "";
    } else {
      current += char;
    }
  }
  if (current) {
    tools.push(current);
  }
  return tools;
}

// The body with fenced code blocks removed, for counting README words.
function proseWords(source) {
  const withoutFences = source.replace(/^```[\s\S]*?^```\s*$/gm, " ");
  return withoutFences.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

export function findInlineShell(source) {
  const hits = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (/!`[^`]*`/.test(line) || /^\s*```!/.test(line) || /!\$(\d|ARGUMENTS|\{)/.test(line)) {
      hits.push(index + 1);
    }
  });
  return hits;
}

export function checkDirectoryPolicy(pluginRoot = DIRECTORY_PLUGIN_ROOT) {
  const findings = [];
  const add = (code, file, message) => findings.push({ code, file, message });

  if (!fs.existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"))) {
    add("MANIFEST_MISSING", ".claude-plugin/plugin.json", "the folder has no .claude-plugin/plugin.json");
    return findings;
  }

  const files = walk(pluginRoot);
  if (files.length > MAX_FILES) {
    add("FILES_NOT_INSPECTED", ".", `${files.length} files; the directory holds a plugin with more than ${MAX_FILES}`);
  }

  for (const { full, relative, entry } of files) {
    const name = path.basename(relative);
    const extension = path.extname(name).toLowerCase();
    const segments = relative.split("/");

    if (entry.isSymbolicLink()) {
      add("LOCAL_CODE_FILE_TYPE", relative, "symbolic link; commit a regular file");
      continue;
    }
    if (SYSTEM_FILES.has(name) || segments.includes("__MACOSX")) {
      add("SYSTEM_FILE", relative, "macOS or Windows system file");
      continue;
    }
    if (/[:\\]/.test(relative)) {
      add("LOCAL_CODE_FILE_TYPE", relative, "the path has a character that not every computer keeps (: or \\)");
    }
    if (PACKAGE_MANAGER_FILES.has(name)) {
      add("LOCAL_CODE_FILE_TYPE", relative, "package manager configuration");
      continue;
    }
    if (RUNTIME_CONFIG_FILES.has(name)) {
      // hooks.json is reported by the hook rule below.
      if (name !== "hooks.json") {
        add("LOCAL_CODE_FILE_TYPE", relative, "configuration that makes Claude Code start a program");
      }
      continue;
    }
    if (segments.includes(".claude") || (segments.includes(".claude-plugin") && segments[0] !== ".claude-plugin")) {
      add("LOCAL_CODE_FILE_TYPE", relative, "a .claude folder, or a .claude-plugin folder that is not the plugin's own");
      continue;
    }
    if (segments[0] === ".claude-plugin" && name !== "plugin.json" && !(extension in IMAGE_SIGNATURES)) {
      add("LOCAL_CODE_FILE_TYPE", relative, ".claude-plugin may hold only plugin.json and an icon");
      continue;
    }

    const buffer = fs.readFileSync(full);
    if (extension in IMAGE_SIGNATURES) {
      if (!IMAGE_SIGNATURES[extension].some((signature) => startsWith(buffer, signature))) {
        add("LOCAL_CODE_FILE_TYPE", relative, `content is not a ${extension} image`);
      }
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extension) && !EXTENSIONLESS_TEXT.test(name)) {
      add(
        "LOCAL_CODE_FILE_TYPE",
        relative,
        "not Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image"
      );
      continue;
    }
    if (buffer.length > MAX_TEXT_BYTES) {
      add("FILES_NOT_INSPECTED", relative, `${buffer.length} bytes; the directory holds files over 256 KiB`);
    }
    if (buffer.includes(0)) {
      add("LOCAL_CODE_FILE_TYPE", relative, "holds a NUL byte");
      continue;
    }
    if (!isUtf8(buffer)) {
      add("LOCAL_CODE_FILE_TYPE", relative, "not valid UTF-8");
      continue;
    }
    const source = buffer.toString("utf8");
    if (source.startsWith("#!")) {
      add("LOCAL_CODE_FILE_TYPE", relative, "starts with #!");
    }
    if (extension === ".json") {
      try {
        JSON.parse(source);
      } catch (error) {
        add("JSON_INVALID", relative, error.message);
      }
    }

    if (extension !== ".md") {
      continue;
    }
    for (const line of findInlineShell(source)) {
      add(
        "LOCAL_CODE_INLINE_SHELL",
        `${relative}:${line}`,
        "inline shell (an exclamation mark before a backtick span, a fenced block marked with one, or one an argument could finish)"
      );
    }
    const frontmatter = readFrontmatter(source);
    if (!frontmatter) {
      continue;
    }
    if (frontmatter.problem) {
      add("LOCAL_CODE_FRONTMATTER_KEY", relative, frontmatter.problem);
    }
    for (const { key, value, line } of frontmatter.keys) {
      if (key === "hooks") {
        add("LOCAL_CODE_HOOK_COMMAND", `${relative}:${line}`, "frontmatter declares hooks");
        continue;
      }
      if (!ACCEPTED_FRONTMATTER_KEYS.has(key)) {
        add(
          "LOCAL_CODE_FRONTMATTER_KEY",
          `${relative}:${line}`,
          `frontmatter key "${key}" has not been accepted by a portal validation`
        );
        continue;
      }
      if (value === "" || /^[[{|>]/.test(value)) {
        add("LOCAL_CODE_FRONTMATTER_KEY", `${relative}:${line}`, `"${key}" needs a single-line text value`);
      }
      if (key === "allowed-tools" || key === "allowedTools") {
        for (const tool of splitToolList(value)) {
          if (!PLAIN_TOOL_GRANTS.has(tool)) {
            add(
              "LOCAL_CODE_TOOL_GRANT",
              `${relative}:${line}`,
              `allowed-tools pre-approves ${tool}; only plain Read, Grep, Glob and LS are accepted`
            );
          }
        }
      }
    }
  }

  // Hooks of every type are refused.
  if (fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json"))) {
    add("LOCAL_CODE_HOOK_COMMAND", "hooks/hooks.json", "the plugin declares hooks");
  }
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  } catch {
    // Reported as JSON_INVALID above.
  }
  for (const key of ["hooks", "mcpServers", "lspServers", "monitors", "settings", "bin"]) {
    if (key in manifest) {
      add(
        key === "hooks" ? "LOCAL_CODE_HOOK_COMMAND" : "LOCAL_CODE_FILE_TYPE",
        ".claude-plugin/plugin.json",
        `plugin.json declares "${key}", which starts a program on the user's computer`
      );
    }
  }
  if (fs.existsSync(path.join(pluginRoot, "bin"))) {
    add("LOCAL_CODE_FILE_TYPE", "bin/", "a bin folder puts programs on the user's PATH");
  }

  // Pre-submission checklist: these block a submission.
  const readme = files.find(({ relative }) => /^readme(\.md|\.txt)?$/i.test(relative));
  if (!readme) {
    add("README_MISSING", "README.md", "the plugin folder has no README; it is the listing's description");
  } else if (proseWords(fs.readFileSync(readme.full, "utf8")) < README_MIN_WORDS) {
    add("README_TOO_SHORT", readme.relative, `fewer than ${README_MIN_WORDS} words outside code blocks`);
  }
  if (!manifest.license && !files.some(({ relative }) => /^licen[sc]e(\.md|\.txt)?$/i.test(relative))) {
    add("LICENSE_MISSING", "LICENSE", "no LICENSE file and no license in plugin.json");
  }

  return findings;
}

// --- The CLI contract (tests/opencode-cli-contract.json) --------------------

export function loadCliContract() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "opencode-cli-contract.json"), "utf8"));
}

// Every `opencode ...` command line in a Markdown source: a line of a fenced
// code block, or an inline code span, that starts with the word opencode.
export function extractOpencodeInvocations(source) {
  const invocations = [];
  let inFence = false;
  source.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      if (/^\s*opencode(\s|$)/.test(line)) {
        invocations.push({ line: index + 1, text: line.trim() });
      }
      return;
    }
    for (const match of line.matchAll(/`(opencode(?:\s[^`]*)?)`/g)) {
      invocations.push({ line: index + 1, text: match[1].trim() });
    }
  });
  return invocations;
}

// Splits a command line into the contract command it uses and its flags.
// Returns { command, flags, operation } or { problem }.
export function parseInvocation(text, contract) {
  const withoutHeredoc = text.replace(/<<.*$/, "").replace(/\s\|.*$/, "");
  const tokens = withoutHeredoc.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const names = Object.keys(contract.commands).sort((a, b) => b.split(" ").length - a.split(" ").length);
  const words = [];
  for (const token of tokens) {
    if (/^-/.test(token) || /^["'<]/.test(token)) {
      break;
    }
    words.push(token);
  }
  const command = names.find((name) => {
    const parts = name.split(" ");
    return parts.every((part, index) => words[index] === part);
  });
  if (!command) {
    return { problem: `no contract entry for "${words.join(" ")}"` };
  }
  const flags = tokens
    .filter((token) => /^--?[A-Za-z]/.test(token))
    .map((token) => token.split("=")[0]);
  const rest = words.slice(command.split(" ").length);
  if (command === "opencode api") {
    return { command, flags, operation: rest[0] ?? null };
  }
  if (rest.length > 0) {
    // A bare word after the longest matching command is a subcommand the
    // contract does not list, such as `opencode serve`.
    return { problem: `no contract entry for "${words.join(" ")}"` };
  }
  return { command, flags, operation: null };
}

export function checkCliContract(pluginRoot = DIRECTORY_PLUGIN_ROOT, contract = loadCliContract()) {
  const findings = [];
  for (const { full, relative } of walk(pluginRoot)) {
    if (path.extname(relative).toLowerCase() !== ".md") {
      continue;
    }
    for (const { line, text } of extractOpencodeInvocations(fs.readFileSync(full, "utf8"))) {
      const parsed = parseInvocation(text, contract);
      const where = `${relative}:${line}`;
      if (parsed.problem) {
        findings.push({ code: "CLI_NOT_IN_CONTRACT", file: where, message: `${parsed.problem}: ${text}` });
        continue;
      }
      const entry = contract.commands[parsed.command];
      for (const flag of parsed.flags) {
        if (!(flag in entry.flags)) {
          findings.push({
            code: "CLI_NOT_IN_CONTRACT",
            file: where,
            message: `${parsed.command} is used with ${flag}, which the contract does not list: ${text}`
          });
        }
      }
      if (parsed.operation && !/^</.test(parsed.operation) && !entry.operations.includes(parsed.operation)) {
        findings.push({
          code: "CLI_NOT_IN_CONTRACT",
          file: where,
          message: `opencode api operation ${parsed.operation} is not in the contract: ${text}`
        });
      }
    }
  }
  return findings;
}

function main() {
  const pluginRoot = path.resolve(process.argv[2] ?? DIRECTORY_PLUGIN_ROOT);
  const findings = [...checkDirectoryPolicy(pluginRoot), ...checkCliContract(pluginRoot)];
  const label = path.relative(process.cwd(), pluginRoot) || ".";
  if (findings.length === 0) {
    process.stdout.write(`${label}: no directory-policy or CLI-contract finding.\n`);
    return;
  }
  for (const { code, file, message } of findings) {
    process.stdout.write(`${code}  ${file}  ${message}\n`);
  }
  process.stdout.write(`\n${label}: ${findings.length} finding${findings.length === 1 ? "" : "s"}.\n`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
