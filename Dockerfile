# ── Build stage ──────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# node-pty requires native compilation tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Remove devDependencies (except tsx which is needed at runtime for edge-tts .ts imports)
RUN npm prune --omit=dev && npm install tsx

# ── Production stage ────────────────────────────────────────
FROM node:20-bookworm-slim

# Runtime dependencies: git (claude-agent-sdk), ffmpeg (audio), tmux, python3 (node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ffmpeg tmux python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Claude Code CLI (for agent-sdk authentication)
RUN npm install -g @anthropic-ai/claude-code

# Projects directory (will be mounted via volumes)
RUN mkdir -p /app/projects

ENV NODE_ENV=production

CMD ["npx", "tsx", "dist/index.js"]
