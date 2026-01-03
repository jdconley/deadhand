# Deadhand

Remote command and control for Cursor AI agents.

## Overview

Deadhand enables remote monitoring and control of Cursor AI agents from your phone or any device on your local network. It consists of:

- **Daemon**: A local server that aggregates data from multiple Cursor instances
- **Extension**: A Cursor extension that connects to the daemon
- **Web UI**: A mobile-friendly dashboard for viewing agent status and transcripts

## Features

### Observability
- View all running Cursor instances from a single dashboard
- Monitor agent/session status in real-time
- Stream chat transcripts as they happen
- Secure LAN access with HTTPS and token authentication

### Remote Control
- **Send messages** to existing composer sessions remotely
- **Create new chat sessions** with a specified mode (Agent, Ask, Plan, Debug)
- **Select model** when creating new chats (queries available models from Cursor)
- **Start agents** remotely by creating a new Agent-mode chat with a prompt

## Security

- **HTTPS required** for LAN access (self-signed certificate)
- **Token authentication** required for all requests
- Plain HTTP allowed only on localhost for development

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+

### Installation

```bash
# Clone the repo
git clone <repo-url> deadhand
cd deadhand

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Running the Daemon

```bash
# Start in localhost-only mode (for development)
DEADHAND_LOCALHOST_ONLY=true pnpm --filter @deadhand/daemon start

# Start with LAN access (HTTPS, for mobile access)
pnpm --filter @deadhand/daemon start
```

On first run, the daemon will:
1. Generate a self-signed TLS certificate
2. Generate an access token
3. Display the token and TLS fingerprint in the terminal

### Accessing the Web UI

1. Open the URL shown in the daemon output (e.g., `https://localhost:31337`)
2. If using HTTPS, accept the self-signed certificate warning
3. Enter the access token from the daemon output

### Installing the Extension

1. Open Cursor
2. Install the extension from `packages/extension` (F5 to run in development)
3. The extension will auto-connect to the daemon

## Development

### Development Mode

```bash
# Run all services in development mode
./scripts/dev.sh

# Or run individually:

# Terminal 1: Daemon
DEADHAND_LOCALHOST_ONLY=true pnpm --filter @deadhand/daemon dev

# Terminal 2: Web UI (with hot reload)
pnpm --filter @deadhand/web dev

# Terminal 3: Extension (press F5 in VS Code)
```

### Cursor Launch Configurations

Use the provided `.vscode/launch.json`:
- **Run Daemon**: Start the daemon with debugging
- **Run Extension**: Launch extension development host
- **Extension + Daemon**: Run both together

## Configuration

### Daemon Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEADHAND_PORT` | `31337` | Port for the daemon |
| `DEADHAND_DATA_DIR` | `~/.deadhand` | Directory for config/certs |
| `DEADHAND_LOCALHOST_ONLY` | `false` | Disable LAN access (HTTP only) |

### Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `deadhand.daemonPort` | `31337` | Daemon port |
| `deadhand.autoStartDaemon` | `true` | Auto-start daemon if not running |
| `deadhand.enableLogsAdapter` | `false` | Enable log file parsing (fallback adapter) |
| `deadhand.debugMode` | `false` | Enable debug mode with verbose logging |

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
                     │ (WebSocket)
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

## Project Structure

```
packages/
  daemon/    # Local server (Node.js/Fastify)
  extension/ # Cursor extension
  web/       # React web UI
docs/
  prd/       # Product requirements documents
scripts/
  dev.sh     # Development helper script
```

## Troubleshooting

### Certificate Warning on Mobile

When accessing the web UI from your phone, you'll see a certificate warning because we use a self-signed certificate. To verify you're connecting to the right server:

1. Check the TLS fingerprint shown in the daemon terminal
2. Compare it with the fingerprint shown on the login page
3. If they match, it's safe to proceed

### Extension Not Connecting

1. Ensure the daemon is running
2. Check if the port matches (`deadhand.daemonPort`)
3. Try running `Deadhand: Show Status` from the command palette

### No Agent Data Showing

Agent data extraction from Cursor uses internal APIs:
- The official adapter monitors Cursor's composer commands and SQLite storage
- Enable `deadhand.enableLogsAdapter` to try log file parsing as a fallback

### Send Message / Create Chat Not Working

These features use Cursor's internal commands (`composer.createNew`, `composer.triggerCreateWorktreeButton`) and reverse-engineered storage access that may break with Cursor updates. See [docs/reverse-engineering/cursor-storage.md](docs/reverse-engineering/cursor-storage.md) for technical details.

## Roadmap

- **v1.1**: Remote send-message + start agent (complete)
- **v1.2**: Mode/model switching (complete via create_chat) + image upload (pending)
- **v2**: Optional tunnel mode for internet access

See [docs/prd/deadhand-cursor-v1.md](docs/prd/deadhand-cursor-v1.md) for the full product requirements.

Reverse-engineering notes live in [docs/reverse-engineering/cursor-storage.md](docs/reverse-engineering/cursor-storage.md).

## License

MIT
