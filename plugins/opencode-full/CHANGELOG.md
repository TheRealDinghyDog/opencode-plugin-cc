# Changelog

## 1.1.1

- The prompting skill is now `opencode-prompting`. It was still named `gpt-5-4-prompting`, after the Codex plugin this one started from.
- The `spark` model alias is gone. It mapped to one OpenAI Codex model. Pass a model in the `provider/model` form that `opencode models` lists, such as `deepseek/deepseek-flash`.
- A `--model` without a provider now fails with a message saying what it needs. Before, it quietly fell back to OpenCode's default model.
- `setup --json` no longer reports the always-empty `authMethod`, `verified` and `requiresOpenaiAuth` fields.
- On OpenCode 1.x, a job whose connection to OpenCode dropped before any text arrived no longer ends on interim narration ("I'll look into it…"). It waits for the final answer.

## 1.1.0

- **OpenCode 2.x support, experimental.** The plugin detects whether your OpenCode is 1.x or 2.x and drives each through its own client; 1.x works as before.
  - All commands work on 2.x.
  - 2.x keeps its own logins, separate from 1.x and the desktop app. Log in with `opencode auth login <provider>`, and `/opencode:setup` lists the stored logins.
  - 2.x reviews read the review's JSON from the reply and ask once more if it's malformed.
  - Questions OpenCode asks mid-task are handed back to Claude.
  - A resumed session switches to the read-only or write mode you ask for.
  - `--effort` needs `--model` as well on 2.x.
  - Tested against a real 2.x server on macOS only.
- **Windows fixes:**
  - The OpenCode server is stopped at session end under Git Bash.
  - Arguments passed through the shell keep their spaces and backslashes. Under Git Bash, Windows paths used to lose them, which broke `/opencode:transfer`.
  - Cancelling one background job no longer kills the server another job uses.
  - The first request after a server start no longer fails on a stale connection.
- **No time limit.** A background job runs until OpenCode finishes, you cancel it, or the Claude session ends. Before, it was reported failed after 30 minutes while OpenCode kept working. If the connection to OpenCode is lost and the job can't be followed any more, the plugin says so, and says when the job may still be running.
- **Reviews on more models.** On OpenCode 1.x, a model that refuses forced tool calls still gets its review, from JSON in its reply. DeepSeek's thinking mode is one such model ("Thinking mode does not support this tool_choice").
- **More reliable jobs:**
  - After a dropped connection to OpenCode, permission requests and questions are still answered, and the final answer is used instead of interim text.
  - A reply to a permission request OpenCode had already dropped no longer fails the job.
  - Concurrent commands no longer lose job updates.

## 1.0.2

- Commands now pre-approve only the plugin's own companion script, instead of any `node`, `git`, or `npm` command. Review commands rely on Claude Code's built-in approval of read-only `git` commands, and `/opencode:setup` pre-approves only `npm install -g opencode-ai`, which it runs after you choose to install.
- With another plugin installed that exports `CLAUDE_PLUGIN_DATA` from its session hook, such as the Codex plugin, OpenCode jobs and settings could land in that plugin's data directory. Jobs then went missing between commands, and `/opencode:setup --enable-review-gate` or `--disable-review-gate` could miss the setting the stop hook reads. The plugin now keeps its own data directory, and it no longer overwrites other plugins' `CLAUDE_PLUGIN_DATA`. A review gate setting or background job saved in the other plugin's directory before this update won't be visible afterwards; re-run `/opencode:setup --enable-review-gate` if you use the gate.

## 1.0.1

- When a model call fails (unsupported model, quota, expired login), commands now report OpenCode's error. Previously the user's own prompt came back as if it were OpenCode's answer, and reviews reported a JSON parse failure.
- OpenCode 2.x is detected and reported as unsupported before any server starts, with instructions for installing the 1.x line. Previously `/opencode:setup` reported "No OpenCode provider is connected", and commands failed with `HTTP 405`.
- The server health check now requires a real OpenCode 1.x health response, so a 2.x server configured through `OPENCODE_COMPANION_SERVER_URL` is rejected with a clear reason.

## 1.0.0

- Initial version of the OpenCode plugin for Claude Code
