# Privacy Policy

**Plugin:** opencode (opencode-plugin-cc)
**Last updated:** 2026-11-13

## Summary

This plugin runs entirely on your machine. It collects no data, sends no telemetry, and transmits nothing to the plugin author or any third party of its own. The only place your code or prompts travel is to the AI providers **you** have configured in your own OpenCode installation.

The plugin holds instructions only. It has no code of its own, keeps no state and starts no server. Each run is an ordinary `opencode` command that Claude Code asks you to approve.

## What the plugin does with your data

### Data sent to AI providers

When you run a review or a task, Claude passes your prompt to your **local OpenCode installation**, which reads what it needs from your repository, such as diffs and file contents, and sends it to whichever AI provider and model you configured in OpenCode. That transmission is governed by your agreements with those providers and by [OpenCode's own policies](https://opencode.ai), not by this plugin. The plugin never chooses, adds, or substitutes a provider on its own.

### Data stored locally

The plugin stores nothing. Two other programs keep records of its runs on your machine:

- **OpenCode** keeps the sessions that reviews and tasks create in its normal local session store, where you can inspect or delete them with standard OpenCode tooling (`opencode session list`, `opencode --session <id>`).
- **Claude Code** keeps the output of a background run with its other background tasks, for the life of that Claude Code session.

Nothing is uploaded, synced, or backed up anywhere by this plugin.

### Network activity

The plugin has no network traffic of its own. The `opencode` commands it tells Claude to run talk to your AI providers. On OpenCode 2.x they also talk to OpenCode's own background service on your machine. If you accept `/opencode:setup`'s offer to install OpenCode, npm downloads the `opencode-ai` package.

There is no telemetry, no analytics, no crash reporting, no update phone-home.

### Credentials

The plugin does not read, store, or transmit your AI provider API keys. Provider authentication is handled entirely by your OpenCode installation. `/opencode:setup` runs `opencode auth list`, which shows provider names only.

## Data collection by the author

None. The plugin author receives no data from your use of this plugin — no usage statistics, no error reports, no content of any kind.

## Changes to this policy

Changes are made via pull requests to this repository, so the full history of this document is available in the git log.

## Contact

Questions or concerns: open an issue at
https://github.com/TheRealDinghyDog/opencode-plugin-cc/issues
