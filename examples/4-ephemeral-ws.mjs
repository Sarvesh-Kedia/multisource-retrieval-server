// Scenario 4: WebSocket · ephemeral session · history ON (client sends chat_history).
//
//   POST {baseUrl}/api/v1/account/{account_id}/kb/{kb_id}/ephemeral_tokens  { agent_session: "ephemeral" }
//   WS   {wsBaseUrl}/api/v1/agent/{agent_id}/session/ephemeral/ws?eph-token=...&workflow_id=...
//
// Same memory model as scenario 1 (client resends `chat_history`), different wire: one
// short-lived token and one socket per question. The socket is bidirectional, so this is
// the transport to pick when the agent may ask the user something mid-run (feedback /
// OAuth packets); the POST stream cannot carry a reply back.

import { config, QUESTIONS, createEphemeralToken, askOverWebSocket } from "./common.mjs";

const history = []; // [{ question, answer }]

for (const question of QUESTIONS) {
  console.log(`\nQ: ${question}   (sending ${history.length} prior turn(s))`);

  const token = await createEphemeralToken("ephemeral");
  const url =
    `${config.wsBaseUrl}/api/v1/agent/${config.agentId}/session/ephemeral/ws` +
    `?eph-token=${encodeURIComponent(token)}&workflow_id=${config.workflowId}`;

  const answer = await askOverWebSocket(url, {
    question,
    operation: 0,
    headers: {},
    chat_history: history,
  });
  console.log(`A: ${answer.slice(0, 400)}`);

  history.push({ question, answer });
}
