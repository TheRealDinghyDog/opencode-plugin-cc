---
description: Run a read-only OpenCode review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
disallowed-tools: Edit, Write, NotebookEdit
---

Run an adversarial OpenCode review of local git changes by calling the user's own `opencode` CLI.

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

## Choose the target and the focus

- `--scope working-tree`: review staged, unstaged and untracked changes.
- `--scope branch`, or `--base <ref>` given: review the current branch against the base. Without `--base`, use the repository's default branch.
- `--scope auto` or no scope: use the working tree when `git status --short --untracked-files=all` shows changes, otherwise the branch against the default branch.
- Everything in the arguments that is not one of the flags above is the user's focus text. Pass it on unchanged. Do not add review instructions of your own.
- Only conclude there is nothing to review when the working-tree status is empty and the branch diff is empty. When in doubt, run the review.

## Choose foreground or background

- If the arguments include `--wait`, run in the foreground without asking.
- If the arguments include `--background`, run in the background without asking.
- Otherwise estimate the size first: `git status --short --untracked-files=all`, and `git diff --shortstat --cached` plus `git diff --shortstat` for a working-tree review, or `git diff --shortstat <base>...HEAD` for a branch review. Count untracked files as work to review.
- Recommend waiting only when the review is clearly tiny, roughly 1-2 files. In every other case, including unclear size, recommend background.
- Then use `AskUserQuestion` exactly once with two options, the recommended one first with `(Recommended)` after its label: `Wait for results` and `Run in background`.

## Build the prompt

Fill in the three placeholders in this template and change nothing else:

```text
<role>
You are OpenCode performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the change described below as if you are trying to find the strongest reasons it should not ship yet.
Target: {{TARGET}}
User focus: {{FOCUS}}
</task>

<collection>
You are running inside the repository. Collect the change yourself with read-only git commands:
{{COLLECTION}}
Read the changed files and their callers where the diff alone does not show enough.
Do not modify, create or delete any file. Do not run commands that change the repository.
</collection>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus, weight it heavily, but still report any other material issue you can defend.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding answers: what can go wrong, why this code path is vulnerable, what the likely impact is, and what concrete change would reduce the risk.
</finding_bar>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the code you read or the output of the commands you ran.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
If a conclusion depends on an inference, say so in the finding and keep the confidence honest.
</grounding_rules>

<output_contract>
Reply in Markdown with these sections, in this order:
1. `Verdict:` followed by `approve` or `needs-attention`. Use `needs-attention` if there is any material risk worth blocking on.
2. `Summary:` a terse ship or no-ship assessment in one to three sentences, not a neutral recap.
3. `Findings:` a numbered list, strongest first. Each item gives a severity (critical, high, medium or low), `file:line_start-line_end`, what can go wrong, the impact, a concrete recommendation, and a confidence from 0 to 1. Write `No findings.` if you cannot support any substantive finding.
4. `Next steps:` at most three short bullets, or omit the section.
Prefer one strong finding over several weak ones.
</output_contract>

<final_check>
Before finalizing, check that each finding is adversarial rather than stylistic, tied to a concrete code location, plausible under a real failure scenario, and actionable.
</final_check>
```

- `{{TARGET}}`: `working tree (staged, unstaged and untracked changes)`, or `branch <current> against <base>`.
- `{{FOCUS}}`: the user's focus text, or `none`.
- `{{COLLECTION}}` for a working-tree review: `git status --short --untracked-files=all`, `git diff --cached`, `git diff`, and read each untracked file.
- `{{COLLECTION}}` for a branch review: `git log --oneline <base>..HEAD` and `git diff <base>...HEAD`.

## Run the review

Foreground: one `Bash` call with `timeout` set to 600000.

```bash
opencode run --agent plan --title "Claude Code adversarial review: <target in a few words>" <<'OPENCODE_PROMPT'
<the filled-in prompt>
OPENCODE_PROMPT
```

Background: the same command in one `Bash` call with `run_in_background: true`. Do not wait for it in this turn. Tell the user: "OpenCode adversarial review started in the background. I'll show the result when it finishes. `/opencode:status` shows progress."

## Present the result

- OpenCode prints progress first: lines that start with a marker (`>`, `$`, `→`, `←`, `✱`, `✗`, or an exclamation mark for a permission notice), and the output of the commands it ran. Its answer is the text after the last of those. Lines inside the answer itself, such as a Markdown quote that starts with `>` or a `$` line in a code block, belong to the answer.
- Return the answer verbatim. Do not paraphrase, summarize, or add commentary before or after it.
- If there is no answer, or the run failed or timed out, show the last progress and error lines and stop. A foreground run that hit the time limit was stopped; suggest `--background`. On OpenCode 2.x the session can keep running in OpenCode's service after that: tell the user that `/opencode:status` shows it and `/opencode:cancel <session id>` stops it.
- Do not fix any issue the review mentions. Ask the user which findings, if any, they want fixed before touching a file.
