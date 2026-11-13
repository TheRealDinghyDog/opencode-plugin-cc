# OpenCode plugin for Claude Code

Use OpenCode from inside Claude Code to review code or hand a task to another model.

The plugin holds instructions only. Its commands tell Claude which `opencode` command line to run with the OpenCode you already have, and Claude Code asks you before each run. It ships no scripts and no hooks, and it downloads nothing unless you accept `/opencode:setup`'s offer to install OpenCode.

> [!NOTE]
> This is an independent community project. It is not affiliated with or endorsed by the OpenCode project, Anthropic, or OpenAI.

## What You Get

- `/opencode:review` for a read-only OpenCode review
- `/opencode:adversarial-review` for a steerable review that challenges the approach
- `/opencode:rescue` to hand a task to OpenCode: investigate, fix, or continue an earlier task
- `/opencode:status`, `/opencode:result` and `/opencode:cancel` to follow, read and stop runs
- `/opencode:setup` to check that OpenCode is installed, supported and logged in

## Requirements

- **Claude Code on your own computer.** The commands need a shell on the machine where your OpenCode is installed, so they do nothing useful in claude.ai chat or Cowork.
- **OpenCode 1.x or 2.x**, installed and logged in to at least one provider. Usage is billed by the provider and model you select in OpenCode.

  | OpenCode | Installed by |
  |---|---|
  | 1.x | `npm install -g opencode-ai`, the `opencode.ai/install` script, OpenCode's Homebrew tap (`brew install anomalyco/tap/opencode`), Scoop, Chocolatey |
  | 2.x | the core Homebrew formula (`brew install opencode`) |

  A later major version is not supported until its command line has been checked. `/opencode:setup` says so, and every command stops and shows you OpenCode's output if OpenCode rejects an option.

## Install

Install it from Anthropic's plugin directory, or add this repository as a marketplace in Claude Code:

```bash
/plugin marketplace add TheRealDinghyDog/opencode-plugin-cc
```

Install the plugin:

```bash
/plugin install opencode@opencode
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/opencode:setup
```

`/opencode:setup` tells you whether OpenCode is ready. If OpenCode is missing and npm is available, it offers to install it and asks first. To install OpenCode yourself:

```bash
npm install -g opencode-ai
```

If OpenCode is installed but no provider is logged in, run `opencode auth login` and then `/opencode:setup` again.

A simple first run is:

```bash
/opencode:review --background
/opencode:status
/opencode:result
```

## Usage

### `/opencode:review`

Runs an OpenCode review of your current work.

> [!NOTE]
> A review of a change that spans many files can take a while. Run it in the background when it does.

Use it when you want:

