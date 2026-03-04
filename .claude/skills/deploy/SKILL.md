---
name: deploy
description: Deploy CCWeb to a remote server
when_to_use: When the user asks to deploy, redeploy, or update CCWeb on a server
argument-hint: user@host[:port]
---

# Deploy CCWeb

Deploy or update CCWeb on a remote Linux server.

## Prerequisites
- SSH access to target server (key-based auth)
- Node.js 22+ on server (install if missing)

## Steps

1. **Build locally**
   ```bash
   npx tsc --noEmit           # type-check
   cd web && npx vite build   # build frontend
   cd .. && npx tsc           # compile backend
   ```

2. **Sync to server**
   ```bash
   rsync -avz --delete \
     --exclude='node_modules' \
     --exclude='.git' \
     --exclude='.DS_Store' \
     --exclude='ccweb.config.json' \
     --exclude='ccweb.db*' \
     --exclude='tweakcc' \
     ./ user@host:/opt/ccweb/
   ```

3. **Install deps on server** (first deploy only)
   ```bash
   ssh user@host "cd /opt/ccweb && npm install --production"
   ```

4. **Create config** (first deploy only)
   ```bash
   ssh user@host "cp /opt/ccweb/ccweb.config.example.json /opt/ccweb/ccweb.config.json"
   # Then edit with actual token, port, project path
   ```

5. **Setup systemd** (first deploy only)
   ```bash
   scp /tmp/ccweb.service user@host:/etc/systemd/system/
   ssh user@host "systemctl daemon-reload && systemctl enable ccweb"
   ```

6. **Sync plugins & skills** (ensures server has same enabledPlugins and project skills)
   ```bash
   # Merge enabledPlugins from template into server's settings.json (preserves env/permissions)
   ssh user@host 'python3 -c "
import json, os
tpl = json.load(open(\"/opt/ccweb/server/claude-settings.template.json\"))
settings_path = os.path.expanduser(\"~/.claude/settings.json\")
os.makedirs(os.path.dirname(settings_path), exist_ok=True)
try:
    s = json.load(open(settings_path))
except:
    s = {}
s.setdefault(\"enabledPlugins\", {}).update(tpl.get(\"enabledPlugins\", {}))
json.dump(s, open(settings_path, \"w\"), indent=2)
print(\"Plugins merged:\", list(s[\"enabledPlugins\"].keys()))
"'
   # Sync skills to server's global skills dir (works regardless of defaultProject)
   rsync -avz .claude/skills/ user@host:~/.claude/skills/
   ```

7. **Restart service**
   ```bash
   ssh user@host "systemctl restart ccweb && sleep 2 && systemctl status ccweb --no-pager"
   ```

8. **Verify**
   ```bash
   curl -s http://HOST:PORT/api/health
   ```

## Service file template
```ini
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
```

## Notes
- Telegram bot token can only run in ONE instance. Stop local before starting remote.
- Config file (`ccweb.config.json`) is excluded from sync — edit on server separately.
- Database (`ccweb.db`) is excluded — each server has its own session history.
