# Claude Code Discord Bot

A Discord bot that enables interaction with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through Discord channels. Each channel can be mapped to a different project, allowing you to manage multiple codebases through Discord.

## Features

- **Multi-Project Support**: Map different Discord channels to different project directories
- **Session Management**: Create, manage, and end Claude Code sessions per thread
- **Mode Switching**: Switch between Action, Plan, and Ask modes
- **Permission Handling**: Interactive permission prompts for tool executions
- **Image Support**: Send images for Claude to analyze
- **Voice Messages**: Text-to-speech responses and voice message transcription
- **Subsession Delegation**: Spawn parallel sub-agents for complex tasks
- **Hot-Reload Configuration**: Update settings without restarting the bot

## Quick Start

**One-command setup:**
```bash
git clone https://github.com/anthropics/claude-with-discord.git
cd claude-with-discord
./scripts/setup.sh
```

This script will:
- Check and install dependencies
- Authenticate Claude Code CLI
- Guide you through Discord bot token setup
- Configure your first channel

For manual setup, see the **[Setup Guide](docs/SETUP.md)**.

## Prerequisites

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Discord Bot Token ([create one here](https://discord.com/developers/applications))
- (Optional) OpenAI API Key for voice message transcription

## Installation

1. Clone the repository:
```bash
git clone https://github.com/anthropics/claude-with-discord.git
cd claude-with-discord
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add your Discord bot token:
```env
DISCORD_TOKEN=your_discord_bot_token_here
OPENAI_API_KEY=your_openai_api_key_here  # Optional: for voice transcription
```

4. Configure your channels and projects:
```bash
cp config.example.json config.json
```

Edit `config.json` to map your Discord channel IDs to project paths:
```json
{
  "channel_project_map": {
    "YOUR_CHANNEL_ID": "/path/to/your/project"
  },
  "channel_system_prompts": {
    "YOUR_CHANNEL_ID": "Custom system prompt for this project..."
  }
}
```

5. Build and run:
```bash
npm run build
npm start
```

## Configuration

### config.json

| Field | Type | Description |
|-------|------|-------------|
| `global_context` | string | Context included in all sessions |
| `channel_project_map` | object | Maps Discord channel IDs to project directories |
| `channel_system_prompts` | object | Custom system prompts per channel |
| `permission_mode` | string | `"bypassPermissions"` or `"default"` |
| `max_budget_usd` | number | Maximum budget per session in USD |
| `max_turns` | number | Maximum conversation turns per session |
| `max_concurrent_sessions` | number | Maximum active sessions |
| `session_timeout_minutes` | number | Session timeout in minutes |
| `allowed_users` | array | Discord user IDs allowed to use the bot (empty = all) |
| `tts_enabled` | boolean | Enable text-to-speech responses |
| `tts_voice` | string | TTS voice (e.g., `"en-US-AriaNeural"`) |

### Permission Modes

- `bypassPermissions`: Automatically approve all tool executions (use with caution)
- `default`: Show interactive permission prompts for potentially dangerous operations

## Usage

### Starting a Session

1. Send a message in a configured channel
2. A new thread will be created with your session
3. Claude Code will respond in the thread

### Commands

In an active session thread:
- **New Session**: Click the "New Session" button to start fresh
- **End Session**: Click "End Session" to close the current session
- **Mode Switch**: Use mode buttons to switch between Action/Plan/Ask modes

### Subsessions

The bot supports spawning parallel sub-agents (subsessions) for complex tasks:
- Sub-agents run in their own Discord threads
- Results are automatically delivered back to the parent session
- Useful for parallelizing independent tasks

## Docker

### Using Docker Compose

```bash
docker-compose up -d
```

### Building Manually

```bash
docker build -t claude-discord .
docker run -d \
  --name claude-discord \
  --env-file .env \
  -v $(pwd)/config.json:/app/config.json:ro \
  claude-discord
```

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Build TypeScript
npm run build
```

## Architecture

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuration management
├── types.ts              # TypeScript types
├── discord/              # Discord.js integration
│   ├── client.ts         # Discord client setup
│   ├── events/           # Event handlers
│   └── components/       # Interactive components
├── claude/               # Claude Agent SDK integration
│   ├── sessionManager.ts # Core session logic
│   └── messageFormatter.ts
├── mcp/                  # Model Context Protocol
│   └── tools/            # MCP tools for subsessions
├── services/             # Business logic services
└── utils/                # Utilities
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Security

See [SECURITY.md](SECURITY.md) for security policy and reporting vulnerabilities.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
- Powered by [discord.js](https://discord.js.org/)
