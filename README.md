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

### Automated Setup (Recommended)

```bash
git clone https://github.com/anthropics/claude-with-discord.git
cd claude-with-discord
./scripts/setup.sh
```

The script handles everything: dependency installation, Claude CLI auth, and configuration.

### Manual Setup

See the **[Setup Guide](docs/SETUP.md)** for step-by-step instructions.

### Docker

See the **[Docker Guide](docs/DOCKER.md)** for container deployment.

## Usage

### Starting a Session

1. Send a message in a configured channel
2. A new thread will be created with your session
3. Claude Code will respond in the thread

### Session Controls

- **New Session**: Start a fresh session
- **End Session**: Close the current session
- **Mode Switch**: Toggle between Action/Plan/Ask modes

### Modes

| Mode | Description |
|------|-------------|
| **Action** | Claude executes tasks directly |
| **Plan** | Claude creates plans for approval before execution |
| **Ask** | Claude only answers questions, no code changes |

### Subsessions

The bot supports spawning parallel sub-agents for complex tasks:
- Sub-agents run in their own Discord threads
- Results are automatically delivered back to the parent session
- Useful for parallelizing independent tasks

## Configuration

See [config.example.json](config.example.json) for all available options.

Key settings:

| Option | Description |
|--------|-------------|
| `channel_project_map` | Maps Discord channel IDs to project directories |
| `channel_system_prompts` | Custom system prompts per channel |
| `permission_mode` | `"bypassPermissions"` or `"default"` |
| `max_concurrent_sessions` | Maximum active sessions |
| `allowed_users` | Restrict access to specific Discord user IDs |

## Development

```bash
# Development mode with hot reload
npm run dev

# Build TypeScript
npm run build

# Lint and format
npm run lint
npm run format
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

## Documentation

- [Setup Guide](docs/SETUP.md) - Detailed installation instructions
- [Docker Guide](docs/DOCKER.md) - Container deployment
- [Contributing](CONTRIBUTING.md) - Contribution guidelines
- [Security](SECURITY.md) - Security policy

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
- Powered by [discord.js](https://discord.js.org/)
