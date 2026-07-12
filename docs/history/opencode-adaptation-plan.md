# Adapting `codex-plugin-cc` to OpenCode

> [!NOTE]
> **Historical document.** This is the original conversion plan written before implementation. It is kept for provenance and design context; parts of it were superseded during implementation (superseded sections are marked inline). It does not describe the current behavior — see the README and code for that.

Analysis of the current Codex plugin and a concrete plan to build an **`opencode` plugin for Claude Code** that delegates work to OpenCode the same way this repo delegates to Codex — with `/opencode:rescue`, `/opencode:review`, etc.

**Verdict up front:** The approach ports cleanly, and the OpenCode version is *architecturally simpler* than the Codex one. Both target characteristics are retainable:

1. **Subagents shown in the Claude Code TUI** — ✅ fully retained (unchanged mechanism).
2. **Subagent sessions appear automatically in the OpenCode app** — ✅ retained (with one small fidelity note about *live* vs *on-refresh*, covered below).

---

## 1. How the Codex plugin works today

The mechanism has four layers:

| Layer | Files | Role |
|---|---|---|
| **Claude Code surface** | `commands/*.md`, `agents/codex-rescue.md`, `skills/*`, `hooks/hooks.json` | Slash commands, the `codex:codex-rescue` subagent, session-lifecycle hooks. |
| **Companion CLI** | `scripts/codex-companion.mjs` | One Node entrypoint with subcommands: `setup`, `review`, `adversarial-review`, `task`, `transfer`, `status`, `result`, `cancel`, plus internal `task-worker` / `task-resume-candidate`. |
| **Runtime bridge** | `lib/codex.mjs`, `lib/app-server.mjs`, `app-server-broker.mjs`, `lib/broker-lifecycle.mjs`, `lib/broker-endpoint.mjs` | Talks to `codex app-server` over JSON-RPC/stdio; a **broker** multiplexes one app-server across concurrent calls via a Unix socket / named pipe. |
| **Runtime-agnostic plumbing** | `lib/state.mjs`, `lib/job-control.mjs`, `lib/tracked-jobs.mjs`, `lib/git.mjs`, `lib/render.mjs`, `lib/args.mjs`, `lib/process.mjs`, `lib/workspace.mjs`, `lib/prompts.mjs`, `lib/fs.mjs` | Job state files, background workers, git target selection, output rendering, arg parsing. **Not Codex-specific.** |

### How the two target characteristics are produced

**(1) Subagent in the Claude Code TUI.** `/codex:rescue` (`commands/rescue.md`) routes through the Claude Code **`Agent` tool** (`subagent_type: "codex:codex-rescue"`). `agents/codex-rescue.md` defines a *thin forwarder* subagent whose only job is one `Bash` call to `codex-companion.mjs task …`. Because it's a native Claude Code subagent, Claude Code renders it as a running subagent in the TUI. **This has nothing to do with Codex** — it's pure Claude Code plumbing.

**(2) Session appears in the Codex app.** `lib/codex.mjs` starts threads on the shared `codex app-server` with `ephemeral: false` + a thread name (`buildThreadParams` / `runAppServerTurn` with `persistThread: true`). Because the app-server writes to the same `~/.codex` session store the Codex app reads, the thread shows up in the Codex app automatically and is resumable via `codex resume <session-id>`. The broker exists so *all* concurrent plugin calls share *one* app-server → one consistent session store and one auth/config context.

Progress is surfaced by `captureTurn` in `lib/codex.mjs`: it subscribes to app-server notifications (`turn/started`, `item/started|completed`, `thread/started`, `turn/completed`, …), maps them to phases (`running`, `editing`, `verifying`, `investigating`, `finalizing`), and even surfaces Codex's *own* internal subagents (`collabAgentToolCall` / `receiverThreadIds`) as `Subagent X: …` log lines in the Claude TUI.

---

## 2. OpenCode capability mapping (verified locally, `opencode 1.17.10`)

