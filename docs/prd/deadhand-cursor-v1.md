# Deadhand (Cursor) v1 — Product Requirements Document

## Summary

Deadhand is a desktop-side companion (daemon + Cursor extension) that exposes **remote observability and control** for Cursor Agent: list active Cursor IDE instances, show agent/run status, stream chat/transcript in near real-time, send messages, and create new chat sessions remotely—all accessible via a **web UI** (mobile browser friendly) and a future mobile app.

## Problem

Cursor's Agent UI is only accessible inside the IDE. Users want to:

- Monitor what agents are doing remotely
- See multiple running Cursor instances from one place
- Control agents remotely (send prompts, pick modes/models, upload images)

## Goals (v1)

- **Multi-instance aggregation**: A single local daemon can track multiple Cursor IDE instances concurrently.
- **Read-only observability**:
  - List IDE instances (workspace, status)
  - Show agent runs/sessions list + status (best-effort)
  - Stream chat/transcript (best-effort)
- **Network access**: Serve UI/API over LAN by default via **HTTPS/WSS**, protected by a required token. (Plain HTTP is allowed only on `127.0.0.1`.)
- **Future-ready**: Stable API versioning and internal event model that can later support write actions.

## Non-goals (v1)

- ~~Remote control actions (send message, start/stop agent, change modes/models, image upload)~~ — **Implemented in v1.1** (see below)
- Tunnel mode / internet exposure (explicitly deferred; design hooks only)
- Supporting VS Code (non-Cursor) or other derivatives (Cursor-first)

## Goals (v1.1)

The following write actions have been implemented:

- **Remote send-message**: Send a message to an existing composer session
- **Create new chat**: Start a new composer session with a specified prompt, mode (Agent/Ask/Plan/Debug), and model
- **Model discovery**: Query which models are enabled/available in a Cursor instance

## Personas

- **Solo dev on laptop + phone**: wants to check agent progress from another room.
- **Power user running multiple Cursor windows/workspaces**: wants a single dashboard.

## User Stories (v1)

- As a user, I can open a web page on my phone and see all running Cursor instances.
- As a user, I can select an instance and view current/previous agent sessions.
- As a user, I can watch the transcript update as the agent works.

## User Stories (v1.1)

- As a user, I can send a follow-up message to an existing agent session from my phone.
- As a user, I can start a new chat session remotely, choosing the mode (Agent, Ask, Plan) and model.
- As a user, I can see which models are available in each Cursor instance.

## Functional Requirements (v1)

### Daemon

- Runs as a single host process per machine.
- Exposes **HTTPS API + WSS** for LAN operation (required). Optionally exposes HTTP + WS only on `127.0.0.1` for local bootstrap/dev.
- Generates and persists a **self-signed TLS certificate** on first run (v1 strategy).
- Maintains registry of connected IDE instances.
- Stores/validates an access token (required for all non-localhost requests; for v1 we can require it for all requests to keep behavior consistent).
- Serves bundled web UI.

#### Daemon Terminal Output (Auto-login URLs)

On startup, the daemon prints **clickable auto-login URLs** that include the token in the URL fragment for easy local debugging:

- **Localhost-only mode**:
  - `Auto-login URL: http://127.0.0.1:<port>/#token=<token>`

- **TLS/LAN mode**:
  - `Auto-login URL (localhost): https://localhost:<port>/#token=<token>`
  - `Auto-login URL (LAN): https://<lan-ip>:<port>/#token=<token>` (best-effort, one or more LAN IPs)

The token is placed in the **URL fragment** (`#token=...`) rather than as a query parameter, ensuring it is never sent to the server in HTTP requests and is only accessible client-side.

### Cursor Extension

- Connects to daemon and registers instance metadata.
- Streams agent/session events to daemon.
- Uses **official Cursor/VS Code APIs/hooks first**, and falls back to reverse-engineered sources (logs/files) if needed.
- Degrades gracefully if transcript extraction is not possible (clear UI messaging).

#### Pairing UX (Extension)

The extension provides a **prominent in-IDE UI** for obtaining the access token and pairing mobile devices:

