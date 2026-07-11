import fs from "node:fs";
import path from "node:path";

import { buildOpenCodeImportDocumentFromClaudeJsonl } from "./claude-session-transfer.mjs";
import { createTempDir, readJsonFile, writeJsonFile } from "./fs.mjs";
import { OpencodeHttpError, OpencodeServerClient } from "./opencode-server.mjs";
import {
  SERVER_PASSWORD_ENV,
  SERVER_URL_ENV,
  SERVER_USERNAME_ENV,
  ensureServer,
  loadServerSession,
  serverSessionCredentials
} from "./server-lifecycle.mjs";
import { binaryAvailable, runCommandChecked } from "./process.mjs";

const TASK_SESSION_PREFIX = "OpenCode Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
const MODEL_ALIASES = new Map([["spark", "openai/gpt-5.3-codex-spark"]]);
const WRITE_AGENT = "build";
const READ_ONLY_AGENT = "plan";
// A turn is normally completed by a `session.idle` event. This is only a
// last-resort ceiling so a dropped event stream can't hang the turn forever
// (issue #2 / review finding #17). Deep reviews legitimately run many minutes,
// so keep it generous; on expiry we still try to recover the final message.
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
// After the event stream drops, wait this long for the held-open /message
// response and any trailing events to land before the first HTTP recovery
// poll. This is a grace before polling STARTS — not a deadline (issue #30).
const DEFAULT_STREAM_DROP_GRACE_MS = 5000;
// Interval between HTTP recovery polls while the stream is down and the turn
// has not otherwise completed. Polling continues until the outer turn timeout.
const DEFAULT_STREAM_DROP_POLL_INTERVAL_MS = 2000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function normalizeModelSelection(model) {
  if (model == null) {
    return null;
  }
  if (typeof model === "object") {
    // A pre-built model object is only valid to OpenCode with both providerID
    // and modelID; drop anything partial rather than sending an invalid shape.
    return typeof model.providerID === "string" && typeof model.modelID === "string"
      ? { providerID: model.providerID, modelID: model.modelID }
      : null;
  }

  const raw = String(model).trim();
  if (!raw) {
    return null;
  }

  const normalized = MODEL_ALIASES.get(raw.toLowerCase()) ?? raw;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0 && slashIndex < normalized.length - 1) {
    return {
      providerID: normalized.slice(0, slashIndex),
      modelID: normalized.slice(slashIndex + 1)
    };
  }

  // OpenCode requires both providerID and modelID. Without a `provider/model`
  // form we cannot build a valid selection, so fall back to the server default
  // rather than sending an invalid model object the API would reject.
  return null;
}

function buildTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function buildCreateSessionParams(cwd, options = {}) {
  const write = Boolean(options.write);
  const agent = options.agent ?? (write ? WRITE_AGENT : READ_ONLY_AGENT);
  // The create-session body is strict (additionalProperties: false) and, in
  // practice, the real server also rejects a `model` object here with
  // BadRequest — the model is selected per-message instead (buildMessageParams).
  // `directory` is not accepted either: the session inherits it from the
  // `opencode serve` working directory, which server-lifecycle spawns with
  // `cwd`. `title` must be a string when present.
  //
  // Deliberately no session-level `permission` rules for either mode. OpenCode
  // appends session rules AFTER the agent's ruleset and resolves each request
  // with the LAST matching rule, so any broad session rule silently overrides
  // the stock agents' safety guards (`external_directory`, `.env` reads, and
  // `doom_loop` stay on "ask") — and a session-level guard would likewise
  // clobber the agent's allowances for OpenCode's own tool-output directories.
  // Write turns rely on the stock `build` agent, read-only turns on the
  // read-only `plan` agent; guard categories that reach "ask" are denied
  // headlessly in respondToPermission (issue #26).
  const rawTitle = options.title ?? options.threadName ?? null;
  const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle : null;
  return {
    agent,
    ...(title ? { title } : {})
  };
}

function buildMessageParams(prompt, options = {}) {
  const model = normalizeModelSelection(options.model);
  return {
    parts: [{ type: "text", text: prompt }],
    agent: options.agent ?? (options.write ? WRITE_AGENT : READ_ONLY_AGENT),
    ...(model ? { model } : {}),
    ...(options.variant ? { variant: options.variant } : {}),
    ...(options.outputSchema
      ? {
          format: {
            type: "json_schema",
            schema: options.outputSchema
          }
        }
      : {})
  };
}

function extractEventType(event, meta = {}) {
  return (
    event?.type ??
    event?.event ??
    event?.name ??
    event?.properties?.type ??
    event?.properties?.event ??
    meta.eventName ??
    ""
  );
}

function extractSessionId(event) {
  return (
    event?.sessionID ??
    event?.sessionId ??
    event?.session?.id ??
    event?.message?.sessionID ??
    event?.message?.sessionId ??
    event?.info?.sessionID ??
    event?.info?.sessionId ??
    event?.properties?.sessionID ??
    event?.properties?.sessionId ??
    null
  );
}

function extractParentSessionId(event) {
  return (
    event?.parentID ??
    event?.parentId ??
    event?.session?.parentID ??
    event?.session?.parentId ??
    event?.properties?.parentID ??
    event?.properties?.parentId ??
    null
  );
}

function extractPermissionId(event) {
  // Prefer permission-specific fields over the generic envelope `id` (which is
  // the `evt_…` event id, not the permission id). The real permission.asked
  // event carries the permission id at `properties.id`.
  return (
    event?.permissionID ??
    event?.permissionId ??
    event?.permID ??
    event?.permId ??
    event?.permission?.id ??
    event?.properties?.permissionID ??
    event?.properties?.permissionId ??
    event?.properties?.permID ??
    event?.properties?.permId ??
    event?.properties?.permission?.id ??
    event?.properties?.id ??
    event?.id ??
    null
  );
}

