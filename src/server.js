import { createServer } from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * RAO demo relay server.
 *
 * Two independent switches describe how a question reaches the RAO agent:
 *
 *   transport    "post" | "ws"            how bytes move (HTTP POST stream vs WebSocket)
 *   sessionMode  "ephemeral" | "persistent"  who remembers the conversation
 *
 *   ephemeral   -> RAO path uses the literal session id "ephemeral". Nothing is stored
 *                  server-side, so the client must resend `chat_history` on every turn.
 *   persistent  -> RAO path uses a real session id (created via POST /sessions). RAO
 *                  stores every exchange, so the client omits `chat_history` and only
 *                  keeps the session id. Sending `chat_history` on a persistent session
 *                  overrides the stored history for that one request only.
 *
 * Both transports hit the same two path templates; only {session_id} changes:
 *   POST  {baseUrl}/api/v1/agent/{agent_id}/session/{session_id}?workflow_id=...
 *   WS    {wsBaseUrl}/api/v1/agent/{agent_id}/session/{session_id}/ws?eph-token=...&workflow_id=...
 */

loadEnvFile();

const SESSION_MODES = new Set(["ephemeral", "persistent"]);
const EPHEMERAL_SESSION_ID = "ephemeral";

const config = buildConfig();
const server = createServer(async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "rao-mvp-backend" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/config") {
      sendJson(res, 200, {
        ok: true,
        baseUrl: config.baseUrl,
        wsBaseUrl: config.wsBaseUrl,
        agentId: config.agentId,
        kbId: config.kbId,
        workflowId: config.workflowId,
        hasApiKey: Boolean(config.apiKey),
        hasAccountId: Boolean(config.accountId),
      });
      return;
    }

    // ---- Session management (only meaningful for sessionMode "persistent") ----

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = await raoRequest({ method: "GET", path: config.sessionsPath });
      sendJson(res, 200, sessions);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody(req);
      const session = await createSession(body ?? {});
      sendJson(res, 201, session);
      return;
    }

    if (url.pathname.startsWith("/api/sessions/") && (req.method === "GET" || req.method === "DELETE")) {
      const sessionId = decodeURIComponent(url.pathname.split("/").pop());
      const result = await raoRequest({
        method: req.method,
        path: renderSessionPath(config.sessionPathTemplate, sessionId),
      });
      sendJson(res, 200, result ?? { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ephemeral-token") {
      const body = await readJsonBody(req);
      const sessionId = body?.sessionId || EPHEMERAL_SESSION_ID;
      const token = await createEphemeralToken(sessionId);
      sendJson(res, 201, token);
      return;
    }

    // ---- Interactions (SSE out, either transport in) ----

    if (req.method === "POST" && url.pathname === "/api/interactions/stream") {
      await streamInteractionViaWebSocket(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/interactions/stream-post") {
      await streamInteractionViaPost(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: error.message || "Internal server error",
      details: error.details || null,
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`RAO MVP backend listening on http://${config.host}:${config.port}`);
});

// ---------------------------------------------------------------------------
// Transport 1: WebSocket upstream  ->  SSE downstream
// ---------------------------------------------------------------------------

async function streamInteractionViaWebSocket(req, res) {
  const prepared = await prepareInteraction(req, res);
  if (!prepared) return;
  const { interactionRequest, workflowId, session, streamId } = prepared;

  // Each WebSocket connection needs a fresh short-lived token bound to the session id
  // ("ephemeral" or a real one). The long-lived API key never reaches the browser.
  const eph = await createEphemeralToken(session.id);
  const ephToken = eph?.token;
  if (!ephToken) {
    throw createError(502, "Ephemeral token response did not include token", eph);
  }

  const wsUrl = buildWebSocketUrl({ sessionId: session.id, ephToken, workflowId });

  startSseResponse(res);
  writeSse(res, "ready", { streamId, ...session, transport: "ws", upstream: redactUrl(wsUrl) });

  const socket = new WebSocket(wsUrl);
  let closed = false;

  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    res.end();
  };

  req.on("close", closeStream);

  socket.addEventListener("open", () => {
    writeSse(res, "socket_open", { streamId, sessionId: session.id });
    socket.send(JSON.stringify(interactionRequest));
    writeSse(res, "request_sent", { streamId });
  });

  socket.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    let parsed = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Preserve the raw payload if the backend sends non-JSON messages.
    }

    writeSse(res, "packet", parsed);

    const completion = detectCompletion(parsed);
    if (completion) {
      writeSse(res, "complete", { streamId, ...completion });
      closeStream();
    }
  });

  socket.addEventListener("error", () => {
    writeSse(res, "error", { streamId, message: "WebSocket connection failed" });
    closeStream();
  });

  socket.addEventListener("close", (event) => {
    writeSse(res, "socket_close", { streamId, code: event.code, reason: event.reason || null });
    closeStream();
  });
}

