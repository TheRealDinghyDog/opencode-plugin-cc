---
description: Check whether the local OpenCode CLI is installed, supported and logged in
---

Check that the user's own `opencode` CLI is ready for this plugin.

This command works only in Claude Code running on the user's own computer, where their OpenCode is installed. In claude.ai chat, the Claude apps or Cowork, any shell you have is a sandbox that does not hold the user's OpenCode or their logins: say that this plugin needs Claude Code, and stop. Do not run or install anything there.

Raw slash-command arguments:
$ARGUMENTS

If the arguments mention `--enable-review-gate` or `--disable-review-gate`: say that the stop-time review gate is part of the full plugin, not this edition, point to https://github.com/TheRealDinghyDog/opencode-plugin-cc#editions, and continue with the checks.

## Rules for every OpenCode call

- Use only the `opencode` invocations written in this file. If one fails with an unknown option or an unknown command, or prints OpenCode's help text instead of doing what was asked, stop: show the user the exact output and the output of `opencode --version`, and say the plugin may not support that OpenCode version yet. Do not try other flags or subcommands.
- Never print a credential. `opencode auth list` shows provider names only; do not run anything that prints stored secrets.

## 1. Is OpenCode installed?

```bash
opencode --version
```

- If the command is not found, and `npm --version` works: use `AskUserQuestion` exactly once to ask whether to install OpenCode now, with `Install OpenCode (Recommended)` and `Skip for now`. If the user chooses to install, run:

```bash
npm install -g opencode-ai
```

  Then run `opencode --version` again.
- If npm is not available either, do not ask. Tell the user to install OpenCode from https://opencode.ai and run `/opencode:setup` again.

## 2. Is the version supported?

- The first number of the version is the major version. 1 and 2 are supported.
- For any other major version, say that this plugin has not been tested with it, and stop. Do not offer to install another copy; it can collide with the existing `opencode` binary.

## 3. Is a provider logged in?

```bash
opencode auth list
```

- If no credential is listed, the plugin cannot confirm that OpenCode can reach a model. A provider set up through an environment variable or a local server may still work. Tell the user to log in from their own terminal with `opencode auth login`, which is interactive, and to run `/opencode:setup` again afterwards.
- OpenCode 1.x and 2.x keep separate logins. A login made in one does not appear in the other.

## Report

Tell the user, briefly:

- the OpenCode version and whether it is supported,
- the providers that are logged in, by name,
- whether the plugin is ready, and if not, the one thing to do next,
- that each OpenCode run asks for permission, and that they can allow read-only runs for good by adding `Bash(opencode run --agent plan *)` to the `permissions.allow` list in their own Claude Code settings (`Bash(opencode run --agent build *)` does the same for runs that can edit files). Such a rule also allows any further flags on that line; the plugin never adds `--auto`. Do not edit their settings yourself.
