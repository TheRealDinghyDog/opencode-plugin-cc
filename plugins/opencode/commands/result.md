---
description: Show the final answer of a finished OpenCode run started from Claude Code in this repository
argument-hint: '[session-id]'
disable-model-invocation: true
---

Show what an OpenCode run this plugin started answered.

This command works only in Claude Code running on the user's own computer, where their OpenCode is installed. In claude.ai chat, the Claude apps or Cowork, any shell you have is a sandbox that does not hold the user's OpenCode or their logins: say that this plugin needs Claude Code, and stop. Do not run or install anything there.

Raw slash-command arguments:
$ARGUMENTS

## Rules for every OpenCode call

- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.
- This command only reads. Do not start, continue, stop or delete anything.
- Check values before they go on a command line. A session ID has only letters, digits, `_` and `-`. A git ref, model or variant has only letters, digits and `/ . _ - : @ ~ ^`. If a value has anything else, say so and stop.
- If `opencode` is not installed, stop and tell the user to run `/opencode:setup`.

## Find the run

- With a session ID in the arguments, use that session.
- Without one, use the most recent `opencode run` you started in this conversation. If there is none, list OpenCode's sessions and take the newest whose title starts with `Claude Code task:`, `Claude Code review:` or `Claude Code adversarial review:`:

```bash
opencode session list -n 10
```

- If nothing matches, say so and stop.

## Get the answer

- If the run is a background task of this conversation and it has finished, read its output with the tool Claude Code gives you for background task output. The answer is the text after the last progress line (a line that starts with `>`, `$`, `→`, `←`, `✱`, `✗`, or an exclamation mark for a permission notice). Lines inside the answer itself, such as a Markdown quote that starts with `>`, belong to the answer.
- If it is still running, say so, show its last few progress lines, and stop.
- Otherwise export the session. Find the major version with `opencode --version`, then run the one that matches, exactly as written, without redirecting its output to a file.

  2.x:

```bash
opencode session export <session id>
```

  1.x:

```bash
opencode export <session id>
```

- The export is JSON with a `messages` list. The answer is the text of the last assistant message: on 2.x a message with `type` `assistant` and its `content` items of type `text`; on 1.x a message whose `info.role` is `assistant` and its `parts` of type `text`. On 2.x the top-level `info.outcome` says how the run ended. On 1.x the export does not record that; say `unknown`.
- The export can be long. If the output was cut off and Claude Code saved it to a file, read the end of that file. If it was cut off and not saved, say so and tell the user they can read the session with `opencode --session <session id>`. Do not run the export a second time, and never print the raw JSON to the user.

## Present

- Return the answer verbatim, with the session ID and how the run ended. Do not paraphrase or summarize it.
- If the run was a review, do not fix anything it mentions. Ask the user which findings, if any, they want fixed.
- If the run was interrupted or failed before it answered, say that and show the last text OpenCode produced, marked as incomplete.
- Mention that the session can be opened in OpenCode itself with `opencode --session <session id>`.
