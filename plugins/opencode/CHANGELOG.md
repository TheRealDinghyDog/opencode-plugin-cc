# Changelog

This is the changelog of the directory edition. The full plugin keeps its own in `plugins/opencode-full/CHANGELOG.md`.

## 2.0.0

The plugin directory now accepts only instruction files (Markdown, text, JSON, YAML, images) from community publishers. This release is the plugin rebuilt to that rule.

- **No code in the plugin.** The companion runtime, the hooks and the pre-approved shell access are gone. Each command tells Claude to run your own `opencode` CLI, and Claude Code asks before each run.
- **Works on OpenCode 1.x and 2.x.** The commands use the CLI options both versions share and name the few that differ.
- **Reviews** use OpenCode's read-only `plan` agent, which collects the diff itself. The result is a Markdown report with a verdict, findings by severity and next steps.
- **Tasks** (`/opencode:rescue`) run in the foreground or as a Claude Code background task, and can continue an earlier session, read-only or write-capable.
- **Status, result and cancel** read Claude Code's background tasks and OpenCode's own session list. On 2.x they also ask OpenCode's background service whether a session is running, and can interrupt it.
- **Not in this edition:** the stop-time review gate, `/opencode:transfer`, and the `opencode-rescue` subagent. They need code or hooks. The full plugin still has them; see the repository README.
- If you had the review gate enabled in an earlier version, it no longer runs.