function stringifyError(value) {
  if (value == null) {
    return "OpenCode session error.";
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    const nested = value.message ?? value.data?.message ?? value.error?.message ?? value.name;
    if (typeof nested === "string" && nested) {
      return nested;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function extractMessageParts(value) {
  const parts = value?.parts ?? value?.message?.parts ?? value?.properties?.parts ?? value?.data?.parts ?? null;
  return Array.isArray(parts) ? parts : [];
}

function getMessagesArray(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.messages)) {
    return response.messages;
  }
  return [];
}

function isAssistantMessage(message) {
  return (message?.info?.role ?? message?.role) === "assistant";
}

function extractMessageId(message) {
  return message?.info?.id ?? message?.id ?? null;
}

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(textFromContent).filter(Boolean).join("");
  }
  if (content && typeof content === "object") {
    return content.text ?? content.content ?? "";
  }
  return "";
}

function extractTextFromParts(parts) {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      // Reasoning parts are captured separately; excluding them keeps the final
      // assistant message from being prefixed with the model's reasoning text.
      if (String(part.type ?? "").includes("reasoning")) {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string" || Array.isArray(part.content)) {
        return textFromContent(part.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function extractReasoningFromParts(parts) {
  return parts
    .filter((part) => String(part?.type ?? "").includes("reasoning"))
    .map((part) => part.text ?? part.summary ?? part.content ?? "")
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .map((entry) => String(entry ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractStructuredOutput(parts) {
  // OpenCode returns json_schema output as a synthetic "StructuredOutput" tool
  // call whose completed `state.input` is the schema-conforming object — there
  // is no text part, so text-based capture misses it entirely.
  for (const part of parts) {
    if (part && part.type === "tool" && part.tool === "StructuredOutput") {
      const toolState = part.state ?? {};
      if (toolState.status && toolState.status !== "completed") {
        continue;
      }
      if (toolState.input !== undefined) {
        return toolState.input;
      }
    }
  }
  return undefined;
}

function extractFilePath(event) {
  return (
    event?.path ??
    event?.file ??
    event?.filename ??
    event?.properties?.path ??
    event?.properties?.file ??
    event?.data?.path ??
    null
  );
}

function extractCommand(event) {
  return (
    event?.command ??
    event?.cmd ??
    event?.tool?.command ??
    event?.properties?.command ??
    event?.properties?.cmd ??
    event?.data?.command ??
    ""
  );
}

function createTurnCaptureState(sessionID, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    sessionID,
    sessionIDs: new Set([sessionID]),
    childLabels: new Map(),
    nextChildIndex: 1,
    messageID: null,
    completed: false,
    completion,
    resolveCompletion,
    rejectCompletion,
    priorAssistantIds: new Set(options.priorAssistantIds ?? []),
    priorAssistantSnapshotSucceeded: false,
    priorAssistantSnapshotError: null,
    resumed: Boolean(options.resumed),
    finalMessage: "",
    structuredOutput: null,
    reasoningSummary: [],
    // Latest snapshot of every streamed part, keyed by part id. Insertion
    // order is preserved across snapshot replacements, which keeps text
    // assembly stable while parts stream in (issue #28).
    parts: new Map(),
    touchedFiles: new Set(),
    commandExecutions: [],
    error: null,
    streamError: null,
    responseError: null,
    recoveryError: null,
    response: null,
    fallbackTimer: null,
    onProgress: options.onProgress ?? null
  };
}

function labelForSession(state, sessionID) {
  if (!sessionID || sessionID === state.sessionID) {
    return null;
  }
  if (!state.childLabels.has(sessionID)) {
    state.childLabels.set(sessionID, String(state.nextChildIndex++));
  }
  return state.childLabels.get(sessionID);
}

function trackSession(state, event) {
  // Real session.created/session.updated events carry the Session object in
  // `properties.info` (id, parentID, title, agent); other events only carry
  // `properties.sessionID`.
  const info = event?.properties?.info ?? event?.info ?? event?.session ?? null;
  const sessionID = extractSessionId(event) ?? info?.id ?? null;
  if (!sessionID) {
    return;
  }

  const parentID = info?.parentID ?? extractParentSessionId(event);
  if (sessionID === state.sessionID || state.sessionIDs.has(parentID)) {
    state.sessionIDs.add(sessionID);
    const label =
      info?.title ??
      info?.agent ??
      event?.agent ??
      event?.properties?.title ??
      event?.properties?.agent ??
      null;
    if (label && sessionID !== state.sessionID) {
      state.childLabels.set(sessionID, label);
    }
  }
}

function mergeReasoning(state, sections) {
  for (const section of sections) {
    const normalized = String(section ?? "").replace(/\s+/g, " ").trim();
    if (normalized && !state.reasoningSummary.includes(normalized)) {
      state.reasoningSummary.push(normalized);
    }
  }
}

function completeTurn(state, options = {}) {
  if (state.completed) {
    return;
  }
  if (state.fallbackTimer) {
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
  }
  state.completed = true;
  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after OpenCode returned the message response.", "finalizing");
  }
  state.resolveCompletion(state);
}

function scheduleResponseFallbackCompletion(state) {
  if (state.completed || state.fallbackTimer) {
    return;
  }
  state.fallbackTimer = setTimeout(() => {
    state.fallbackTimer = null;
    completeTurn(state, { inferred: true });
  }, 250);
  state.fallbackTimer.unref?.();
}

function applyMessageParts(state, parts, sessionID) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return;
  }
  if (!sessionID || sessionID === state.sessionID) {
    const structured = extractStructuredOutput(parts);
    if (structured !== undefined) {
      state.structuredOutput = structured;
    }
  }
  const text = extractTextFromParts(parts);
  const reasoning = extractReasoningFromParts(parts);
  mergeReasoning(state, reasoning);

  const subagentLabel = labelForSession(state, sessionID);
  if (text && !subagentLabel) {
    state.finalMessage = text;
    emitLogEvent(state.onProgress, {
      message: `Assistant message captured: ${shorten(text, 96)}`,
      stderrMessage: null,
      phase: "finalizing",
      logTitle: "Assistant message",
      logBody: text
    });
  } else if (text && subagentLabel) {
    emitLogEvent(state.onProgress, {
      message: `Subagent ${subagentLabel}: ${shorten(text, 96)}`,
      stderrMessage: null,
      logTitle: `Subagent ${subagentLabel} message`,
      logBody: text
    });
  }

  if (reasoning.length > 0) {
    emitLogEvent(state.onProgress, {
      message: subagentLabel
        ? `Subagent ${subagentLabel} reasoning: ${shorten(reasoning[0], 96)}`
        : `Reasoning summary captured: ${shorten(reasoning[0], 96)}`,
      stderrMessage: null,
      logTitle: subagentLabel ? `Subagent ${subagentLabel} reasoning summary` : "Reasoning summary",
      logBody: reasoning.map((section) => `- ${section}`).join("\n")
    });
  }
}

function partIsAssembledText(part) {
  return String(part?.type ?? "") === "text" && typeof part?.text === "string" && !part.synthetic && !part.ignored;
}

// Rebuild the main-session final message from streamed text-part snapshots.
// Parts belong to messages, so assemble the text of one target message: the
// turn's assistant message when known, otherwise the message of the newest
// streamed text part (its parts still arrive in order).
function rebuildMainSessionText(state, hintMessageID = null) {
  const textParts = [];
  for (const part of state.parts.values()) {
    if ((part.sessionID ?? state.sessionID) !== state.sessionID || !partIsAssembledText(part)) {
      continue;
    }
    textParts.push(part);
  }
  if (textParts.length === 0) {
    return;
  }

  const candidates = [state.messageID, hintMessageID, textParts[textParts.length - 1].messageID];
  const target = candidates.find((id) => id && textParts.some((part) => part.messageID === id));
  const text = textParts
    .filter((part) => (part.messageID ?? target) === target)
    .map((part) => part.text)
    .join("");
  if (text) {
    state.finalMessage = text;
  }
}

// One streamed part snapshot (message.part.updated => properties.part). The
// event carries the part's full current state, so replace by part id.
function applyPartSnapshot(state, part) {
  if (!part || typeof part !== "object" || !part.id) {
    return;
  }
  const stored = { ...(state.parts.get(part.id) ?? {}), ...part };
  state.parts.set(part.id, stored);

  const sessionID = stored.sessionID ?? state.sessionID;
  if (sessionID && !state.sessionIDs.has(sessionID)) {
    return;
  }
  const subagentLabel = labelForSession(state, sessionID);
  const type = String(stored.type ?? "");
  const completed = Boolean(stored.time?.end) || stored.state?.status === "completed";

  if (!subagentLabel) {
    const structured = extractStructuredOutput([stored]);
    if (structured !== undefined) {
      state.structuredOutput = structured;
    }
  }

  if (partIsAssembledText(stored)) {
    if (!subagentLabel) {
      rebuildMainSessionText(state, stored.messageID ?? null);
      if (completed && stored.text) {
        emitLogEvent(state.onProgress, {
          message: `Assistant message captured: ${shorten(stored.text, 96)}`,
          stderrMessage: null,
          phase: "finalizing",
          logTitle: "Assistant message",
          logBody: stored.text
        });
      }
    } else if (completed && stored.text) {
      emitLogEvent(state.onProgress, {
        message: `Subagent ${subagentLabel}: ${shorten(stored.text, 96)}`,
        stderrMessage: null,
        logTitle: `Subagent ${subagentLabel} message`,
        logBody: stored.text
      });
    }
    return;
  }

  if (type === "reasoning" && completed && stored.text) {
    const reasoning = extractReasoningFromParts([stored]);
    mergeReasoning(state, reasoning);
    if (reasoning.length > 0) {
      emitLogEvent(state.onProgress, {
        message: subagentLabel
          ? `Subagent ${subagentLabel} reasoning: ${shorten(reasoning[0], 96)}`
          : `Reasoning summary captured: ${shorten(reasoning[0], 96)}`,
        stderrMessage: null,
        logTitle: subagentLabel ? `Subagent ${subagentLabel} reasoning summary` : "Reasoning summary",
        logBody: reasoning.map((section) => `- ${section}`).join("\n")
      });
    }
  }
}

// Incremental text (message.part.delta => {sessionID, messageID, partID,
// field, delta}). Deltas only ever extend a part we already saw a snapshot
// for; the next snapshot is authoritative and replaces the accumulated value.
function applyPartDelta(state, props) {
  const partID = typeof props?.partID === "string" ? props.partID : null;
  const field = typeof props?.field === "string" ? props.field : null;
  const delta = typeof props?.delta === "string" ? props.delta : null;
  if (!partID || !field || delta == null) {
    return;
  }
  const existing = state.parts.get(partID);
  if (!existing) {
    return;
  }
  existing[field] = (typeof existing[field] === "string" ? existing[field] : "") + delta;
  if (partIsAssembledText(existing) && (existing.sessionID ?? state.sessionID) === state.sessionID) {
    rebuildMainSessionText(state, existing.messageID ?? null);
  }
}

function extractQuestionRequestId(event) {
  // The question request id lives at properties.id (que_...); the envelope's
  // own id is the evt_... event id and must not be used.
  const id = event?.properties?.id;
  return typeof id === "string" && id ? id : null;
}

function describeQuestions(event) {
  const questions = Array.isArray(event?.properties?.questions) ? event.properties.questions : [];
  const summary = questions
    .map((question) => question?.header ?? question?.question)
    .filter((value) => typeof value === "string" && value)
    .slice(0, 2)
    .join("; ");
  return summary || null;
}

// OpenCode's question tool blocks its session on a deferred reply. Headless
// runs have nobody to answer, so reject immediately — the model receives the
// rejection and must proceed autonomously — instead of stalling the turn
// until the outer timeout (issue #28 / review M-02).
async function respondToQuestion(client, state, event) {
  const requestID = extractQuestionRequestId(event);
  if (!requestID) {
    return;
  }
  const described = describeQuestions(event);
  emitProgress(
    state.onProgress,
    `Rejecting OpenCode question ${requestID}${described ? ` (${shorten(described, 96)})` : ""}: headless runs cannot answer interactive questions.`,
    "running"
  );
  try {
    await client.rejectQuestion(requestID);
  } catch (error) {
    state.error = error;
    emitProgress(state.onProgress, `OpenCode question rejection failed: ${error.message}`, "failed");
  }
}

function describePermissionRequest(event) {
  const category =
    (typeof event?.permission === "string" ? event.permission : null) ??
    (typeof event?.properties?.permission === "string" ? event.properties.permission : null);
  const rawPatterns = event?.patterns ?? event?.properties?.patterns ?? null;
  const patterns = Array.isArray(rawPatterns) ? rawPatterns.filter((value) => typeof value === "string") : [];
  if (!category) {
    return null;
  }
  return patterns.length > 0 ? `${category}: ${patterns.join(", ")}` : category;
}

async function respondToPermission(client, state, event, sessionID) {
  const permissionID = extractPermissionId(event);
  if (!permissionID || !sessionID) {
    return;
  }

  // Never self-approve, in write mode included. Headless turns have no human
  // to ask, and under the stock agents a request only reaches "ask" when a
  // safety guard trips (external-directory access, `.env` reads, doom-loop
  // protection) or the user configured a category as interactive. Rejecting is
  // the only answer that preserves those guards; the model sees the rejection
  // and adapts (issue #26).
  const described = describePermissionRequest(event);
  emitProgress(
    state.onProgress,
    `Denying OpenCode permission request ${permissionID}${described ? ` (${described})` : ""}: headless runs never self-approve gated permissions.`,
    "running"
  );
  try {
    await client.respondPermission(sessionID, permissionID, "reject");
  } catch (error) {
    state.error = error;
    emitProgress(state.onProgress, `OpenCode permission response failed: ${error.message}`, "failed");
  }
}

function describeNextEvent(type, event) {
  if (type.startsWith("session.next.tool")) {
    const tool = event?.tool ?? event?.name ?? event?.properties?.tool ?? event?.properties?.name ?? "tool";
    return { message: `Running tool: ${tool}.`, phase: "investigating" };
  }

  if (type.startsWith("session.next.shell")) {
    const command = extractCommand(event);
    return {
      message: command ? `Running command: ${shorten(command, 96)}` : "Running shell command.",
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }

  if (type.startsWith("session.next.reasoning")) {
    return { message: "Reasoning in progress.", phase: "investigating" };
  }

  if (type.startsWith("session.next.text")) {
    return { message: "Assistant response in progress.", phase: "running" };
  }

  if (type.startsWith("session.next.step")) {
    return { message: "OpenCode advanced to the next step.", phase: "running" };
  }

  return null;
}

async function applyOpenCodeEvent(client, state, event, meta = {}) {
  if (!event || typeof event !== "object") {
    return;
  }

  const type = extractEventType(event, meta);
  trackSession(state, event);

  const sessionID = extractSessionId(event);
  if (sessionID && !state.sessionIDs.has(sessionID)) {
    return;
  }

  if (type === "session.created" || type === "session.updated") {
    // Child registration already happened in trackSession above.
    return;
  }

  if (type === "permission.asked" || type === "permission.v2.asked") {
    await respondToPermission(client, state, event, sessionID ?? state.sessionID);
    return;
  }

  if (type === "question.asked" || type === "question.v2.asked") {
    await respondToQuestion(client, state, event);
    return;
  }

  if (type === "message.updated") {
    // Metadata only in the real contract: properties.info carries the Message.
    // Parts arrive separately via message.part.updated / message.part.delta.
    const info = event?.properties?.info ?? event?.info ?? event?.message ?? null;
    const infoSessionID = info?.sessionID ?? sessionID ?? state.sessionID;
    if (info?.role === "assistant" && infoSessionID === state.sessionID) {
      if (typeof info.id === "string" && info.id) {
        state.messageID = info.id;
        rebuildMainSessionText(state);
      }
      // json_schema output also lands on the assistant message itself.
      if (info.structured !== undefined) {
        state.structuredOutput = info.structured;
      }
    }
    return;
  }

  if (type === "message.part.updated") {
    applyPartSnapshot(state, event?.properties?.part ?? event?.part ?? null);
    return;
  }

  if (type === "message.part.delta") {
    applyPartDelta(state, event?.properties ?? null);
    return;
  }

  if (type === "file.edited") {
    const filePath = extractFilePath(event);
    if (filePath) {
      state.touchedFiles.add(filePath);
      emitProgress(state.onProgress, `Edited ${filePath}.`, "editing");
    } else {
      emitProgress(state.onProgress, "File edited.", "editing");
    }
    return;
  }

  if (type === "session.error") {
    const rawError = event?.error ?? event?.properties?.error ?? event?.message ?? "OpenCode session error.";
    state.error = rawError instanceof Error ? rawError : new Error(stringifyError(rawError));
    emitProgress(state.onProgress, `OpenCode error: ${state.error.message}`, "failed");
    completeTurn(state);
    return;
  }

  if (type === "session.idle" && (!sessionID || sessionID === state.sessionID)) {
    emitProgress(state.onProgress, "Turn completed.", "finalizing");
    completeTurn(state);
    return;
  }

  const nextDescription = describeNextEvent(type, event);
  if (nextDescription) {
    const subagentLabel = labelForSession(state, sessionID);
    emitProgress(
      state.onProgress,
      subagentLabel ? `Subagent ${subagentLabel}: ${nextDescription.message}` : nextDescription.message,
      nextDescription.phase
    );
  }
}

// When the turn's transport dies or the event stream drops before we captured a
// result, the OpenCode server may still hold the completed assistant message.
// Re-fetch it over HTTP so a slow-but-successful turn isn't reported as failed
// (issue #2).
async function recoverFinalMessageFromServer(client, state, options = {}) {
  const recoveryTimeoutMs = Math.max(
    0,
    Number(options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS) || DEFAULT_RECOVERY_TIMEOUT_MS
  );
  const controller = new AbortController();
  let timeout = null;
  if (recoveryTimeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(new Error(`OpenCode recovery timed out after ${recoveryTimeoutMs}ms.`));
    }, recoveryTimeoutMs);
    timeout.unref?.();
  }

  try {
    const raw = await client.listMessages(state.sessionID, {
      signal: controller.signal,
      freshConnection: true,
      requestTimeoutMs: recoveryTimeoutMs
    });
    const messages = getMessagesArray(raw).filter(isAssistantMessage);
    let assistant = state.messageID
      ? messages.find((message) => extractMessageId(message) === state.messageID)
      : null;
    if (!assistant && (state.priorAssistantSnapshotSucceeded || !state.resumed)) {
      assistant = messages
        .filter((message) => {
          const messageID = extractMessageId(message);
          return messageID && !state.priorAssistantIds.has(messageID);
        })
        .pop();
    }
    if (!assistant) {
      return false;
    }
    state.messageID = extractMessageId(assistant) ?? state.messageID;
    applyMessageParts(state, extractMessageParts(assistant), state.sessionID);
    if (state.finalMessage || state.structuredOutput != null) {
      state.recovered = true;
      completeTurn(state);
      return true;
    }
    return false;
  } catch (error) {
    state.recoveryError = error;
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function snapshotPriorAssistantIds(client, state, options = {}) {
  try {
    const raw = await client.listMessages(state.sessionID, { signal: options.signal });
    state.priorAssistantIds = new Set(
      getMessagesArray(raw)
        .filter(isAssistantMessage)
        .map(extractMessageId)
        .filter(Boolean)
    );
    state.priorAssistantSnapshotSucceeded = true;
    state.priorAssistantSnapshotError = null;
  } catch (error) {
    state.priorAssistantIds = new Set();
    state.priorAssistantSnapshotSucceeded = false;
    state.priorAssistantSnapshotError = error;
  }
}

async function captureTurn(client, sessionID, startRequest, options = {}) {
  const state = createTurnCaptureState(sessionID, options);
  const eventAbort = new AbortController();
  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  // The event stream is the source of truth for turn completion. If it drops we
  // record the error but do NOT fail the turn outright — the completed message
  // may still be recoverable from the server (issue #2).
  const eventStream = client
    .subscribeEvents((event, meta) => applyOpenCodeEvent(client, state, event, meta), {
      signal: eventAbort.signal,
      onOpen: resolveOpen
    })
    .catch((error) => {
      if (eventAbort.signal.aborted) {
        return;
      }
      state.streamError = error;
      rejectOpen(error);
    });

  const turnTimeoutMs = Math.max(0, Number(options.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS);
  let timedOut = false;
  let turnTimer = null;
  // Hoisted so the finally block can drain it even if the try throws early.
  let streamDropRecovery = Promise.resolve();

  try {
    await Promise.race([
      opened,
      sleep(options.eventOpenTimeoutMs ?? 3000).then(() => {
        throw new Error("Timed out waiting for OpenCode event stream.");
      })
    ]);

    await snapshotPriorAssistantIds(client, state, { signal: eventAbort.signal });

    // Send the prompt. The synchronous /message endpoint keeps this request open
    // for the whole turn, so on long turns it can hit the client fetch timeout and
    // reject with a transport error well before `session.idle` arrives. That
    // transport failure must NOT fail the turn — only a real HTTP rejection (bad
    // request, bad model, etc.) is fatal (issue #2 / findings #16, #17).
    let responseSettled = false;
    let resolveResponseSettled;
    const responseSettledPromise = new Promise((resolve) => {
      resolveResponseSettled = resolve;
    });

    const responsePromise = startRequest(eventAbort.signal)
      .then((response) => {
        state.response = response;
        state.messageID = response?.info?.id ?? response?.id ?? state.messageID;
        applyMessageParts(state, response?.parts ?? [], state.sessionID);
        scheduleResponseFallbackCompletion(state);
        return response;
      })
      .catch((error) => {
        state.responseError = error;
        // A server-side rejection is terminal; a transport error is not.
        if (error instanceof OpencodeHttpError) {
          state.error = error;
          completeTurn(state);
        }
        return null;
      })
      .finally(() => {
        responseSettled = true;
        resolveResponseSettled(state);
      });

    // Complete on `session.idle` / `session.error`, the response fallback
    // (`scheduleResponseFallbackCompletion`, whose 250ms grace also lets trailing
    // events like file edits drain before we finalize), or the outer safety
    // timeout. A bare event-stream close is NOT completion while /message is still
    // pending; on a stream drop, give the response a short grace window before
    // trying recovery. We deliberately do NOT complete the race the instant the
    // response resolves — that would cut the trailing-event grace short.
    const timeoutPromise =
      turnTimeoutMs > 0
        ? new Promise((resolve) => {
            turnTimer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, turnTimeoutMs);
            turnTimer.unref?.();
          })
        : new Promise(() => {});
    const streamDropGraceMs = Math.max(
      0,
      Number(options.streamDropGraceMs ?? DEFAULT_STREAM_DROP_GRACE_MS) || DEFAULT_STREAM_DROP_GRACE_MS
    );
    const streamDropPollIntervalMs = Math.max(
      50,
      Number(options.streamDropPollIntervalMs ?? DEFAULT_STREAM_DROP_POLL_INTERVAL_MS) ||
        DEFAULT_STREAM_DROP_POLL_INTERVAL_MS
    );

    // A dropped event stream is loss of one observation channel, NOT turn
    // completion. The held-open /message response can still be running and
    // succeed well after the drop, and the finished message is fetchable over
    // HTTP. So once the stream closes: wait a short grace for the response and
    // trailing events to land, then actively poll the server for the finished
    // message until the turn completes another way (response fallback,
    // recovery, session.idle over a reconnect) or the OUTER turn timeout fires.
    // We never fail the turn merely because the stream ended (issue #30).
    streamDropRecovery = eventStream.then(async () => {
      if (streamDropGraceMs > 0 && !state.completed && !responseSettled) {
        await Promise.race([state.completion, responseSettledPromise, sleep(streamDropGraceMs)]);
      }
      while (!state.completed && !timedOut) {
        // Only fetch when we actually lack a result; skip the redundant GET if
        // parts already streamed in before the drop (issue #12).
        if (!state.error && !state.finalMessage && state.structuredOutput == null) {
          await recoverFinalMessageFromServer(client, state, { recoveryTimeoutMs: options.recoveryTimeoutMs });
        }
        if (state.completed || timedOut) {
          break;
        }
        await Promise.race([state.completion, timeoutPromise, sleep(streamDropPollIntervalMs)]);
      }
    });

    await Promise.race([state.completion, streamDropRecovery, timeoutPromise]);

    // If we didn't capture a usable result, pull the finished message straight
    // from the server before giving up. Key this off whether we actually lack a
    // result — NOT off `state.completed`. The race can resolve while a result is
    // already captured but the completion flag hasn't flipped yet (e.g. within the
    // response fallback's 250ms grace); re-fetching a message we already have is a
    // redundant GET that undoes the issue #12 sync-capture optimization. This
    // mirrors the "lack a result" check used just below for the error path.
    if (!state.error && !state.finalMessage && state.structuredOutput == null) {
      await recoverFinalMessageFromServer(client, state, { recoveryTimeoutMs: options.recoveryTimeoutMs });
    }

    // Nothing captured and no genuine error => surface the underlying cause.
    if (!state.error && !state.finalMessage && state.structuredOutput == null) {
      state.error =
        state.recoveryError ??
        state.responseError ??
        state.streamError ??
        new Error(
          timedOut
            ? "OpenCode turn timed out before completion."
            : "OpenCode turn ended without a result."
        );
    }

    return state;
  } finally {
    if (turnTimer) {
      clearTimeout(turnTimer);
    }
    eventAbort.abort();
    await eventStream.catch(() => {});
    // Drain the stream-drop recovery loop so it cannot poll past return. Its
    // guard (state.completed || timedOut) is already satisfied once the outer
    // race resolved, so this settles promptly.
    await streamDropRecovery.catch(() => {});
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
    }
  }
}

// The canonical (symlink-resolved) workspace path is what OpenCode records as
// a session's directory, so use it for the client's directory scope. Use the
// native resolver: unlike the JS implementation it also expands Windows 8.3
// short names (RUNNER~1 -> runneradmin) and normalizes separators, so the
// value matches what a child process sees as its cwd. Same choice as
// resolveStateDir in state.mjs.
function canonicalWorkspaceDirectory(cwd) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    try {
      return fs.realpathSync(cwd);
    } catch {
      return cwd;
    }
  }
}

