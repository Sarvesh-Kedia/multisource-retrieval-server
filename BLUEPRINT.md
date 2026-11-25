# RAO Demo — session & transport blueprint

> This file lives in the server repo but describes the whole demo: the relay (`server/`), the React UI (`frontend/`, a separate repo) and the standalone scripts (`server/examples/`).

A small, complete reference for talking to a Progress Agentic RAG retrieval agent (the RAO API)
from a web app. It exists to answer one question for future projects: **which way of carrying a
conversation serves this use case best?**

All four transport/session combinations have relay and example code. The chat UI
exposes only ephemeral POST and WebSocket, always with explicit history.
Code availability does not imply production availability; see the status below.

### Production availability — 25 November 2026

Status supplied by the project owner: both persistent approaches are currently **not
working in production**. They depend on the platform's **Memory function**, which is
separate from the request-level `chat_history` field. Persistent examples below describe
the intended integration and retained demo code, not a currently usable production path.

All paths below are underlying Progress API paths, relative to `/api/v1`.

| Approach | Workflow interaction endpoint | Prerequisites | Production status |
|---|---|---|---|
| Ephemeral + HTTP POST | `POST /agent/{agent_id}/session/ephemeral?workflow_id=...` | Bearer API key; optional `chat_history` in each request | Available |
| Ephemeral + WebSocket | `WS /agent/{agent_id}/session/ephemeral/ws?eph-token=...&workflow_id=...` | Mint a token for `agent_session: "ephemeral"`, then send interaction JSON on the socket | Available |
| Persistent + HTTP POST | `POST /agent/{agent_id}/session/{session_id}?workflow_id=...` | Create a real session using `POST /agent/{agent_id}/sessions`; requires Memory | **Unavailable in production** (scenario 3) |
| Persistent + WebSocket | `WS /agent/{agent_id}/session/{session_id}/ws?eph-token=...&workflow_id=...` | Create a real session, then mint a token for that ID; requires Memory | **Unavailable in production** (scenario 6) |

`POST /agent/{agent_id}/sessions` creates a persistent session; it does not execute a
workflow. `POST /account/{account_id}/kb/{kb_id}/ephemeral_tokens` mints a credential;
for RAO WebSocket use, its body is `{ "agent_session": "ephemeral" }` or the real session
ID. Token minting does not execute a workflow either. An ephemeral token is an
authentication credential, not a conversation identifier or chat history store.

The demo contains:

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

**Session mode** — whether to use an ephemeral interaction or the platform's persistent
Memory feature. It is selected by what fills `{session_id}`. Only the ephemeral
approaches are currently available in production.

| | `{session_id}` | Who stores history | What the client sends each turn |
|---|---|---|---|
| **Ephemeral** | the literal `ephemeral` | nobody | the question **plus the full transcript as `chat_history`** |
| **Persistent** | a real session id from `POST /sessions` | RAO, per session | the question only; `chat_history` omitted |

The six scenarios below remain in the relay and standalone scripts for reference.
The current chat UI exposes only scenarios 1 and 4, with history always enabled;
the UI settings column records the previous comparison controls.

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

`chat_history` supplies context for the current request. It is distinct from the
platform's Memory feature. Persistent-session behavior described here is the intended
contract; both persistent transports are currently unavailable in production.

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

### Tracking an ephemeral chat conversation

For both ephemeral transports, pass the interaction JSON shown above directly in the
POST body or as a WebSocket text message. Keep prior completed `{ question, answer }`
pairs oldest first in `chat_history`; put the new question only in `question`. On the
first turn, omit `chat_history` or send `[]`. After receiving the final successful
answer, append that turn to the application's transcript and resend the transcript
on the next turn. The upstream workflow must be configured to consume chat history.

The ephemeral interaction API does not create a durable chat conversation that the
application can later retrieve by a unique chat ID. The literal `ephemeral` is shared
as a mode selector, not a unique conversation ID. WebSocket tokens, per-request stream
IDs, and question UUIDs do not replace an application conversation ID.

The application owns conversation tracking and storage:

1. Generate an application conversation ID when a user starts a chat.
2. Store the conversation's owner, selected agent/workflow, and ordered messages under
   that ID. Use application storage if the conversation must survive reloads or devices.
3. On each question, load that conversation's completed turns and build `chat_history`.
4. Save the final successful answer with its question; keep failed/partial runs separate.
5. To resume a chat, reload its transcript. To start a new chat, create a new ID and an
   empty transcript. Keep this ID in application requests/storage; the Progress path
   remains `/session/ephemeral`.

RAO Demo saves completed transcripts and the active conversation in browser `localStorage`.
The live trace remains in React memory.

### RAO Demo conversation storage

This design is implemented in **this RAO Demo project** (`frontend/` and `server/`).
The UI has a saved-chat sidebar, New chat, and automatic history on both transports.
There are no history or persistent-session controls in the chat UI.

For the demo, the frontend owns conversation IDs and transcripts, with
`localStorage` as persistence. Use `localStorage` rather than `sessionStorage` so saved
chats survive closing and reopening the browser. They remain local to that browser
profile and site origin; clearing browser storage removes them. The Node relay does
not need a database, a conversation registry, or an in-memory transcript store.