- **Explorer View ("Deadhand")**: A dedicated view in the Explorer sidebar showing:
  - Daemon status (reachable/unreachable) and mode (localhost HTTP vs LAN HTTPS/TLS)
  - **Access token** (masked by default):
    - "Reveal" button to show token
    - "Copy token" button
  - **TLS certificate fingerprint** (when in TLS mode) for out-of-band verification
  - **QR code for LAN pairing** (when daemon is in TLS mode):
    - Encodes: `https://<host>:<port>/#token=<token>`
    - Token is placed in **URL fragment** (not query string) so it is never sent in HTTP requests
    - Host/IP selector populated from available network interfaces
  - Quick actions: "Open Web UI", "Copy URL"

- **Status Bar Entry**: Shows Deadhand connectivity indicator; click opens/focuses the pairing view.

- **Commands**:
  - `deadhand.showPairing` - Open the pairing view
  - `deadhand.copyToken` - Copy token to clipboard
  - `deadhand.copyWebUrl` - Copy web UI URL to clipboard

### Web UI

- Mobile-friendly dashboard.
- Instance list + detail view.
- Transcript view that updates live.
- **Auto-login via URL fragment**: If opened with `#token=...`:
  - Parse token from fragment
  - Store in `localStorage`
  - Clear the fragment from URL (removes token from visible address bar)
  - Proceed directly to authenticated dashboard

## Non-functional Requirements (v1)

### Security

- **LAN binding requires TLS**: no plaintext HTTP/WS when binding to non-localhost interfaces.
- TLS is required because transcripts are sensitive and users may be on open Wi‑Fi.
- v1 TLS strategy: **self-signed** server certificate (expect browser warnings); provide clear guidance and a visible **cert fingerprint** for verification.
- LAN binding allowed by default, but **token auth required**.
- Token should be random, sufficiently long, and rotatable.
- Clear warning on first run that transcript may contain sensitive data.

### Performance

- Minimal overhead in Cursor extension host (avoid heavy polling; prefer event-driven).
- Transcript streaming should not block the IDE.

### Reliability

- Daemon survives IDE restarts.
- Multiple IDE instances connecting/disconnecting should be handled cleanly.

### Compatibility

- Cursor-first; design adapters to support future VS Code.

## Data Model (v1)

### Instance

| Field | Type | Description |
|-------|------|-------------|
| `instanceId` | string | Unique identifier for this IDE instance |
| `app` | string | Application name (e.g., "Cursor") |
| `appVersion` | string | Application version |
| `workspaceName` | string | Name of the open workspace |
| `workspacePath` | string | Path to the workspace |
| `pid` | number | Process ID |
| `startedAt` | string (ISO 8601) | When this instance connected |
| `lastSeenAt` | string (ISO 8601) | Last heartbeat time |

### Session (conversation/run) - best-effort

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Unique identifier for this session |
| `instanceId` | string | The IDE instance this session belongs to |
| `title` | string | Session title/description |
| `createdAt` | string (ISO 8601) | When the session started |
| `status` | string | Current status (active, idle, error) |
| `mode` | string | Session mode: `agent`, `chat`, `plan`, `debug`, `background`, `unknown` |
| `model` | string | Model name (e.g., "gpt-5.2", "claude-3.5-sonnet") |
| `lastUpdatedAt` | string (ISO 8601) | When the session was last updated |
| `contextUsagePercent` | number | Context window usage percentage |
| `totalLinesAdded` | number | Total lines added by the agent |
| `totalLinesRemoved` | number | Total lines removed by the agent |
| `filesChangedCount` | number | Number of files changed |
| `subtitle` | string | Session subtitle/description |

### EnabledModel (v1.1)

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Internal model ID (e.g., "gpt-5.2") |
| `clientDisplayName` | string | UI display label (e.g., "GPT-5.2") |
| `serverModelName` | string | Server-side model identifier |
| `supportsMaxMode` | boolean | Whether model supports "max" mode |
| `supportsThinking` | boolean | Whether model supports thinking/reasoning |

