import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  diffRoutes,
  diffV1Contract,
  diffV2Requests,
  extractV1Contract,
  failingIssueTitle,
  newMajorIssueTitle,
  planIssueActions,
  reportLabel,
  rollupStatus
} from "../scripts/opencode-canary.mjs";

const require = createRequire(import.meta.url);

const pinned = {
  events: {
    "session.idle": {
      required: ["id", "type", "properties"],
      properties: { required: ["sessionID"], keys: ["sessionID"] }
    }
  },
  objects: {
    TextPart: { required: ["id", "text"], keys: ["id", "text", "synthetic"] }
  }
};

function openapiDoc({ eventProperties, textPart, paths = {} } = {}) {
  return {
    paths,
    components: {
      schemas: {
        Event: { anyOf: [{ $ref: "#/components/schemas/EventSessionIdle" }] },
        EventSessionIdle: {
          type: "object",
          required: ["id", "type", "properties"],
          properties: {
            id: { type: "string" },
            type: { type: "string", const: "session.idle" },
            properties: eventProperties ?? {
              type: "object",
              required: ["sessionID"],
              properties: { sessionID: { type: "string" } }
            }
          }
        },
        TextPart: textPart ?? {
          type: "object",
          required: ["id", "text"],
          properties: { id: {}, text: {}, synthetic: {} }
        }
      }
    }
  };
}

test("extractV1Contract rebuilds the pinned shapes from an OpenAPI document", () => {
  assert.deepEqual(extractV1Contract(openapiDoc(), pinned), {
    events: pinned.events,
    objects: pinned.objects
  });
});

test("the committed 1.x contract pins events, objects and routes", () => {
  const contract = require("./opencode-event-contract.json");
  assert.ok(Object.keys(contract.events).length > 0);
  assert.ok(Object.keys(contract.objects).length > 0);
  assert.ok(contract.routes.some((route) => route.path === "/global/health"));
});

test("diffV1Contract treats removed or no-longer-required keys as breaking", () => {
  const live = extractV1Contract(
    openapiDoc({
      textPart: { type: "object", required: ["id"], properties: { id: {}, text: {} } }
    }),
    pinned
  );
  const findings = diffV1Contract(pinned, live);
  assert.deepEqual(findings.breaking.sort(), [
    'object TextPart: "synthetic" was removed',
    'object TextPart: "text" is no longer required'
  ]);
});

test("diffV1Contract treats new keys as additive, not breaking", () => {
  const live = extractV1Contract(
    openapiDoc({
      eventProperties: {
        type: "object",
        required: ["sessionID", "reason"],
        properties: { sessionID: {}, reason: {} }
      }
    }),
    pinned
  );
  const findings = diffV1Contract(pinned, live);
  assert.deepEqual(findings.breaking, []);
  assert.deepEqual(findings.additive, ['event session.idle properties: new key "reason"']);
});

test("diffV1Contract reports a vanished event as breaking", () => {
  const doc = openapiDoc();
  doc.components.schemas.Event.anyOf = [];
  const findings = diffV1Contract(pinned, extractV1Contract(doc, pinned));
  assert.deepEqual(findings.breaking, ["event session.idle no longer exists"]);
});

test("diffRoutes ignores path parameter names but catches missing routes", () => {
  const doc = { paths: { "/session/{id}": { delete: {} }, "/event": { get: {} } } };
  const routes = [
    { method: "DELETE", path: "/session/{sessionID}" },
    { method: "GET", path: "/event" },
    { method: "POST", path: "/session/{sessionID}/abort" }
  ];
  assert.deepEqual(diffRoutes(routes, doc).breaking, ["route POST /session/{sessionID}/abort is missing"]);
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

test("diffV2Requests catches dropped fields and newly required ones", () => {
  const doc = {
    paths: {
      "/api/session/{id}/prompt": {
        post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Prompt" } } } } }
      }
    },
    components: {
      schemas: { Prompt: { type: "object", required: ["parts"], properties: { parts: {}, metadata: {} } } }
    }
  };
  const findings = diffV2Requests({ "POST /api/session/{sessionID}/prompt": { sends: ["text"] } }, doc);
  assert.deepEqual(findings.breaking, [
    'POST /api/session/{sessionID}/prompt: "text" is no longer accepted',
    'POST /api/session/{sessionID}/prompt: "parts" is now required'
  ]);
  assert.deepEqual(diffV2Requests({ "POST /api/missing": { sends: [] } }, doc).breaking, [
    "POST /api/missing: no JSON request body"
  ]);
});
