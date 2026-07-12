# Implementation Notes

> [!NOTE]
> **Historical document.** Mid-conversion working notes, frozen at the state they describe. Kept for provenance; the "Status" below refers to the early conversion phases, not the current release.

## Status: Phase 0 + Phase 1 complete and verified live

### Phase 0 — scaffold (done)
- Plugin moved to `plugins/opencode`; manifests/package metadata updated; `OPENCODE_COMPANION_*` env vars adopted; Codex app-server type generation and TS build removed.

### Phase 1 — runtime bridge (done, verified against a real `opencode serve`)
- `server-lifecycle.mjs` (ensure/reuse/teardown a headless `opencode serve`, health-poll startup, `OPENCODE_COMPANION_SERVER_URL` override), `opencode-server.mjs` (zero-dep fetch + SSE client), `opencode.mjs` (SSE turn capture). Codex app-server broker files deleted.
- Fake `opencode serve` test harness with HTTP/SSE endpoints and permission prompts.

### Fixes applied after the initial implementation (all verified)
The first pass shipped unrun (the build sandbox couldn't bind 127.0.0.1). Running against a real server surfaced and fixed:
1. **create-session body** — removed `directory` and `model` (the real `POST /session` returns HTTP 400 on both; `additionalProperties:false`, and `model` is sent per-message). `title` included only when a non-empty string.
2. **Headless permission auto-approval** — write sessions attach `{permission:"*",action:"allow",pattern:"*"}`; read-only uses the built-in `plan` agent. `respondPermission` posts `{ response: "always" | "reject" }` (the endpoint enum is once|always|reject, additionalProperties:false).
3. **Model normalization** — `spark` → `openai/gpt-5.3-codex-spark`, `provider/model` → `{providerID,modelID}`; bare/partial model → null (avoids a 400).
4. **Final message** — reasoning parts excluded so the answer isn't prefixed with reasoning text.
5. **`extractPermissionId`** — prefers the permission id over the `evt_` envelope id.
6. **`session.error`** — extracts a readable message instead of `[object Object]`.
7. **Fake fixture** — `/event` flushes SSE headers; create-session now rejects `directory`/`model`, and the permission endpoint enforces the `response` enum, so the tests guard these regressions.

### Live verification (real `opencode serve`, this machine)
- Write turn: edit auto-approved with no permission stall; `smoke.txt` written. ✓
- Read-only turn: clean answer, no edits (read-only respected). ✓
- Created sessions visible in `opencode session list` for the project dir (characteristic #2). ✓
- Progress streamed to the Claude TUI (Starting / Session ready / Edited / Assistant message / Turn completed). ✓
- `npm test` — 30/30 green. ✓
- Codex read-only review of the fixes: all 7 confirmed correct; LOW findings (title/model guards, fixture schema enforcement) applied.

## Phase 2 — command surface + hardening (done)
Delegated to Codex, then a two-way review round (Claude reviewed Codex; Codex reviewed the result), then Codex's findings fixed. `npm test` 32/32.
- **`/opencode:review` structured output** — OpenCode returns `json_schema` output as a synthetic `StructuredOutput` tool part (`state.input`), not text; captured it (was returning unparseable prose). Regression test added.
- **`ensureServer` inter-process lock** — atomic `mkdirSync` lock with token-matched release, double-checked healthy-session read, and dead-PID/age stale detection. Codex's review found 3 real bugs, now fixed: stale-takeover TOCTOU → atomic single-winner rename-steal; leaked lock on owner-file write failure → cleanup-on-failure; age note. Race-safe boot-marker test (serverStarts counter was itself racy).
- **Targeted cancel** — per-job `serverUrl` recorded so cancel aborts the exact server that ran the turn (fallback to `ensureServer`).
- **Prompting skill** — `gpt-5-4-prompting` generalized to be provider-neutral; `codex-prompt-*.md` → `opencode-prompt-*.md`.
- **Housekeeping** — dropped unused `typescript` devDep; `.codex/` gitignored; removed stale CI `npm run build`.

## Phase 3 — transfer (done)
Delegated to Codex; live-verified end-to-end by Claude (real transcript → `opencode import` → resumable session with correct roles/order/text). `npm test` 35/35.
- **`transfer`** — converts the Claude JSONL transcript to an OpenCode import document and runs `opencode import <file>`; returns the new `ses_...` id and prints `opencode --session <id>` for resume.
- Non-text content (thinking/tool_use/tool_result/images) is skipped; timestamps are normalized to strictly increasing so order is preserved.
- Edge-case fix (found via live testing): assistant turns before the first user message are dropped — `opencode import` rejects a null `parentID`.

## Deferred
- **Review sessions persist** — read-only review sessions are not deleted; acceptable, or delete for ephemeral parity.
- **Optional** — regenerate TypeScript types from OpenCode's OpenAPI (`GET /doc`) to restore a type-check build.
