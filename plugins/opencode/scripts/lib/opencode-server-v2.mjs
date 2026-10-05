// Client for OpenCode 2.x's /api/* server (issue #51). The routes, request
// fields and event shapes it relies on are pinned in
// tests/opencode-v2-contract.json, recorded from a real 2.0.20 server.
//
// Differences from the 1.x client that callers rely on:
// - Workspace binding travels as `location: {directory}` in bodies and as
//   the deepObject query `location[directory]=` (1.x: `?directory=`).
// - Prompts are queued (`POST .../prompt` returns at once); the turn itself
//   arrives on GET /api/event.
// - There are no /global routes: no dispose, and health is GET /api/info.
// - Retired 1.x routes answer GET with the web UI (HTML, 200), so every
//   successful response must be JSON or the request fails.
import {
  OpencodeHttpError,
  buildBasicAuthHeader,
  consumeEventStream,
  encodePathSegment,
  parseOpencodeVersionInfo,
  requestWithFreshConnection,
  unsupportedOpencodeVersionError
} from "./opencode-server.mjs";

export const OPENCODE_V2_MAJOR = 2;

function trimBaseUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

function parseJsonBody(text, method, path) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenCode ${method} ${path} did not return JSON; is this an OpenCode 2.x server?`);
  }
}

export class OpencodeV2Client {
  constructor(baseUrl, options = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.authorization = buildBasicAuthHeader(options);
    this.directory = typeof options.directory === "string" && options.directory ? options.directory : null;
    this.api = OPENCODE_V2_MAJOR;
    if (!this.baseUrl) {
      throw new Error("OpenCode server URL is required.");
    }
    if (typeof this.fetch !== "function") {
      throw new Error("OpenCode server client requires global fetch (Node >= 18).");
    }
  }

  // Routes that take a `location` query get the workspace directory.
  url(path, { location = false } = {}) {
    const base = `${this.baseUrl}${path}`;
    if (!location || !this.directory) {
      return base;
    }
    const separator = path.includes("?") ? "&" : "?";
    return `${base}${separator}${encodeURIComponent("location[directory]")}=${encodeURIComponent(this.directory)}`;
  }

  authHeaders() {
    return this.authorization ? { authorization: this.authorization } : {};
  }

  async request(method, path, options = {}) {
    const url = this.url(path, options);
    if (options.freshConnection) {
      const result = await requestWithFreshConnection(new URL(url), {
        method,
        path,
        headers: this.authHeaders(),
        body: options.body,
        signal: options.signal,
        requestTimeoutMs: options.requestTimeoutMs
      });
      if (typeof result === "string") {
        throw new Error(`OpenCode ${method} ${path} did not return JSON; is this an OpenCode 2.x server?`);
      }
      return result;
    }

    const response = await this.fetch(url, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...this.authHeaders(),
        ...(options.headers ?? {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new OpencodeHttpError(`OpenCode ${method} ${path} failed with HTTP ${response.status}.`, {
        status: response.status,
        body: text,
        url
      });
    }
    return parseJsonBody(text, method, path);
  }

  info(options = {}) {
    return this.request("GET", "/api/info", {
      signal: options.signal,
      headers: options.closeConnection ? { connection: "close" } : undefined
    });
  }

  async health(options = {}) {
    const info = await this.info(options);
    const versionInfo = parseOpencodeVersionInfo(info?.version);
    if (!versionInfo) {
      throw new Error("OpenCode GET /api/info did not report a version.");
    }
    if (versionInfo.major !== OPENCODE_V2_MAJOR) {
      throw unsupportedOpencodeVersionError(versionInfo.version);
    }
    return info;
  }

  async createSession({ title, agent, model, directory } = {}, options = {}) {
    const body = {
      ...(title ? { title } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      location: { directory: directory ?? this.directory ?? process.cwd() }
    };
    const result = await this.request("POST", "/api/session", { body, signal: options.signal });
    return result?.data ?? null;
  }

  async prompt(sessionID, text, options = {}) {
    const result = await this.request("POST", `/api/session/${encodePathSegment(sessionID)}/prompt`, {
      body: { text },
      signal: options.signal
    });
    return result?.data ?? null;
  }

  async listSessions(options = {}) {
    const result = await this.request("GET", "/api/session", { location: true, signal: options.signal });
    return result?.data ?? [];
  }

  async listMessages(sessionID, options = {}) {
    const result = await this.request("GET", `/api/session/${encodePathSegment(sessionID)}/message`, {
      signal: options.signal,
      freshConnection: options.freshConnection,
      requestTimeoutMs: options.requestTimeoutMs
    });
    return result?.data ?? [];
  }

  interrupt(sessionID, options = {}) {
    return this.request("POST", `/api/session/${encodePathSegment(sessionID)}/interrupt`, { signal: options.signal });
  }

  // Cancel paths call abort() on either client; 2.x's equivalent is interrupt.
  abort(sessionID, options = {}) {
    return this.interrupt(sessionID, options);
  }

  setModel(sessionID, model, options = {}) {
    return this.request("POST", `/api/session/${encodePathSegment(sessionID)}/model`, {
      body: { model },
      signal: options.signal
    });
  }

  deleteSession(sessionID, options = {}) {
    return this.request("DELETE", `/api/session/${encodePathSegment(sessionID)}`, { signal: options.signal });
  }

  async listPermissions(sessionID, options = {}) {
    const result = await this.request("GET", `/api/session/${encodePathSegment(sessionID)}/permission`, {
      signal: options.signal
    });
    return result?.data ?? [];
  }

  replyPermission(sessionID, requestID, { decision, message } = {}, options = {}) {
    return this.request(
      "POST",
      `/api/session/${encodePathSegment(sessionID)}/permission/${encodePathSegment(requestID)}/reply`,
      { body: { decision, ...(message ? { message } : {}) }, signal: options.signal }
    );
  }

  async listForms(sessionID, options = {}) {
    const result = await this.request("GET", `/api/session/${encodePathSegment(sessionID)}/form`, {
      signal: options.signal
    });
    return result?.data ?? [];
  }

  cancelForm(sessionID, formID, options = {}) {
    return this.request("DELETE", `/api/session/${encodePathSegment(sessionID)}/form/${encodePathSegment(formID)}`, {
      signal: options.signal
    });
  }

  async listModels(options = {}) {
    const result = await this.request("GET", "/api/model", { location: true, signal: options.signal });
    return result?.data ?? [];
  }

  async defaultModel(options = {}) {
    const result = await this.request("GET", "/api/model/default", { location: true, signal: options.signal });
    return result?.data ?? null;
  }

  async listAgents(options = {}) {
    const result = await this.request("GET", "/api/agent", { location: true, signal: options.signal });
    return result?.data ?? [];
  }

  async listProviders(options = {}) {
    const result = await this.request("GET", "/api/provider", { location: true, signal: options.signal });
    return result?.data ?? [];
  }

  async listCredentials(options = {}) {
    const result = await this.request("GET", "/api/credential", { signal: options.signal });
    return result?.data ?? [];
  }

  async subscribeEvents(onEvent, options = {}) {
    const url = this.url("/api/event");
    const response = await this.fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream", ...this.authHeaders() },
      signal: options.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpencodeHttpError(`OpenCode GET /api/event failed with HTTP ${response.status}.`, {
        status: response.status,
        body,
        url
      });
    }
    if (!response.body) {
      throw new Error("OpenCode event stream did not include a response body.");
    }
    return consumeEventStream(response, onEvent, options);
  }
}