function buildServerClient(cwd, server) {
  return new OpencodeServerClient(server.url, {
    ...serverSessionCredentials(server),
    directory: canonicalWorkspaceDirectory(cwd)
  });
}

async function withServer(cwd, fn) {
  const server = await ensureServer(cwd);
  if (!server?.url) {
    throw new Error("OpenCode server did not become ready.");
  }
  return fn(buildServerClient(cwd, server), server);
}

// A job record only stores the server URL, so a later cancel process must
// re-derive credentials: the workspace's persisted owned-server session first,
// then the ambient external-server variables.
function resolveCredentialsForServerUrl(cwd, serverUrl) {
  const normalized = normalizeServerUrlForCompare(serverUrl);
  const session = loadServerSession(cwd);
  if (session?.url && normalizeServerUrlForCompare(session.url) === normalized) {
    return serverSessionCredentials(session);
  }
  if (normalizeServerUrlForCompare(process.env[SERVER_URL_ENV]) === normalized) {
    return {
      password: process.env[SERVER_PASSWORD_ENV] || null,
      username: process.env[SERVER_USERNAME_ENV] || undefined
    };
  }
  return { password: null, username: undefined };
}

async function abortSessionAtUrl(serverUrl, threadId, timeoutMs = 1000, credentials = {}, directory = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = new OpencodeServerClient(serverUrl, {
      ...credentials,
      ...(directory ? { directory } : {})
    });
    await client.abort(threadId, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeServerUrlForCompare(url) {
  const normalized = String(url ?? "").trim().replace(/\/+$/, "");
  return normalized || null;
}

function getSessionsArray(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.sessions)) {
    return response.sessions;
  }
  return [];
}

