# Privacy Policy

**Plugin:** opencode (opencode-plugin-cc)
**Last updated:** 2026-07-13

## Summary

This plugin runs entirely on your machine. It collects no data, sends no telemetry, and transmits nothing to the plugin author or any third party of its own. The only place your code or prompts travel is to the AI providers **you** have configured in your own OpenCode installation.

## What the plugin does with your data

### Data sent to AI providers

When you run a review, task, or transfer, the plugin passes your prompt — and, depending on the command, repository content such as diffs, file contents, or conversation transcripts — to your **local OpenCode installation**, which forwards it to whichever AI provider and model you configured in OpenCode. That transmission is governed by your agreements with those providers and by [OpenCode's own policies](https://opencode.ai), not by this plugin. The plugin never chooses, adds, or substitutes a provider on its own.

### Data stored locally

The plugin keeps its working state on your machine only:

- **Job records and logs** (task status, progress, results) in Claude Code's plugin data directory.
- **Server session state** for the plugin-owned `opencode serve` process, including a randomly generated server password, stored with owner-only file permissions (0600).
- **OpenCode sessions** created by reviews, tasks, and transfers live in OpenCode's normal local session store, where you can inspect or delete them with standard OpenCode tooling (`opencode session list`, `opencode --session <id>`).

Nothing is uploaded, synced, or backed up anywhere by this plugin.

### Network activity

The plugin's own network traffic is limited to:

- **localhost only**: an `opencode serve` process it starts on `127.0.0.1`, protected with a per-server random password (HTTP Basic auth), or
- an **external OpenCode server you explicitly configure** via `OPENCODE_COMPANION_SERVER_URL`.

It contacts no other endpoints. There is no telemetry, no analytics, no crash reporting, no update phone-home.

### Credentials

The plugin does not read, store, or transmit your AI provider API keys. Provider authentication is handled entirely by your OpenCode installation. The only credential the plugin manages is the random password it generates to protect its own local server, which never leaves your machine.

## Data collection by the author

None. The plugin author receives no data from your use of this plugin — no usage statistics, no error reports, no content of any kind.

## Changes to this policy

Changes are made via pull requests to this repository, so the full history of this document is available in the git log.

## Contact

Questions or concerns: open an issue at
https://github.com/TheRealDinghyDog/opencode-plugin-cc/issues