OpenCode has a **client/server architecture** that maps onto the Codex model almost 1:1 — and removes the need for a custom broker.

| Need | Codex | OpenCode (verified) |
|---|---|---|
| Headless runtime | `codex app-server` (JSON-RPC/stdio) | **`opencode serve`** → HTTP server on `127.0.0.1:<port>` |
| Multiplex concurrent callers | custom Unix-socket **broker** | **built in** — the HTTP server is already multi-client |
| Create a thread/session | `thread/start` | `POST /session` → `{ id, directory, title, agent, model, … }` |
| Run a turn (blocking) | `turn/start` | `POST /session/{id}/message` → returns `{ info, parts }` when the turn completes (synchronous) |
| Fire-and-forget turn | — | `POST /session/{id}/prompt_async` |
| Stream progress | JSON-RPC notifications | **`GET /event`** (SSE); 86 event types incl. `session.next.text.*`, `.reasoning.*`, `.tool.*`, `.shell.*`, `.step.*`, `file.edited`, `session.idle`, `session.error`, `permission.asked` |
| Turn-complete signal | `turn/completed` | **`session.idle`** (carries `sessionID`) |
| Cancel | `turn/interrupt` | `POST /session/{id}/abort` |
| Resume a session | `codex resume <id>` | `opencode --session <id>` (TUI) / `opencode run --session <id>` / `opencode attach <url>` |
| List sessions | `thread/list` | `GET /session` (events carry `sessionID`; sessions carry `directory` for project scoping) |
| Structured output | `outputSchema` on turn | `format: { type: "json_schema", schema }` on message |
| Read-only vs write | `sandbox: read-only \| workspace-write` + `approvalPolicy: never` | per-turn **`agent`** (`plan` = read-only, `build` = write) and/or session **`permission`** rules (`{permission, action: allow\|ask\|deny, pattern}`) |
| Model select | `--model`, alias `spark`→`gpt-5.3-codex-spark` | `model: { providerID, modelID }`; `openai/gpt-5.3-codex-spark` etc. present in `opencode models` |
| Reasoning effort | `--effort none…xhigh` | **`variant`** (provider-specific: `minimal`/`high`/`max`, …) |
| Append history w/o a reply | — (native importer) | **`noReply: true`** on `POST /session/{id}/message` — the key to `transfer` |
| Auth/config | `account/read`, `config/read` | `GET /config`, `GET /provider`, `GET /config/providers`; `opencode providers list`; creds in `~/.local/share/opencode/auth.json` |
| Session storage | `~/.codex` | **`~/.local/share/opencode/opencode.db`** (shared SQLite/WAL) + `storage/` — read by every `opencode` process → sessions are visible across TUI / `serve` / `run` |

**Consequence:** we can **delete the broker** (`app-server-broker.mjs`, `broker-endpoint.mjs`, most of the socket handling) and replace the JSON-RPC stdio client with a tiny `fetch` + SSE HTTP client. Everything in the "runtime-agnostic plumbing" row stays.

---

## 3. Do the two characteristics survive? (detailed)

### (1) Subagent in the Claude Code TUI — ✅ unchanged
Rename `agents/codex-rescue.md` → `agents/opencode-rescue.md`, keep it a thin forwarder to `opencode-companion.mjs task …`, and route `/opencode:rescue` through the `Agent` tool exactly as today. Claude Code renders it identically. Additionally, OpenCode's *own* subagents (child sessions via `parentID`, `session.next.agent.switched`, `POST /experimental/session/{id}/background`) surface as `session.created`/`message.updated` events with a different `sessionID`, so the progress reporter can still print `Subagent X: …` lines — the same UX as Codex's `collabAgentToolCall`.

### (2) Session appears in the OpenCode app — ✅ retained (one nuance)

The original characteristic was the **Codex *desktop app*** (not the Codex TUI) auto-listing the plugin's subagent sessions. The OpenCode analog holds because **the TUI and the OpenCode desktop app are both just clients over one shared local store** — verified empirically on this machine:

