---
description: Transfer the current Claude Code session into a resumable OpenCode thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the OpenCode session ID and the `opencode --session <session-id>` command.
