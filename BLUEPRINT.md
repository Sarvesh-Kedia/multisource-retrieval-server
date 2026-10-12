# RAO Demo — session & transport blueprint

> This file lives in the server repo but describes the whole demo: the relay (`server/`), the React UI (`frontend/`, a separate repo) and the standalone scripts (`server/examples/`).

A small, complete reference for talking to a Progress Agentic RAG retrieval agent (the RAO API)
from a web app. It exists to answer one question for future projects: **which way of carrying a
conversation serves this use case best?**

Every option is implemented end to end and switchable at runtime:

- `server/` — a thin Node relay that keeps the API key off the browser and turns either upstream transport into Server-Sent Events.
- `frontend/` — a React trace viewer with controls for transport, session mode and history.
- `server/examples/` — six standalone scripts, one per scenario, that call the RAO API directly with no relay.

---

## 1. The two switches

A question reaches the agent along two independent axes.

**Transport** — how bytes move.

| | HTTP POST | WebSocket |
|---|---|---|
| Upstream call | `POST /api/v1/agent/{agent_id}/session/{session_id}?workflow_id=…` | `WS /api/v1/agent/{agent_id}/session/{session_id}/ws?eph-token=…&workflow_id=…` |
| Auth | `Authorization: Bearer {RAO_API_KEY}` | short-lived `eph-token` query param, one per connection |
| Response | stream of concatenated JSON objects, no delimiter | one JSON text frame per packet |
| Completion | packet with `operation: 3` | packet with `operation: 3`, then socket close |
| Bidirectional | no | yes: agent can ask the user for input (`feedback`, `oauth` packets) |

**Session mode** — who remembers the conversation. It is decided entirely by what fills `{session_id}`.

| | `{session_id}` | Who stores history | What the client sends each turn |
|---|---|---|---|
| **Ephemeral** | the literal `ephemeral` | nobody | the question **plus the full transcript as `chat_history`** |
| **Persistent** | a real session id from `POST /sessions` | RAO, per session | the question only; `chat_history` omitted |

Combined with the history toggle, that gives six scenarios. All six are implemented in the UI, the relay and as standalone scripts.

### The scenario matrix

| # | Transport | Session mode | History toggle | What the client sends each turn | Where history lives | UI settings | Example script |
|---|---|---|---|---|---|---|---|
| 1 | HTTP POST | Ephemeral | On | question + full transcript as `chat_history` | Client (React state) | Transport: HTTP POST · Session: Ephemeral · Persist history: on | `server/examples/1-ephemeral-post.mjs` |
| 2 | HTTP POST | Ephemeral | Off | question only | Nowhere, each question stands alone | Transport: HTTP POST · Session: Ephemeral · Persist history: off | `server/examples/2-ephemeral-post-no-history.mjs` |
| 3 | HTTP POST | Persistent | Locked on | question + `sessionId`, no `chat_history` | RAO, stored against the session id | Transport: HTTP POST · Session: Persistent | `server/examples/3-persistent-post.mjs` |
| 4 | WebSocket | Ephemeral | On | question + full transcript as `chat_history` | Client (React state) | Transport: WebSocket · Session: Ephemeral · Persist history: on | `server/examples/4-ephemeral-ws.mjs` |
| 5 | WebSocket | Ephemeral | Off | question only | Nowhere, each question stands alone | Transport: WebSocket · Session: Ephemeral · Persist history: off | `server/examples/5-ephemeral-ws-no-history.mjs` |
| 6 | WebSocket | Persistent | Locked on | question + `sessionId`, no `chat_history` | RAO, stored against the session id | Transport: WebSocket · Session: Persistent | `server/examples/6-persistent-ws.mjs` |

What the scenarios demonstrate:

- **1 and 4** — client-owned history. The app is stateless; the transcript travels with every request.
- **3 and 6** — platform-owned history. The app holds only a session id; RAO remembers.
- **2 and 5** — no history. The baseline to compare the others against.
- Transport is orthogonal: every memory model works over both wires, so you can compare POST versus WebSocket with the memory model held constant.

In every scenario, history only has an effect if the workflow contains agents that read it (see §2).

---

## 2. How history actually works

These are the rules the agent follows, confirmed against the API docs and the Nuclia SDK source.

