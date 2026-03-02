# CCWeb Design Document

Web + Telegram transport layer over Claude Code CLI, enabling agentic development from browser and mobile.

## Architecture: "Thin Bridge"

Single Node.js process with three layers:

```
[React PWA] <--WebSocket--> [Fastify] <--SDK--> [Claude Code]
[Telegram]  <--grammY----->     |
                            [SessionManager]
                            [SQLite state]
```

- **Fastify** - HTTP + WebSocket server, serves React PWA static files
- **SessionManager** - core abstraction wrapping Claude Code SDK. Manages session lifecycle: create, stream, interrupt, history. Stores state in SQLite.
- **grammY Bot** - Telegram transport. Subscribes to SessionManager events, streams output via debounce-and-flush pattern.

Key principle: Web and Telegram are adapters to the same SessionManager. No business logic in transports.

## Engine

Claude Code SDK (`@anthropic-ai/claude-code`):
- `query()` for stateless headless execution
- `resume` for session continuity
- `interrupt()` for cancellation
- Streaming `StreamEvent` objects for real-time output
- Inherits API config from `~/.claude/settings.json` (custom apiUrl/apiKey supported)

CCWeb config can override API settings:
```json
{
  "claude": {
    "apiUrl": "https://custom-api.example.com",
    "apiKey": "KEY"
  }
}
```

## Fault Tolerance

Three layers of protection:

### 1. Timeouts and Watchdog
- Configurable session timeout (default: 30 min). Agent silent beyond that = auto-kill.
- Watchdog checks every 10s: is process alive, are events flowing. Hung = `interrupt()` via SDK, if that fails = force kill.

### 2. Session Isolation
- Each Claude Code session is a separate SDK invocation, no shared memory.
- Crashed session = error in log + notification to Telegram/web. Server continues.
- SessionManager catches all errors via try/catch + uncaught exception handling. Agent never crashes the main process.
- Hangs during compact, tool calls, anything = watchdog catches, kills, notifies. User hits "restart" from any transport, new session picks up via `resume`.

### 3. Control from Any Transport
- `/stop` from Telegram or Cancel button in web = instant `interrupt()` via SDK
- `/status` = see what agent is doing, how long it's been running, tokens consumed
- If agent ignores interrupt = force kill + message "agent killed, session saved"

## Web UI (React PWA, Mobile-First)

```
+------------------------------+
| CCWeb            * connected |
+------------------------------+
| project-name      [Switch v] |
+------------------------------+
|                              |
| Bot: Reading src/index.ts... |
|                              |
| > I'll fix the bug in the   |
|   handleAuth function...     |
|                              |
| Edit: src/auth.ts            |
|   - old line                 |
|   + new line                 |
|                              |
| Done. 12.4k tokens           |
|                              |
+------------------------------+
| [Type message...]     [Send] |
| [Stop] [Restart]             |
+------------------------------+
```

- Real-time streaming via WebSocket
- Stop / Restart always accessible
- Project switching
- Session history (scroll up)
- PWA - add to home screen on iOS, works as app

## Telegram Bot

Commands:
- Plain text = send prompt to agent
- `/stop` - kill current session
- `/restart` - restart with resume
- `/status` - what's happening
- `/project <name>` - switch project
- `/history` - recent sessions

Output: debounce-and-flush pattern (buffer chunks, edit message every 2-3s, respect 4096 char limit, split into parts if needed). ANSI codes stripped.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Engine | Claude Code SDK (`@anthropic-ai/claude-code`) |
| Backend | Fastify + `@fastify/websocket` + `@fastify/static` |
| Frontend | React 19 + Vite (PWA) |
| Telegram | grammY + `@grammyjs/runner` |
| Database | SQLite via `better-sqlite3` |
| Language | TypeScript |

## Project Structure

```
CCWeb/
├── package.json
├── ccweb.config.json
├── ccweb.db
│
├── src/
│   ├── index.ts
│   ├── config.ts
│   │
│   ├── core/
│   │   ├── session-manager.ts
│   │   ├── session.ts
│   │   └── db.ts
│   │
│   ├── transports/
│   │   ├── web.ts
│   │   └── telegram.ts
│   │
│   └── shared/
│       ├── types.ts
│       └── events.ts
│
├── web/
│   ├── index.html
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat.tsx
│   │   │   ├── Controls.tsx
│   │   │   └── ProjectPicker.tsx
│   │   └── hooks/
│   │       └── useSession.ts
│   └── vite.config.ts
│
└── tweakcc/
```

## Constraints

- Single user (personal tool)
- Single active session initially, data model ready for multi
- One process, no Redis, no external deps beyond SQLite
- Mobile-first web UI

## Checkpoints

1. `pnpm dev` -> send prompt -> agent creates calculator -> cancel via button -> works
2. Web UI with chat, streaming, controls
3. Telegram bot with same capabilities
