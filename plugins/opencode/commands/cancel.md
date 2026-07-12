---
description: Cancel an active background OpenCode job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cancel "$ARGUMENTS"`
