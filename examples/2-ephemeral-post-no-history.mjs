// Scenario 2: HTTP POST · ephemeral session · history OFF.
//
//   POST {baseUrl}/api/v1/agent/{agent_id}/session/ephemeral?workflow_id=...
//   Authorization: Bearer {RAO_API_KEY}
//
// Identical wire to scenario 1 but no `chat_history` is sent, so every question is
// answered in isolation. This is the baseline to compare the other scenarios against:
// the second default question ("Summarise your previous answer") should fail here.

import { config, QUESTIONS, consumeJsonStream } from "./common.mjs";

const url = `${config.baseUrl}/api/v1/agent/${config.agentId}/session/ephemeral?workflow_id=${config.workflowId}`;

for (const question of QUESTIONS) {
  console.log(`\nQ: ${question}   (no history sent)`);

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