// ---------------------------------------------------------------------------
// Transport 2: HTTP POST (concatenated JSON stream) upstream  ->  SSE downstream
// ---------------------------------------------------------------------------

async function streamInteractionViaPost(req, res) {
  const prepared = await prepareInteraction(req, res);
  if (!prepared) return;
  const { interactionRequest, workflowId, session, streamId } = prepared;

  const postUrl = new URL(renderSessionPath(config.interactionPathTemplate, session.id), config.baseUrl);
  if (workflowId) postUrl.searchParams.set("workflow_id", workflowId);

  startSseResponse(res);
  writeSse(res, "ready", { streamId, ...session, transport: "post", upstream: postUrl.toString() });

  const upstream = await fetch(postUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(interactionRequest),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    writeSse(res, "error", { streamId, message: `RAO POST failed (${upstream.status}): ${text}` });
    res.end();
    return;
  }

  writeSse(res, "socket_open", { streamId, sessionId: session.id });
  writeSse(res, "request_sent", { streamId });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  let emittedComplete = false;

  req.on("close", () => {
    if (!closed) {
      closed = true;
      reader.cancel().catch(() => {});
    }
  });

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { objects, remaining } = extractJsonObjects(buffer);
      buffer = remaining;

      for (const obj of objects) {
        writeSse(res, "packet", obj);

        const completion = detectCompletion(obj);
        if (completion) {
          writeSse(res, "complete", { streamId, ...completion });
          emittedComplete = true;
          closed = true;
          break;
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
    if (!emittedComplete) {
      writeSse(res, "complete", { streamId, packetType: null, operation: null });
    }
    writeSse(res, "socket_close", { streamId, code: 1000, reason: null });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Shared request handling
// ---------------------------------------------------------------------------

/**
 * Parses the browser request and resolves which RAO session id to talk to.
 * Returns null after writing a 400 when the body is invalid.
 */
async function prepareInteraction(req, res) {
  const body = await readJsonBody(req);

  const interactionRequest = normalizeInteractionRequest(body?.interactionRequest);
  if (!interactionRequest) {
    sendJson(res, 400, { error: "interactionRequest is required and must be an object" });
    return null;
  }

  const sessionMode = String(body?.sessionMode || "ephemeral").toLowerCase();
  if (!SESSION_MODES.has(sessionMode)) {
    sendJson(res, 400, { error: `sessionMode must be one of: ${[...SESSION_MODES].join(", ")}` });
    return null;
  }

  const session = await resolveSession({
    sessionMode,
    sessionId: body?.sessionId ?? null,
    sessionCreatePayload: body?.sessionCreatePayload ?? {},
  });

  return {
    interactionRequest,
    workflowId: body?.workflowId ?? config.workflowId,
    session,
    streamId: randomUUID(),
  };
}

/**
 * ephemeral  -> always the literal id "ephemeral"; RAO stores nothing.
 * persistent -> the caller's session id, or a freshly created one when absent.
 */
async function resolveSession({ sessionMode, sessionId, sessionCreatePayload }) {
  if (sessionMode === "ephemeral") {
    return { sessionId: EPHEMERAL_SESSION_ID, id: EPHEMERAL_SESSION_ID, sessionMode, sessionCreated: false };
  }

  if (sessionId && sessionId !== EPHEMERAL_SESSION_ID) {
    return { sessionId, id: sessionId, sessionMode, sessionCreated: false };
  }

  const session = await createSession(sessionCreatePayload);
  const id = session?.uuid || session?.id || session?.session_id || session?.sessionId || null;
  if (!id) {
    throw createError(502, "Session was created but no session id was found in the response", session);
  }
  return { sessionId: id, id, sessionMode, sessionCreated: true };
}

/**
 * Shape sent upstream on both transports. `chat_history` is forwarded only when the
 * client sent an array, so omitting it keeps RAO's server-side history (persistent mode)
 * and sending [] explicitly clears context for that request.
 */
function normalizeInteractionRequest(request) {
  if (!request || typeof request !== "object") {
    return null;
  }

  const normalized = {
    operation: 0,
    ...request,
    headers: request.headers && typeof request.headers === "object" ? request.headers : {},
  };

  if (Array.isArray(request.chat_history)) {
    normalized.chat_history = request.chat_history
      .filter((turn) => turn && typeof turn === "object")
      .map((turn) => ({ question: String(turn.question ?? ""), answer: String(turn.answer ?? "") }));
  } else {
    delete normalized.chat_history;
  }

  return normalized;
}

function detectCompletion(packet) {
  if (typeof packet !== "object" || packet === null) return null;
  const packetType = String(packet.type || packet.kind || packet.event || "").toUpperCase();
  const operationCode = Number(packet.operation);
  if (packetType === "DONE" || packetType === "ERROR" || operationCode === 3 || operationCode === 4) {
    return {
      packetType: packetType || null,
      operation: Number.isNaN(operationCode) ? null : operationCode,
    };
  }
  return null;
}

function extractJsonObjects(buffer) {
  const objects = [];
  let i = 0;

  while (i < buffer.length) {
    while (i < buffer.length && /\s/.test(buffer[i])) i++;
    if (i >= buffer.length || buffer[i] !== "{") {
      if (i < buffer.length) i++;
      continue;
    }

    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;

    for (; j < buffer.length; j++) {
      const c = buffer[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth === 0 && j < buffer.length) {
      try {
        objects.push(JSON.parse(buffer.slice(i, j + 1)));
      } catch {}
      i = j + 1;
    } else {
      break;
    }
  }

  return { objects, remaining: buffer.slice(i) };
}

// ---------------------------------------------------------------------------
// RAO REST helpers
// ---------------------------------------------------------------------------

async function createEphemeralToken(sessionId) {
  const path = renderTemplate(config.ephemeralTokensPathTemplate, {
    agent_id: config.agentId,
    session_id: sessionId,
    account_id: config.accountId,
    kb_id: config.kbId,
  });

  return raoRequest({
    method: "POST",
    path,
    body: {
      agent_session: sessionId,
    },
  });
}

/**
 * RAO requires slug, name, summary, data and format on create. Callers may pass any
 * subset; the rest is filled with demo defaults so `{}` is a valid create payload.
 */
function buildSessionCreatePayload(payload = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  return {
    slug: `rao-demo-${stamp}`,
    name: `RAO demo ${stamp}`,
    summary: "Conversation created by the RAO demo UI",
    data: "",
    format: "PLAIN",
    ...payload,
  };
}

async function createSession(rawPayload) {
  const payload = buildSessionCreatePayload(rawPayload ?? {});
  try {
    return await raoRequest({
      method: "POST",
      path: config.sessionsPath,
      body: payload,
    });
  } catch (error) {
    if (!shouldRecoverSessionCreate(error, payload)) {
      throw error;
    }

    const session = await findSessionBySlug(payload.slug);
    if (!session) {
      throw error;
    }

    return session;
  }
}

async function findSessionBySlug(slug) {
  const response = await raoRequest({
    method: "GET",
    path: config.sessionsPath,
  });

  const resources = Array.isArray(response?.resources) ? response.resources : [];
  return resources.find((resource) => resource?.slug === slug) ?? null;
}

function shouldRecoverSessionCreate(error, payload) {
  if (!payload?.slug || error?.statusCode !== 422) {
    return false;
  }

  const detail = error?.details?.detail;
  return detail === "Failed to create session";
}

async function raoRequest({ method, path, body }) {
  const url = new URL(path, config.baseUrl);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = tryParseJson(text);

  if (!response.ok) {
    throw createError(
      response.status,
      `RAO request failed: ${method} ${url.pathname}`,
      data ?? text,
    );
  }

  return data ?? (text ? { raw: text } : null);
}

function buildWebSocketUrl({ sessionId, ephToken, workflowId }) {
  const url = new URL(renderSessionPath(config.websocketPathTemplate, sessionId), config.wsBaseUrl);
  url.searchParams.set("eph-token", ephToken);
  if (workflowId) {
    url.searchParams.set("workflow_id", workflowId);
  }
  return url.toString();
}

function renderSessionPath(template, sessionId) {
  return renderTemplate(template, {
    agent_id: config.agentId,
    session_id: sessionId,
    account_id: config.accountId,
    kb_id: config.kbId,
  });
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("eph-token")) url.searchParams.set("eph-token", "<redacted>");
    return url.toString();
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function buildConfig() {
  const baseUrl = requiredEnv("RAO_BASE_URL");
  const agentId = requiredEnv("RAO_AGENT_ID");
  const apiKey = requiredEnv("RAO_API_KEY");
  const accountId = process.env.RAO_ACCOUNT_ID || "";
  const kbId = process.env.RAO_KB_ID || agentId;
  const wsBaseUrl =
    process.env.RAO_WS_BASE_URL ||
    baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");

  // Session CRUD
  const sessionsPathTemplate =
    process.env.RAO_SESSIONS_PATH_TEMPLATE || "/api/v1/agent/{agent_id}/sessions";
  const sessionPathTemplate =
    process.env.RAO_SESSION_PATH_TEMPLATE || "/api/v1/agent/{agent_id}/session/{session_id}";
  const ephemeralTokensPathTemplate =
    process.env.RAO_EPHEMERAL_TOKENS_PATH_TEMPLATE ||
    "/api/v1/account/{account_id}/kb/{kb_id}/ephemeral_tokens";

  // Interactions. {session_id} is "ephemeral" or a real session id depending on sessionMode.
  const interactionPathTemplate =
    process.env.RAO_INTERACTION_PATH_TEMPLATE ||
    process.env.RAO_POST_INTERACTION_PATH_TEMPLATE ||
    "/api/v1/agent/{agent_id}/session/{session_id}";
  const websocketPathTemplate =
    process.env.RAO_WEBSOCKET_PATH_TEMPLATE ||
    "/api/v1/agent/{agent_id}/session/{session_id}/ws";
  const workflowId = process.env.RAO_WORKFLOW_ID || "default";

  for (const [name, template] of [
    ["RAO_INTERACTION_PATH_TEMPLATE", interactionPathTemplate],
    ["RAO_WEBSOCKET_PATH_TEMPLATE", websocketPathTemplate],
  ]) {
    if (!template.includes("{session_id}")) {
      console.warn(
        `[config] ${name} has no {session_id} placeholder; sessionMode will have no effect on that transport.`,
      );
    }
  }

  return {
    port: Number(process.env.PORT || 3001),
    host: process.env.HOST || "0.0.0.0",
    baseUrl,
    wsBaseUrl,
    agentId,
    apiKey,
    accountId,
    kbId,
    sessionsPath: renderTemplate(sessionsPathTemplate, {
      agent_id: agentId,
      account_id: accountId,
      kb_id: kbId,
    }),
    sessionPathTemplate,
    ephemeralTokensPathTemplate,
    interactionPathTemplate,
    websocketPathTemplate,
    workflowId,
  };
}

function renderTemplate(template, values) {
  return template.replace(/\{([a-z_]+)\}/gi, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

function loadEnvFile() {
  const file = `${process.cwd()}/.env`;
  try {
    const data = readFileSync(file, "utf8");
    for (const line of data.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const idx = trimmed.indexOf("=");
      if (idx === -1) {
        continue;
      }

      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional for local development.
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw createError(500, `Missing required environment variable ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}

function sendJson(res, statusCode, data) {
  if (res.writableEnded) {
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data, null, 2));
}

function startSseResponse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function tryParseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}
