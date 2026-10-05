// Captures one OpenCode 2.x turn (issues #52, #53). The events arrive on
// GET /api/event in the shapes pinned in tests/opencode-v2-contract.json:
//
//   session.execution.started
//   session.inbox.delivered         an input (our prompt, or a synthetic
//                                   reminder) reaches the model
//   session.step.started            one assistantMessageID per step
//   session.text.started / .delta / .ended
//   session.step.ended              files the step changed
//   session.execution.succeeded | .failed | .interrupted
//
// `applyV2Event` is a pure reducer over that stream; it returns the asks the
// caller must answer. `captureV2Turn` drives it: it subscribes before
// prompting (the prompt is queued and returns at once), answers permission
// asks and question forms headlessly, recovers over HTTP when the stream
// drops, and returns the same fields the 1.x capture does.

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_EVENT_OPEN_TIMEOUT_MS = 3000;
const DEFAULT_STREAM_DROP_POLL_INTERVAL_MS = 2000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 5000;

// What the model sees when its permission request is rejected (issue #26:
// headless runs never self-approve; the agent's guards stay in force).
export const HEADLESS_PERMISSION_MESSAGE =
  "This OpenCode Companion run is headless, so nobody can approve permission requests and they are rejected. Continue without it, or explain what you need.";

// 2.x has no way to decline a question and continue: cancelling the form
// interrupts the whole turn, so the turn ends with this error.
export const HEADLESS_QUESTION_MESSAGE =
  "OpenCode asked a question, which a headless run can't answer, so the turn stopped. Put the answer in the prompt and run it again, or continue the session in OpenCode.";

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function progress(state, message, phase = null, log = null) {
  if (!state.onProgress || !message) {
    return;
  }
  state.onProgress(
    log
      ? { message, phase, stderrMessage: null, logTitle: log.title, logBody: log.body }
      : phase
        ? { message, phase }
        : message
  );
}

function errorMessage(error) {
  if (typeof error === "string" && error) {
    return error;
  }
  return error?.message || error?.type || "OpenCode turn failed.";
}

export function createV2TurnState(sessionID, options = {}) {
  return {
    sessionID,
    sessionIDs: new Set([sessionID]),
    childLabels: new Map(),
    nextChildIndex: 1,
    seen: new Set(),
    // Main-session steps in arrival order, each step's text, and the input
    // (inbox item) each step answers.
    steps: [],
    texts: new Map(),
    stepInputs: new Map(),
    currentInput: null,
    promptID: null,
    messageID: null,
    finalMessage: "",
    finalMessageID: null,
    structuredOutput: null,
    reasoningSummary: [],
    touchedFiles: new Set(),
    commandExecutions: [],
    questionAsked: false,
    interruptReason: null,
    outcome: null,
    error: null,
    completed: false,
    resolveCompletion: null,
    onProgress: options.onProgress ?? null
  };
}

function complete(state, outcome) {
  if (state.completed) {
    return;
  }
  state.completed = true;
  state.outcome = outcome;
  state.resolveCompletion?.(state);
}

// The answer is the last step that produced text: a tool-using turn first
// says what it is about to do, and answers in a later step. Only steps that
// answer our prompt count: the plan agent's "You are in Plan mode" reminder
// is queued asynchronously, and when our prompt wins that race the reminder
// is delivered later in the same execution and gets its own reply.
function refreshFinalMessage(state) {
  const ours = state.promptID ? state.steps.filter((step) => state.stepInputs.get(step) === state.promptID) : [];
  const steps = ours.length > 0 ? ours : state.steps;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const text = state.texts.get(steps[index]);
    if (text && text.trim()) {
      state.finalMessage = text;
      state.finalMessageID = steps[index];
      return;
    }
  }
}

// The prompt's inbox id is only known once POST .../prompt returns, which
// can be after its delivery event, so the answer is recomputed then.
export function setV2PromptID(state, promptID) {
  state.promptID = promptID ?? null;
  refreshFinalMessage(state);
}

