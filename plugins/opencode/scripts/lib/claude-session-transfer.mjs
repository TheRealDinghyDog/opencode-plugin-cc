import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "OPENCODE_COMPANION_TRANSCRIPT_PATH";
export const OPENCODE_IMPORT_MODEL_ID = "imported-transcript";
export const OPENCODE_IMPORT_PROVIDER_ID = "claude-code";
export const OPENCODE_IMPORT_AGENT = "build";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`OpenCode can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

function shorten(text, limit = 80) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function kebab(text, limit = 48) {
  const value = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit)
    .replace(/-+$/g, "");
  return value || "claude-session";
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function joinTextParts(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractMessageText(role, content) {
  if (role === "user") {
    if (typeof content === "string") {
      return content;
    }
    return joinTextParts(content);
  }
  if (role === "assistant") {
    if (typeof content === "string") {
      return content;
    }
    return joinTextParts(content);
  }
  return "";
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampFromEntry(entry) {
  return (
    parseTimestamp(entry?.timestamp) ??
    parseTimestamp(entry?.created_at) ??
    parseTimestamp(entry?.createdAt) ??
    parseTimestamp(entry?.time?.created) ??
    parseTimestamp(entry?.message?.timestamp) ??
    parseTimestamp(entry?.message?.created_at) ??
    parseTimestamp(entry?.message?.createdAt) ??
    parseTimestamp(entry?.message?.time?.created) ??
    null
  );
}

function nextTimestamp(entry, state) {
  let value = timestampFromEntry(entry);
  if (value == null) {
    value = state.fallbackTime + state.fallbackOffset;
    state.fallbackOffset += 1;
  }
  if (value <= state.lastTime) {
    value = state.lastTime + 1;
  }
  state.lastTime = value;
  return value;
}

function parseClaudeJsonl(jsonl) {
  const entries = [];
  const lines = String(jsonl ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Could not parse Claude transcript JSONL line ${index + 1}: ${error.message}`);
    }
  }
  return entries;
}

function buildTextPart(text, sessionID, messageID, partID) {
  return {
    type: "text",
    text,
    id: partID,
    sessionID,
    messageID
  };
}

function buildUserMessage(text, time, sessionID, messageID, partID) {
  return {
    info: {
      role: "user",
      time: { created: time },
      agent: OPENCODE_IMPORT_AGENT,
      model: { providerID: OPENCODE_IMPORT_PROVIDER_ID, modelID: OPENCODE_IMPORT_MODEL_ID },
      summary: { diffs: [] },
      id: messageID,
      sessionID
    },
    parts: [buildTextPart(text, sessionID, messageID, partID)]
  };
}

function buildAssistantMessage(text, time, sessionID, messageID, partID, parentID, cwd) {
  return {
    info: {
      parentID,
      role: "assistant",
      mode: OPENCODE_IMPORT_AGENT,
      agent: OPENCODE_IMPORT_AGENT,
      path: { cwd, root: cwd },
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { write: 0, read: 0 }
      },
      modelID: OPENCODE_IMPORT_MODEL_ID,
      providerID: OPENCODE_IMPORT_PROVIDER_ID,
      time: { created: time, completed: time },
      finish: "stop",
      id: messageID,
      sessionID
    },
    parts: [buildTextPart(text, sessionID, messageID, partID)]
  };
}

export function buildOpenCodeImportDocumentFromClaudeJsonl(jsonl, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const version = options.version ?? "unknown";
  const idFactory = options.idFactory ?? randomId;
  const sessionID = options.sessionID ?? idFactory("ses");
  const timeState = {
    fallbackTime: Number.isFinite(options.fallbackTime) ? Math.trunc(options.fallbackTime) : Date.now(),
    fallbackOffset: 0,
    lastTime: -Infinity
  };
  const messages = [];
  let firstUserText = "";
  let lastMessageID = null;

  for (const entry of parseClaudeJsonl(jsonl)) {
    // Skip sidechain/subagent turns — Claude Code interleaves them into the same
    // transcript, and importing them would pollute the main conversation and
    // mis-thread assistant `parentID`s onto subagent messages.
    if (entry?.isSidechain === true) {
      continue;
    }
    const role = entry?.message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = extractMessageText(role, entry.message.content);
    if (!text.trim()) {
      continue;
    }

    // `opencode import` requires an assistant `parentID` string; drop assistant
    // turns that precede the first user message (a null parentID fails the whole
    // import). Real Claude transcripts open with a user turn, so this only skips
    // orphaned leading assistant content.
    if (role === "assistant" && !lastMessageID) {
      continue;
    }

    const time = nextTimestamp(entry, timeState);
    const messageID = idFactory("msg");
    const partID = idFactory("prt");
    if (role === "user") {
      if (!firstUserText) {
        firstUserText = text;
      }
      messages.push(buildUserMessage(text, time, sessionID, messageID, partID));
      lastMessageID = messageID;
    } else {
      messages.push(buildAssistantMessage(text, time, sessionID, messageID, partID, lastMessageID, cwd));
      lastMessageID = messageID;
    }
  }

  if (messages.length === 0) {
    throw new Error("Claude transcript did not contain any importable user or assistant text messages.");
  }

  const title = shorten(firstUserText || messages[0].parts[0].text, 80) || "Claude session";
  return {
    info: {
      id: sessionID,
      slug: kebab(title),
      projectID: "global",
      directory: cwd,
      path: "",
      title,
      agent: OPENCODE_IMPORT_AGENT,
      model: {
        id: OPENCODE_IMPORT_MODEL_ID,
        providerID: OPENCODE_IMPORT_PROVIDER_ID,
        variant: "default"
      },
      version,
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 }
      },
      time: {
        created: messages[0].info.time.created,
        updated: messages[messages.length - 1].info.time.created
      }
    },
    messages
  };
}
