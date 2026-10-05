import http from "node:http";
import https from "node:https";

const DEFAULT_FRESH_CONNECTION_TIMEOUT_MS = 30_000;

export class OpencodeHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OpencodeHttpError";
    this.status = options.status ?? null;
    this.body = options.body ?? "";
    this.url = options.url ?? null;
  }
}

// The plugin drives OpenCode's 1.x server API, and 2.x's new /api/* surface
// through a separate client. 2.x support stays off until it is complete
// (issue #46); OPENCODE_COMPANION_EXPERIMENTAL_V2=1 turns it on for
// development. Every "is this major usable?" decision goes through here.
export const SUPPORTED_OPENCODE_MAJOR = 1;
export const EXPERIMENTAL_V2_ENV = "OPENCODE_COMPANION_EXPERIMENTAL_V2";

export function opencodeV2Enabled(env = process.env) {
  return env?.[EXPERIMENTAL_V2_ENV] === "1";
}

export function isSupportedOpencodeMajor(major, env = process.env) {
  return major === SUPPORTED_OPENCODE_MAJOR || (major === 2 && opencodeV2Enabled(env));
}

// `opencode --version` prints "1.18.34" on 1.x and "opencode v2.0.20" on 2.x;
// the /global/health body carries the bare version.
export function parseOpencodeVersionInfo(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? { version: match[0], major: Number(match[1]) } : null;
}

export function unsupportedOpencodeVersionMessage(version) {
  return (
    `OpenCode ${version} is not supported yet: this plugin uses the OpenCode 1.x server API, which OpenCode 2.x replaced. ` +
    "Install the OpenCode 1.x line (`npm install -g opencode-ai`, or OpenCode's Homebrew tap " +
    "`anomalyco/tap/opencode` after uninstalling the core `opencode` formula), then rerun `/opencode:setup`."
  );
}

export function unsupportedOpencodeVersionError(version) {
  const error = new Error(unsupportedOpencodeVersionMessage(version));
  error.code = "OPENCODE_UNSUPPORTED_VERSION";
  return error;
}

// fetch() reports every network failure as just "fetch failed"; its cause
// says what happened (refused, reset, timed out). Keep it in the message, and
// keep the error a plain transport error: callers treat those differently
// from HTTP rejections. Aborts pass through unchanged.
export async function fetchWithCause(fetchImpl, url, init, label) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    const detail = error?.cause?.code ?? error?.cause?.message ?? null;
    if (error?.name === "AbortError" || init?.signal?.aborted || !detail || String(error?.message).includes(detail)) {
      throw error;
    }
    const wrapped = new Error(`OpenCode ${label} failed: ${error.message} (${detail})`, { cause: error });
    wrapped.code = error.cause?.code ?? null;
    throw wrapped;
  }
}

function trimBaseUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

