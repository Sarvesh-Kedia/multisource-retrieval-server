// Scenario 5: WebSocket · ephemeral session · history OFF.
//
//   POST {baseUrl}/api/v1/account/{account_id}/kb/{kb_id}/ephemeral_tokens  { agent_session: "ephemeral" }
//   WS   {wsBaseUrl}/api/v1/agent/{agent_id}/session/ephemeral/ws?eph-token=...&workflow_id=...
//
// Identical wire to scenario 4 but no `chat_history` is sent, so every question is
// answered in isolation. Baseline for the WebSocket transport.

import { config, QUESTIONS, createEphemeralToken, askOverWebSocket } from "./common.mjs";

for (const question of QUESTIONS) {
  console.log(`\nQ: ${question}   (no history sent)`);

  const token = await createEphemeralToken("ephemeral");
  const url =
    `${config.wsBaseUrl}/api/v1/agent/${config.agentId}/session/ephemeral/ws` +
    `?eph-token=${encodeURIComponent(token)}&workflow_id=${config.workflowId}`;

  const answer = await askOverWebSocket(url, { question, operation: 0, headers: {} });
  console.log(`A: ${answer.slice(0, 400)}`);
}