- a review of your uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for a branch review. It also takes `--wait` and `--background`; with neither, the command asks which you want. It does not take focus text. Use [`/opencode:adversarial-review`](#opencodeadversarial-review) to challenge a specific decision or risk area.

Examples:

```bash
/opencode:review
/opencode:review --base main
/opencode:review --background
```

The result is a Markdown report with a verdict, findings by severity and next steps. The command fixes nothing. See [What it runs](#what-it-runs) for what "read-only" means here.

### `/opencode:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design: assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It selects what to review the same way `/opencode:review` does, takes the same flags, and can take focus text after them.

Examples:

```bash
/opencode:adversarial-review
/opencode:adversarial-review --base main challenge whether this was the right caching and retry design
/opencode:adversarial-review --background look for race conditions and question the chosen approach
```

This command fixes nothing either.

### `/opencode:rescue`

Hands a task to OpenCode and returns what it says.

Use it when you want OpenCode to:

- investigate a bug
- try a fix
- continue an earlier OpenCode task
- take a faster or cheaper pass with a smaller model

> [!IMPORTANT]
> A task runs OpenCode's stock `build` agent, which can edit files in the project, under your own OpenCode permission configuration. Ask for a read-only run and it uses the `plan` agent instead. The plugin never passes `--auto`, so OpenCode rejects any request it would otherwise ask you to approve, such as reading `.env` or touching files outside the project. OpenCode permissions are approval-level controls, not an operating-system sandbox.

It takes `--background`, `--wait`, `--resume` and `--fresh`. With neither `--resume` nor `--fresh`, the command can offer to continue the latest task for this repository.

Examples:

```bash
/opencode:rescue investigate why the tests started failing
/opencode:rescue fix the failing test with the smallest safe patch
/opencode:rescue --resume apply the top fix from the last run
/opencode:rescue --model deepseek/deepseek-flash --effort high investigate the flaky integration test
/opencode:rescue --background investigate the regression
```

You can also ask in plain words:

```text
Ask OpenCode to redesign the database connection to be more resilient.
```

**Notes:**

- Without `--model` or `--effort`, OpenCode uses its own defaults.
- `--model` takes the `provider/model` form that `opencode models` lists, such as `deepseek/deepseek-flash`.
- `--effort` is passed to OpenCode as the model's variant. On OpenCode 2.x it needs `--model` as well, because 2.x sets the variant on a specific model.

### `/opencode:status`

Lists running and recent OpenCode runs this plugin started in the current repository.

```bash
/opencode:status
/opencode:status <session-id>
```

A run started with `--background` is a Claude Code background task, and status shows its latest progress. On OpenCode 2.x, status also asks OpenCode which sessions are running. On 1.x, a run that was not started in the current Claude Code conversation is shown as `unknown`, because 1.x has nothing to ask.

### `/opencode:result`

Shows the final answer of a finished run, with its OpenCode session ID.

```bash
/opencode:result
/opencode:result <session-id>
```

### `/opencode:cancel`

Stops a running one.

```bash
/opencode:cancel
/opencode:cancel <session-id>
```

On OpenCode 2.x, a session can outlive the command that started it. Cancel checks the session afterwards and interrupts it through OpenCode if it is still running.

### `/opencode:setup`

Checks that OpenCode is installed, that its version is one the plugin knows, and that at least one provider is logged in. If OpenCode is missing and npm is available, it offers to install it.

## Typical Flows

### Review Before Shipping

```bash
/opencode:review
```

### Hand A Problem To OpenCode

```bash
/opencode:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/opencode:adversarial-review --background
/opencode:rescue --background investigate the flaky test
```

Then check in with:

```bash
/opencode:status
/opencode:result
```

A foreground run is limited to ten minutes by Claude Code's shell tool, so use `--background` for anything longer. On OpenCode 1.x, a run ends when the Claude Code session that started it ends.

## What it runs

Every `opencode` command line the plugin uses is listed in [`plugins/opencode/skills/opencode-cli/SKILL.md`](plugins/opencode/skills/opencode-cli/SKILL.md). In short: `opencode --version`, `opencode auth list`, `opencode run` with the prompt on standard input, `opencode session list`, and on OpenCode 2.x `opencode api` to read or interrupt a session and `opencode session export` (`opencode export` on 1.x).

- **Reviews** run OpenCode's `plan` agent, whose edit tools are denied and which is told to change nothing. That makes a review read-only by instruction, not by force: the agent can still run shell commands. After each review the plugin compares `git status` and the diff size with what they were before, and tells you if anything changed.
- **Tasks** run its `build` agent, which can edit files in the project, unless you ask for read-only.
- **Each run shows Claude Code's permission prompt.** To stop the prompt for reviews and read-only runs, add `Bash(opencode run --agent plan *)` to `permissions.allow` in your Claude Code settings. Weigh that against the first point: with the rule in place, the prompt no longer stands between a review and your shell. The rule also allows any further flags on that line; the plugin never adds `--auto`.

If OpenCode rejects an option or a command, the plugin's commands show you its output and stop. They do not try other flags.

### Continuing The Work In OpenCode

Every run is an ordinary OpenCode session. Open one in OpenCode with `opencode --session <session-id>`, using the ID that `/opencode:result` or `/opencode:status` shows, or pick it from OpenCode's session list.

## FAQ

### Which model does the plugin use?

Your OpenCode default: the `model` setting in your OpenCode config (`opencode.json`), or OpenCode's own choice when you haven't set one. Pass `--model provider/model` to `/opencode:rescue` to pick one for a single task.

### Do I need a separate OpenCode account for this plugin?

No. The plugin runs your local OpenCode CLI, so the logins it already has are the ones used. OpenCode 2.x keeps its logins separately from 1.x and from the desktop app: if a provider that works elsewhere rejects requests, log in again with `opencode auth login <provider>`.

### Will it use the same OpenCode config I already have?

Yes. It is the same OpenCode install, the same configuration and the same repository checkout you would use directly.

### Does it work in claude.ai chat or Cowork?

No. Those have no access to the OpenCode on your computer. The commands say so and stop.

## Development

`npm test` checks the plugin's Markdown against the plugin directory's rules for community plugins and against [`tests/opencode-cli-contract.json`](tests/opencode-cli-contract.json), the list of every `opencode` command line the plugin uses. `npm run canary` compares that list with the `opencode` installed on your machine; a weekly workflow does the same for the npm and Homebrew builds.

## Privacy

The plugin collects nothing. Your prompts and code go only to the AI providers you configured in your own OpenCode install. See [PRIVACY.md](PRIVACY.md).

## Acknowledgements and provenance

This project began as a conversion of OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0), the Codex companion plugin for Claude Code. The command set and the prompting guidance descend from that work. The pre-conversion history is preserved in this repository; the fork point is tagged [`codex-fork-point`](../../releases/tag/codex-fork-point). See [NOTICE](NOTICE) for license attribution.
