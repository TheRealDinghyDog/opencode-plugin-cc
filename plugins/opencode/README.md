# OpenCode plugin for Claude Code

Use OpenCode from inside Claude Code to review code or hand a task to another model.

This is the edition of the plugin that Anthropic's plugin directory lists. It holds instructions only: its commands tell Claude to run the `opencode` CLI you already have, and Claude Code asks you before each run. It ships no scripts and no hooks, and it downloads nothing unless you accept `/opencode:setup`'s offer to install OpenCode.

It is an independent community project, not affiliated with or endorsed by the OpenCode project, Anthropic, or OpenAI.

## Requirements

- Claude Code. The commands need a shell on your own machine, so they do nothing useful in claude.ai chat or Cowork.
- OpenCode 1.x or 2.x, installed and logged in to at least one provider. Usage is billed by the provider and model you select in OpenCode.

Run `/opencode:setup` to check both.

## Commands

| Command | What it does |
| - | - |
| `/opencode:setup` | Checks that OpenCode is installed, supported and logged in |
| `/opencode:review` | Read-only review of your working tree or branch |
| `/opencode:adversarial-review` | Read-only review that challenges the approach, with optional focus text |
| `/opencode:rescue` | Hands a task to OpenCode: investigate, fix, or continue an earlier task |
| `/opencode:status` | Lists running and recent runs this plugin started |
| `/opencode:result` | Shows the final answer of a finished run |
| `/opencode:cancel` | Stops a running one |

Reviews and tasks can run in the foreground or as a Claude Code background task (`--background`). A background run is listed by `/opencode:status` with its latest progress, and its sessions stay in OpenCode's own history, where `opencode --session <id>` opens them.

## What it runs

Every `opencode` command line the plugin uses is listed in `skills/opencode-cli/SKILL.md`. In short: `opencode --version`, `opencode auth list`, `opencode run` with the prompt on standard input, `opencode session list`, and on OpenCode 2.x `opencode api` to read or interrupt a session and `opencode session export` (`opencode export` on 1.x). `/opencode:setup` offers `npm install -g opencode-ai` if OpenCode is missing, and asks first.

- Reviews run OpenCode's `plan` agent, whose edit tools are denied and which is told to change nothing.
- Tasks run its `build` agent, which can edit files in the project, unless you ask for read-only.
- The plugin never passes `--auto`, so OpenCode rejects any permission request it would otherwise ask you about, such as reading `.env` or touching files outside the project.
- OpenCode permissions are approval-level controls, not an operating-system sandbox.

Each run shows Claude Code's permission prompt. To allow read-only runs for good, add `Bash(opencode run --agent plan *)` to `permissions.allow` in your Claude Code settings. The rule also allows any further flags on that line; the plugin never adds `--auto`.

## Data

The plugin itself collects and sends nothing. OpenCode sends your prompts and the code it reads to the model provider you configured in OpenCode. See the [privacy note](https://github.com/TheRealDinghyDog/opencode-plugin-cc/blob/main/PRIVACY.md).

## The full plugin

The directory accepts only instruction files from community publishers, so this edition leaves out what needs code: the stop-time review gate, session transfer, and job tracking that survives outside Claude Code's background tasks. The full plugin has them and installs from its own marketplace. See [Editions](https://github.com/TheRealDinghyDog/opencode-plugin-cc#editions).
