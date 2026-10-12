// Scenario 1: HTTP POST · ephemeral session · history ON (client sends chat_history).
//
//   POST {baseUrl}/api/v1/agent/{agent_id}/session/ephemeral?workflow_id=...
//   Authorization: Bearer {RAO_API_KEY}
//
// RAO stores nothing between requests. The client owns the transcript and resends the
// whole thing as `chat_history` on every turn. This is the stateless option: no session
// to create, nothing to clean up, and any server instance can serve any turn.

import { config, QUESTIONS, consumeJsonStream } from "./common.mjs";

const url = `${config.baseUrl}/api/v1/agent/${config.agentId}/session/ephemeral?workflow_id=${config.workflowId}`;
const history = []; // [{ question, answer }]

for (const question of QUESTIONS) {
  console.log(`\nQ: ${question}   (sending ${history.length} prior turn(s))`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question,
      operation: 0,
      headers: {},
      chat_history: history, // omit this and every turn is answered in isolation
    }),
  });
  if (!response.ok) throw new Error(`POST failed (${response.status}): ${await response.text()}`);

  const answer = await consumeJsonStream(response.body);
  console.log(`A: ${answer.slice(0, 400)}`);

  history.push({ question, answer });
}
