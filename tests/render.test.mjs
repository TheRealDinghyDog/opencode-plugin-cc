import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/opencode/scripts/lib/render.mjs";

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
