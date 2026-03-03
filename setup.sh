#!/bin/bash
set -e

echo "CCWeb Setup"
echo "==========="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Install Node.js 18+ first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "ERROR: Node.js 18+ required (found $(node -v))"
    exit 1
fi
echo "OK: Node.js $(node -v)"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi
echo "OK: pnpm $(pnpm -v)"

# Install dependencies
echo "Installing dependencies..."
pnpm install

# Install web deps & build
echo "Building web UI..."
cd web && pnpm install && npx vite build && cd ..

# Create config if not exists
if [ ! -f ccweb.config.json ]; then
    echo ""
    echo "Creating ccweb.config.json..."

    # Prompt for API key
    read -p "Anthropic API key (or press Enter to skip): " API_KEY
    read -p "Telegram bot token (or press Enter to skip): " TG_TOKEN
    read -p "Project directory [$(pwd)]: " PROJECT_DIR
    PROJECT_DIR=${PROJECT_DIR:-$(pwd)}

    cat > ccweb.config.json << EOF
{
  "claude": {
    "apiUrl": null,
    "apiKey": ${API_KEY:+\"$API_KEY\"}${API_KEY:-null}
  },
  "web": {
    "port": 3001,
    "host": "0.0.0.0"
  },
  "telegram": {
    "token": ${TG_TOKEN:+\"$TG_TOKEN\"}${TG_TOKEN:-null},
    "allowedUsers": []
  },
  "session": {
    "timeoutMs": 1800000,
    "watchdogIntervalMs": 10000,
    "defaultProject": "$PROJECT_DIR"
  }
}
EOF
    echo "Config written to ccweb.config.json"
fi

# Claude Code settings for plugins
CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
    mkdir -p "$CLAUDE_DIR"
    cat > "$SETTINGS_FILE" << 'EOF'
{
  "enabledPlugins": {
    "context7@claude-plugins-official": true,
    "superpowers@claude-plugins-official": true
  },
  "skipDangerousModePermissionPrompt": true
}
EOF
    echo "Created $SETTINGS_FILE with default plugins"
else
    echo "OK: $SETTINGS_FILE exists"
fi

echo ""
echo "Setup complete!"
echo ""
echo "To start:"
echo "  npx tsx ./src/index.ts"
echo ""
echo "Or with env var:"
echo "  ANTHROPIC_API_KEY=sk-ant-... npx tsx ./src/index.ts"
echo ""
echo "Web UI: http://localhost:3001"
