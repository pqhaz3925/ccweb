# CCWeb

Remote control panel for [Claude Code](https://code.claude.com) via web and Telegram.

Access your Claude Code sessions from phone, tablet, or any browser. Send prompts, manage plugins, edit memory files, switch projects — all remotely.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-22%2B-green)

[Русская версия](README.ru.md)

## Features

- **Web UI** — mobile-first React PWA with real-time streaming via WebSocket
- **Telegram Bot** — full Claude Code access from Telegram with live streaming drafts, typing indicators, photo/file uploads
- **Multi-session** — create, switch, and manage multiple chat sessions
- **Plugin Marketplace** — browse, install, enable/disable plugins from `~/.claude/plugins/marketplaces/`
- **MCP Servers** — manage global and project-level MCP server configs
- **Skills Viewer** — browse project and global Claude Code skills
- **Memory Editor** — view and edit all CLAUDE.md layers and memory files
- **Permissions** — switch between Default / Accept Edits / YOLO modes
- **Session Persistence** — SQLite-backed history survives restarts

## Architecture

```
┌──────────────┐     ┌──────────────┐
│  React PWA   │────▶│   Fastify    │
│  (mobile)    │ WS  │   + REST     │
└──────────────┘     └──────┬───────┘
                            │
┌──────────────┐     ┌──────▼───────┐     ┌──────────────┐
│  Telegram    │────▶│   Session    │────▶│  Claude Code  │
│  Bot         │     │   Manager    │     │  Agent SDK    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────▼───────┐
                     │   SQLite DB  │
                     └──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 22+
- [Anthropic API key](https://console.anthropic.com/) (set as `ANTHROPIC_API_KEY`)
- Telegram Bot token from [@BotFather](https://t.me/BotFather) (optional)

### Install & Run

```bash
git clone https://github.com/pqhaz3925/ccweb.git
cd ccweb
npm install
cd web && npm install && cd ..

# Create config
cp ccweb.config.example.json ccweb.config.json
# Edit ccweb.config.json with your Telegram bot token

# Build
npm run build    # type-check + build frontend
npx tsc          # compile backend

# Run
export ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Open `http://localhost:3001` in your browser.

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/stop` | Stop current task |
| `/new` | New chat session |
| `/chats` | List chat sessions |
| `/chat N` | Switch to chat #N |
| `/status` | Current status |
| `/project /path` | Switch project |
| `/history` | Recent session history |
| `/restart` | Restart Claude session |

Send any text message to prompt Claude Code. Send photos or files for analysis.

## Deploy to VPS

```bash
# On server (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g @anthropic-ai/claude-code@latest

# Copy project
rsync -avz --exclude='node_modules' --exclude='.git' . root@your-server:/opt/ccweb/

# On server
cd /opt/ccweb
npm install --production
cp ccweb.config.example.json ccweb.config.json
# Edit config: set port, telegram token, project path

# Create systemd service
cat > /etc/systemd/system/ccweb.service << 'EOF'
[Unit]
Description=CCWeb
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ccweb
ExecStart=/usr/bin/node dist/index.js
Environment=ANTHROPIC_API_KEY=sk-ant-...
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable ccweb
systemctl start ccweb
```

## Config

`ccweb.config.json`:

```json
{
  "web": { "port": 3001, "host": "0.0.0.0" },
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "allowedUsers": []
  },
  "session": {
    "timeoutMs": 1800000,
    "defaultProject": "/path/to/your/project"
  }
}
```

- `allowedUsers` — array of Telegram user IDs. Empty = allow all.
- `defaultProject` — working directory for Claude Code.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Session status |
| GET | `/api/messages` | Current session messages |
| GET | `/api/sessions` | List sessions |
| GET | `/api/mcp` | Plugins + MCP servers |
| GET | `/api/skills` | List skills |
| GET | `/api/memory` | Read memory files |
| POST | `/api/memory` | Save memory file |
| GET | `/api/permissions` | Get permission mode |
| POST | `/api/permissions` | Set permission mode |
| WS | `/ws` | Real-time streaming |

## Tech Stack

- **Backend**: Fastify, WebSocket, better-sqlite3
- **Frontend**: React 19, Vite, TypeScript
- **Telegram**: grammY, `sendMessageDraft` streaming
- **AI**: `@anthropic-ai/claude-agent-sdk`

## License

MIT
