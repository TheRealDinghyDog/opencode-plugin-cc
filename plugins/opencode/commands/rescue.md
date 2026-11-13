---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to OpenCode
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--effort <variant>] [what OpenCode should investigate, solve, or continue]'
---

Hand a task to OpenCode by calling the user's own `opencode` CLI, and return what it says.

Use this when the user asks for OpenCode, or when you are stuck and want a second implementation or diagnosis pass on a substantial task. Do not use it for a small ask you can finish quickly yourself.

This command works only in Claude Code running on the user's own computer, where their OpenCode is installed. In claude.ai chat, the Claude apps or Cowork, any shell you have is a sandbox that does not hold the user's OpenCode or their logins: say that this plugin needs Claude Code, and stop. Do not run or install anything there.

Raw user request:
$ARGUMENTS

If the user did not supply a request, ask what OpenCode should investigate or fix.

## Rules for every OpenCode call

- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.
- Never add `--auto`. In these non-interactive runs OpenCode rejects any permission request it would otherwise ask about, and that is intended.
- Pass the prompt on standard input with a quoted here-document, exactly as shown, so the shell expands nothing in it. If the prompt contains a line that reads `OPENCODE_PROMPT`, use another delimiter. In PowerShell, pipe a single-quoted here-string to the same command instead.
- A title is plain words: letters, digits, spaces, `-`, `.` and `:` only.
- Check values before they go on a command line. A session ID has only letters, digits, `_` and `-`. A git ref, model or variant has only letters, digits and `/ . _ - : @ ~ ^`. If a value has anything else, say so and stop.
- If `opencode` is not installed or not logged in, stop and tell the user to run `/opencode:setup`.

## Read the flags

These are controls, not task text. Remove them from the text you send to OpenCode.

- `--background` or `--wait`: how you run the command (see below).
- `--resume`: continue the earlier task without asking. `--fresh`: start a new session without asking.
- `--model <provider/model>`: pass it through. Leave the model unset unless the user asks for one.
- `--effort <variant>`: pass it through as described under "Model and effort". Leave it unset unless the user asks.
- Read-only: if the user asks for diagnosis, research or review without edits, or says read-only, run with `--agent plan`. Otherwise run with `--agent build`, which can edit files in the project.
- When you continue a session, keep the agent of the run you are continuing. Switch to `build` only when the new instruction asks for changes. If you do not know which agent the earlier run used, use `plan` unless the new instruction asks for changes.

## Continue or start fresh

- With `--fresh`, start a new session and skip the rest of this section.
- Otherwise find the session to continue. If you started a task with this command earlier in this conversation, that session is the candidate. If not, list this repository's sessions:

```bash
opencode session list -n 10
```

  The candidate is then the newest session whose title starts with `Claude Code task:`.
- This command continues tasks only. Never continue a session whose title starts with `Claude Code review:` or `Claude Code adversarial review:`; a review is run again with its own command.
- Skip a session whose background task in this conversation is still running. Tell the user it is still running and that `/opencode:status` shows it.
- With `--resume`: continue the candidate without asking. If there is none, say so and stop.
- With neither flag and a candidate: use `AskUserQuestion` exactly once with `Continue: <the candidate's title>` and `Start a new OpenCode thread`. Put `(Recommended)` on the first when the user is clearly following up ("continue", "keep going", "apply the top fix", "dig deeper"), otherwise on the second.
- With neither flag and no candidate: start a new session without asking.

## Build the prompt

- Keep the user's task text as it is, apart from removing the flags.
- You may load the `opencode-prompting` skill to tighten the request into a better OpenCode prompt. That is the only work you do on the task yourself: do not inspect the repository, solve the problem, or draft a solution first.
- When continuing a session, send only the new instruction.

## Run OpenCode

New session, write-capable:

```bash
opencode run --agent build --title "Claude Code task: <the task in a few words>" <<'OPENCODE_PROMPT'
<the prompt>
OPENCODE_PROMPT
```

New session, read-only:

```bash
opencode run --agent plan --title "Claude Code task: <the task in a few words>" <<'OPENCODE_PROMPT'
<the prompt>
OPENCODE_PROMPT
```

Continue a session, write-capable. Always name the agent, because a session keeps the agent of its last run:

```bash
opencode run --agent build --session <session id> <<'OPENCODE_PROMPT'
<the new instruction>
OPENCODE_PROMPT
```

Continue a session, read-only:

```bash
opencode run --agent plan --session <session id> <<'OPENCODE_PROMPT'
<the new instruction>
OPENCODE_PROMPT
```

### Model and effort

Add these after `--agent <agent>`, before the title or session flag.

- Model, on both versions:

```bash
opencode run --agent build --model <provider/model> --title "Claude Code task: <the task in a few words>" <<'OPENCODE_PROMPT'
```

- Effort depends on the OpenCode version. Check it once with `opencode --version`.

  1.x takes it as its own flag:

```bash
opencode run --agent build --variant <variant> --title "Claude Code task: <the task in a few words>" <<'OPENCODE_PROMPT'
```

  2.x takes it as part of the model, in quotes because of the `#`. Without a model there is nowhere to put it, so ask the user for the model:

```bash
opencode run --agent build --model "<provider/model>#<variant>" --title "Claude Code task: <the task in a few words>" <<'OPENCODE_PROMPT'
```

### Foreground or background

- `--wait`: one `Bash` call with `timeout` set to 600000.
- `--background`: one `Bash` call with `run_in_background: true`. Do not wait for it in this turn. Tell the user: "OpenCode task started in the background. I'll show the result when it finishes. `/opencode:status` shows progress."
- Neither flag: use the foreground for a small, clearly bounded request, and the background for anything complicated, open-ended, or likely to run for more than a few minutes.
- A foreground run that hits the time limit is stopped. Say so. On OpenCode 2.x the session can keep running in OpenCode's service after that, so do not continue it straight away: tell the user that `/opencode:status` shows it and `/opencode:cancel <session id>` stops it. Once it is no longer running, offer to continue the same session in the background.

## Present the result

- OpenCode prints progress first: lines that start with a marker (`>`, `$`, `→`, `←`, `✱`, `✗`, or an exclamation mark for a permission notice), and the output of the commands it ran. Its answer is the text after the last of those. Lines inside the answer itself, such as a Markdown quote that starts with `>` or a `$` line in a code block, belong to the answer.
- Return the answer verbatim first. Do not paraphrase or summarize it, and add no commentary of your own.
- If OpenCode edited files, the `←` lines name them. After the answer, add one line that lists the changed files.
- If the answer is a question for the user: when the conversation already makes the answer clear, continue the session with that answer and tell the user what you answered and why. Otherwise ask the user and continue the session with their answer. Never answer for the user when it changes scope or risk: deleting data, choosing between incompatible designs, credentials, or anything they have not indicated.
- If there is no answer, or the run failed, show the last progress and error lines and stop. Do not turn a failed OpenCode run into your own attempt at the task.
