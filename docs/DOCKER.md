# Docker Deployment Guide

This guide covers deploying Claude Code Discord Bot using Docker.

## Prerequisites

- Docker 20.10+
- Docker Compose v2+ (optional but recommended)
- `.env` file with `DISCORD_TOKEN`
- `config.json` with channel mappings

## Quick Start with Docker Compose

```bash
# Create config files first
cp .env.example .env
cp config.example.json config.json

# Edit .env and config.json with your settings
# Then start the container
docker-compose up -d
```

## Docker Compose Configuration

Create or edit `docker-compose.yml`:

```yaml
services:
  bot:
    build: .
    container_name: claude-discord
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      # Config (read-only, hot-reload supported)
      - ./config.json:/app/config.json:ro

      # Home directory persistence (for Claude auth, git config, etc.)
      - user-home:/root

      # Project directories - add your projects here
      - /path/to/your/project1:/app/projects/project1
      - /path/to/your/project2:/app/projects/project2
    deploy:
      resources:
        limits:
          memory: 512M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  user-home:
```

### Volume Mappings

| Volume | Purpose |
|--------|---------|
| `./config.json:/app/config.json:ro` | Bot configuration (read-only) |
| `user-home:/root` | Persists Claude auth, git config, SSH keys |
| `/path/to/project:/app/projects/name` | Your project directories |

**Important**: Update `config.json` paths to match container paths:
```json
{
  "channel_project_map": {
    "CHANNEL_ID": "/app/projects/project1"
  }
}
```

## Manual Docker Build

### Build the Image

```bash
docker build -t claude-discord .
```

### Run the Container

```bash
docker run -d \
  --name claude-discord \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/config.json:/app/config.json:ro \
  -v claude-home:/root \
  -v /path/to/your/project:/app/projects/my-project \
  --memory=512m \
  claude-discord
```

## Claude Authentication in Docker

The bot needs Claude Code CLI authentication. Two options:

### Option 1: Authenticate Before Building

```bash
# On host machine
claude login

# Copy credentials to container volume
docker cp ~/.claude/. claude-discord:/root/.claude/
```

### Option 2: Authenticate Inside Container

```bash
# Enter container shell
docker exec -it claude-discord bash

# Run Claude login
claude login

# Exit container
exit
```

The credentials persist in the `user-home` volume.

## Commands

### Start
```bash
docker-compose up -d
```

### Stop
```bash
docker-compose down
```

### View Logs
```bash
docker-compose logs -f

# Or specific container
docker logs -f claude-discord
```

### Restart
```bash
docker-compose restart
```

### Rebuild (after code changes)
```bash
docker-compose up -d --build
```

### Shell Access
```bash
docker exec -it claude-discord bash
```

## Dockerfile Overview

The Dockerfile uses multi-stage builds:

**Build Stage:**
- Node.js 20 with Python/Make/G++ for native modules (node-pty)
- Installs dependencies and compiles TypeScript
- Prunes dev dependencies

**Production Stage:**
- Slim Node.js 20 image
- Runtime dependencies: git, ffmpeg, tmux, python3
- Claude Code CLI installed globally
- ~200MB final image size

## Resource Limits

Default memory limit is 512MB. Adjust in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      memory: 1G  # Increase if needed
```

## Troubleshooting

### Container keeps restarting

Check logs for errors:
```bash
docker logs claude-discord
```

Common issues:
- Invalid Discord token in `.env`
- Missing or invalid `config.json`
- Claude not authenticated

### Permission denied on project files

Ensure mounted directories are readable:
```bash
# Check container user
docker exec claude-discord whoami  # Should be root

# Check file permissions in container
docker exec claude-discord ls -la /app/projects/
```

### Out of memory

Increase memory limit or reduce concurrent sessions in `config.json`:
```json
{
  "max_concurrent_sessions": 5
}
```

### Config changes not applied

Config hot-reload should work automatically. If not:
```bash
docker-compose restart
```

## Production Recommendations

1. **Use specific image tags** instead of `latest`
2. **Set resource limits** appropriate for your workload
3. **Enable logging limits** to prevent disk fill
4. **Use secrets management** instead of `.env` files for sensitive data
5. **Set up health checks**:
   ```yaml
   healthcheck:
     test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health')"]
     interval: 30s
     timeout: 10s
     retries: 3
   ```
6. **Use a reverse proxy** (nginx/traefik) if exposing any HTTP endpoints
