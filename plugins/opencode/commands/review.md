---
description: Run a read-only OpenCode code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
disallowed-tools: Edit, Write, NotebookEdit
---

Run an OpenCode review of local git changes by calling the user's own `opencode` CLI.

This command needs Claude Code on a machine where OpenCode is installed. If you have no shell tool here, say so and stop.

Raw slash-command arguments:
$ARGUMENTS

## Core constraint

- This command is review-only. Do not fix issues, apply patches, or say you are about to make changes.
- Your only job is to run the review and return OpenCode's answer verbatim.

## Rules for every OpenCode call

- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.
- Never add `--auto`. In these non-interactive runs OpenCode rejects any permission request it would otherwise ask about, and that is intended.
- Pass the prompt on standard input with a quoted here-document, exactly as shown, so the shell expands nothing in it. If the prompt contains a line that reads `OPENCODE_PROMPT`, use another delimiter. In PowerShell, pipe a single-quoted here-string to the same command instead.
- A title is plain words: letters, digits, spaces, `-`, `.` and `:` only.
- Check values before they go on a command line. A session ID has only letters, digits, `_` and `-`. A git ref, model or variant has only letters, digits and `/ . _ - : @ ~ ^`. If a value has anything else, say so and stop.
- If `opencode` is not installed or not logged in, stop and tell the user to run `/opencode:setup`.

## Choose the target

- `--scope working-tree`: review staged, unstaged and untracked changes.
- `--scope branch`, or `--base <ref>` given: review the current branch against the base. Without `--base`, use the repository's default branch.
- `--scope auto` or no scope: use the working tree when `git status --short --untracked-files=all` shows changes, otherwise the branch against the default branch.
- This command takes no focus text and no staged-only or unstaged-only mode. If the user wants custom instructions, point them to `/opencode:adversarial-review`.
- Only conclude there is nothing to review when the working-tree status is empty and the branch diff is empty. When in doubt, run the review.

## Choose foreground or background

- If the arguments include `--wait`, run in the foreground without asking.
- If the arguments include `--background`, run in the background without asking.
- Otherwise estimate the size first: `git status --short --untracked-files=all`, and `git diff --shortstat --cached` plus `git diff --shortstat` for a working-tree review, or `git diff --shortstat <base>...HEAD` for a branch review. Count untracked files as work to review.
- Recommend waiting only when the review is clearly tiny, roughly 1-2 files. In every other case, including unclear size, recommend background.
- Then use `AskUserQuestion` exactly once with two options, the recommended one first with `(Recommended)` after its label: `Wait for results` and `Run in background`.

## Build the prompt

Fill in the two placeholders in this template and change nothing else:

```text
<role>
You are OpenCode performing a balanced, high-signal software review.
Your job is to find real bugs, correctness issues, and regressions in the change.
</role>

<task>
Review the change described below for bugs, correctness issues, regressions, and quality problems.
Target: {{TARGET}}
</task>

<collection>
You are running inside the repository. Collect the change yourself with read-only git commands:
{{COLLECTION}}
Read the changed files where the diff alone does not show enough.
Do not modify, create or delete any file. Do not run commands that change the repository.
</collection>

<operating_stance>
Be honest, calibrated, and thorough.
Flag what matters. Acknowledge what looks correct.
Do not manufacture skepticism or invent problems where none exist.
If the change is solid, say so clearly.
</operating_stance>

<focus_areas>
Prioritize findings that affect correctness, reliability, or security:
- logic errors, off-by-one mistakes, and incorrect control flow
- broken contracts, type mismatches, and violated invariants
- resource leaks, missing cleanup, and unhandled error paths
- race conditions, ordering assumptions, and stale-state bugs
- data loss, corruption, duplication, or irreversible state changes
- regressions that break existing behavior or compatibility
- missing tests or verification for critical paths
- unclear or misleading code that hides a real defect
</focus_areas>

<finding_bar>
Each finding must say what the defect is, where it is (file and line range), what the impact is, and how to fix it.
Skip style nits, naming preferences, and opinion-only feedback.
Do not report issues you cannot support from the code.
</finding_bar>

<output_contract>
Reply in Markdown with these sections, in this order:
1. `Verdict:` followed by `approve` or `needs-attention`. Use `needs-attention` for any material finding.
2. `Summary:` a terse, actionable assessment in one to three sentences.
3. `Findings:` a numbered list, strongest first. Each item gives a severity (critical, high, medium or low), `file:line_start-line_end`, the defect, the impact, a concrete recommendation, and a confidence from 0 to 1. Write `No findings.` if the change is clean.
4. `Next steps:` at most three short bullets, or omit the section.
Group related issues rather than splitting them.
</output_contract>

<final_check>
Before finalizing, check that each finding is a real defect, tied to a concrete code location, supported by what you read, and actionable.
</final_check>
```

- `{{TARGET}}`: `working tree (staged, unstaged and untracked changes)`, or `branch <current> against <base>`.
- `{{COLLECTION}}` for a working-tree review: `git status --short --untracked-files=all`, `git diff --cached`, `git diff`, and read each untracked file.
- `{{COLLECTION}}` for a branch review: `git log --oneline <base>..HEAD` and `git diff <base>...HEAD`.

## Run the review

Foreground: one `Bash` call with `timeout` set to 600000.

```bash
opencode run --agent plan --title "Claude Code review: <target in a few words>" <<'OPENCODE_PROMPT'
<the filled-in prompt>
OPENCODE_PROMPT
```

Background: the same command in one `Bash` call with `run_in_background: true`. Do not wait for it in this turn. Tell the user: "OpenCode review started in the background. I'll show the result when it finishes. `/opencode:status` shows progress."

## Present the result

- OpenCode prints progress first: lines that start with a marker (`>`, `$`, `→`, `←`, `✱`, `✗`, or an exclamation mark for a permission notice), and the output of the commands it ran. Its answer is the text after the last of those. Lines inside the answer itself, such as a Markdown quote that starts with `>` or a `$` line in a code block, belong to the answer.
- Return the answer verbatim. Do not paraphrase, summarize, or add commentary before or after it.
- If there is no answer, or the run failed or timed out, show the last progress and error lines and stop. A foreground run that hit the time limit was stopped; suggest `--background`. On OpenCode 2.x the session can keep running in OpenCode's service after that: tell the user that `/opencode:status` shows it and `/opencode:cancel <session id>` stops it.
- Do not fix any issue the review mentions. Ask the user which findings, if any, they want fixed before touching a file.
