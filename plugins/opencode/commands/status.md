---
description: Show running and recent OpenCode runs started from Claude Code in this repository
argument-hint: '[session-id]'
disable-model-invocation: true
---

Show the state of OpenCode runs this plugin started, using Claude Code's own background tasks and OpenCode's own session list.

This command works only in Claude Code running on the user's own computer, where their OpenCode is installed. In claude.ai chat, the Claude apps or Cowork, any shell you have is a sandbox that does not hold the user's OpenCode or their logins: say that this plugin needs Claude Code, and stop. Do not run or install anything there.

Raw slash-command arguments:
$ARGUMENTS

## Rules for every OpenCode call

- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.
- This command only reads. Do not start, continue, stop or delete anything.
- Check values before they go on a command line. A session ID has only letters, digits, `_` and `-`. A git ref, model or variant has only letters, digits and `/ . _ - : @ ~ ^`. If a value has anything else, say so and stop.
- If `opencode` is not installed, stop and tell the user to run `/opencode:setup`.

## Collect

1. Background tasks: for each `opencode run` you started in the background in this conversation, read its current output with the tool Claude Code gives you for background task output. Note whether it is still running and its last few progress lines.
2. OpenCode's sessions for this repository:

```bash
opencode session list -n 10
```

   Keep the sessions whose title starts with `Claude Code task:`, `Claude Code review:` or `Claude Code adversarial review:`. Those were started by this plugin.
3. Find the major version with `opencode --version`. On 2.x only, ask the OpenCode service which sessions are running:

```bash
opencode api session.active
```

   Then get the details of the session the user passed, or, without one, of each kept session that is not running (the five newest at most):

```bash
opencode api session.get --param sessionID=<session id>
```

   In that answer, a `time.busy` value with no `outcome` means the session is running. `outcome` says how the last run ended, for example `interrupted`, and `cost` and `tokens` give its usage.
4. On 1.x there is no service to ask. A run is known to be running, finished or stopped only when it is one of your background tasks from step 1; say `unknown` for the others instead of guessing.

## Present

If the user did not pass a session ID:
- Render one compact Markdown table and no prose outside it: session ID, kind (review, adversarial review or task, from the title), title, state (running, finished, interrupted or unknown), last updated, and follow-up.
- Follow-up is `/opencode:result <session id>` for a finished run and `/opencode:cancel <session id>` for a running one.
- If there are no such sessions, say so in one line.

If the user passed a session ID:
- Show everything collected for that session: state, title, last updated, usage when known, and the last progress lines if it is one of your background tasks.
- Add that the session can be opened in OpenCode itself with `opencode --session <session id>`.
