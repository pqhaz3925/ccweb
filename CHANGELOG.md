# Changelog

## [0.1.2] - 2026-03-03

### Fixed
- Fix root user deployment: set `IS_SANDBOX=1` to allow `bypassPermissions` under root
- Fix Telegram long message handling: split messages exceeding 4096 char limit into chunks

### Changed
- Split README into separate EN (`README.md`) and RU (`README.ru.md`) files
- Add `claude-code` CLI as deployment prerequisite in docs

## [0.1.1] - 2026-03-03

### Added
- Settings panel redesigned as fullscreen modal overlay (was sidebar)
- Telegram bot commands registered via `setMyCommands`
- Deploy skill (`.claude/skills/deploy/SKILL.md`)
- Gear button in header to open settings

### Changed
- Drawer simplified to only show chats (settings moved to overlay)
- Pill-style tabs in settings instead of underline tabs

## [0.1.0] - 2026-03-02

### Added
- Initial release
- Web UI: mobile-first React PWA with WebSocket streaming
- Telegram bot: live streaming via `sendMessageDraft`, typing indicators, photo/file uploads
- Multi-session support with SQLite persistence
- Plugin marketplace: browse, install, enable/disable plugins
- MCP server management (global + project level)
- Skills viewer (project + global)
- Memory editor for CLAUDE.md files
- Permission mode switching (Default / Accept Edits / YOLO)
- REST API + WebSocket transport
- Session watchdog with configurable timeout