function sessionTitle(session) {
  return session?.title ?? session?.name ?? "";
}

function sessionDirectory(session) {
  return session?.directory ?? session?.cwd ?? session?.path ?? "";
}

function sessionUpdatedAt(session) {
  return Date.parse(session?.updatedAt ?? session?.updated_at ?? session?.time?.updated ?? "") || 0;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

export function getAvailability(cwd) {
  const versionStatus = binaryAvailable("opencode", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const serveStatus = binaryAvailable("opencode", ["serve", "--help"], { cwd });
  if (!serveStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; headless server unavailable: ${serveStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; headless server available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const envUrl = env?.[SERVER_URL_ENV] ?? null;
  const url = envUrl ?? loadServerSession(cwd)?.url ?? null;
  if (url) {
    return {
      mode: "shared",
      label: "shared OpenCode server",
      detail: "This Claude session is configured to reuse one shared OpenCode server.",
      endpoint: url,
      url,
      // Env-configured servers are user-managed; a persisted server session is
      // one the plugin spawned and owns.
      external: Boolean(envUrl)
    };
  }

  return {
    mode: "direct",
    label: "lazy OpenCode server startup",
    detail: "No shared OpenCode server is active yet. The first review or task command will start one on demand.",
    endpoint: null,
    url: null,
    external: false
  };
}

export async function getAuthStatus(cwd) {
  const availability = getAvailability(cwd);
  if (!availability.available) {
    return buildAuthStatus({
      available: false,
      detail: availability.detail,
      source: "availability"
    });
  }

  try {
    return await withServer(cwd, async (client) => {
      const [config, provider] = await Promise.all([
        client.getConfig().catch((error) => ({ error })),
        client.getProvider().catch((error) => ({ error }))
      ]);
      if (config?.error && provider?.error) {
        throw config.error;
      }
      const providerID =
        provider?.id ??
        provider?.providerID ??
        provider?.providerId ??
        config?.providerID ??
        config?.providerId ??
        config?.config?.model_provider ??
        null;
      return buildAuthStatus({
        loggedIn: true,
        detail: providerID ? `OpenCode provider ${providerID} is configured` : "OpenCode server config is readable",
        source: "server",
        provider: providerID
      });
    });
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "server"
    });
  }
}

// `serverExternal` is the ownership flag persisted in the job record when the
// job started. Historical ownership must never be inferred from the current
// process environment — a cancel process without the job-start env would
// otherwise mistake a user-managed server for a plugin-owned one (issue #29).
export async function interruptServerTurn(cwd, { threadId, serverUrl = null, serverExternal = null }) {
  const ownership = typeof serverExternal === "boolean" ? { serverExternal } : {};
  if (!threadId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing OpenCode session id",
      ...(serverUrl ? { serverUrl } : {}),
      ...ownership
    };
  }

  if (serverUrl) {
    try {
      await abortSessionAtUrl(
        serverUrl,
        threadId,
        1000,
        resolveCredentialsForServerUrl(cwd, serverUrl),
        canonicalWorkspaceDirectory(cwd)
      );
      return {
        attempted: true,
        interrupted: true,
        transport: "server",
        detail: `Aborted OpenCode session ${threadId}.`,
        serverUrl,
        ...ownership
      };
    } catch (error) {
      return {
        attempted: true,
        interrupted: false,
        transport: "server",
        detail: error instanceof Error ? error.message : String(error),
        serverUrl,
        ...ownership
      };
    }
  }

  const availability = getAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let usedServerUrl = null;
  let usedServerExternal = false;
  try {
    const server = await ensureServer(cwd);
    usedServerUrl = server?.url ?? null;
    usedServerExternal = Boolean(server?.external);
    if (!usedServerUrl) {
      throw new Error("OpenCode server did not become ready.");
    }
    const client = buildServerClient(cwd, server);
    await client.abort(threadId);
    return {
      attempted: true,
      interrupted: true,
      transport: "server",
      detail: `Aborted OpenCode session ${threadId}.`,
      serverUrl: usedServerUrl,
      serverExternal: usedServerExternal
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: "server",
      detail: error instanceof Error ? error.message : String(error),
      ...(usedServerUrl ? { serverUrl: usedServerUrl } : {}),
      ...(usedServerUrl ? { serverExternal: usedServerExternal } : {})
    };
  }
}

export async function runServerTurn(cwd, options = {}) {
  const availability = getAvailability(cwd);
  if (!availability.available) {
    throw new Error("OpenCode CLI is not installed or is missing headless server support. Install OpenCode, then rerun `/opencode:setup`.");
  }

  const write = Boolean(options.write ?? options.sandbox === "workspace-write");
  const agent = options.agent ?? (write ? WRITE_AGENT : READ_ONLY_AGENT);
  const prompt = options.prompt || options.defaultPrompt || "";
  if (!prompt.trim()) {
    throw new Error("A prompt is required for this OpenCode run.");
  }

  return withServer(cwd, async (client, server) => {
    emitProgress(options.onProgress, "Using shared OpenCode server.", "starting", {
      serverUrl: server.url,
      // Recorded into the job so a later cancel process knows whether this
      // server is plugin-owned without consulting its own environment.
      serverExternal: Boolean(server.external)
    });

    let sessionID = options.resumeThreadId ?? options.resumeSessionId ?? null;
    let createdSessionID = null;
    const resumedSession = Boolean(sessionID);

    if (sessionID) {
      emitProgress(options.onProgress, `Resuming OpenCode session ${sessionID}.`, "starting", {
        threadId: sessionID,
        serverUrl: server.url
      });
    } else {
      emitProgress(options.onProgress, "Starting OpenCode task session.", "starting", {
        serverUrl: server.url
      });
      const session = await client.createSession(
        buildCreateSessionParams(cwd, {
          title: options.threadName ?? options.title ?? (options.taskSessionTitle ? buildTaskSessionName(prompt) : null),
          model: options.model,
          write,
          agent
        })
      );
      sessionID = session?.id ?? session?.session?.id ?? session?.info?.id ?? null;
      if (!sessionID) {
        throw new Error("OpenCode did not return a session id.");
      }
      createdSessionID = sessionID;
      emitProgress(options.onProgress, `Session ready (${sessionID}).`, "starting", {
        threadId: sessionID,
        serverUrl: server.url
      });
    }

    let turnState;
    try {
      turnState = await captureTurn(
        client,
        sessionID,
        (signal) =>
          client.sendMessage(
            sessionID,
            buildMessageParams(prompt, {
              model: options.model,
              variant: options.variant ?? options.effort ?? null,
              outputSchema: options.outputSchema ?? null,
              write,
              agent
            }),
            { signal }
          ),
        {
          onProgress: options.onProgress,
          resumed: resumedSession,
          turnTimeoutMs: options.turnTimeoutMs
        }
      );
    } catch (error) {
      if (createdSessionID) {
        try {
          await client.deleteSession(createdSessionID);
        } catch {
          // Preserve the turn failure; session deletion is best-effort cleanup.
        }
      }
      throw error;
    }

    const structured = turnState.structuredOutput;
    const finalMessage =
      options.outputSchema && structured !== null && structured !== undefined
        ? typeof structured === "string"
          ? structured
          : JSON.stringify(structured)
        : turnState.finalMessage;

    return {
      status: turnState.error ? 1 : 0,
      threadId: sessionID,
      turnId: turnState.messageID,
      serverUrl: server.url,
      finalMessage,
      structuredOutput: structured ?? null,
      reasoningSummary: turnState.reasoningSummary,
      turn: {
        id: turnState.messageID ?? "opencode-message",
        status: turnState.error ? "failed" : "completed"
      },
      error: turnState.error,
      stderr: "",
      fileChanges: [],
      touchedFiles: [...turnState.touchedFiles],
      commandExecutions: turnState.commandExecutions
    };
  });
}

export async function runServerReview(cwd, options = {}) {
  const result = await runServerTurn(cwd, {
    ...options,
    agent: READ_ONLY_AGENT,
    sandbox: "read-only",
    // Review sessions intentionally remain in OpenCode's session store so
    // users can reopen them with `opencode --session <id>`.
    taskSessionTitle: false,
    threadName: options.threadName ?? "OpenCode Review"
  });
  return {
    ...result,
    reviewText: result.finalMessage,
    sourceThreadId: result.threadId
  };
}

export async function findLatestTaskThread(cwd) {
  const availability = getAvailability(cwd);
  if (!availability.available) {
    throw new Error("OpenCode CLI is not installed or is missing headless server support. Install OpenCode, then rerun `/opencode:setup`.");
  }

  // Compare canonical-to-canonical: stored session directories originate from
  // the canonical directory the client sends, while `cwd` here can be git's
  // forward-slash toplevel (Windows) or a symlinked path (macOS /var).
  const canonicalCwd = canonicalWorkspaceDirectory(cwd);
  return withServer(cwd, async (client) => {
    const sessions = getSessionsArray(await client.listSessions())
      .filter((session) => sessionTitle(session).startsWith(TASK_SESSION_PREFIX))
      .filter((session) => {
        const directory = sessionDirectory(session);
        return !directory || directory === canonicalCwd;
      })
      .sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left));
    return sessions[0] ?? null;
  });
}

