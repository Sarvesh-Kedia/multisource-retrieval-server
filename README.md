# RAO Demo — Node Backend

Thin Node.js relay server for the RAO (Retrieval Agent Orchestrator) demo UI. It keeps API
credentials on the server, resolves which RAO session to talk to, and streams RAO API responses
to the browser as Server-Sent Events (SSE) regardless of the upstream transport.

For the full decision guide on session modes and transports see [BLUEPRINT.md](./BLUEPRINT.md).

## What it does

- Holds the long-lived `RAO_API_KEY` JWT — never exposed to the browser
- Resolves a **session mode** per request: `ephemeral` (nothing stored, client resends `chat_history`) or `persistent` (RAO stores history against a real session id)
- Creates sessions and mints short-lived ephemeral WebSocket tokens on demand
- Supports two upstream **transports**: WebSocket and HTTP POST; both produce identical SSE output
- Ships six standalone example scripts in `examples/`, one per scenario, that call RAO directly

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/config` | Non-secret config (base URL, agent ID, workflow ID) |
| `GET` | `/api/sessions` | List sessions stored on the agent |
| `POST` | `/api/sessions` | Create a RAO session (defaults filled for the five required fields) |
| `GET` | `/api/sessions/:sessionId` | Get one session, including stored conversation data |
| `DELETE` | `/api/sessions/:sessionId` | Delete a session |
| `POST` | `/api/ephemeral-token` | Mint a short-lived WebSocket token (`{ "sessionId": "ephemeral" \| "<id>" }`) |
| `POST` | `/api/interactions/stream` | Ask via WebSocket upstream (SSE out) |
| `POST` | `/api/interactions/stream-post` | Ask via HTTP POST upstream (SSE out) — recommended |

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:

| Variable | Purpose |
|---|---|
| `RAO_BASE_URL` | `https://<region>.dp.progress.cloud`; the region is shown in the agent's Settings section |
| `RAO_AGENT_ID` | Agent UUID, from the agent's Settings section |
| `RAO_API_KEY` | Long-lived JWT (RS256) — Bearer token for REST and HTTP POST streaming |
| `RAO_ACCOUNT_ID` | Account UUID (used in ephemeral token path) |
| `RAO_KB_ID` | Knowledge box UUID; for a RAO agent this is the same value as `RAO_AGENT_ID` (defaults to it) |
| `RAO_WORKFLOW_ID` | Workflow name sent as `?workflow_id=` (defaults to `"default"`) |
| `RAO_INTERACTION_PATH_TEMPLATE` | POST interaction path, default `/api/v1/agent/{agent_id}/session/{session_id}` |
| `RAO_WEBSOCKET_PATH_TEMPLATE` | WebSocket path, default `/api/v1/agent/{agent_id}/session/{session_id}/ws` |

`{session_id}` is filled with the literal `ephemeral` or a real session id depending on `sessionMode`.
Both templates must keep that placeholder, otherwise session mode has no effect on that transport
(the server warns at startup).

3. Start the server:

```bash
npm run dev
```

Server listens on `http://127.0.0.1:3001`.

## Interaction request body

Both streaming endpoints accept the same body:

```jsonc
{
  "sessionMode": "ephemeral",          // or "persistent"; default "ephemeral"
  "sessionId": "<id>",                 // persistent only; omit on first turn to create one
  "sessionCreatePayload": { },         // persistent only; optional overrides for the created session
  "workflowId": "default",             // optional
  "interactionRequest": {
    "question": "…",
    "operation": 0,
    "headers": {},
    "chat_history": [ { "question": "…", "answer": "…" } ]   // ephemeral only; forwarded only when an array
  }
}
```

`resolveSession()` applies the rule:

| `sessionMode` | `sessionId` given | Upstream `{session_id}` | `ready.sessionCreated` |
|---|---|---|---|
| `ephemeral` | ignored | `ephemeral` | `false` |
| `persistent` | yes | that id | `false` |
| `persistent` | no | newly created id | `true` |

`chat_history` is passed through untouched when the client sends an array and stripped otherwise, so
omitting it keeps RAO's stored history and sending `[]` clears context for one request.

## Usage examples

### Ephemeral with client-side history (stateless)