export function applyV2Event(state, event) {
  const asks = [];
  if (!event || typeof event !== "object") {
    return asks;
  }
  if (typeof event.id === "string") {
    if (state.seen.has(event.id)) {
      return asks;
    }
    state.seen.add(event.id);
  }
  const type = String(event.type ?? "");
  const data = event.data ?? {};

  if (type === "session.created") {
    if (data.parentID && state.sessionIDs.has(data.parentID) && data.sessionID && !state.sessionIDs.has(data.sessionID)) {
      const label = `#${state.nextChildIndex++}${data.agent ? ` (${data.agent})` : ""}`;
      state.sessionIDs.add(data.sessionID);
      state.childLabels.set(data.sessionID, label);
      progress(state, `Subagent ${label} started.`, "investigating");
    }
    return asks;
  }

  const sessionID = data.sessionID ?? data.form?.sessionID ?? null;
  if (!sessionID || !state.sessionIDs.has(sessionID)) {
    return asks;
  }
  const child = state.childLabels.get(sessionID) ?? null;
  const messageID = data.assistantMessageID ?? null;

  switch (type) {
    case "session.execution.started":
      if (!child) {
        progress(state, "OpenCode turn started.", "running");
      }
      break;
    case "session.inbox.delivered":
      if (!child && data.inboxID) {
        state.currentInput = data.inboxID;
      }
      break;
    case "session.step.started":
      if (!child && messageID && !state.steps.includes(messageID)) {
        state.steps.push(messageID);
        state.stepInputs.set(messageID, state.currentInput);
        state.messageID = messageID;
      }
      break;
    case "session.text.delta":
      if (!child && messageID) {
        state.texts.set(messageID, `${state.texts.get(messageID) ?? ""}${data.delta ?? ""}`);
        refreshFinalMessage(state);
      }
      break;
    case "session.text.ended":
      if (child) {
        if (data.text) {
          progress(state, `Subagent ${child}: ${shorten(data.text)}`, null, {
            title: `Subagent ${child} message`,
            body: data.text
          });
        }
      } else if (messageID) {
        state.texts.set(messageID, data.text ?? "");
        refreshFinalMessage(state);
        if (data.text) {
          progress(state, `Assistant message captured: ${shorten(data.text)}`, "finalizing", {
            title: "Assistant message",
            body: data.text
          });
        }
      }
      break;
    case "session.step.ended":
    case "session.step.failed":
      for (const file of Array.isArray(data.files) ? data.files : []) {
        if (typeof file === "string" && file && !state.touchedFiles.has(file)) {
          state.touchedFiles.add(file);
          progress(state, `Edited ${file}.`, "editing");
        }
      }
      break;
    case "permission.asked": {
      const target = (Array.isArray(data.resources) ? data.resources : []).join(", ");
      progress(
        state,
        `Denying OpenCode permission request ${data.id}${data.action ? ` (${data.action}${target ? `: ${target}` : ""})` : ""}: headless runs never self-approve gated permissions.`,
        "running"
      );
      asks.push({ type: "reject-permission", sessionID, requestID: data.id });
      break;
    }
    case "form.created": {
      const form = data.form ?? {};
      const titles = (Array.isArray(form.fields) ? form.fields : [])
        .map((field) => field?.description || field?.title)
        .filter(Boolean)
        .join("; ");
      state.questionAsked = true;
      progress(
        state,
        `Dismissing OpenCode question ${form.id}${titles ? ` (${shorten(titles)})` : ""}: headless runs cannot answer interactive questions.`,
        "running"
      );
      asks.push({ type: "cancel-form", sessionID, formID: form.id });
      break;
    }
    case "session.execution.succeeded":
      if (child) {
        progress(state, `Subagent ${child} finished.`, "investigating");
      } else {
        progress(state, "Turn completed.", "finalizing");
        complete(state, "succeeded");
      }
      break;
    case "session.execution.failed":
      if (child) {
        progress(state, `Subagent ${child} failed: ${errorMessage(data.error)}`, "investigating");
      } else {
        state.error = new Error(errorMessage(data.error));
        progress(state, `OpenCode error: ${state.error.message}`, "failed");
        complete(state, "failed");
      }
      break;
    case "session.execution.interrupted":
      if (!child) {
        state.interruptReason = data.reason ?? null;
        state.error = new Error(
          state.questionAsked
            ? HEADLESS_QUESTION_MESSAGE
            : `OpenCode stopped the turn${state.interruptReason ? ` (${state.interruptReason})` : ""}.`
        );
        progress(state, `OpenCode error: ${state.error.message}`, "failed");
        complete(state, "interrupted");
      }
      break;
    default:
      break;
  }
  return asks;
}

async function answerAsk(client, state, ask) {
  try {
    if (ask.type === "reject-permission") {
      await client.replyPermission(ask.sessionID, ask.requestID, {
        decision: "reject",
        message: HEADLESS_PERMISSION_MESSAGE
      });
    } else if (ask.type === "cancel-form") {
      await client.cancelForm(ask.sessionID, ask.formID);
    }
  } catch (error) {
    // An unanswered ask would hold the turn until the timeout.
    state.error = error;
    progress(state, `OpenCode ${ask.type === "cancel-form" ? "question" : "permission"} response failed: ${error.message}`, "failed");
    complete(state, "failed");
  }
}

