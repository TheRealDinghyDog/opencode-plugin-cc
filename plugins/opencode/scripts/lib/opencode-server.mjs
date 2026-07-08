export class OpencodeHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OpencodeHttpError";
    this.status = options.status ?? null;
    this.body = options.body ?? "";
    this.url = options.url ?? null;
  }
}

function trimBaseUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
    if (!this.baseUrl) {
      throw new Error("OpenCode server URL is required.");
    }
    if (typeof this.fetch !== "function") {
      throw new Error("OpenCode server client requires global fetch (Node >= 18).");
    }
  }

  url(path) {
    const suffix = String(path ?? "").startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${suffix}`;
  }

  async request(method, path, options = {}) {
    const url = this.url(path);
    const headers = {
      ...(options.body == null ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {})
    };
    const response = await this.fetch(url, {
      method,
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });

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
      signal: options.signal
    });
  }

  respondPermission(sessionID, permissionID, response = "always", options = {}) {
    return this.request("POST", `/session/${encodePathSegment(sessionID)}/permissions/${encodePathSegment(permissionID)}`, {
      body: { response },
      signal: options.signal
    });
  }

  health(options = {}) {
    return this.request("GET", "/global/health", { signal: options.signal });
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
        accept: "text/event-stream"
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

    options.onOpen?.();

    const reader = response.body.getReader();
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
}
