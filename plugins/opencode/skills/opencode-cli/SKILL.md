---
name: opencode-cli
description: Internal reference for the opencode command lines this plugin uses on OpenCode 1.x and 2.x
user-invocable: false
---

# OpenCode CLI reference

This plugin has no code of its own. Its commands tell Claude to run the user's `opencode` CLI. This file lists every invocation the plugin uses and where OpenCode 1.x and 2.x differ. Use it when a `/opencode:` command sends you here or when you run OpenCode for the user outside those commands.

## Rules

- Use only the invocations in the table. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop and show the user the exact output and the output of `opencode --version`. Do not try other flags or subcommands: a guess can start a run the user did not ask for.
- Never add `--auto`. Without it, a non-interactive run rejects every permission request OpenCode would otherwise ask about, such as reading `.env` or touching files outside the project.
- Send the prompt on standard input, with a quoted here-document, so the shell expands nothing in it.
- Never print credentials. `opencode auth list` shows names only.

## Invocations

| Purpose | OpenCode 1.x | OpenCode 2.x |
| - | - | - |
| Version | `opencode --version` | same |
| Logins | `opencode auth list` | same |
| Read-only run | `opencode run --agent plan --title "<title>"` | same |
| Write-capable run | `opencode run --agent build --title "<title>"` | same |
| Continue a session | `opencode run --agent build --session <session id>`, or `--agent plan` for read-only | same |
| Choose a model | `--model <provider/model>` | same |
| Choose an effort | `--variant <variant>` | `--model <provider/model>#<variant>` |
| List sessions | `opencode session list -n 10` | same |
| Running sessions | not available | `opencode api session.active` |
| Session details | not available | `opencode api session.get --param sessionID=<session id>` |
| Interrupt a session | stop the command that runs it | `opencode api session.interrupt --param sessionID=<session id>` |
| Export a session | `opencode export <session id>` | `opencode session export <session id>` |

## How a run behaves

- `opencode run` prints progress and then the answer. Progress lines start with a marker: `>` for the agent and model, `$` for a shell command, `→` for a read, `←` for an edit, `✱` for a search, `✗` for a failed step, and an exclamation mark for a permission request that was rejected. The answer is the text after the last of those.
- The run lasts as long as the command. In Claude Code, set the `Bash` timeout to 600000 for a foreground run, and use `run_in_background: true` for anything that may take longer. A command that is stopped interrupts its run.
- On 2.x the session lives in OpenCode's background service. If the command is killed hard, the session can keep running; check it with the session details call and interrupt it.
- On 1.x each run starts its own OpenCode and ends with it.
- The `plan` agent cannot edit files. The `build` agent can edit files inside the project. A session keeps the agent of its last run, so name the agent on every run.
- Sessions this plugin starts have a title that begins with `Claude Code`, which is how the status, result and cancel commands find them.

## PowerShell

Where the shell is PowerShell, replace the here-document with a single-quoted here-string piped to the same command: start it with a line holding an at sign and a single quote, end it with a line holding a single quote and an at sign, then `| opencode run ...`.
