#!/bin/bash
set -e

cd /Volumes/T7/projects/claude-with-discord

echo "Installing dependencies..."
npm install

echo "Building..."
if npm run build; then
  echo "Build successful, restarting PM2..."
  if pm2 describe claude-discord > /dev/null 2>&1; then
    pm2 restart claude-discord
  else
    pm2 start ecosystem.config.cjs
  fi
else
  echo "Build failed, keeping existing process running."
  exit 1
fi