- CLI canonical data dir (`opencode debug paths`) → `~/.local/share/opencode`, session DB `opencode.db` (SQLite/WAL).
- OpenCode desktop app is installed (`/Applications/OpenCode.app`, `ai.opencode.desktop`). Its Electron support dir holds **only** Chromium shell state + workspace-preference `.dat` files + a `locks/` dir — **no session `.db` of its own**. Its embedded **sidecar server** (an Electron `utilityProcess` running the standard OpenCode server) therefore reads/writes the **same** `~/.local/share/opencode/opencode.db`.

So a session the plugin creates via its own `opencode serve` (or `opencode run`) lands in that shared DB, scoped by `directory`, and **shows up in the OpenCode desktop app's session list** for that project — the direct analog of the Codex desktop app picking up subagent sessions. Resume from anywhere with `opencode --session <id>`.

This is the *same* fidelity Codex offered: the Codex desktop app also has its own backend and shares `~/.codex` storage — "appeared automatically" means "auto-listed from shared local state," not real-time streaming into an open window.

**Nuance — auto-listed vs live-streamed.** The desktop app runs its *own* sidecar server with its *own* `/event` bus, separate from the plugin's `opencode serve`. So new sessions appear in the desktop app's **list** (shared DB), which matches the Codex bar; whether an *already-open* desktop window repaints instantly depends on how it refreshes its list. Two levels:
- **Good (default, Codex-parity):** plugin runs its own `opencode serve`; sessions auto-appear in the desktop app's and TUI's session lists (same DB), resumable in the app.
- **Best (true-live, beyond Codex):** OpenCode uniquely supports `opencode attach <url>` — multiple clients on one server share a live event stream. Print the plugin's server URL and support attaching to a pre-existing server via `OPENCODE_COMPANION_SERVER_URL`, so a TUI/web client attached to the plugin's server streams turns in real time.

We'll implement the "good" default (Codex-parity) and expose the "best" path.

---

## 4. Recommended architecture

**Primary: a per-Claude-session shared `opencode serve` + a zero-dependency HTTP/SSE client.** This mirrors the Codex broker lifecycle but uses OpenCode's native server instead of a custom multiplexer.

```
Claude Code
  ├─ /opencode:* commands ──► opencode-companion.mjs <subcommand>
  │                                   │
  │                                   ├─ lib/server-lifecycle.mjs  (ensure `opencode serve`, health-check /global/health, reuse if alive, store {url,pid})
  │                                   └─ lib/opencode.mjs          (HTTP+SSE client: createSession / sendMessage / abort / subscribeEvents / captureTurn)
  │                                                                     │  fetch + ReadableStream SSE
  │                                                                     ▼
  │                                                            opencode serve  (HTTP 127.0.0.1:PORT)
  │                                                                     │  writes
  │                                                                     ▼
  └─ agents/opencode-rescue.md (Agent tool)               ~/.local/share/opencode/opencode.db  ◄── user's opencode TUI reads the same DB
```

- **Lifecycle** (`lib/server-lifecycle.mjs`, replaces `broker-lifecycle.mjs`): `SessionStart` hook exports env; first `/opencode:*` command lazily runs `ensureServer(cwd)` → if a healthy server URL is stored (or `OPENCODE_COMPANION_SERVER_URL` is set), reuse it; else `spawn("opencode", ["serve","--hostname","127.0.0.1","--port","0", …], {detached})`, parse `opencode server listening on http://127.0.0.1:PORT` from stdout (or health-poll), store `{url, pid}` in plugin state. `SessionEnd` hook posts `/global/dispose` (or kills the pid) and clears state. Reuse across concurrent calls = free (HTTP is multi-client).
- **Client** (`lib/opencode.mjs`, replaces `codex.mjs`+`app-server.mjs`): Node 18+ global `fetch`; SSE parsed by reading the response body stream and splitting on `\n\n`. `captureTurn(sessionId, …)` subscribes to `GET /event`, filters by `sessionID` (and child session IDs for subagents), maps events → the *existing* progress-reporter contract, resolves on `session.idle`, captures final assistant text from `message.updated` parts and touched files from `file.edited`.

