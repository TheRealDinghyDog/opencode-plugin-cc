---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the OpenCode rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--effort <variant>] [what OpenCode should investigate, solve, or continue]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" *), AskUserQuestion, Agent
---

Invoke the `opencode:opencode-rescue` subagent via the `Agent` tool (`subagent_type: "opencode:opencode-rescue"`), forwarding the raw user request as the prompt.
`opencode:opencode-rescue` is a subagent, not a skill. Do not call `Skill(opencode:opencode-rescue)` or `Skill(opencode:rescue)`. The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be OpenCode's output verbatim, except when OpenCode stopped to ask a question (below).

If OpenCode's output says it stopped to ask a question (OpenCode 2.x can't continue past one in a headless run):
- When the conversation already makes the answer clear (the user stated it, or one option is plainly what they asked for), invoke `opencode:opencode-rescue` again with `--resume` and that answer as the prompt. Tell the user which answer you gave OpenCode and why.
- Otherwise ask the user with `AskUserQuestion`, offering OpenCode's options, then invoke `opencode:opencode-rescue` again with `--resume` and their answer.
- Never answer on the user's behalf when the answer changes scope or risk: deleting data, picking between incompatible designs, credentials, or anything they haven't indicated. Ask instead.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `opencode:opencode-rescue` subagent in the background.
- If the request includes `--wait`, run the `opencode:opencode-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting OpenCode, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current OpenCode thread or start a new one.
- The two choices must be:
  - `Continue current OpenCode thread`
  - `Start a new OpenCode thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode thread (Recommended)` first.
- Otherwise put `Start a new OpenCode thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...` and return that command's stdout as-is.
- Return the OpenCode companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
- If the user did not supply a request, ask what OpenCode should investigate or fix.
