# OpenCode plugin for Claude Code

Use OpenCode from inside Claude Code for code reviews or to delegate tasks to OpenCode.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

> [!NOTE]
> This is an independent community project. It is not affiliated with or endorsed by the OpenCode project, Anthropic, or OpenAI.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:rescue`, `/opencode:transfer`, `/opencode:status`, `/opencode:result`, and `/opencode:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **A working local OpenCode install and provider configuration.**
  - Usage is billed by whichever OpenCode provider/model you select.
  - Supported OpenCode versions:

    | OpenCode | Status | Installed by |
    |---|---|---|
    | 1.x | Supported | `npm install -g opencode-ai`, the `opencode.ai/install` script, OpenCode's Homebrew tap (`brew install anomalyco/tap/opencode`), Scoop, Chocolatey |
    | 2.x | **Experimental** | the core Homebrew formula (`brew install opencode`) |
    | later | Refused until tested | |

    2.x replaced the server API that 1.x uses, so the plugin drives each through its own client and picks the right one automatically. 2.x support has been tested against a real 2.x server on macOS only; on Linux and Windows it has run only against the plugin's own fake 2.x server in CI. See [OpenCode 2.x](#opencode-2x).
- **Node.js 18.18 or later**

The plugin starts its own local `opencode serve` on demand, bound to `127.0.0.1` and protected with a per-server random password (HTTP Basic auth), so other local processes cannot reach its API. If you point the plugin at your own server via `OPENCODE_COMPANION_SERVER_URL` and that server is password-protected, also export `OPENCODE_SERVER_PASSWORD` (and `OPENCODE_SERVER_USERNAME` if you customized it).

## Install

Add the marketplace in Claude Code:

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

`/opencode:setup` will tell you whether OpenCode is ready. If OpenCode is missing and npm is available, it can offer to install OpenCode for you.

If you prefer to install OpenCode yourself, use:

```bash
npm install -g opencode-ai
```

If OpenCode is installed but no provider is configured yet, follow your OpenCode provider setup flow and rerun `/opencode:setup`.

After install, you should see:

- the slash commands listed below
- the `opencode:opencode-rescue` subagent in `/agents`

One simple first run is:

```bash
/opencode:review --background
/opencode:status
/opencode:result
```

## Usage

### `/opencode:review`

