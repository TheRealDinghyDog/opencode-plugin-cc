# Changelog

## 1.0.2

- Commands now pre-approve only the plugin's own companion script, instead of any `node`, `git`, or `npm` command. Review commands rely on Claude Code's built-in approval of read-only `git` commands, and `/opencode:setup` pre-approves only `npm install -g opencode-ai`, which it runs after you choose to install.
- With another plugin installed that exports `CLAUDE_PLUGIN_DATA` from its session hook, such as the Codex plugin, OpenCode jobs and settings could land in that plugin's data directory. Jobs then went missing between commands, and `/opencode:setup --enable-review-gate` or `--disable-review-gate` could miss the setting the stop hook reads. The plugin now keeps its own data directory, and it no longer overwrites other plugins' `CLAUDE_PLUGIN_DATA`. A review gate setting or background job saved in the other plugin's directory before this update won't be visible afterwards; re-run `/opencode:setup --enable-review-gate` if you use the gate.

## 1.0.1

- When a model call fails (unsupported model, quota, expired login), commands now report OpenCode's error. Previously the user's own prompt came back as if it were OpenCode's answer, and reviews reported a JSON parse failure.
- OpenCode 2.x is detected and reported as unsupported before any server starts, with instructions for installing the 1.x line. Previously `/opencode:setup` reported "No OpenCode provider is connected", and commands failed with `HTTP 405`.
- The server health check now requires a real OpenCode 1.x health response, so a 2.x server configured through `OPENCODE_COMPANION_SERVER_URL` is rejected with a clear reason.

## 1.0.0

- Initial version of the OpenCode plugin for Claude Code
