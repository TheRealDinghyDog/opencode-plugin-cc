---
name: opencode-cli
description: Internal reference for the opencode command lines this plugin uses on OpenCode 1.x and 2.x
user-invocable: false
---

# OpenCode CLI reference

This plugin has no code of its own. Its commands tell Claude to run the user's `opencode` CLI. This file lists every invocation the plugin uses and where OpenCode 1.x and 2.x differ. Use it when a `/opencode:` command sends you here or when you run OpenCode for the user outside those commands.

## Rules

- Run OpenCode only from Claude Code on the user's own computer. In claude.ai chat, the Claude apps or Cowork, a shell is a sandbox without the user's OpenCode or logins: say the plugin needs Claude Code, and stop.
- Use only the invocations in the table. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop and show the user the exact output and the output of `opencode --version`. Do not try other flags or subcommands: a guess can start a run the user did not ask for.
- Never add `--auto`. Without it, a non-interactive run rejects every permission request OpenCode would otherwise ask about, such as reading `.env` or touching files outside the project.
- Send the prompt on standard input, with a quoted here-document, so the shell expands nothing in it.
- Never print credentials. `opencode auth list` shows names only.

## Invocations

| Purpose | OpenCode 1.x | OpenCode 2.x |
| - | - | - |
| Version | `opencode --version` | same |
| Logins | `opencode auth list` | same |
| Log in (the user runs it; it is interactive) | `opencode auth login` | same |
| Read-only run | `opencode run --agent plan --title "<title>"` | same |
| Write-capable run | `opencode run --agent build --title "<title>"` | same |
| Continue a session | `opencode run --agent build --session <session id>`, or `--agent plan` for read-only | same |
| Choose a model | `--model <provider/model>` | same |
| Choose an effort | `--variant <variant>` | `--model "<provider/model>#<variant>"`, quoted because of the `#` |
| List sessions | `opencode session list -n 10` | same |
| Running sessions | not available | `opencode api session.active` |
| Session details | not available | `opencode api session.get --param sessionID=<session id>` |
| Interrupt a session | stop the command that runs it | `opencode api session.interrupt --param sessionID=<session id>` |
| Export a session | `opencode export <session id>` | `opencode session export <session id>` |
| Open a session in OpenCode (the user runs it) | `opencode --session <session id>` | same |

## How a run behaves

- `opencode run` prints progress and then the answer. Progress lines start with a marker: `>` for the agent and model, `$` for a shell command, `→` for a read, `←` for an edit, `✱` for a search, `✗` for a failed step, and an exclamation mark for a permission request that was rejected. The answer is the text after the last of those. Lines inside the answer itself, such as a Markdown quote that starts with `>`, belong to the answer.
- The run lasts as long as the command. In Claude Code, set the `Bash` timeout to 600000 for a foreground run, and use `run_in_background: true` for anything that may take longer. A command that is stopped normally interrupts its run.
- On 2.x the session lives in OpenCode's background service. If the command is killed hard, or runs into a time limit, the session can keep running; check it with the session details call and interrupt it before you send it anything else.
- On 1.x each run starts its own OpenCode and ends with it.
- The `plan` agent has its edit tools denied and is told to change nothing. That is an instruction, not a lock: it can still run shell commands, and in a test on 2.2.7 a prompt that asked it to create a file with a shell command got the file created. Treat a `plan` run as read-only by intent, and check the working tree after a review. The `build` agent can edit files inside the project. A session keeps the agent of its last run, so name the agent on every run.
- Sessions this plugin starts have a title that begins with `Claude Code task:`, `Claude Code review:` or `Claude Code adversarial review:`, which is how the status, result and cancel commands find them. Titles are not unique, so ask before stopping one of two sessions with the same title.

## PowerShell

Where the shell is PowerShell, replace the here-document with a single-quoted here-string piped to the same command: start it with a line holding an at sign and a single quote, end it with a line holding a single quote and an at sign, then `| opencode run ...`. A here-string ends at the first line that starts with a single quote and an at sign, so if a prompt line starts that way, put a space before it.