```bash
curl -N -X POST http://localhost:3001/api/interactions/stream-post \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionMode": "ephemeral",
    "interactionRequest": {
      "question": "Summarise your previous answer in one sentence.",
      "operation": 0,
      "headers": {},
      "chat_history": [
        { "question": "What are Eastspring'\''s top performing funds this year?", "answer": "<previous answer>" }
      ]
    }
  }'
```

### Persistent (RAO keeps history)

```bash
# turn 1: no sessionId, one gets created and reported on the `ready` event
curl -N -X POST http://localhost:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "persistent", "interactionRequest": { "question": "What are Eastspring'\''s top performing funds this year?", "operation": 0, "headers": {} } }'

# turn 2: reuse the id, send no chat_history
curl -N -X POST http://localhost:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "persistent", "sessionId": "<id from ready>", "interactionRequest": { "question": "Summarise your previous answer in one sentence.", "operation": 0, "headers": {} } }'
```

Swap `/stream` for `/stream-post` to change the upstream transport; the body is identical.

## Standalone examples

One script per scenario in the [scenario matrix in BLUEPRINT.md](./BLUEPRINT.md#the-scenario-matrix), calling RAO directly with no relay:

```bash
npm run example:1     # HTTP POST · ephemeral · history on   — /session/ephemeral, Bearer, chat_history resent each turn
npm run example:2     # HTTP POST · ephemeral · history off  — same, no chat_history
npm run example:3     # HTTP POST · persistent               — create session, /session/{id}, Bearer, no chat_history
npm run example:4     # WebSocket · ephemeral · history on   — eph-token for "ephemeral", /session/ephemeral/ws, chat_history resent
npm run example:5     # WebSocket · ephemeral · history off  — same, no chat_history
npm run example:6     # WebSocket · persistent               — create session, eph-token for it, /session/{id}/ws, no chat_history
```

Each script runs a two-turn conversation and prints every packet. Pass your own questions as arguments.

## Transport comparison

| | HTTP POST (`/stream-post`) | WebSocket (`/stream`) |
|---|---|---|
| **Auth to RAO** | `Authorization: Bearer {RAO_API_KEY}` | `?eph-token=` minted per connection for the resolved session id |
| **Answer quality** | Generally fuller answers; more MCP tool calls observed | Sometimes returns "Not enough data" for data-heavy questions |
| **Completion signal** | `operation: 3` packet in stream | `operation: 3` packet, then socket close |
| **Agent-to-user prompts** | Not possible | Supported (`feedback` / `oauth` packets) |
| **Recommended** | Yes (default in UI) | When the workflow needs user input mid-run |

Both transports produce identical SSE output to the browser and support both session modes.

## SSE events

| Event | When | Data |
|---|---|---|
| `ready` | Stream opened | `{ streamId, sessionId, sessionMode, sessionCreated, transport, upstream }` |
| `socket_open` | Upstream connected | `{ streamId, sessionId }` |
| `request_sent` | Question dispatched upstream | `{ streamId }` |
| `packet` | Every RAO API message | Raw RAO packet object |
| `complete` | Stream finished | `{ streamId, packetType, operation }` |
| `error` | Server-side failure | `{ streamId, message }` |
| `socket_close` | Upstream closed | `{ streamId, code, reason }` |

The frontend primarily listens for `packet` events and reads `sessionId` from `ready` in persistent
mode. Each packet is a JSON object with an `operation` field and one populated payload field (`step`,
`context`, `answer`, or `exception`). See `README.md` in the frontend for the full packet schema.

## Saving response artifacts

```bash
curl -s -N -X POST http://localhost:3001/api/interactions/stream-post \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "ephemeral", "interactionRequest": { "question": "YOUR QUESTION HERE", "operation": 0, "headers": {} } }' \
  > artifacts/response_<label>.txt
```

## Key source files

| File | Purpose |
|---|---|
| `BLUEPRINT.md` | Session modes × transports: the six-scenario matrix, history rules, curl per scenario, decision guide |
| `src/server.js` | All server logic — session resolution, both transport handlers, SSE relay |
| `examples/*.mjs` | One standalone script per scenario (numbered 1–6 to match the BLUEPRINT.md matrix) |
| `.env` | Credentials and config (never commit) |
| `artifacts/` | Saved raw SSE streams for packet analysis |