Runs a normal OpenCode review on your current work. It gives you the same quality of code review as running `/review` inside OpenCode directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/opencode:adversarial-review`](#opencodeadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/opencode:review
/opencode:review --base main
/opencode:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/opencode:status`](#opencodestatus) to check on the progress and [`/opencode:cancel`](#opencodecancel) to cancel the ongoing task.

### `/opencode:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/opencode:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/opencode:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/opencode:adversarial-review
/opencode:adversarial-review --base main challenge whether this was the right caching and retry design
/opencode:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/opencode:rescue`

Hands a task to OpenCode through the `opencode:opencode-rescue` subagent.

Use it when you want OpenCode to:

- investigate a bug
- try a fix
- continue a previous OpenCode task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

> [!IMPORTANT]
> Rescue tasks default to a write-capable run using OpenCode's stock `build` agent under your own OpenCode permission configuration. Permission categories OpenCode gates behind an approval prompt (external-directory access, `.env` reads, doom-loop protection) are automatically **denied** in these headless runs — the plugin never approves a gated request on your behalf. Note that OpenCode permissions are approval-level controls, not an operating-system sandbox; run the OpenCode server in a container or as a restricted user if you need a hard filesystem boundary.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/opencode:rescue investigate why the tests started failing
/opencode:rescue fix the failing test with the smallest safe patch
/opencode:rescue --resume apply the top fix from the last run
/opencode:rescue --model openai/gpt-5.4-mini --effort high investigate the flaky integration test
/opencode:rescue --model spark fix the issue quickly
/opencode:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to OpenCode:

```text
Ask OpenCode to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, OpenCode chooses its own defaults.
- if you say `spark`, the plugin maps that to `openai/gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest OpenCode task in the repo

### `/opencode:transfer`

Transfer imports the current Claude Code JSONL transcript into a resumable OpenCode session with visible user and assistant turn history. Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in OpenCode.

Examples:

```bash
/opencode:transfer
/opencode:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override.

### `/opencode:status`

Shows running and recent OpenCode jobs for the current repository.

Examples:

```bash
/opencode:status
/opencode:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/opencode:result`

Shows the final stored OpenCode output for a finished job.
When available, it also includes the OpenCode session ID so you can reopen that run directly in OpenCode with `opencode --session <session-id>`.

Examples:

```bash
/opencode:result
/opencode:result task-abc123
```

### `/opencode:cancel`

Cancels an active background OpenCode job.

Examples:

```bash
/opencode:cancel
/opencode:cancel task-abc123
```

### `/opencode:setup`

Checks whether OpenCode is installed and authenticated, and labels OpenCode 2.x as experimental.
If OpenCode is missing and npm is available, it can offer to install OpenCode for you.

You can also use `/opencode:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/opencode:setup --enable-review-gate
/opencode:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted OpenCode review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first. The gate also blocks stopping when the OpenCode reviewer is unavailable; restore OpenCode and rerun `/opencode:setup`, or disable the gate with `/opencode:setup --disable-review-gate`.

> [!WARNING]
> The review gate can create a long-running Claude/OpenCode loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

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

## OpenCode Integration

The OpenCode plugin wraps a local `opencode serve` process. It uses the global `opencode` binary installed in your environment and OpenCode's normal provider/configuration state.

### Common Configurations

If you want to change the default model used by the plugin, configure it in OpenCode. You can also pass a provider/model pair explicitly:

```bash
/opencode:rescue --model openai/gpt-5.4-mini --effort high investigate the flaky integration test
```

`--effort` is forwarded to OpenCode as the provider-specific message `variant`.

### Moving The Work Over To OpenCode

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside OpenCode by running `opencode --session <session-id>` with the specific session ID you received from `/opencode:result` or `/opencode:status`, or by selecting it from the list.

This way you can review the OpenCode work or continue the work there.

### OpenCode 2.x

OpenCode 2.x support is experimental. All the plugin's commands support 2.x, with these differences:

- **Logins.** 2.x keeps its own logins, separate from OpenCode 1.x and the desktop app. If a provider that works elsewhere rejects requests, log in again with `opencode auth login <provider>`. `/opencode:setup` lists the stored 2.x logins.
- **Reviews.** 2.x has no structured-output mode, so the plugin puts the review's JSON schema in the prompt and reads the JSON from OpenCode's reply. If the reply isn't valid, the plugin asks once more in the same session.
- **Questions.** When OpenCode stops a task to ask a question, the plugin hands the question back to Claude, which answers by resuming the task.
- **`--effort`** needs `--model` as well, since 2.x sets the effort on a specific model.

## FAQ

### Which model does the plugin use?

Your OpenCode default: the `model` setting in your OpenCode config (`opencode.json`), or OpenCode's own choice when you haven't set one. Pass `--model provider/model` to pick one for a single command.

### Does every model work for reviews?

Reviews need the model to return the review as JSON. On OpenCode 1.x, the plugin first asks for structured output, which OpenCode implements by forcing a tool call. Some models refuse forced tool calls: DeepSeek's thinking mode answers "Thinking mode does not support this tool_choice". When that happens, the plugin asks for the JSON in the reply text instead, the way it always does on 2.x, so the review still works. If a model can't produce valid JSON even then, the review shows its raw reply.

### Do I need a separate OpenCode account for this plugin?

If you are already signed into OpenCode on this machine, that account should work immediately here too. This plugin uses your local OpenCode CLI authentication. OpenCode 2.x keeps its logins separately from 1.x: see [OpenCode 2.x](#opencode-2x).

If you only use Claude Code today and have not used OpenCode yet, configure an OpenCode provider first. Run `/opencode:setup` to check whether OpenCode is ready.

### Does the plugin use a separate OpenCode runtime?

No. This plugin delegates through your local OpenCode CLI and a headless `opencode serve` process on the same machine.

That means:

- it uses the same OpenCode install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same OpenCode config I already have?

Yes. If you already use OpenCode, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local OpenCode CLI, your existing sign-in method and config still apply.

If you need to point a provider at a different endpoint, configure that in OpenCode and rerun `/opencode:setup`.

## Privacy

The plugin runs entirely locally and collects nothing. Your prompts and code go only to the AI providers you configured in your own OpenCode install. See [PRIVACY.md](PRIVACY.md) for details.

## Acknowledgements and provenance

This project began as a conversion of OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0) — the Codex companion plugin for Claude Code — into an OpenCode companion. The plugin surface (commands, background jobs, session transfer) descends from that work; the OpenCode server integration, security model, and test contract were built for this project. The complete pre-conversion history is preserved in this repository; the fork point is tagged [`codex-fork-point`](../../releases/tag/codex-fork-point). See [NOTICE](NOTICE) for license attribution and [docs/history/](docs/history/) for the original conversion plan.
