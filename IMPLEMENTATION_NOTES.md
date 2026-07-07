# Implementation Notes

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

## Deferred to Phase 2
- **`ensureServer` has no inter-process lock** — concurrent plugin commands could spawn duplicate `opencode serve` processes and orphan one. Needs a lock file (or single-flight) around load/spawn/save. LOW (commands rarely overlap; tests run sequentially).
- **`transfer`** — still stubbed (`OpenCode transfer is not implemented in Phase 1`). Phase 3: replay a Claude JSONL transcript into an OpenCode session via `noReply`.
- **Background cancel** — `interruptServerTurn` may connect to a different server instance than the one running a backgrounded job's turn; the abort may not land.
- **Review sessions persist** — read-only review sessions are not deleted; acceptable, or delete for ephemeral parity.
- **Housekeeping** — `typescript` devDep is now unused (build step removed); add `.codex/` to `.gitignore` (local Codex-subagent config, not part of the plugin).
