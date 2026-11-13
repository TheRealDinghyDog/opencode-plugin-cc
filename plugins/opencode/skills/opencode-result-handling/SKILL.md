---
name: opencode-result-handling
description: Internal guidance for presenting OpenCode output back to the user
user-invocable: false
---

# OpenCode Result Handling

When an `opencode run` returns:
- The answer is the text after the last progress line. Return it verbatim, and keep its verdict, summary, findings and next-steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as OpenCode reports them.
- Preserve evidence boundaries. If OpenCode marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If OpenCode made edits, say so explicitly and list the files its edit lines name.
- Do not turn a failed or incomplete OpenCode run into your own attempt at the task. Report the failure and stop.
- If OpenCode was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the run failed, include the most actionable error lines and stop there instead of guessing.
- If OpenCode is missing or not logged in, direct the user to `/opencode:setup` and do not improvise another login flow.
- If a command fails with an unknown option, or prints OpenCode's help text instead of doing what was asked, show the output and the OpenCode version and stop. Do not try other flags.
- If OpenCode's answer is a question, answer it when the conversation makes the answer clear: continue the session with `/opencode:rescue --resume <answer>` and tell the user what you answered. Otherwise ask the user and continue with their answer. Never answer on the user's behalf when the answer changes scope or risk.