- `chat_history` is an array of `{ "question": "...", "answer": "..." }` pairs, oldest first. Not OpenAI-style role messages.
- **Omit** `chat_history` → the agent uses whatever history is stored for the session (nothing, for `ephemeral`).
- **Send** `chat_history` → it **replaces** the stored history for that one request. It is **not** added to the persistent session afterwards.
- Send `"chat_history": []` → explicitly answer with no context.
- On `/session/ephemeral` nothing is ever stored, so the client must resend the complete transcript on every turn.
- On a real session, RAO appends each new exchange itself. One session id = one conversation. Start a new session for a new conversation.
- The ephemeral **token** is unrelated to the ephemeral **session**. The token is a per-connection WebSocket credential minted for any session id, including `"ephemeral"`. The session id is the conversation identity.
- History only has an effect if the workflow contains agents that read it: a **rephrase** agent with `history: true`, a **summarize** agent with `conversational: true`, or a **smart** agent. That is agent configuration in the RAO console, not something the client controls.

Interaction request body, both transports and both modes:

```jsonc
{
  "question": "Which of those has the lowest fee?",
  "operation": 0,                // 0 = question, 1 = quit
  "headers": {},
  "chat_history": [              // ephemeral mode only; omit in persistent mode
    { "question": "What are Eastspring's top performing funds this year?",
      "answer":   "Based on the provided context, ..." }
  ]
}
```

---

## 3. Using the relay (what the UI does)

Request body the browser sends to either `POST /api/interactions/stream-post` (HTTP POST upstream) or
`POST /api/interactions/stream` (WebSocket upstream):

```jsonc
{
  "sessionMode": "ephemeral" | "persistent",   // default "ephemeral"
  "sessionId": "…",                            // persistent only; omit on the first turn to have one created
  "sessionCreatePayload": { "name": "…" },     // persistent only; optional overrides for the created session
  "workflowId": "default",                     // optional, falls back to RAO_WORKFLOW_ID
  "interactionRequest": { "question": "…", "operation": 0, "headers": {}, "chat_history": [ … ] }
}
```

The first SSE event is `ready`, and it tells you exactly what was resolved:

```json
{ "streamId": "…", "sessionId": "ephemeral", "sessionMode": "ephemeral", "sessionCreated": false,
  "transport": "post", "upstream": "https://…/api/v1/agent/…/session/ephemeral?workflow_id=default" }
```

In persistent mode the client stores `sessionId` from this event and sends it back on every later turn.

### Scenario 1 — HTTP POST, ephemeral, history on (stateless; the UI default)

```bash
curl -N -X POST http://127.0.0.1:3001/api/interactions/stream-post \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionMode": "ephemeral",
    "interactionRequest": {
      "question": "Summarise your previous answer in one sentence.",
      "operation": 0, "headers": {},
      "chat_history": [
        { "question": "What are Eastspring'\''s top performing funds this year?",
          "answer": "<answer text captured from the previous stream>" }
      ]
    }
  }'
```

### Scenario 2 — HTTP POST, ephemeral, history off

Same endpoint as scenario 1 with `chat_history` omitted (or `[]` to be explicit). Each question is answered in isolation.

### Scenario 4 — WebSocket, ephemeral, history on

Same body as scenario 1, different endpoint. The relay mints an `eph-token` for session `ephemeral` and opens one socket for this turn.

```bash
curl -N -X POST http://127.0.0.1:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "ephemeral", "interactionRequest": { "question": "…", "operation": 0, "headers": {}, "chat_history": [] } }'
```

### Scenario 5 — WebSocket, ephemeral, history off

Same endpoint as scenario 4 with `chat_history` omitted.

### Scenario 6 — WebSocket, persistent

First turn with no `sessionId`: the relay creates a session and reports it on `ready`.

```bash
curl -N -X POST http://127.0.0.1:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "persistent", "interactionRequest": { "question": "What are Eastspring'\''s top performing funds this year?", "operation": 0, "headers": {} } }'
# event: ready
# data: {"sessionId":"51915a98f8f64191b79b8ac01efceb91","sessionCreated":true, …}
```

Every later turn sends that id and no history:

```bash
curl -N -X POST http://127.0.0.1:3001/api/interactions/stream \
  -H 'Content-Type: application/json' \
  -d '{ "sessionMode": "persistent", "sessionId": "51915a98f8f64191b79b8ac01efceb91",
        "interactionRequest": { "question": "Summarise your previous answer in one sentence.", "operation": 0, "headers": {} } }'
```

### Scenario 3 — HTTP POST, persistent

Identical to scenario 6 with `/api/interactions/stream-post`.

### Session management helpers

