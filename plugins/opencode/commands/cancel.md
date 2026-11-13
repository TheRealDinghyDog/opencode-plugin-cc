---
description: Cancel a running OpenCode run started from Claude Code in this repository
argument-hint: '[session-id]'
disable-model-invocation: true
---

Stop an OpenCode run this plugin started.

This command needs Claude Code on a machine where OpenCode is installed. If you have no shell tool here, say so and stop.

Raw slash-command arguments:
$ARGUMENTS

## Rules for every OpenCode call

- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.
- Cancel only what the user asked for. Never delete a session, and never stop a session whose title does not start with `Claude Code task:`, `Claude Code review:` or `Claude Code adversarial review:` unless the user gave its ID.
- Check values before they go on a command line. A session ID has only letters, digits, `_` and `-`. A git ref, model or variant has only letters, digits and `/ . _ - : @ ~ ^`. If a value has anything else, say so and stop.
- If `opencode` is not installed, stop and tell the user to run `/opencode:setup`.

## Find the run

- With a session ID in the arguments, cancel that session.
- Without one, cancel the `opencode run` you started in the background in this conversation that is still running. If more than one is running, ask the user which one. If none is running, say so and stop.
- To learn the session ID of a background task, match its title in:

```bash
opencode session list -n 10
```

- If more than one listed session has that title, ask the user which one before you stop anything. Another Claude Code window on the same repository can have a run with the same title.

## Stop it

1. If the run is a background task of this conversation, stop it with the tool Claude Code gives you for stopping a background task.
2. Find the major version with `opencode --version`.
3. On 2.x the session lives in OpenCode's background service and can outlive the command that started it, so check it:

```bash
opencode api session.get --param sessionID=<session id>
```

   If the answer has a `time.busy` value and no `outcome`, the session is still running. Interrupt it, then check once more:

```bash
opencode api session.interrupt --param sessionID=<session id>
```

4. On 1.x the run ends with the command that started it. A run started outside this conversation cannot be cancelled from here; say so, and that the user can stop it in the terminal or app it runs in.

## Report

Say in one or two lines which session was cancelled and its state now. Mention that the session and whatever files it already changed are kept. For a task, add that `/opencode:rescue --resume` can continue it. A cancelled review is run again with its review command.
