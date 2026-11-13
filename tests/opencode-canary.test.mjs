import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  classifyRun,
  diffCliHelp,
  failingIssueTitle,
  missingApiOperations,
  newMajorIssueTitle,
  parseVersion,
  planIssueActions,
  reportLabel,
  rollupStatus
} from "../scripts/opencode-canary.mjs";

const require = createRequire(import.meta.url);

test("parseVersion reads both the 1.x and the 2.x version line", () => {
  assert.deepEqual(parseVersion("1.19.5\n"), { version: "1.19.5", major: 1 });
  assert.deepEqual(parseVersion("opencode v2.2.7\n"), { version: "2.2.7", major: 2 });
  assert.equal(parseVersion("command not found: opencode"), null);
});

test("classifyRun fails only a command line OpenCode rejects", () => {
  assert.equal(classifyRun({ status: 0, stdout: "PONG\n", stderr: "" }), "answered");
  assert.equal(classifyRun({ status: 1, stdout: "", stderr: "USAGE\n  opencode run [flags]\nERROR\n  Unknown flag" }), "rejected");
  assert.equal(classifyRun({ status: 1, stdout: "", stderr: 'Unexpected positional argument: "x"' }), "rejected");
  assert.equal(classifyRun({ status: 1, stdout: "", stderr: "Error: rate limit exceeded" }), "provider");
  assert.equal(classifyRun({ status: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }), "no-answer");
  assert.equal(classifyRun({ status: 0, stdout: "", stderr: "" }), "no-answer");
});

test("rollupStatus ranks fail over notice over pass", () => {
  assert.equal(rollupStatus([{ status: "pass" }, { status: "notice" }, { status: "fail" }]), "fail");
  assert.equal(rollupStatus([{ status: "pass" }, { status: "notice" }]), "notice");
  assert.equal(rollupStatus([{ status: "pass" }]), "pass");
});

function report(overrides = {}) {
  return {
    channel: "homebrew",
    opencodeVersion: "2.0.20",
    newMajor: null,
    status: "pass",
    checkedAt: "2026-10-05T00:00:00.000Z",
    runUrl: null,
    checks: [{ name: "opencode --version", status: "pass", detail: "2.0.20" }],
    ...overrides
  };
}

test("planIssueActions opens one failing issue per channel, then comments on it", () => {
  const failing = report({ status: "fail" });
  assert.deepEqual(
    planIssueActions(failing, [{ number: 7, title: "Unrelated" }]).map(({ action, title }) => ({ action, title })),
    [{ action: "create", title: failingIssueTitle("homebrew") }]
  );
  const actions = planIssueActions(failing, [{ number: 9, title: failingIssueTitle("homebrew") }]);
  assert.deepEqual(actions.map(({ action, number }) => ({ action, number })), [{ action: "comment", number: 9 }]);
});

test("planIssueActions closes the failing issue once the channel recovers", () => {
  const actions = planIssueActions(report({ status: "notice" }), [{ number: 9, title: failingIssueTitle("homebrew") }]);
  assert.deepEqual(actions.map(({ action, number }) => ({ action, number })), [{ action: "close", number: 9 }]);
  assert.deepEqual(planIssueActions(report(), []), []);
});

test("planIssueActions opens a new-major issue once", () => {
  const newMajor = report({ status: "notice", newMajor: 3, opencodeVersion: "3.0.0" });
  const title = newMajorIssueTitle(3, "homebrew");
  assert.deepEqual(planIssueActions(newMajor, []).map(({ action, title: t }) => ({ action, title: t })), [
    { action: "create", title }
  ]);
  assert.deepEqual(planIssueActions(newMajor, [{ number: 12, title }]), []);
});

test("each OS running a channel gets its own label and issue", () => {
  assert.equal(reportLabel("npm-latest", "linux"), "npm-latest on Linux");
  assert.equal(reportLabel("npm-latest", "win32"), "npm-latest on Windows");
  assert.equal(reportLabel("homebrew", "darwin"), "homebrew on macOS");
  const failing = report({ status: "fail", channel: "npm-latest", label: "npm-latest on Windows" });
  const open = [{ number: 3, title: failingIssueTitle("npm-latest on Linux") }];
  assert.deepEqual(
    planIssueActions(failing, open).map(({ action, title }) => ({ action, title })),
    [{ action: "create", title: "OpenCode canary failing: npm-latest on Windows" }]
  );
});

test("the CLI help diff reports a command or option the plugin needs and the CLI lacks", () => {
  const cli = require("./opencode-cli-contract.json");
  const runHelp = [
    "USAGE",
    "  opencode run [flags] [<message...>]",
    "FLAGS",
    "  --session, -s string      Session ID to continue",
    "  --model, -m string        Model to use",
    "  --agent string            Agent to use",
    "  --title string            Session title"
  ].join("\n");

  // 2.x has no --variant; the contract lists it for 1.x only.
  assert.deepEqual(diffCliHelp("opencode run", cli.commands["opencode run"], 2, runHelp), []);
  assert.deepEqual(diffCliHelp("opencode run", cli.commands["opencode run"], 1, runHelp), ["opencode run: no --variant option"]);
  assert.deepEqual(diffCliHelp("opencode run", cli.commands["opencode run"], 2, runHelp.replace("--agent", "--persona")), [
    "opencode run: no --agent option"
  ]);
  // An unknown subcommand prints the root help, which never names the command.
  assert.deepEqual(
    diffCliHelp("opencode session export", cli.commands["opencode session export"], 2, "USAGE\n  opencode <subcommand> [flags]"),
    ["opencode session export: --help does not describe this command"]
  );
  assert.deepEqual(
    diffCliHelp("opencode session list", cli.commands["opencode session list"], 2, "  opencode session list [flags]\n  --max-count, -n integer"),
    []
  );

  const openapi = {
    paths: {
      "/api/session/active": { get: { operationId: "session.active" } },
      "/api/session/{sessionID}": { get: { operationId: "session.get" } }
    }
  };
  assert.deepEqual(missingApiOperations(cli, openapi), ["session.interrupt"]);
  openapi.paths["/api/session/{sessionID}/interrupt"] = { post: { operationId: "session.interrupt" } };
  assert.deepEqual(missingApiOperations(cli, openapi), []);
});
