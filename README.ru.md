# CCWeb

Панель удалённого управления [Claude Code](https://code.claude.com) через веб и Telegram.

Доступ к Claude Code с телефона, планшета или браузера. Отправка промптов, управление плагинами, редактирование памяти, переключение проектов — всё удалённо.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-22%2B-green)

[English version](README.md)

## Возможности

- **Веб-интерфейс** — мобильный React PWA с real-time стримингом через WebSocket
- **Telegram-бот** — полный доступ к Claude Code из Telegram: стриминг через drafts, индикатор набора, отправка фото/файлов
- **Мультисессии** — создание, переключение и управление несколькими чатами
- **Маркетплейс плагинов** — просмотр, установка, включение/выключение плагинов
- **MCP-серверы** — управление глобальными и проектными MCP-серверами
- **Навыки (Skills)** — просмотр проектных и глобальных навыков Claude Code
- **Редактор памяти** — просмотр и редактирование всех CLAUDE.md файлов
- **Разрешения** — переключение между режимами Default / Accept Edits / YOLO
- **Персистентность** — SQLite-история переживает перезапуски

## Архитектура

```
┌──────────────┐     ┌──────────────┐
│  React PWA   │────▶│   Fastify    │
│  (mobile)    │ WS  │   + REST     │
└──────────────┘     └──────┬───────┘
                            │
┌──────────────┐     ┌──────▼───────┐     ┌──────────────┐
│  Telegram    │────▶│   Session    │────▶│  Claude Code  │
│  Бот         │     │   Manager    │     │  Agent SDK    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────▼───────┐
                     │   SQLite DB  │
                     └──────────────┘
```

## Быстрый старт

### Требования

- Node.js 22+
- [Anthropic API ключ](https://console.anthropic.com/) (`ANTHROPIC_API_KEY`)
- Telegram Bot токен от [@BotFather](https://t.me/BotFather) (опционально)

### Установка

```bash
git clone https://github.com/pqhaz3925/ccweb.git
cd ccweb
npm install && cd web && npm install && cd ..

cp ccweb.config.example.json ccweb.config.json
# Отредактируй ccweb.config.json — вставь токен бота

npm run build && npx tsc

export ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Открой `http://localhost:3001` в браузере.

### Команды Telegram-бота

| Команда | Описание |
|---------|----------|
| `/stop` | Остановить текущую задачу |
| `/new` | Новый чат |
| `/chats` | Список чатов |
| `/chat N` | Переключиться на чат #N |
| `/status` | Текущий статус |
| `/project /path` | Сменить проект |
| `/history` | История сессий |
| `/restart` | Перезапустить сессию Claude |

Отправь текст — получишь ответ от Claude Code. Фото и файлы тоже принимаются.

## Деплой на VPS

```bash
# На сервере (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g @anthropic-ai/claude-code@latest

# Скопировать проект
rsync -avz --exclude='node_modules' --exclude='.git' . root@сервер:/opt/ccweb/

# На сервере
cd /opt/ccweb
npm install --production
cp ccweb.config.example.json ccweb.config.json
# Настрой конфиг: порт, токен Telegram, путь к проекту

# systemd сервис
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

systemctl enable ccweb && systemctl start ccweb
```

## Конфиг

`ccweb.config.json`:

```json
{
  "web": { "port": 3001, "host": "0.0.0.0" },
  "telegram": {
    "token": "ТОКЕН_БОТА",
    "allowedUsers": []
  },
  "session": {
    "timeoutMs": 1800000,
    "defaultProject": "/путь/к/проекту"
  }
}
```

- `allowedUsers` — массив Telegram user ID. Пустой = доступ всем.
- `defaultProject` — рабочая директория для Claude Code.

## API

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/health` | Проверка здоровья |
| GET | `/api/status` | Статус сессии |
| GET | `/api/messages` | Сообщения текущей сессии |
| GET | `/api/sessions` | Список сессий |
| GET | `/api/mcp` | Плагины + MCP серверы |
| GET | `/api/skills` | Список навыков |
| GET | `/api/memory` | Чтение файлов памяти |
| POST | `/api/memory` | Сохранение файла памяти |
| GET | `/api/permissions` | Текущий режим разрешений |
| POST | `/api/permissions` | Установить режим разрешений |
| WS | `/ws` | Real-time стриминг |

## Стек

- **Бэкенд**: Fastify, WebSocket, better-sqlite3
- **Фронтенд**: React 19, Vite, TypeScript
- **Telegram**: grammY, `sendMessageDraft` стриминг
- **AI**: `@anthropic-ai/claude-agent-sdk`

## Лицензия

MIT
