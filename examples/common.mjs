// Shared helpers for the standalone examples. Each example file shows one complete scenario
// from the root README matrix against the RAO API directly, with no relay server.
//
// Run from the server/ directory so ../.env resolves:   node examples/1-ephemeral-post.mjs
// Requires Node >= 22 (global fetch and WebSocket).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const file = join(here, "..", ".env");
  let data = "";
  try {
    data = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of data.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

// Print a one-line failure instead of a stack trace; these scripts are meant to be read.
for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (err) => {
    console.error(`\nFailed: ${err?.message || err}`);
    process.exit(1);
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  baseUrl: required("RAO_BASE_URL").replace(/\/$/, ""),
  wsBaseUrl: (process.env.RAO_WS_BASE_URL || required("RAO_BASE_URL"))
    .replace(/\/$/, "")
    .replace(/^https:/i, "wss:")
    .replace(/^http:/i, "ws:"),
  agentId: required("RAO_AGENT_ID"),
  apiKey: required("RAO_API_KEY"),
  accountId: process.env.RAO_ACCOUNT_ID || "",
  kbId: process.env.RAO_KB_ID || required("RAO_AGENT_ID"),
  workflowId: process.env.RAO_WORKFLOW_ID || "default",
};

/** Default two-turn conversation. The second question only makes sense with history. */
export const QUESTIONS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "What are Eastspring's top performing funds this year?",
      "Summarise your previous answer in one sentence.",
    ];

/** Authenticated JSON call to the RAO REST API using the long-lived API key. */
export async function raoFetch(path, { method = "GET", body } = {}) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Create a persistent session. RAO requires all five fields.
 * Returns the new session id.
 */
export async function createSession(overrides = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  const payload = {
    slug: `example-${stamp}`,
    name: `Example ${stamp}`,
    summary: "Created by server/examples",
    data: "",
    format: "PLAIN",
    ...overrides,
  };
  const created = await raoFetch(`/api/v1/agent/${config.agentId}/sessions`, {
    method: "POST",
    body: payload,
  });
  return created.uuid || created.id;
}

/**
 * Short-lived token for one WebSocket connection. `agentSession` is the literal
 * "ephemeral" or a real session id. The long-lived API key never goes on the socket URL.
 */
export async function createEphemeralToken(agentSession) {
  const result = await raoFetch(
    `/api/v1/account/${config.accountId}/kb/${config.kbId}/ephemeral_tokens`,
    { method: "POST", body: { agent_session: agentSession } },
  );
  if (!result?.token) throw new Error(`No token in ephemeral token response: ${JSON.stringify(result)}`);
  return result.token;
}

/** One-line log of an AragAnswer packet. */
export function printPacket(packet) {
  const op = packet?.operation;
  if (packet?.step) {
    console.log(`  [step ${op}] ${packet.step.module}: ${packet.step.title}`);
  } else if (packet?.context) {
    console.log(`  [context ${op}] ${packet.context.agent} (${packet.context.chunks?.length ?? 0} chunks)`);
  } else if (typeof packet?.answer === "string" && packet.answer) {
    console.log(`  [answer ${op}] ${packet.answer.slice(0, 120).replace(/\s+/g, " ")}…`);
  } else if (packet?.exception) {
    console.log(`  [error ${op}] ${packet.exception.detail}`);
  } else if (op === 2) {
    console.log("  [start]");
  } else if (op === 3) {
    console.log("  [done]");
  }
}

/**
 * The HTTP POST transport returns a stream of concatenated JSON objects with no
 * delimiter. This scans brace depth to split them and resolves with the final answer.
 */
export async function consumeJsonStream(body, onPacket = printPacket) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let error = null;

  const drain = () => {
    let i = 0;
    while (i < buffer.length) {
      while (i < buffer.length && /\s/.test(buffer[i])) i++;
      if (i >= buffer.length || buffer[i] !== "{") { if (i < buffer.length) i++; continue; }
      let depth = 0, inStr = false, esc = false, j = i;
      for (; j < buffer.length; j++) {
        const c = buffer[j];
        if (esc) { esc = false; continue; }
        if (inStr) { if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) break; }
      }
      if (depth !== 0 || j >= buffer.length) break;
      let packet = null;
      try { packet = JSON.parse(buffer.slice(i, j + 1)); } catch {}
      i = j + 1;
      if (packet) {
        onPacket(packet);
        if (packet.operation === 4) error = packet.exception?.detail || packet.answer || "Pipeline error";
        if (typeof packet.answer === "string" && packet.answer && packet.operation !== 4) answer = packet.answer;
      }
    }
    buffer = buffer.slice(i);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
  if (error) throw new Error(error);
  return answer;
}

/**
 * The WebSocket transport: open, send one interaction request, collect packets until
 * operation 3 (done) or 4 (error), then close. Resolves with the final answer.
 */
export function askOverWebSocket(url, request, onPacket = printPacket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let answer = "";
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000);
      }
      err ? reject(err) : resolve(answer);
    };

    socket.addEventListener("open", () => socket.send(JSON.stringify(request)));
    socket.addEventListener("message", (event) => {
      let packet;
      try { packet = JSON.parse(String(event.data)); } catch { return; }
      onPacket(packet);
      if (packet.operation === 4) return finish(new Error(packet.exception?.detail || packet.answer || "Pipeline error"));
      if (typeof packet.answer === "string" && packet.answer) answer = packet.answer;
      if (packet.operation === 3) finish();
    });
    socket.addEventListener("error", () => finish(new Error("WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (!settled && event.code !== 1000) finish(new Error(`WebSocket closed (${event.code})`));
      finish();
    });
  });
}
