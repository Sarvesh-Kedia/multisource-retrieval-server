# RAO Demo — Node Backend

Thin Node.js relay server for the RAO (Retrieval Agent Orchestrator) demo UI built for Eastspring Investments. It keeps API credentials on the server, manages sessions, and streams RAO API responses to the browser as Server-Sent Events (SSE).

## What it does

- Holds the long-lived `RAO_API_KEY` JWT — never exposed to the browser
- Creates sessions and generates short-lived ephemeral WebSocket tokens on demand
- Relays the RAO API stream to the browser as SSE regardless of upstream transport
- Supports two upstream transports: WebSocket and HTTP POST (both produce the same SSE output)

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/config` | Returns non-secret config (base URL, agent ID, workflow ID) |
| `POST` | `/api/sessions` | Create a new RAO session |
| `GET` | `/api/sessions/:sessionId` | Get session info |
| `POST` | `/api/ephemeral-token` | Generate a short-lived WebSocket token |
| `POST` | `/api/interactions/stream` | Stream via WebSocket (SSE output) |
| `POST` | `/api/interactions/stream-post` | Stream via HTTP POST (SSE output) — recommended |

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:

| Variable | Purpose |
|---|---|
| `RAO_BASE_URL` | Base HTTPS URL of the RAO API |
| `RAO_AGENT_ID` | Agent UUID |
| `RAO_API_KEY` | Long-lived JWT (RS256) — used as Bearer token for REST and HTTP POST streaming |
| `RAO_ACCOUNT_ID` | Account UUID (used in ephemeral token path) |
| `RAO_KB_ID` | Knowledge base UUID (defaults to `RAO_AGENT_ID` if unset) |
| `RAO_WORKFLOW_ID` | Workflow name sent as `?workflow_id=` query param (defaults to `"default"`) |

3. Start the server:

```bash
npm run dev
```

Server listens on `http://127.0.0.1:3001`.

## Usage examples

### Create a session

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### Stream via HTTP POST (recommended)

```bash
curl -N -X POST http://localhost:3001/api/interactions/stream-post \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "YOUR_SESSION_UUID",
    "interactionRequest": {
      "question": "What are Eastspring'\''s top performing funds this year?",
      "operation": 0,
      "headers": {}
    }
  }'
```

### Stream via WebSocket

```bash
curl -N -X POST http://localhost:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "YOUR_SESSION_UUID",
    "interactionRequest": {
      "question": "What are Eastspring'\''s top performing funds this year?",
      "operation": 0,
      "headers": {}
    }
  }'
```

`workflowId` is optional in the request body — if omitted, the server uses `RAO_WORKFLOW_ID` from `.env`.

If you omit `sessionId`, include `sessionCreatePayload: {}` and the server creates a session first.

## Transport comparison

| | HTTP POST (`/stream-post`) | WebSocket (`/stream`) |
|---|---|---|
| **Auth to RAO** | `Authorization: Bearer {RAO_API_KEY}` | `?eph-token=` (short-lived ephemeral token) |
| **Answer quality** | Generally fuller answers; more MCP tool calls observed | Sometimes returns "Not enough data" for data-heavy questions |
| **Completion signal** | `operation: 3` packet in stream | WebSocket close event |
| **Recommended** | Yes (default in UI) | Fallback |

Both transports produce identical SSE output to the browser.

## SSE events

The browser receives these SSE events from both streaming endpoints:

| Event | When | Data |
|---|---|---|
| `ready` | Stream opened | `{ streamId, sessionId }` |
| `socket_open` | Upstream connected (WebSocket only) | `{ streamId, sessionId }` |
| `request_sent` | Question dispatched upstream | `{ streamId }` |
| `packet` | Every RAO API message | Raw RAO packet object |
| `complete` | Stream finished | `{ streamId, packetType, operation }` |
| `error` | Server-side failure | `{ streamId, message }` |
| `socket_close` | Upstream closed (WebSocket only) | `{ streamId, code, reason }` |

The frontend primarily listens for `packet` events. Each packet is a JSON object with an `operation` field and one populated payload field (`step`, `context`, `answer`, or `exception`). See `README.md` in the frontend repo for the full packet schema.

## Saving response artifacts

To capture a raw SSE stream for analysis, pipe the output to `artifacts/`:

```bash
curl -s -N -X POST http://localhost:3001/api/interactions/stream-post \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "YOUR_SESSION_UUID",
    "interactionRequest": {
      "question": "YOUR QUESTION HERE",
      "operation": 0,
      "headers": {}
    }
  }' > artifacts/response_<label>.txt
```

Artifacts are useful for inspecting raw packet shapes without running the full UI.

## Key source files

| File | Purpose |
|---|---|
| `src/server.js` | All server logic — session management, both transport handlers, SSE relay |
| `.env` | Credentials and config (never commit) |
| `artifacts/` | Saved raw SSE streams for packet analysis |
