import fs from "node:fs";
import path from "node:path";

import { buildOpenCodeImportDocumentFromClaudeJsonl } from "./claude-session-transfer.mjs";
import { createTempDir, readJsonFile, writeJsonFile } from "./fs.mjs";
import { OpencodeHttpError, OpencodeServerClient } from "./opencode-server.mjs";
import { SERVER_URL_ENV, ensureServer, loadServerSession } from "./server-lifecycle.mjs";
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

function buildWritePermissionRules() {
  // OpenCode's PermissionRule.permission is a free-form string but only real
  // permission keys take effect, and the built-in `build` agent's own defaults
  // still leave some categories on "ask". Use the same wildcard-allow rule the
  // `build` agent ships with so headless write turns never stall on approval.
  return [{ permission: "*", action: "allow", pattern: "*" }];
}

function buildCreateSessionParams(cwd, options = {}) {
  const write = Boolean(options.write);
  const agent = options.agent ?? (write ? WRITE_AGENT : READ_ONLY_AGENT);
  // The create-session body is strict (additionalProperties: false) and, in
  // practice, the real server also rejects a `model` object here with
  // BadRequest — the model is selected per-message instead (buildMessageParams).
  // `directory` is not accepted either: the session inherits it from the
  // `opencode serve` working directory, which server-lifecycle spawns with
  // `cwd`. `title` must be a string when present. Read-only turns rely on the
  // read-only `plan` agent instead of a permission override.
  const rawTitle = options.title ?? options.threadName ?? null;
  const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle : null;
  return {
    agent,
    ...(title ? { title } : {}),
    ...(write ? { permission: buildWritePermissionRules() } : {})
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
    finalMessage: "",
    structuredOutput: null,
    reasoningSummary: [],
    touchedFiles: new Set(),
    commandExecutions: [],
    error: null,
    streamError: null,
    responseError: null,
    recoveryError: null,
    response: null,
    fallbackTimer: null,
    onProgress: options.onProgress ?? null,
    write: Boolean(options.write)
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
  const sessionID = extractSessionId(event);
  if (!sessionID) {
    return;
  }

  const parentID = extractParentSessionId(event);
  if (sessionID === state.sessionID || state.sessionIDs.has(parentID)) {
    state.sessionIDs.add(sessionID);
    const label =
      event?.session?.title ??
      event?.session?.agent ??
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

async function respondToPermission(client, state, event, sessionID) {
  const permissionID = extractPermissionId(event);
  if (!permissionID || !sessionID) {
    return;
  }

  const response = state.write ? "always" : "reject";
  emitProgress(
    state.onProgress,
    `${state.write ? "Allowing" : "Denying"} OpenCode permission request ${permissionID}.`,
    state.write ? "running" : "investigating"
  );
  try {
    await client.respondPermission(sessionID, permissionID, response);
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

  if (type === "permission.asked" || type === "permission.v2.asked") {
    await respondToPermission(client, state, event, sessionID ?? state.sessionID);
    return;
  }

  if (type === "message.updated") {
    state.messageID = event?.message?.id ?? event?.info?.id ?? event?.id ?? state.messageID;
    applyMessageParts(state, extractMessageParts(event), sessionID ?? state.sessionID);
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
  try {
    const raw = await client.listMessages(state.sessionID, { signal: options.signal, freshConnection: true });
    const messages = getMessagesArray(raw).filter(isAssistantMessage);
    let assistant = state.messageID
      ? messages.find((message) => extractMessageId(message) === state.messageID)
      : null;
    if (!assistant) {
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
  } catch {
    state.priorAssistantIds = new Set();
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
      });

    // Complete on `session.idle` / `session.error` / the response fallback, on the
    // stream closing, or on the outer safety timeout — whichever comes first.
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
    await Promise.race([state.completion, eventStream, timeoutPromise]);

    // If we didn't capture a usable result, pull the finished message straight
    // from the server before giving up.
    if (!state.error && (!state.completed || (!state.finalMessage && state.structuredOutput == null))) {
      await recoverFinalMessageFromServer(client, state, { signal: eventAbort.signal });
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
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
    }
  }
}

async function withServer(cwd, fn) {
  const server = await ensureServer(cwd);
  if (!server?.url) {
    throw new Error("OpenCode server did not become ready.");
  }
  return fn(new OpencodeServerClient(server.url), server);
}

async function abortSessionAtUrl(serverUrl, threadId, timeoutMs = 1000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = new OpencodeServerClient(serverUrl);
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
  const url = env?.[SERVER_URL_ENV] ?? loadServerSession(cwd)?.url ?? null;
  if (url) {
    return {
      mode: "shared",
      label: "shared OpenCode server",
      detail: "This Claude session is configured to reuse one shared OpenCode server.",
      endpoint: url,
      url
    };
  }

  return {
    mode: "direct",
    label: "lazy OpenCode server startup",
    detail: "No shared OpenCode server is active yet. The first review or task command will start one on demand.",
    endpoint: null,
    url: null
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

export async function interruptServerTurn(cwd, { threadId, serverUrl = null }) {
  if (!threadId) {
    const serverExternal =
      serverUrl && normalizeServerUrlForCompare(serverUrl) === normalizeServerUrlForCompare(process.env[SERVER_URL_ENV]);
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing OpenCode session id",
      ...(serverUrl ? { serverUrl } : {}),
      ...(serverExternal ? { serverExternal: true } : {})
    };
  }

  if (serverUrl) {
    try {
      await abortSessionAtUrl(serverUrl, threadId);
      const serverExternal = normalizeServerUrlForCompare(serverUrl) === normalizeServerUrlForCompare(process.env[SERVER_URL_ENV]);
      return {
        attempted: true,
        interrupted: true,
        transport: "server",
        detail: `Aborted OpenCode session ${threadId}.`,
        serverUrl,
        ...(serverExternal ? { serverExternal: true } : {})
      };
    } catch (error) {
      const serverExternal = normalizeServerUrlForCompare(serverUrl) === normalizeServerUrlForCompare(process.env[SERVER_URL_ENV]);
      return {
        attempted: true,
        interrupted: false,
        transport: "server",
        detail: error instanceof Error ? error.message : String(error),
        serverUrl,
        ...(serverExternal ? { serverExternal: true } : {})
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
    const client = new OpencodeServerClient(usedServerUrl);
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
      serverUrl: server.url
    });

    let sessionID = options.resumeThreadId ?? options.resumeSessionId ?? null;
    let createdSessionID = null;

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
          title: options.threadName ?? options.title ?? (options.persistThread ? buildTaskSessionName(prompt) : null),
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
          write,
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
    persistThread: false,
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

  return withServer(cwd, async (client) => {
    const sessions = getSessionsArray(await client.listSessions())
      .filter((session) => sessionTitle(session).startsWith(TASK_SESSION_PREFIX))
      .filter((session) => {
        const directory = sessionDirectory(session);
        return !directory || directory === cwd;
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
  getAvailability as getOpencodeAvailability,
  getAuthStatus as getOpencodeAuthStatus
};
