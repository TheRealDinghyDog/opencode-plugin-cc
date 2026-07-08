import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildOpenCodeImportDocumentFromClaudeJsonl } from "../plugins/opencode/scripts/lib/claude-session-transfer.mjs";
import { buildEnv, installFakeOpencode, readFakeState } from "./fake-opencode-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");

function sequentialIds() {
  let next = 0;
  return (prefix) => `${prefix}_${++next}`;
}

function sampleClaudeJsonl() {
  return [
    JSON.stringify({ type: "metadata", message: { id: "ignored" } }),
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Investigate the failure" }
    }),
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "The bug is in parser." },
          { type: "tool_use", name: "Read", input: { file_path: "parser.js" } }
        ]
      }
    }),
    JSON.stringify({
      message: {
        role: "user",
        content: [
          { type: "text", text: "Please fix" },
          { type: "image", source: {} },
          { type: "text", text: "and test" }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2025-12-31T23:59:59.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Fixed and tested." }] }
    })
  ].join("\n");
}

test("Claude JSONL converts to a well-formed OpenCode import document", () => {
  const doc = buildOpenCodeImportDocumentFromClaudeJsonl(sampleClaudeJsonl(), {
    cwd: "/tmp/project",
    version: "1.17.10-test",
    idFactory: sequentialIds(),
    fallbackTime: 1000
  });

  assert.equal(doc.info.id, "ses_1");
  assert.equal(doc.info.projectID, "global");
  assert.equal(doc.info.directory, "/tmp/project");
  assert.equal(doc.info.title, "Investigate the failure");
  assert.equal(doc.info.slug, "investigate-the-failure");
  assert.equal(doc.info.agent, "build");
  assert.deepEqual(doc.info.model, {
    id: "gpt-5.4-mini",
    providerID: "openai",
    variant: "default"
  });
  assert.equal(doc.info.version, "1.17.10-test");

  assert.deepEqual(doc.messages.map((message) => message.info.role), [
    "user",
    "assistant",
    "user",
    "assistant"
  ]);
  assert.deepEqual(doc.messages.map((message) => message.parts[0].text), [
    "Investigate the failure",
    "The bug is in parser.",
    "Please fix\nand test",
    "Fixed and tested."
  ]);

  const times = doc.messages.map((message) => message.info.time.created);
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
  assert.equal(doc.info.time.created, times[0]);
  assert.equal(doc.info.time.updated, times[times.length - 1]);

  assert.equal(doc.messages[1].info.parentID, doc.messages[0].info.id);
  assert.equal(doc.messages[3].info.parentID, doc.messages[2].info.id);
  for (const message of doc.messages) {
    assert.equal(message.info.sessionID, doc.info.id);
    assert.equal(message.parts.length, 1);
    assert.equal(message.parts[0].sessionID, doc.info.id);
    assert.equal(message.parts[0].messageID, message.info.id);
  }
});

test("converter drops assistant turns before the first user message (no null parentID)", () => {
  const jsonl = [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "orphan leading reply" }] } }),
    JSON.stringify({ message: { role: "user", content: "first user turn" } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "grounded reply" }] } })
  ].join("\n");

  const doc = buildOpenCodeImportDocumentFromClaudeJsonl(jsonl, {
    cwd: "/tmp/project",
    version: "t",
    idFactory: sequentialIds(),
    fallbackTime: 1000
  });

  // The leading assistant is dropped (opencode import rejects a null parentID).
  assert.deepEqual(doc.messages.map((message) => message.info.role), ["user", "assistant"]);
  assert.equal(doc.info.title, "first user turn");
  for (const message of doc.messages) {
    if (message.info.role === "assistant") {
      assert.equal(typeof message.info.parentID, "string");
      assert.ok(message.info.parentID.length > 0);
    }
  }
});

test("transfer imports a Claude transcript and prints an OpenCode resume command", () => {
  const repo = makeTempDir();
  const home = makeTempDir("opencode-plugin-home-");
  const binDir = makeTempDir();
  installFakeOpencode(binDir);

  const claudeProjects = path.join(home, ".claude", "projects", "-tmp-project");
  fs.mkdirSync(claudeProjects, { recursive: true });
  const transcriptPath = path.join(claudeProjects, "session-123.jsonl");
  fs.writeFileSync(transcriptPath, sampleClaudeJsonl(), "utf8");

  const env = buildEnv(binDir, {
    HOME: home,
    OPENCODE_COMPANION_TRANSCRIPT_PATH: transcriptPath
  });
  const result = run("node", [SCRIPT, "transfer"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/OpenCode session ID: (ses_[A-Za-z0-9]+)/);
  assert.ok(match, result.stdout);
  const importedSessionID = match[1];
  assert.match(result.stdout, new RegExp(`Resume in OpenCode: opencode --session ${importedSessionID}`));

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.imports.length, 1);
  assert.equal(fakeState.lastImport.sessionID, importedSessionID);
  assert.equal(fakeState.lastImport.document.info.directory, fs.realpathSync(repo));
  assert.equal(fakeState.lastImport.document.info.version, "1.17.10-test");
  assert.deepEqual(fakeState.lastImport.document.messages.map((message) => message.info.role), [
    "user",
    "assistant",
    "user",
    "assistant"
  ]);
});