```bash
curl -s -X POST http://127.0.0.1:3001/api/sessions -H 'Content-Type: application/json' -d '{}'   # create (defaults filled in)
curl -s http://127.0.0.1:3001/api/sessions                                                      # list
curl -s http://127.0.0.1:3001/api/sessions/<id>                                                 # inspect stored session
curl -s -X DELETE http://127.0.0.1:3001/api/sessions/<id>                                       # delete
```

RAO requires `slug`, `name`, `summary`, `data` and `format` on create; the relay fills defaults for anything you leave out.

---

## 4. Standalone examples (no relay)

One script per scenario, numbered to match the matrix, written to be read top to bottom. Each runs a
two-turn conversation where the second question only makes sense if the first one is remembered, so
scenarios 2 and 5 are expected to fail that second question.

```bash
cd server
npm run example:1     # HTTP POST · ephemeral · history on
npm run example:2     # HTTP POST · ephemeral · history off
npm run example:3     # HTTP POST · persistent
npm run example:4     # WebSocket · ephemeral · history on
npm run example:5     # WebSocket · ephemeral · history off
npm run example:6     # WebSocket · persistent

# or with your own questions
node examples/6-persistent-ws.mjs "What is the fund's benchmark?" "And its expense ratio?"
```

`examples/common.mjs` holds only the mechanics shared by every scenario: env loading, the REST helper,
session creation, ephemeral token minting, and the two stream readers (`consumeJsonStream` for POST,
`askOverWebSocket` for WebSocket).

---

## 5. The UI controls

Footer of the app:

- **Scenario**: 1 to 6, matching the matrix in §1. Picking one sets the three controls below in one go, and the header chip shows "Scenario N" so the current combination is always named. Changing a control by hand updates the scenario number to match.
- **Transport**: HTTP POST / WebSocket. Changes the wire only.
- **Session**: Ephemeral / Persistent. Switching starts a fresh conversation because the memory model changes.
- **Persist history** toggle (ephemeral only): when on, every request carries the transcript as `chat_history`; when off, every question stands alone. In persistent mode the toggle is locked on and labelled "History kept by RAO session".
- **New chat**: clears the transcript (ephemeral) or drops the session id so the next question creates a new session (persistent).

The header chip shows the scenario number, the mode, the session id, and how many prior turns were sent.
Under each turn, "Request payload sent to the relay" shows the exact JSON that went out and the upstream URL that was hit.

The scenario presets are the `SCENARIOS` table and the payload rules are `buildInteractionPayload()`, both
exported from `frontend/src/App.jsx`, so the matrix lives in one place in code.

---

## 6. Picking an option

| Pick | When |
|---|---|
| **1 · Ephemeral + POST, history on** | Stateless backends, serverless, horizontal scaling, no cleanup. You already keep the chat transcript in the client. Simplest to reason about. |
| **4 · Ephemeral + WebSocket, history on** | As above, but the workflow may ask the user for input mid-run (missing parameter, OAuth). Only a socket can carry the reply back. |
| **3 · Persistent + POST** | Server-to-server multi-turn where you would rather hand RAO a session id than ship a growing transcript. Also gives you an audit trail: `GET /session/{id}`. |
| **6 · Persistent + WebSocket** | Long interactive chats with agent-to-user prompts and server-side history. The closest match to the Nuclia SDK's default (`interact(sessionId, …, 'WS')`). |

Scenarios 2 and 5 are not production choices; they exist as the no-history baseline.

Trade-offs to keep in mind:

- Ephemeral payloads grow with the conversation. Cap or summarise `chat_history` client-side for long chats.
- Persistent sessions are a resource. Create one per conversation and delete stale ones, or they accumulate on the agent.
- A single hardcoded session id shared by all users of a UI means all users share one conversation. Never do that in persistent mode.
- Client-sent `chat_history` on a persistent session is a one-shot override and is not stored. If you mix the two, you are responsible for the gap.

---

## 7. Known gotchas (seen while building this)

- The session **create** endpoint is `POST …/sessions` but get/patch/delete are `…/session/{id}` (singular).
- `POST /sessions` with `{}` is rejected: `slug`, `name`, `summary`, `data`, `format` are all required.
- The ephemeral token response is `{ "token": "…" }`. It is not a JWT and cannot be used in an `Authorization` header.
- The HTTP POST stream has no delimiter between JSON objects; split on brace depth, not newlines.
- An `operation: 4` packet carries the error in `exception.detail` and often also a short string in `answer` ("Error in preprocess"). Check `operation` before trusting `answer`.
- A `402` from RAO with `AccountBlockingState.BUDGET` means the account's budget is exhausted. Every scenario returns `operation: 4` until it is lifted.
