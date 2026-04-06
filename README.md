# RAO MVP backend

Small Node backend for a custom Progress Agentic RAG UI. It keeps the API key on the server, creates sessions, generates ephemeral websocket tokens, and relays websocket packets back to your frontend as Server-Sent Events.

## Endpoints

- `GET /health`
- `GET /config`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `POST /api/ephemeral-token`
- `POST /api/interactions/stream`

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `RAO_BASE_URL`
   - `RAO_AGENT_ID`
   - `RAO_API_KEY`
   - `RAO_ACCOUNT_ID`
   - optionally `RAO_KB_ID`
   - optionally `RAO_WORKFLOW_ID` (defaults to `default`)
3. Start the server:

```bash
npm run dev
```

## Session create example

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Stream interaction example

Pass the raw websocket request payload that RAO expects as `interactionRequest`. The backend does not reshape it, so you can iterate quickly even if the model changes.

```bash
curl -N -X POST http://localhost:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "YOUR_SESSION_UUID",
    "interactionRequest": {
      "question": "What can you do?",
      "operation": 0,
      "headers": {}
    }
  }'
```

`workflowId` is optional in the request body. If omitted, the backend uses `RAO_WORKFLOW_ID` (default: `default`).

If you do not pass a `sessionId`, the backend will create one first:

```json
{
  "sessionCreatePayload": {},
  "interactionRequest": {
    "type": "InteractionRequest",
    "question": "What can you do?"
  }
}
```

## SSE events from `/api/interactions/stream`

- `ready`
- `socket_open`
- `request_sent`
- `packet`
- `complete`
- `error`
- `socket_close`

Your frontend should mostly care about `packet`. Each `packet` event contains the raw backend websocket packet so you can map it to answer chunks, agent steps, tool calls, or completion states in your UI.
