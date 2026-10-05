# OpenCode 2.x recordings

Recorded on 2026-10-05 from a real OpenCode 2.0.20 server (`opencode serve`) with `deepseek/deepseek-v4-pro`, variant `none`. Each file is one prompt: every event from `GET /api/event` in arrival order, plus the session's `GET /api/session/{id}/message`, `…/permission` and `…/form` afterwards. Local paths were replaced with `/tmp/workspace`, `/tmp` and `/home/user`.

| File | Prompt |
| --- | --- |
| `success.json` | Reply with one word, no tools |
| `nomodel-success.json` | The same with no model on session create; the server's default answers and `session.created` has no `model` |
| `env-read.json` | `plan` reads `.env`; the `read *.env: ask` guard fires and is rejected |
| `external-write.json` | `build` writes outside the workspace; the `external_directory: ask` guard fires and is rejected |
| `write.json` | `build` writes inside the workspace; no ask |
| `form.json` | The question tool opens a form; it is cancelled, which interrupts the turn |
| `interrupt.json` | A long reply interrupted with `POST …/interrupt` |
| `subagent.json` | The task tool runs the `explore` subagent in a child session; a guard fires inside the child |

`tests/opencode-v2-contract.json` pins these shapes, and `tests/event-contract-v2.test.mjs` checks the recordings and the fake fixture against it. Unlike the fixture, the recordings also include events the plugin ignores (`session.inbox.*`, `session.usage.updated`, `session.step.streamed`, `session.tool.input.*`, `session.renamed`, …).
