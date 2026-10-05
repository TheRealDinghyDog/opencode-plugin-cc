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
// interrupts the whole turn. The question and its options are kept on the
// result so Claude, which has the conversation, can answer it by resuming
// the session.
export const HEADLESS_QUESTION_MESSAGE = "OpenCode stopped to ask a question, which this run can't answer interactively.";

function summarizeForm(form) {
  return {
    title: typeof form.title === "string" ? form.title : null,
    fields: (Array.isArray(form.fields) ? form.fields : []).map((field) => ({
      key: field?.key ?? null,
      question: field?.description || field?.title || null,
      options: (Array.isArray(field?.options) ? field.options : []).map((option) => ({
        label: option?.label ?? String(option?.value ?? ""),
        description: option?.description ?? null
      })),
      custom: Boolean(field?.custom)
    }))
  };
}

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
    // Permission requests and forms already answered, by id: after a stream
    // drop they can also turn up in the pending lists (issue #84).
    askIDs: new Set(),
    // Main-session steps in arrival order, each step's text, and the input
    // (inbox item) each step answers.
    steps: [],
    texts: new Map(),
    stepInputs: new Map(),
    stepFinish: new Map(),
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
    question: null,
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

// Picks the answer among the turn's steps. A step that ends with
// `finish: "stop"` is a complete reply; one that ends with "tool-calls" only
// narrated what it was about to do. The plan agent's "You are in Plan mode"
// reminder is queued asynchronously and can be delivered mid-execution
// (session.inbox.delivered), and both outcomes were seen live on 2.0.20:
// - our prompt already had its complete reply, and the reminder got a reply
//   of its own: the answer is our prompt's last "stop" step;
// - our prompt's steps had no text yet, and the model answered in a step
//   after the reminder: the answer is the last text step overall.
// Until a step ends its finish is unknown, and steps that failed (interrupts,
// dismissed questions) never get one; then our prompt's last text step, or
// else the last text step overall, is the (partial) answer.
function refreshFinalMessage(state) {
  const hasText = (step) => Boolean(state.texts.get(step)?.trim());
  const stopped = (step) => state.stepFinish.get(step) === "stop";
  const ours = state.promptID ? state.steps.filter((step) => state.stepInputs.get(step) === state.promptID) : [];
  const pick =
    ours.findLast((step) => hasText(step) && stopped(step)) ??
    state.steps.findLast((step) => hasText(step) && stopped(step)) ??
    ours.findLast(hasText) ??
    state.steps.findLast(hasText);
  if (pick) {
    state.finalMessage = state.texts.get(pick);
    state.finalMessageID = pick;
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
      if (!child && messageID && typeof data.finish === "string") {
        state.stepFinish.set(messageID, data.finish);
        refreshFinalMessage(state);
      }
      for (const file of Array.isArray(data.files) ? data.files : []) {
        if (typeof file === "string" && file && !state.touchedFiles.has(file)) {
          state.touchedFiles.add(file);
          progress(state, `Edited ${file}.`, "editing");
        }
      }
      break;
    case "permission.asked": {
      if (state.askIDs.has(data.id)) {
        break;
      }
      state.askIDs.add(data.id);
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
      if (state.askIDs.has(form.id)) {
        break;
      }
      state.askIDs.add(form.id);
      const titles = (Array.isArray(form.fields) ? form.fields : [])
        .map((field) => field?.description || field?.title)
        .filter(Boolean)
        .join("; ");
      state.questionAsked = true;
      state.question = summarizeForm(form);
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
    // Already settled: once one request of a step is rejected or a form is
    // dismissed, OpenCode drops the rest and answers 404 (or 409 for a settled
    // form). Nothing waits on it, so the turn goes on (issue #63).
    if (error?.status === 404 || error?.status === 409) {
      progress(
        state,
        `OpenCode ${ask.type === "cancel-form" ? `question ${ask.formID}` : `permission request ${ask.requestID}`} was no longer pending (HTTP ${error.status}).`,
        "running"
      );
      return;
    }
    // An unanswered ask would hold the turn until the timeout.
    state.error = error;
    progress(state, `OpenCode ${ask.type === "cancel-form" ? "question" : "permission"} response failed: ${error.message}`, "failed");
    complete(state, "failed");
  }
}

// After the event stream drops, a permission request or question raised since
// then shows up only in the session's pending lists, and an unanswered one
// holds the turn until the timeout (issue #84). Each pending item goes through
// the same policy as its event: the list items are the events' payloads.
export async function pendingAsksAfterDrop(client, state) {
  const asks = [];
  for (const sessionID of state.sessionIDs) {
    const [permissions, forms] = await Promise.all([
      client.listPermissions(sessionID).catch(() => []),
      client.listForms(sessionID).catch(() => [])
    ]);
    for (const request of permissions) {
      asks.push(...applyV2Event(state, { type: "permission.asked", data: request }));
    }
    for (const form of forms) {
      asks.push(...applyV2Event(state, { type: "form.created", data: { form } }));
    }
  }
  return asks;
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
  // While streaming, the answer can be provisional: the text of a step that
  // went on to call tools ("I'll create that file"). Unless the stream already
  // saw a complete ("stop") reply, take the answer from the stored items
  // (issue #88). Stored assistant items carry the streamed step ids.
  if (!state.finalMessage || state.stepFinish.get(state.finalMessageID) !== "stop") {
    // The same rule as refreshFinalMessage, on the stored items: walking
    // forward from our prompt, the replies before the next input (a reminder,
    // a queued message) are ours; prefer a complete ("stop") reply.
    const ours = [];
    const after = [];
    let ownInput = true;
    for (let index = promptIndex - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.type === "user" || item?.type === "synthetic") {
        ownInput = false;
      } else if (item?.type === "assistant" && assistantText(item).trim()) {
        (ownInput ? ours : after).push(item);
      }
    }
    const replies = [...ours, ...after];
    const answer =
      ours.findLast((item) => item.finish === "stop") ??
      replies.findLast((item) => item.finish === "stop") ??
      ours.at(-1) ??
      replies.at(-1) ??
      null;
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
        for (const ask of await pendingAsksAfterDrop(client, state)) {
          await answerAsk(client, state, ask);
        }
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
