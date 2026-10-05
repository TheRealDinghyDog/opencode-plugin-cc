import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderTaskResult } from "../plugins/opencode/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /OpenCode returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "OpenCode Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# OpenCode Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# OpenCode Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /OpenCode session ID: thr_123/);
  assert.match(output, /Resume in OpenCode: opencode --session thr_123/);
});

test("renderTaskResult surfaces the error of a failed turn", () => {
  assert.equal(
    renderTaskResult({ rawOutput: "", failureMessage: "Bad Request: model unsupported", failed: true }, {}),
    "OpenCode error: Bad Request: model unsupported\n"
  );
  assert.equal(
    renderTaskResult({ rawOutput: "Partial answer.\n", failureMessage: "Rate limited", failed: true }, {}),
    "Partial answer.\n\nOpenCode error: Rate limited\n"
  );
  assert.equal(renderTaskResult({ rawOutput: "Done.", failureMessage: "", failed: false }, {}), "Done.\n");
});

test("renderReviewResult reports a failed review turn as an error, not a parse failure", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "Bad Request", rawOutput: "", status: 1, failureMessage: "Bad Request" },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /OpenCode failed before returning a review\./);
  assert.match(output, /- Error: Bad Request/);
  assert.doesNotMatch(output, /did not return valid structured JSON/);
});

test("renderStoredJobResult shows a failed task's error instead of its partial output alone", () => {
  const output = renderStoredJobResult(
    { id: "task-1", status: "failed", title: "OpenCode Task", jobClass: "task", threadId: "ses_1" },
    {
      threadId: "ses_1",
      rendered: "Partial answer.\n\nOpenCode error: Rate limited\n",
      result: { status: 1, threadId: "ses_1", rawOutput: "Partial answer." }
    }
  );
  assert.match(output, /OpenCode error: Rate limited/);
  assert.match(output, /Resume in OpenCode: opencode --session ses_1/);
});