// Matches OpenCode's own client convention: HTTP Basic with the password from
// OPENCODE_SERVER_PASSWORD and a username defaulting to "opencode". On a
// password-protected server (v1.17.15) every route requires this header,
// including /global/health and the /event stream.
export function buildBasicAuthHeader(credentials = {}) {
  const password = typeof credentials.password === "string" && credentials.password ? credentials.password : null;
  if (!password) {
    return null;
  }
  const username =
    typeof credentials.username === "string" && credentials.username ? credentials.username : "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

async function parseResponseBody(response) {
  const text = await response.text();
  return parseBodyText(text, response.headers.get("content-type") ?? "");
}

function parseBodyText(text, contentType = "") {
  if (!text) {
    return {};
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function requestWithFreshConnection(url, options = {}) {
  const transport = url.protocol === "https:" ? https : http;
  const body = options.body == null ? null : JSON.stringify(options.body);
  const requestTimeoutMs = Math.max(
    0,
    Number(options.requestTimeoutMs ?? DEFAULT_FRESH_CONNECTION_TIMEOUT_MS) || DEFAULT_FRESH_CONNECTION_TIMEOUT_MS
  );
  const headers = {
    ...(body == null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
    ...(options.headers ?? {}),
    connection: "close"
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseEnded = false;

    function settle(fn, value) {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    }

    function resolveOnce(value) {
      settle(resolve, value);
    }

    function rejectOnce(error) {
      settle(reject, error);
    }

    function transportError(message) {
      return new Error(`OpenCode ${options.method} ${options.path} ${message}.`);
    }

    const req = transport.request(
      url,
      {
        method: options.method,
        headers,
        agent: false,
        signal: options.signal
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          responseEnded = true;
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            rejectOnce(
              new OpencodeHttpError(`OpenCode ${options.method} ${options.path} failed with HTTP ${res.statusCode}.`, {
                status: res.statusCode,
                body: text,
                url: url.href
              })
            );
            return;
          }

          try {
            const contentType = res.headers["content-type"];
            resolveOnce(parseBodyText(text, Array.isArray(contentType) ? contentType.join(";") : contentType ?? ""));
          } catch (error) {
            rejectOnce(error);
          }
        });
        res.on("aborted", () => rejectOnce(transportError("response aborted before completion")));
        res.on("error", rejectOnce);
        res.on("close", () => {
          if (!responseEnded) {
            rejectOnce(transportError("response closed before completion"));
          }
        });
      }
    );
    req.on("error", rejectOnce);
    req.on("close", () => {
      if (!responseEnded) {
        rejectOnce(transportError("request closed before response completion"));
      }
    });
    if (requestTimeoutMs > 0) {
      req.setTimeout(requestTimeoutMs, () => {
        const error = transportError(`timed out after ${requestTimeoutMs}ms`);
        rejectOnce(error);
        req.destroy(error);
      });
    }
    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}

function parseSseBlock(block) {
  const event = {
    eventName: "message",
    id: null,
    data: ""
  };
  const dataLines = [];

  for (const rawLine of block.replace(/\r/g, "").split("\n")) {
    if (!rawLine || rawLine.startsWith(":")) {
      continue;
    }
    const colonIndex = rawLine.indexOf(":");
    const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : rawLine.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event.eventName = value || "message";
    } else if (field === "id") {
      event.id = value || null;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  event.data = dataLines.join("\n");
  return event;
}

async function dispatchSseBlocks(buffer, onEvent) {
  let nextBuffer = buffer;
  for (;;) {
    const normalized = nextBuffer.replace(/\r\n/g, "\n");
    const blockEnd = normalized.indexOf("\n\n");
    if (blockEnd === -1) {
      return nextBuffer;
    }

    const block = normalized.slice(0, blockEnd);
    nextBuffer = normalized.slice(blockEnd + 2);
    if (!block.trim()) {
      continue;
    }

    const parsed = parseSseBlock(block);
    if (!parsed.data) {
      continue;
    }

    let data;
    try {
      data = JSON.parse(parsed.data);
    } catch {
      data = parsed.data;
    }
    await onEvent(data, {
      eventName: parsed.eventName,
      id: parsed.id,
      raw: block
    });
  }
}

export class OpencodeServerClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.authorization = buildBasicAuthHeader(options);
    this.directory = typeof options.directory === "string" && options.directory ? options.directory : null;
    if (!this.baseUrl) {
      throw new Error("OpenCode server URL is required.");
    }
    if (typeof this.fetch !== "function") {
      throw new Error("OpenCode server client requires global fetch (Node >= 18).");
    }
  }

  url(path) {
    const suffix = String(path ?? "").startsWith("/") ? path : `/${path}`;
    const base = `${this.baseUrl}${suffix}`;
    // Bind project-scoped requests to the invoking workspace. Without the
    // `directory` query an external server resolves them against its own
    // launch directory (issue #29). Every non-/global/ route the client uses
    // accepts it (verified against the 1.17.15 OpenAPI document).
    if (!this.directory || suffix.startsWith("/global/")) {
      return base;
    }
    const separator = suffix.includes("?") ? "&" : "?";
    return `${base}${separator}directory=${encodeURIComponent(this.directory)}`;
  }

  authHeaders() {
    return this.authorization ? { authorization: this.authorization } : {};
  }

  async request(method, path, options = {}) {
    const url = this.url(path);
    if (options.freshConnection) {
      return requestWithFreshConnection(new URL(url), {
        method,
        path,
        headers: {
          ...this.authHeaders(),
          ...(options.headers ?? {})
        },
        body: options.body,
        signal: options.signal,
        requestTimeoutMs: options.requestTimeoutMs
      });
    }

    const headers = {
      ...(options.body == null ? {} : { "content-type": "application/json" }),
      ...this.authHeaders(),
      ...(options.headers ?? {})
    };
    const response = await fetchWithCause(
      this.fetch,
      url,
      {
        method,
        headers,
        body: options.body == null ? undefined : JSON.stringify(options.body),
        signal: options.signal
      },
      `${method} ${path}`
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpencodeHttpError(`OpenCode ${method} ${path} failed with HTTP ${response.status}.`, {
        status: response.status,
        body,
        url
      });
    }

    return parseResponseBody(response);
  }

  createSession(params = {}, options = {}) {
    return this.request("POST", "/session", {
      body: params,
      signal: options.signal
    });
  }

  sendMessage(sessionID, params = {}, options = {}) {
    return this.request("POST", `/session/${encodePathSegment(sessionID)}/message`, {
      body: params,
      signal: options.signal
    });
  }

  promptAsync(sessionID, params = {}, options = {}) {
    return this.request("POST", `/session/${encodePathSegment(sessionID)}/prompt_async`, {
      body: params,
      signal: options.signal
    });
  }

  abort(sessionID, options = {}) {
    return this.request("POST", `/session/${encodePathSegment(sessionID)}/abort`, {
      body: options.body ?? {},
      signal: options.signal
    });
  }

  deleteSession(sessionID, options = {}) {
    return this.request("DELETE", `/session/${encodePathSegment(sessionID)}`, { signal: options.signal });
  }

  getConfig(options = {}) {
    return this.request("GET", "/config", { signal: options.signal });
  }

  getProvider(options = {}) {
    return this.request("GET", "/provider", { signal: options.signal });
  }

  listSessions(options = {}) {
    return this.request("GET", "/session", { signal: options.signal });
  }

  listMessages(sessionID, options = {}) {
    return this.request("GET", `/session/${encodePathSegment(sessionID)}/message`, {
      signal: options.signal,
      freshConnection: options.freshConnection,
      requestTimeoutMs: options.requestTimeoutMs
    });
  }

  respondPermission(sessionID, permissionID, response = "always", options = {}) {
    return this.request("POST", `/session/${encodePathSegment(sessionID)}/permissions/${encodePathSegment(permissionID)}`, {
      body: { response },
      signal: options.signal
    });
  }

  rejectQuestion(requestID, options = {}) {
    // The reject route takes no request body.
    return this.request("POST", `/question/${encodePathSegment(requestID)}/reject`, {
      signal: options.signal
    });
  }

  async health(options = {}) {
    const body = await this.request("GET", "/global/health", {
      signal: options.signal,
      headers: options.closeConnection ? { connection: "close" } : undefined
    });
    // OpenCode 1.x answers {"healthy":true,"version":"..."}. OpenCode 2.x serves
    // its web UI (HTML, HTTP 200) on this retired route, so anything else is not
    // a server this plugin can drive.
    if (!body || typeof body !== "object" || body.healthy !== true) {
      throw new Error("OpenCode GET /global/health did not return an OpenCode 1.x health response.");
    }
    const versionInfo = parseOpencodeVersionInfo(body.version);
    if (versionInfo && versionInfo.major > SUPPORTED_OPENCODE_MAJOR) {
      throw unsupportedOpencodeVersionError(versionInfo.version);
    }
    return body;
  }

  dispose(options = {}) {
    return this.request("POST", "/global/dispose", {
      body: {},
      signal: options.signal
    });
  }

  async subscribeEvents(onEvent, options = {}) {
    const response = await this.fetch(this.url("/event"), {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...this.authHeaders()
      },
      signal: options.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpencodeHttpError(`OpenCode GET /event failed with HTTP ${response.status}.`, {
        status: response.status,
        body,
        url: this.url("/event")
      });
    }
    if (!response.body) {
      throw new Error("OpenCode event stream did not include a response body.");
    }

    return consumeEventStream(response, onEvent, options);
  }
}

// Shared by the 1.x and 2.x clients: both servers stream `data:` blocks.
export async function consumeEventStream(response, onEvent, options = {}) {
  let reader;
  try {
    options.onOpen?.();
    reader = response.body.getReader();
  } catch (error) {
    if (reader) {
      await reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // Preserve the original onOpen/getReader failure.
      }
    } else {
      await response.body.cancel().catch(() => {});
    }
    throw error;
  }
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = await dispatchSseBlocks(buffer, onEvent);
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await dispatchSseBlocks(`${buffer}\n\n`, onEvent);
    }
  } finally {
    reader.releaseLock();
  }
}
