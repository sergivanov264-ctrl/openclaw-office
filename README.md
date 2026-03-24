# 🏢 OpenClaw Office

Your virtual AI office — visualize multi-agent workflows in real-time.

![OpenClaw Office Dashboard](public/sprites/office-complete.png)

## What is this?

OpenClaw Office is a companion dashboard for [OpenClaw](https://github.com/openclaw/openclaw).
It gives your AI agents a virtual office where you can watch them work in real-time.

- 🎨 AI-generated office scenes matching your style
- ⚡ Real-time workflow animations (task delegation, agent collaboration)
- 🔗 Multi-step chain visualization (Agent A → Orchestrator → Agent B)
- 📊 Activity log, cost savings tracker, team stats
- 🔌 Works with any OpenClaw instance

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/wickedapp/openclaw-office
cd openclaw-office
npm install
```

### 2. Run the setup wizard (recommended)

The interactive CLI wizard auto-detects your agents, generates a custom office scene, and configures everything:

```bash
node cli/index.js init
```

The wizard will:
1. **Connect to your OpenClaw gateway** and auto-detect all your agents
2. **Ask for your office style** — Cyberpunk, Minimalist, Cozy, Corporate, or Custom
3. **Generate a custom office image** using Google Gemini (optional — works without it)
4. **Auto-detect desk positions** using Claude Vision (optional)
5. **Choose deployment method** — Docker, PM2, systemd, launchd, or manual
6. **Write all config files** for you

> For automated/CI setups: `node cli/index.js init --non-interactive`

### 3. Build and start

```bash
npm run build
npm start
```

The dashboard runs on [http://localhost:4200](http://localhost:4200) by default.

### 4. Install the Notify plugin

The [openclaw-office-notify-plugin](https://github.com/wickedapp/openclaw-office-notify-plugin) bridges your OpenClaw gateway to the Office dashboard. **Without it, the dashboard won't show real-time agent activity, task animations, or the request pipeline.**

```bash
git clone https://github.com/wickedapp/openclaw-office-notify-plugin ~/.openclaw/extensions/openclaw-office-notify
```

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-office-notify"],
    "load": {
      "paths": ["~/.openclaw/extensions/openclaw-office-notify"]
    },
    "entries": {
      "openclaw-office-notify": {
        "enabled": true
      }
    }
  }
}
```

Then restart OpenClaw:
```bash
openclaw gateway restart
```

> **No OpenClaw gateway yet?** That's fine — the dashboard works in standalone mode. You'll see the full UI with empty data. Connect a gateway and install the plugin later to see live agent activity.

## Configuration

### `openclaw-office.config.json`

```json
{
  "office": {
    "name": "My AI Office",
    "style": "cyberpunk"           // cyberpunk | minimalist | cozy | corporate
  },
  "gateway": {
    "url": "ws://127.0.0.1:18789", // OpenClaw gateway WebSocket URL
    "token": "your-gateway-token"   // See "Finding your gateway token" below
  },
  "agents": {
    "main": {
      "name": "Main",
      "role": "Orchestrator",
      "color": "#ff006e",
      "emoji": "🤖",
      "position": { "x": 50, "y": 38 }
    },
    "dev": {
      "name": "Dev",
      "role": "Developer",
      "color": "#00f5ff",
      "emoji": "💻",
      "position": { "x": 18, "y": 35 }
    }
  },
  "image": {
    "path": "public/sprites/office.png",
    "positions": {}
  },
  "telegram": {
    "botToken": "",
    "chatId": "",
    "webhookSecret": ""
  }
}
```

### Gateway Token

**If running on the same machine as OpenClaw** — the token is auto-detected from `~/.openclaw/openclaw.json`. No manual configuration needed.

**If running on a different machine**, set the token in `openclaw-office.config.json` under `gateway.token`. You can find it with:

```bash
jq '.gateway.auth.token' ~/.openclaw/openclaw.json
```

### Environment Variables

All environment variables are **optional**. The dashboard works without any of them.

| Variable | Required | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | No | Gateway WebSocket URL (overrides config) |
| `OPENCLAW_GATEWAY_TOKEN` | No | Gateway auth token (overrides config) |
| `GEMINI_API_KEY` | No | Google Gemini API key for office image generation |
| `GOOGLE_API_KEY` | No | Alternative to GEMINI_API_KEY |
| `ANTHROPIC_API_KEY` | No | Claude Vision for auto-detecting desk positions |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID for notifications |

## Features

### Real-Time Workflow Visualization
Watch tasks flow between agents with animated mail envelopes. Multi-step delegation chains show the full path: User → Orchestrator → Agent A → Agent B → Response.

### Dynamic Agent Detection
The dashboard periodically checks your OpenClaw gateway for agent changes. When new agents appear or existing ones are removed, you'll get a notification with options to update your config and regenerate the office image.

### AI-Generated Office Scenes (Optional)
Use Google Gemini or other providers to generate custom isometric office scenes. Claude Vision auto-detects desk positions for accurate agent placement. **This is entirely optional** — the dashboard includes a default office scene that works without any API keys.

### Cost & Activity Tracking
SQLite-backed activity logging with token usage tracking, cost calculations, and productivity stats.

## Deployment

### Docker

```bash
docker build -t openclaw-office .
docker run -d --name openclaw-office \
  -p 4200:4200 \
  -v $(pwd)/openclaw-office.config.json:/app/openclaw-office.config.json \
  -v $(pwd)/data:/app/data \
  --env-file .env.local \
  openclaw-office
```

### PM2

```bash
npm run build
pm2 start npm --name openclaw-office -- start
pm2 save
```

### systemd

```ini
# /etc/systemd/system/openclaw-office.service
[Unit]
Description=OpenClaw Office Dashboard
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/openclaw-office
ExecStart=/usr/bin/npm start
Restart=on-failure
EnvironmentFile=/opt/openclaw-office/.env.local

[Install]
WantedBy=multi-user.target
```

### launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.openclaw.office.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.office</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npm</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/opt/openclaw-office</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

## Architecture

```
openclaw-office/
├── app/                    # Next.js App Router
│   ├── page.js            # Main dashboard
│   └── api/               # REST + SSE endpoints
│       ├── workflow/       # Workflow events & SSE stream
│       ├── agents/sync/   # Agent discovery & sync
│       ├── generate/      # Image generation trigger
│       ├── stats/         # Token & cost statistics
│       └── config/        # Runtime config access
├── cli/                   # CLI tool (npx openclaw-office)
│   ├── commands/          # init, generate, start, status
│   └── lib/               # Gateway, image gen, prompts
├── components/            # React components
│   ├── IsometricOffice.js # Main office visualization
│   ├── AgentSprite.js     # Agent avatar rendering
│   ├── RequestPipeline.js # Workflow animation
│   └── ...
├── lib/                   # Shared server utilities
│   ├── config.js          # Config loader
│   ├── event-bus.js       # SSE event system
│   ├── agent-sync.js      # Gateway agent detection
│   ├── db.js              # SQLite database
│   └── openclaw.js        # Token tracking
└── public/sprites/        # Office images & agent sprites
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE) for details.