function assistantText(item) {
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// When the event stream is gone, the session's message list still tells how
// the turn ended. It lists newest first, so this turn's items are the ones
// before the user item our prompt created.
export async function recoverV2Turn(client, state, options = {}) {
  if (!state.promptID) {
    return false;
  }
  let items;
  try {
    items = await client.listMessages(state.sessionID, {
      freshConnection: true,
      requestTimeoutMs: options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS
    });
  } catch (error) {
    state.recoveryError = error;
    return false;
  }
  const promptIndex = items.findIndex((item) => item?.id === state.promptID);
  if (promptIndex < 0) {
    return false;
  }
  const turnItems = items.slice(0, promptIndex);
  const idle = turnItems.find((item) => item?.type === "idle");
  if (!idle) {
    return false;
  }
  if (!state.finalMessage) {
    // Walk forward in time from our prompt; a later input (a synthetic
    // reminder, a queued user message) starts someone else's answer.
    let answer = null;
    for (let index = promptIndex - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.type === "user" || item?.type === "synthetic") {
        break;
      }
      if (item?.type === "assistant" && assistantText(item).trim()) {
        answer = item;
      }
    }
    if (answer) {
      state.finalMessage = assistantText(answer);
      state.finalMessageID = answer.id ?? null;
      state.messageID = state.messageID ?? answer.id ?? null;
    }
  }
  state.recovered = true;
  if (idle.outcome === "succeeded") {
    complete(state, "succeeded");
  } else {
    state.error =
      state.error ??
      new Error(
        idle.outcome === "interrupted"
          ? state.questionAsked
            ? HEADLESS_QUESTION_MESSAGE
            : "OpenCode stopped the turn."
          : "OpenCode turn failed."
      );
    complete(state, idle.outcome === "interrupted" ? "interrupted" : "failed");
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureV2Turn(client, sessionID, prompt, options = {}) {
  const state = createV2TurnState(sessionID, options);
  state.completion = new Promise((resolve) => {
    state.resolveCompletion = resolve;
  });
  const eventAbort = new AbortController();
  const inFlight = new Set();
  let resolveOpen;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  const eventStream = client
    .subscribeEvents(
      (event) => {
        for (const ask of applyV2Event(state, event)) {
          const answering = answerAsk(client, state, ask).finally(() => inFlight.delete(answering));
          inFlight.add(answering);
        }
      },
      { signal: eventAbort.signal, onOpen: resolveOpen }
    )
    .catch((error) => {
      if (!eventAbort.signal.aborted) {
        state.streamError = error;
        rejectOpen(error);
      }
    });

  const turnTimeoutMs = Math.max(0, Number(options.turnTimeoutMs) || DEFAULT_TURN_TIMEOUT_MS);
  const pollIntervalMs = Math.max(50, Number(options.streamDropPollIntervalMs) || DEFAULT_STREAM_DROP_POLL_INTERVAL_MS);
  let timedOut = false;
  let turnTimer = null;
  const timeout = new Promise((resolve) => {
    turnTimer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, turnTimeoutMs);
    turnTimer.unref?.();
  });

  try {
    await Promise.race([
      opened,
      sleep(options.eventOpenTimeoutMs ?? DEFAULT_EVENT_OPEN_TIMEOUT_MS).then(() => {
        throw new Error("Timed out waiting for OpenCode event stream.");
      })
    ]);

    try {
      const queued = await client.prompt(sessionID, prompt, { signal: eventAbort.signal });
      setV2PromptID(state, queued?.id ?? null);
    } catch (error) {
      state.error = error;
      complete(state, "failed");
      return state;
    }

    // A dropped stream is lost observation, not a finished turn (issue #30):
    // poll the message list until it shows how the turn ended.
    const streamDropRecovery = eventStream.then(async () => {
      while (!state.completed && !timedOut) {
        await recoverV2Turn(client, state, options);
        if (state.completed || timedOut) {
          break;
        }
        await Promise.race([state.completion, timeout, sleep(pollIntervalMs)]);
      }
    });

    await Promise.race([state.completion, streamDropRecovery, timeout]);
    await Promise.allSettled([...inFlight]);

    if (!state.completed) {
      // Timed out: one last look before giving up.
      await recoverV2Turn(client, state, options);
    }
    if (!state.completed) {
      state.error = state.error ?? state.recoveryError ?? state.streamError ?? new Error("OpenCode turn timed out before completion.");
    } else if (state.outcome === "succeeded" && !state.finalMessage && !state.error) {
      state.error = new Error("OpenCode turn ended without a result.");
    }
    return state;
  } finally {
    clearTimeout(turnTimer);
    eventAbort.abort();
  }
}