**Alternative (lighter, or for the background worker): `opencode run --format json`.** One subprocess per task, JSON events on stdout, `--session <id>` to resume, `--agent`/`--model`/`--variant` for routing, kill-to-cancel. Simpler but no shared multiplexed runtime and coarser cancel. Recommendation: use the server for foreground + status/cancel; optionally use `run` inside the detached background worker.

### Read-only vs write (the `sandbox` analog)
- **Review / read-only task:** send the turn with `agent: "plan"` (OpenCode's read-only agent) and/or create the session with `permission` rules denying edits.
- **`--write` task:** `agent: "build"` and create the session with `permission` rules set to `allow` for the edit/shell tools (equivalent to Codex `approvalPolicy: "never"` + `workspace-write`). In headless mode there's no human to approve, so the client must **auto-approve**: either pre-set `permission` on `POST /session`, or reply `allow` to `permission.asked` / `permission.v2.asked` events via `POST /session/{id}/permissions/{permID}`. Design the client to auto-approve in write mode and auto-deny-edits in read-only mode. **This is the single most important implementation detail to get right.**
  - **Superseded (issue #26):** the auto-approve design above disables OpenCode's own safety guards. Session-level rules are merged *after* the agent ruleset with last-match-wins, so a broad session allow strips the stock `build` agent's `external_directory`/`.env`/`doom_loop` guards. The implementation now sends **no** session `permission` rules and **rejects** every headless `permission.asked` — under the stock agents an ask only fires when a guard trips.

### Model / effort mapping
- `--model spark` → `openai/gpt-5.3-codex-spark`; `--model openai/gpt-5.4` → `{providerID:"openai", modelID:"gpt-5.4"}`; unset → OpenCode default. Add an alias map + a `provider/model` splitter.
- `--effort <val>` → `variant: <val>` (pass through; note valid values are provider-specific, e.g. `minimal|high|max`). Optionally also accept `--variant` directly.

---

## 5. File-by-file plan

**Rename plugin identity:** `plugins/codex/` → `plugins/opencode/`; `marketplace.json` + `plugin.json` name/owner → opencode; env vars `CODEX_COMPANION_*` → `OPENCODE_COMPANION_*`; user-facing strings `codex …`/`Codex` → `opencode …`/`OpenCode`; resume hint `codex resume <id>` → `opencode --session <id>`.

| Current | Action | Notes |
|---|---|---|
| `scripts/lib/app-server.mjs` | **Replace** → `lib/opencode-server.mjs` | Hand-rolled `fetch`+SSE `OpencodeServerClient`: `createSession`, `sendMessage`, `promptAsync`, `abort`, `subscribeEvents`, `getConfig`, `listSessions`, `respondPermission`. Zero deps. |
| `scripts/app-server-broker.mjs` | **Delete** | `opencode serve` is the multiplexer. |
| `scripts/lib/broker-endpoint.mjs` | **Delete / fold in** | Store `http://127.0.0.1:PORT` string instead of socket/pipe. |
| `scripts/lib/broker-lifecycle.mjs` | **Rewrite** → `lib/server-lifecycle.mjs` | `ensureServer`/`loadServer`/`teardownServer`; spawn `opencode serve`, health via `GET /global/health`, reuse if alive. |
| `scripts/lib/codex.mjs` | **Rewrite** → `lib/opencode.mjs` | Turn capture from SSE; `runServerTurn`, `runReview`, `getAvailability`, `getAuthStatus`, `interruptTurn` (abort), `findLatestTaskSession`, `importClaudeSession` (transfer). |
| `scripts/lib/app-server-protocol.d.ts` + `prebuild` | **Replace** | Drop `codex app-server generate-ts`. Either hand-write minimal types or generate from `GET /doc` (OpenAPI). Simplest v1: plain `.mjs`, no typed build. |
| `scripts/codex-companion.mjs` | **Adapt** → `opencode-companion.mjs` | Same subcommands & control flow; swap `runAppServer*`→`runServer*`, `interruptAppServerTurn`→abort, model/effort normalization → provider/model + variant. |
| `scripts/session-lifecycle-hook.mjs` | **Keep + adapt** | Start/stop the opencode server (was broker); rename env vars. |
| `scripts/stop-review-gate-hook.mjs` | **Keep + adapt** | Point the gate at the opencode review path. |
| `scripts/lib/claude-session-transfer.mjs` | **Keep as-is** | Claude-side JSONL path resolution; unchanged. |
| `state.mjs`, `job-control.mjs`, `tracked-jobs.mjs`, `git.mjs`, `render.mjs`, `args.mjs`, `process.mjs`, `workspace.mjs`, `prompts.mjs`, `fs.mjs` | **Keep** (env/string renames only) | Runtime-agnostic. `render.mjs` strings + resume hint updated. |
| `schemas/review-output.schema.json` | **Keep** | Used with `format: json_schema`. |
| `agents/codex-rescue.md` | **Rename** → `opencode-rescue.md` | Thin forwarder to `opencode-companion.mjs task`. |
| `commands/*.md` | **Adapt** | `rescue`, `review`, `adversarial-review`, `transfer`, `status`, `result`, `cancel`, `setup`; `codex:`→`opencode:`, resume hints updated. |
| `skills/codex-cli-runtime` | **Rename** → `opencode-cli-runtime` | Same forwarder contract. |
| `skills/codex-result-handling` | **Rename** → `opencode-result-handling` | String updates. |
| `skills/gpt-5-4-prompting` | **Keep or generalize** | Still valid when routing to `openai/gpt-5.*`; consider a provider-neutral prompting skill since OpenCode can target many providers. |
| `tests/*.test.mjs` | **Adapt** | Replace `fake-codex-fixture.mjs` with a **fake `opencode serve`** (a tiny local HTTP+SSE server) for `runtime`/`broker-endpoint`/`process`/`render`/`commands` tests. `git`/`state`/`bump-version` tests largely unchanged. |

### Command behavior deltas
- **`review` / `adversarial-review`:** OpenCode has no built-in reviewer RPC, so *both* become prompt-driven read-only turns (reuse `prompts/adversarial-review.md` + `git.mjs` target selection + `review-output.schema.json` via `format: json_schema`, `agent: "plan"`). This actually *unifies* the two paths (Codex special-cased native review). `review` = fixed prompt, non-steerable; `adversarial-review` = steerable focus text. Optionally `DELETE /session/{id}` after a review to mimic Codex's ephemeral review threads (or keep them — they're harmless and resumable).
- **`task` (`/opencode:rescue`):** create/resume a persistent session (title `OpenCode Companion Task: <excerpt>`), `agent: build`+auto-allow when `--write`, else `plan`. `--resume-last` finds the newest task session in this `directory` (`GET /session` filtered by title prefix), mirroring `findLatestTaskThread`.
- **`transfer`:** convert the Claude JSONL transcript → OpenCode session: `POST /session` (title from the conversation), then replay each transcript message with `POST /session/{id}/message` `{ noReply: true, parts:[{type:"text",…}] }` to build visible, resumable history. Print `opencode --session <id>` to continue. *(Hardest command — Phase 3; ships value even if deferred.)*
- **`status` / `result` / `cancel`:** unchanged plumbing; `cancel` calls `POST /session/{id}/abort` (was `turn/interrupt`) then falls back to killing the tracked pid.
- **`setup`:** check `opencode --version`; auth via `GET /config`+`GET /provider` (or `opencode providers list`) + `~/.local/share/opencode/auth.json`; offer `opencode` install if missing; keep the review-gate toggle.

---

## 6. Phased delivery

- **Phase 0 — scaffold:** rename plugin dir/manifests/env; strip the `codex app-server generate-ts` build; keep tests green on the runtime-agnostic libs.
- **Phase 1 — runtime bridge:** `lib/server-lifecycle.mjs` + `lib/opencode-server.mjs` + `lib/opencode.mjs` (`runServerTurn`, `captureTurn` from SSE, availability/auth). Fake-server test harness. **Milestone:** `opencode-companion.mjs task "…"` runs a foreground turn, streams progress into the Claude TUI, and the session shows up in `opencode` TUI.
- **Phase 2 — full command surface:** `task` (+ `--write`/read-only permission wiring, `--resume-last`, background worker, `--model`/`--effort`→variant), `review`/`adversarial-review`, `status`/`result`/`cancel`, `setup`. Adapt `agents/opencode-rescue.md`, `commands/*`, `skills/*`. **Milestone:** parity with Codex minus transfer; both target characteristics demonstrably working.
- **Phase 3 — transfer + polish:** Claude-JSONL→OpenCode replay via `noReply`; stop-review gate; README; optional `attach`-for-live-parity docs; provider-neutral prompting skill.

---

## 7. Risks / open questions

1. **Headless permission auto-approval (highest risk).** Write-mode turns must not hang on `permission.asked`. Validate the create-session `permission` rule set *and* the `permission.v2.*` reply flow against a real write task early in Phase 1.
2. **Live TUI visibility.** DB sharing guarantees *list* visibility; *live* streaming into an already-open user TUI needs shared-server attach. Decide whether to auto-attach to a detected user server or just document `opencode attach`.
3. **`opencode serve` startup handshake.** Confirm the reliable "ready" signal (stdout line vs `GET /global/health` poll) and port capture when `--port 0`.
4. **Sync `POST /message` for long turns.** Confirm it holds the connection for multi-minute turns without idle timeouts; if not, use `prompt_async` + SSE `session.idle` as the completion path (already needed for progress anyway).
5. **`variant`/effort validity.** Values are provider-specific; validate/pass-through rather than hard-coding Codex's `none…xhigh` set.
6. **Ephemeral reviews.** OpenCode persists every session; decide keep-vs-delete for review sessions (Codex made them ephemeral).
7. **Transfer fidelity.** `noReply` replay reconstructs history but not tool-call/diff artifacts; confirm it's "good enough" to resume meaningfully in the OpenCode TUI.

---

## Appendix — key OpenCode facts (verified `opencode 1.17.10`, this machine)

- Server: `opencode serve --hostname 127.0.0.1 --port <n>` → `opencode server listening on http://127.0.0.1:<port>`; OpenAPI at `GET /doc`.
- Core endpoints: `POST /session`, `POST /session/{id}/message` (sync `{info,parts}`), `POST /session/{id}/prompt_async`, `POST /session/{id}/abort`, `GET /event` (SSE), `GET /session`, `GET /config`, `GET /provider`, `POST /session/{id}/permissions/{permID}`, `POST /experimental/session/{id}/background`, `GET /global/health`, `POST /global/dispose`.
- Message body: `{ parts:[{type:"text",text}], agent, model:{providerID,modelID}, variant, noReply, format:{type:"json_schema",schema}, system }`.
- Completion signal: `session.idle` (has `sessionID`). Progress: `session.next.text|reasoning|tool|shell|step.*`, `file.edited`, `session.error`. Events carry `sessionID` for filtering (incl. child/subagent sessions).
- Storage: shared `~/.local/share/opencode/opencode.db` (SQLite/WAL) — every `opencode` process sees the same sessions, scoped by `directory`.
- Resume: `opencode --session <id>` (TUI) / `opencode run --session <id>` / `opencode attach <url>`.
- Models incl. `openai/gpt-5.4`, `openai/gpt-5.3-codex-spark`; read-only `plan` agent + write `build` agent; per-session `permission` rules `{permission,action,pattern}`.
