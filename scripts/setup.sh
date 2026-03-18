#!/bin/bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════╗"
echo "║   Claude Code Discord Bot - Setup Script   ║"
echo "╚════════════════════════════════════════════╝"
echo -e "${NC}"

# Check Node.js
echo -e "${YELLOW}[1/6] Checking Node.js...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js 20+ first.${NC}"
    echo "  - Using nvm: nvm install 20"
    echo "  - Or download from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}Node.js version must be 20 or higher. Current: $(node -v)${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ Node.js $(node -v) detected${NC}"

# Check Claude Code CLI
echo -e "${YELLOW}[2/6] Checking Claude Code CLI...${NC}"
if ! command -v claude &> /dev/null; then
    echo -e "${YELLOW}  Claude Code CLI not found. Installing...${NC}"
    npm install -g @anthropic-ai/claude-code
fi
echo -e "${GREEN}  ✓ Claude Code CLI installed${NC}"

# Check Claude authentication
echo -e "${YELLOW}[3/6] Checking Claude authentication...${NC}"
if [ ! -f ~/.claude/.credentials.json ]; then
    echo -e "${YELLOW}  Claude Code is not authenticated. Starting login...${NC}"
    claude login
fi
echo -e "${GREEN}  ✓ Claude Code authenticated${NC}"

# Install dependencies
echo -e "${YELLOW}[4/6] Installing dependencies...${NC}"
npm install
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# Setup .env
echo -e "${YELLOW}[5/6] Setting up environment...${NC}"
if [ ! -f .env ]; then
    cp .env.example .env

    echo ""
    echo -e "${BLUE}Enter your Discord Bot Token:${NC}"
    echo -e "(Get it from https://discord.com/developers/applications)"
    read -r DISCORD_TOKEN

    # Update .env file
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/your_discord_bot_token_here/$DISCORD_TOKEN/" .env
    else
        sed -i "s/your_discord_bot_token_here/$DISCORD_TOKEN/" .env
    fi

    echo -e "${GREEN}  ✓ .env file created${NC}"
else
    echo -e "${GREEN}  ✓ .env file already exists${NC}"
fi

# Setup config.json
echo -e "${YELLOW}[6/6] Setting up configuration...${NC}"
if [ ! -f config.json ]; then
    cp config.example.json config.json

    echo ""
    echo -e "${BLUE}Do you want to add a Discord channel now? (y/n)${NC}"
    read -r ADD_CHANNEL

    if [ "$ADD_CHANNEL" = "y" ] || [ "$ADD_CHANNEL" = "Y" ]; then
        echo -e "${BLUE}Enter Discord Channel ID:${NC}"
        echo -e "(Right-click channel > Copy Channel ID)"
        read -r CHANNEL_ID

        echo -e "${BLUE}Enter project path:${NC}"
        echo -e "(e.g., /home/user/projects/my-project)"
        read -r PROJECT_PATH

        # Update config.json using node for proper JSON handling
        node -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        config.channel_project_map = { '$CHANNEL_ID': '$PROJECT_PATH' };
        config.channel_system_prompts = { '$CHANNEL_ID': 'You are an AI agent working on this project.' };
        fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
        "

        echo -e "${GREEN}  ✓ Channel configured${NC}"
    fi

    echo -e "${GREEN}  ✓ config.json created${NC}"
else
    echo -e "${GREEN}  ✓ config.json already exists${NC}"
fi

# Build
echo ""
echo -e "${YELLOW}Building TypeScript...${NC}"
npm run build
echo -e "${GREEN}  ✓ Build complete${NC}"

# Done
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Setup Complete!                   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo -e "To start the bot:"
echo -e "  ${BLUE}npm start${NC}"
echo ""
echo -e "Or in development mode:"
echo -e "  ${BLUE}npm run dev${NC}"
echo ""
echo -e "Edit ${YELLOW}config.json${NC} to add more channels."
echo ""

# Ask to start
echo -e "${BLUE}Start the bot now? (y/n)${NC}"
read -r START_NOW

if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
    npm start
fi
