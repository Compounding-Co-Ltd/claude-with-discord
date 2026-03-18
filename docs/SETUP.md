# Setup Guide

This guide walks you through setting up Claude Code Discord Bot from scratch.

## Prerequisites

### 1. Node.js 20+

```bash
# Check your Node.js version
node --version  # Should be v20.x.x or higher

# Install via nvm (recommended)
nvm install 20
nvm use 20
```

### 2. Claude Code CLI

Install and authenticate the Claude Code CLI:

```bash
# Install Claude Code CLI globally
npm install -g @anthropic-ai/claude-code

# Authenticate (opens browser for OAuth)
claude login
```

Verify the installation:
```bash
claude --version
```

### 3. Discord Bot Token

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" section in the left sidebar
4. Click "Reset Token" to generate a new token
5. **Copy and save this token** (you won't be able to see it again)
6. Enable these Privileged Gateway Intents:
   - MESSAGE CONTENT INTENT
   - SERVER MEMBERS INTENT (optional)

### 4. Invite Bot to Your Server

1. In Discord Developer Portal, go to "OAuth2" > "URL Generator"
2. Select scopes:
   - `bot`
   - `applications.commands`
3. Select bot permissions:
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Embed Links
   - Attach Files
   - Read Message History
   - Add Reactions
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/anthropics/claude-with-discord.git
cd claude-with-discord
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:
```env
DISCORD_TOKEN=your_discord_bot_token_here
OPENAI_API_KEY=your_openai_api_key_here  # Optional: only for voice transcription
```

### 4. Configure Channels and Projects

```bash
cp config.example.json config.json
```

#### Getting Discord Channel IDs

1. Enable Developer Mode in Discord:
   - User Settings > App Settings > Advanced > Developer Mode: ON
2. Right-click on a channel and select "Copy Channel ID"

#### Edit config.json

```json
{
  "global_context": "Optional instructions for all channels",
  "channel_project_map": {
    "1234567890123456789": "/home/user/projects/my-project",
    "9876543210987654321": "/home/user/projects/another-project"
  },
  "channel_system_prompts": {
    "1234567890123456789": "You are an AI agent for my-project...",
    "9876543210987654321": "You are an AI agent for another-project..."
  },
  "permission_mode": "bypassPermissions",
  "max_budget_usd": 50.0,
  "max_turns": 200,
  "max_concurrent_sessions": 20,
  "session_timeout_minutes": 1440,
  "allowed_users": [],
  "tts_enabled": false,
  "tts_voice": "en-US-AriaNeural"
}
```

## Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `global_context` | string | Context included in all sessions |
| `channel_project_map` | object | Maps channel IDs to project directories |
| `channel_system_prompts` | object | Custom system prompts per channel |
| `permission_mode` | string | `"bypassPermissions"` or `"default"` |
| `max_budget_usd` | number | Max budget per session (USD) |
| `max_turns` | number | Max conversation turns per session |
| `max_concurrent_sessions` | number | Max active sessions |
| `session_timeout_minutes` | number | Session timeout (minutes) |
| `allowed_users` | array | Discord user IDs allowed (empty = all) |
| `tts_enabled` | boolean | Enable text-to-speech responses |
| `tts_voice` | string | TTS voice name |

### Permission Modes

- **`bypassPermissions`**: Auto-approve all tool executions. Use only in trusted environments.
- **`default`**: Show interactive prompts for potentially dangerous operations.

### TTS Voice Options

Some available voices:
- `en-US-AriaNeural` (English, Female)
- `en-US-GuyNeural` (English, Male)
- `ko-KR-SunHiNeural` (Korean, Female)
- `ja-JP-NanamiNeural` (Japanese, Female)

See [edge-tts voices](https://github.com/rany2/edge-tts) for full list.

## Running the Bot

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
# Build TypeScript
npm run build

# Run
npm start
```

### Using PM2 (Recommended for Production)

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start ecosystem.config.cjs

# View logs
pm2 logs claude-discord

# Restart
pm2 reload claude-discord
```

## Docker Setup

### Using Docker Compose

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Manual Docker Build

```bash
# Build image
docker build -t claude-discord .

# Run container
docker run -d \
  --name claude-discord \
  --env-file .env \
  -v $(pwd)/config.json:/app/config.json:ro \
  -v /path/to/projects:/app/projects \
  claude-discord
```

## Usage

### Starting a Session

1. Send a message in a configured channel
2. The bot creates a new thread for your session
3. Claude Code responds in the thread

### Session Controls

In an active thread, you'll see buttons:
- **New Session**: Start fresh session
- **End Session**: Close current session
- **Action/Plan/Ask**: Switch Claude's mode

### Mode Descriptions

- **Action Mode**: Claude executes tasks directly
- **Plan Mode**: Claude creates plans for approval before execution
- **Ask Mode**: Claude only answers questions, no code changes

## Troubleshooting

### Bot doesn't respond

1. Check if the channel ID is in `config.json`
2. Verify the bot has permissions in that channel
3. Check logs for errors: `pm2 logs claude-discord`

### "Claude Code not authenticated" error

```bash
claude login
```

### Permission denied errors

Make sure the project paths in `config.json` are accessible by the user running the bot.

### Thread creation fails

Ensure the bot has these permissions:
- Create Public Threads
- Send Messages in Threads

## Updating

```bash
git pull
npm install
npm run build
pm2 reload claude-discord  # if using PM2
```

## Security Recommendations

1. **Never commit** `.env` or `config.json` to git
2. Use `allowed_users` to restrict access in shared servers
3. Set `permission_mode: "default"` in untrusted environments
4. Regularly rotate your Discord bot token
5. Only map trusted project directories
