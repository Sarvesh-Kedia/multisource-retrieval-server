import { createServer } from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

loadEnvFile();

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
        hasApiKey: Boolean(config.apiKey),
        hasAccountId: Boolean(config.accountId),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody(req);
      const payload = body ?? {};
      const session = await createSession(payload);
      sendJson(res, 201, session);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const sessionId = decodeURIComponent(url.pathname.split("/").pop());
      const session = await raoRequest({
        method: "GET",
        path: renderTemplate(config.sessionPathTemplate, {
          agent_id: config.agentId,
          session_id: sessionId,
          account_id: config.accountId,
          kb_id: config.kbId,
        }),
      });
      sendJson(res, 200, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ephemeral-token") {
      const body = await readJsonBody(req);
      const sessionId = body?.sessionId;
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }

      const token = await createEphemeralToken(sessionId);
      sendJson(res, 201, token);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/interactions/stream") {
      await streamInteraction(req, res);
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

async function streamInteraction(req, res) {
  const { sessionCreatePayload, interactionRequest, workflowId, sessionId: rawSessionId } =
    await parseStreamRequest(req);

  if (!interactionRequest) {
    sendJson(res, 400, { error: "interactionRequest is required and must be an object" });
    return;
  }

  const sessionId = await resolveSessionId(rawSessionId, sessionCreatePayload);

  const eph = await createEphemeralToken(sessionId);
  const ephToken = eph?.token;
  if (!ephToken) {
    throw createError(502, "Ephemeral token response did not include token", eph);
  }

  const wsUrl = buildWebSocketUrl({ sessionId, ephToken, workflowId });
  const streamId = randomUUID();

  startSseResponse(res);
  writeSse(res, "ready", { streamId, sessionId });

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
    writeSse(res, "socket_open", { streamId, sessionId });
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

async function streamInteractionViaPost(req, res) {
  const { sessionCreatePayload, interactionRequest, workflowId, sessionId: rawSessionId } =
    await parseStreamRequest(req);

  if (!interactionRequest) {
    sendJson(res, 400, { error: "interactionRequest is required and must be an object" });
    return;
  }

  const sessionId = await resolveSessionId(rawSessionId, sessionCreatePayload);

  const postPath = renderTemplate(config.postInteractionPathTemplate, {
    agent_id: config.agentId,
    session_id: sessionId,
    account_id: config.accountId,
    kb_id: config.kbId,
  });

  const postUrl = new URL(postPath, config.baseUrl);
  if (workflowId) postUrl.searchParams.set("workflow_id", workflowId);

  const streamId = randomUUID();

  startSseResponse(res);
  writeSse(res, "ready", { streamId, sessionId });

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

  writeSse(res, "socket_open", { streamId, sessionId });
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

async function parseStreamRequest(req) {
  const body = await readJsonBody(req);
  return {
    sessionCreatePayload: body?.sessionCreatePayload ?? {},
    interactionRequest: normalizeInteractionRequest(body?.interactionRequest),
    workflowId: body?.workflowId ?? config.workflowId,
    sessionId: body?.sessionId ?? null,
  };
}

async function resolveSessionId(sessionId, sessionCreatePayload) {
  if (sessionId) return sessionId;
  const session = await createSession(sessionCreatePayload);
  const id = session?.uuid || session?.id || session?.session_id || session?.sessionId || null;
  if (!id) {
    throw createError(502, "Session was created but no session id was found in the response", session);
  }
  return id;
}

function startSseResponse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
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

async function createSession(payload) {
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

  return data ?? { raw: text };
}

function buildWebSocketUrl({ sessionId, ephToken, workflowId }) {
  const wsPath = renderTemplate(config.websocketPathTemplate, {
    agent_id: config.agentId,
    session_id: sessionId,
    account_id: config.accountId,
    kb_id: config.kbId,
  });

  const url = new URL(wsPath, config.wsBaseUrl);
  url.searchParams.set("eph-token", ephToken);
  if (workflowId) {
    url.searchParams.set("workflow_id", workflowId);
  }
  return url.toString();
}

function buildConfig() {
  const baseUrl = requiredEnv("RAO_BASE_URL");
  const agentId = requiredEnv("RAO_AGENT_ID");
  const apiKey = requiredEnv("RAO_API_KEY");
  const accountId = process.env.RAO_ACCOUNT_ID || "";
  const kbId = process.env.RAO_KB_ID || agentId;
  const wsBaseUrl =
    process.env.RAO_WS_BASE_URL ||
    baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const sessionsPathTemplate =
    process.env.RAO_SESSIONS_PATH_TEMPLATE || "/api/v1/agent/{agent_id}/sessions";
  const sessionPathTemplate =
    process.env.RAO_SESSION_PATH_TEMPLATE ||
    "/api/v1/agent/{agent_id}/sessions/{session_id}";
  const ephemeralTokensPathTemplate =
    process.env.RAO_EPHEMERAL_TOKENS_PATH_TEMPLATE ||
    "/api/v1/account/{account_id}/kb/{kb_id}/ephemeral_tokens";
  const websocketPathTemplate =
    process.env.RAO_WEBSOCKET_PATH_TEMPLATE ||
    "/api/v1/agent/{agent_id}/session/ephemeral/ws";
  const postInteractionPathTemplate =
    process.env.RAO_POST_INTERACTION_PATH_TEMPLATE ||
    "/api/v1/agent/{agent_id}/session/ephemeral";
  const workflowId = process.env.RAO_WORKFLOW_ID || "default";

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
    websocketPathTemplate,
    postInteractionPathTemplate,
    workflowId,
  };
}

function normalizeInteractionRequest(request) {
  if (!request || typeof request !== "object") {
    return null;
  }

  return {
    operation: 0,
    ...request,
    headers: request.headers && typeof request.headers === "object" ? request.headers : {},
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

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
