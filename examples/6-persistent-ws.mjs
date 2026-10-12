// Scenario 6: WebSocket · persistent session (RAO stores history).
//
//   POST {baseUrl}/api/v1/agent/{agent_id}/sessions                        -> { uuid }
//   POST {baseUrl}/api/v1/account/{account_id}/kb/{kb_id}/ephemeral_tokens  { agent_session: uuid }
//   WS   {wsBaseUrl}/api/v1/agent/{agent_id}/session/{uuid}/ws?eph-token=...&workflow_id=...
//
// RAO stores every exchange against the session, so the client sends only the new
// question and keeps nothing but the session id. Create one session per conversation.
// Note: a fresh ephemeral token is still minted per socket; the token is an auth
// credential for the connection, the session id is the conversation identity.

import { config, QUESTIONS, createSession, createEphemeralToken, askOverWebSocket } from "./common.mjs";

const sessionId = await createSession({ summary: "Scenario 6: persistent WebSocket example" });
console.log(`Session ${sessionId} created`);

for (const question of QUESTIONS) {
  console.log(`\nQ: ${question}   (no chat_history; RAO remembers via session ${sessionId})`);

  const token = await createEphemeralToken(sessionId);
  const url =
    `${config.wsBaseUrl}/api/v1/agent/${config.agentId}/session/${sessionId}/ws` +
    `?eph-token=${encodeURIComponent(token)}&workflow_id=${config.workflowId}`;

  const answer = await askOverWebSocket(url, {
    question,
    operation: 0,
    headers: {},
    // No chat_history: sending one would override the stored history for this request only.
  });
  console.log(`A: ${answer.slice(0, 400)}`);
}

console.log(`\nDone. Inspect the stored session: GET ${config.baseUrl}/api/v1/agent/${config.agentId}/session/${sessionId}`);
