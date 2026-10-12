// Scenario 3: HTTP POST · persistent session (RAO stores history).
//
//   POST {baseUrl}/api/v1/agent/{agent_id}/sessions                   -> { uuid }
//   POST {baseUrl}/api/v1/agent/{agent_id}/session/{uuid}?workflow_id=...
//   Authorization: Bearer {RAO_API_KEY}
//
// Same memory model as scenario 6 (RAO keeps the transcript), same wire as scenario 1. The
// simplest server-to-server option when you want multi-turn without holding state.

import { config, QUESTIONS, createSession, consumeJsonStream } from "./common.mjs";

const sessionId = await createSession({ summary: "Scenario 3: persistent POST example" });
console.log(`Session ${sessionId} created`);

const url = `${config.baseUrl}/api/v1/agent/${config.agentId}/session/${sessionId}?workflow_id=${config.workflowId}`;

for (const question of QUESTIONS) {
  console.log(`\nQ: ${question}   (no chat_history; RAO remembers via session ${sessionId})`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question, operation: 0, headers: {} }),
  });
  if (!response.ok) throw new Error(`POST failed (${response.status}): ${await response.text()}`);

  const answer = await consumeJsonStream(response.body);
  console.log(`A: ${answer.slice(0, 400)}`);
}