### Transcript Event

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | string | Unique identifier for this event |
| `sessionId` | string | The session this event belongs to |
| `ts` | string (ISO 8601) | Timestamp of the event |
| `type` | string | Event type: `message`, `delta`, `tool_start`, `tool_end`, `status` |
| `payload` | object | Event-specific data |

## API Surface (v1)

### HTTP Endpoints (HTTPS on LAN)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/instances` | List all connected instances |
| GET | `/api/v1/instances/{instanceId}` | Get instance details |
| GET | `/api/v1/instances/{instanceId}/sessions` | List sessions for an instance |
| GET | `/api/v1/sessions/{sessionId}` | Get session details with transcript |

### Realtime (WSS on LAN)

WebSocket endpoint: `WSS /ws`

**Subscribe messages (client to server):**
- `subscribe_instances` - receive instance connect/disconnect/update events
- `subscribe_session:{sessionId}` - receive transcript events for a session
- `unsubscribe_instances` - stop receiving instance events
- `unsubscribe_session:{sessionId}` - stop receiving session events

**Server broadcast messages:**
- `instance_update` - instance connected or updated
- `instance_disconnect` - instance disconnected
- `session_update` - session created or updated
- `transcript_event` - new transcript event for a subscribed session

### Write Actions (v1.1)

**Client to server:**

| Message Type | Fields | Description |
|--------------|--------|-------------|
| `send_message` | `sessionId`, `message` | Send a message to an existing session |
| `get_enabled_models` | `requestId`, `instanceId` | Query available models for an instance |
| `create_chat` | `requestId`, `instanceId`, `prompt`, `unifiedMode`, `modelName?`, `maxMode?` | Create a new chat session |

**Server to client (responses):**

| Message Type | Fields | Description |
|--------------|--------|-------------|
| `send_message_result` | `sessionId`, `success`, `composerId?`, `error?` | Result of send_message |
| `enabled_models_result` | `requestId`, `instanceId`, `success`, `models?`, `error?` | Available models |
| `create_chat_result` | `requestId`, `success`, `composerId?`, `error?` | Result of create_chat |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Cursor IDE 1   │     │  Cursor IDE 2   │
│  ┌───────────┐  │     │  ┌───────────┐  │
│  │ Extension │──┼─────┼──│ Extension │  │
│  └───────────┘  │     │  └───────────┘  │
└─────────────────┘     └─────────────────┘
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │   Daemon    │
              │ (HTTPS/WSS) │
              └──────┬──────┘
                     │
         ┌───────────┴───────────┐
         │                       │
  ┌──────▼──────┐        ┌──────▼──────┐
  │   Web UI    │        │ Mobile App  │
  │  (Browser)  │        │  (Future)   │
  └─────────────┘        └─────────────┘
```

## Risks & Mitigations

### Cursor internals not exposed

Transcript/runs may not be accessible via stable APIs.

**Mitigation**: Adapter strategy (official API first, then log/file fallback), best-effort UX, narrow v1 scope to read-only.

### Security exposure on LAN

Transcript can contain secrets.

**Mitigation**: **HTTPS/WSS required** for LAN, token required, strong first-run warnings, easy disable/rotate token.

### Self-signed TLS on mobile browsers

Users will see certificate warnings; risk of user ignoring MITM on open Wi‑Fi.

**Mitigation**: Clearly display/print the **TLS cert fingerprint** for out-of-band verification; consider adding local-CA mode as a near-term improvement.

## Roadmap (Beyond v1)

- **v1.1**: Remote send-message + start agent (complete)
- **v1.2**: Mode/model switching (complete via create_chat) + image upload (pending)
- **v1.x**: Optional "local CA" TLS mode to eliminate browser warnings and improve MITM resistance (still LAN-only)
- **v2**: Optional tunnel mode (off by default), stronger auth, potentially mTLS

## Definition of Done (v1)

From a phone on same LAN, user can open the **HTTPS** web UI (self-signed cert), authenticate with token, see connected Cursor instances, and observe a transcript stream for at least one session (best-effort; adapter-dependent).

## Definition of Done (v1.1)

User can:
1. Send a message to an existing agent session from the web UI
2. Create a new chat session with a specified mode (Agent/Ask/Plan) and model
3. See the new session appear and watch its transcript update in real-time