function parseOpenCodeVersion(output) {
  const tokens = String(output ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1] ?? "unknown";
}

function parseImportedSessionId(output) {
  return String(output ?? "").match(/Imported session:\s*(ses_[A-Za-z0-9]+)/)?.[1] ?? null;
}

export async function importExternalAgentSession(cwd, options = {}) {
  if (!options.sourcePath) {
    throw new Error("Missing Claude session source path for OpenCode transfer.");
  }

  const versionResult = runCommandChecked("opencode", ["--version"], {
    cwd,
    env: options.env
  });
  const version = parseOpenCodeVersion(versionResult.stdout || versionResult.stderr);
  const transcript = fs.readFileSync(options.sourcePath, "utf8");
  const document = buildOpenCodeImportDocumentFromClaudeJsonl(transcript, {
    cwd,
    version,
    idFactory: options.idFactory,
    fallbackTime: options.fallbackTime
  });

  const tempDir = createTempDir("opencode-transfer-");
  const importPath = path.join(tempDir, "claude-session-import.json");
  try {
    writeJsonFile(importPath, document);
    const importResult = runCommandChecked("opencode", ["import", importPath], {
      cwd,
      env: options.env,
      maxBuffer: 1024 * 1024 * 10
    });
    const threadId = parseImportedSessionId(`${importResult.stdout}\n${importResult.stderr}`);
    if (!threadId) {
      throw new Error("OpenCode import completed without reporting an imported session id.");
    }
    return {
      threadId,
      resumeCommand: `opencode --session ${threadId}`
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Preserve the import result/error; temp-dir cleanup is best effort.
    }
  }
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskSessionName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "OpenCode did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export {
  DEFAULT_CONTINUE_PROMPT,
  TASK_SESSION_PREFIX,
  captureTurn as captureTurnForTest,
  getAvailability as getOpencodeAvailability,
  getAuthStatus as getOpencodeAuthStatus
};