| Responsibility | Demo frontend | Demo Node relay |
|---|---|---|
| Conversation identity | Generate a UUID for each new chat; track the active ID | No conversation lookup required |
| Saved chats | Persist titles, timestamps, and ordered turns in `localStorage`; list them in a sidebar (agent/workflow is fixed by relay config) | No storage required |
| New/resumed chat | Create a new empty conversation, or restore a saved one | Accept the next interaction request |
| History on each turn | Build `chat_history` from the active chat's prior successful completed turns, oldest first | Normalize and forward it to Progress |
| Live response | Render the stream; persist the completed question/answer pair immediately when the turn finishes | Relay POST or WebSocket upstream results as SSE |
| Credentials | Never store Progress API credentials in browser storage | Keep the API key server-side; mint WebSocket tokens when needed |

Versioned browser storage shape (key: `rao-demo.conversations.v1`):

```json
{
  "schemaVersion": 1,
  "activeConversationId": "app-generated-uuid",
  "conversations": [
    {
      "id": "app-generated-uuid",
      "title": "First question, shortened for the sidebar",
      "createdAt": "2026-11-25T10:00:00.000Z",
      "updatedAt": "2026-11-25T10:01:00.000Z",
      "turns": [
        {
          "id": "turn-uuid",
          "question": "What are the top five holdings?",
          "answer": "The final successful answer...",
          "completedAt": "2026-11-25T10:01:00.000Z"
        }
      ]
    }
  ]
}
```

Persist the transcript rather than raw packet streams by default; traces can remain
transient to limit browser storage use. Handle unavailable storage, malformed saved
data, and quota failures without silently discarding a conversation. Any storage
schema changes should be versioned. This demo uses the single agent/workflow configured
on the relay for all chats. If the relay is reconfigured to a different agent/workflow,
start a new chat. A future workflow picker should store that identity per conversation.

For the chat experience, **every ephemeral turn includes `chat_history`**:
send `[]` on the first turn and prior completed pairs on subsequent turns, for both
POST and WebSocket. Keep the current question outside that array. Failed, stopped,
or partial answers must not enter the next request's history. No-history comparison scenarios are available only in the standalone examples,
not in the saved-chat UI.

The application conversation UUID is not a RAO `sessionId`. Keep the Progress path
as `/session/ephemeral`, and mint WebSocket tokens with `agent_session: "ephemeral"`.
If an application conversation ID is sent to the relay for logging, use a separate
field such as `conversationId`; do not substitute it into the Progress path.

### Production design: backend-owned conversations

For a real multi-user system, make the backend the source of truth and store
conversations and messages in a durable database. Continue using ephemeral Progress
interactions with explicit history while persistent Memory is unavailable. This
application storage is independent of the platform's Memory feature.

| Concern | Demo approach | Production approach |
|---|---|---|
| Source of truth | Browser `localStorage` | Backend database |
| Chat ID | Frontend UUID for local grouping | Backend creates/validates an application ID and enforces ownership |
| Loading chats | Read the local saved list | Authenticated conversation list/detail APIs |
| Sending a turn | Browser sends question plus `chat_history` | Browser sends conversation ID, new question, and a request ID; backend loads trusted history |
| Building Progress payload | Frontend builds history; relay forwards it | Backend builds `chat_history` from stored completed turns |
| Saving an answer | Frontend saves after successful completion | Backend saves completion independently of browser persistence |
| Resuming | Same browser profile and origin | Authorized access across devices |

Recommended production request lifecycle:

1. Authenticate the user and verify access to the requested conversation and workflow.
2. Record the new user message and a uniquely identified pending run. Use idempotency
   and per-conversation ordering to prevent retries or concurrent requests from
   duplicating turns or using inconsistent history.
3. Load prior completed turns from the database. Apply a context/token budget as
   conversations grow; preserve the full transcript in storage even if only a recent
   or summarized context is sent upstream.
4. Send the new question and server-built `chat_history` to Progress using an
   ephemeral POST interaction or ephemeral WebSocket interaction.
5. Stream results to the browser and persist the final answer and run status on the
   backend. Define whether browser disconnects cancel the run or let it complete;
   record canceled/failed runs separately from successful history.
6. Let the browser reload conversations and run status from the backend rather than
   treating its local cache as authoritative.

Keep credentials server-side, isolate users' conversations, and define retention,
deletion, and access rules for stored messages. A backend process's in-memory map
alone is not durable storage: restarts lose it, and separate server instances do not
share it. Browser storage may remain a UI cache, but must not be the production
conversation authority.

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

- **Sidebar / Chats (mobile)**: lists local saved chats, newest activity first. Select
  one to restore its completed questions and answers.
- **New chat**: creates a fresh application conversation UUID and empty history while
  preserving old chats in `localStorage`.
- **Transport**: HTTP POST / WebSocket. Changes the wire only; both always send history
  and use the upstream literal `ephemeral` session ID.
- **Submit / Stop**: starts or cancels the current interaction. Switching chats is
  disabled during a run so answers cannot be appended to another conversation.

The full-height sidebar contains New chat and saved conversations. The current turn
displays progress inline. Run details includes the request JSON and upstream URL.
Enter sends a message and Shift+Enter inserts a line break. There is no history toggle,
persistent-session selector, or scenario picker in the current UI. Persistent examples
and no-history baselines remain available as standalone scripts only.

`frontend/src/conversations.mjs` owns `buildInteractionPayload()` and versioned browser
storage. `frontend/src/App.jsx` owns conversation selection and the live trace. Storage
failures display an alert; malformed saved data is not overwritten without an explicit
recovery action. Completed turns persist immediately; raw packet traces do not.

---

## 6. Picking an option

Use an ephemeral approach in production today. Persistent rows below describe intended
use cases only; both require Memory and are currently unavailable in production.

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
