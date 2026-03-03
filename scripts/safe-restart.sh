#!/bin/bash
# 안전한 PM2 재시작 스크립트
# delete && start 대신 이 스크립트를 사용하면 실패해도 기존 프로세스가 유지됩니다.

APP_NAME="claude-discord"
ECOSYSTEM_FILE="/Volumes/T7/projects/claude-with-discord/ecosystem.config.cjs"

cd /Volumes/T7/projects/claude-with-discord

# 현재 프로세스 상태 확인
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  echo "[$APP_NAME] 프로세스가 존재합니다. reload 시도..."

  # reload는 새 프로세스가 ready 상태가 된 후에 기존 프로세스를 종료합니다
  # 실패해도 기존 프로세스가 계속 실행됩니다
  if pm2 reload "$APP_NAME" --update-env; then
    echo "[$APP_NAME] reload 성공"
  else
    echo "[$APP_NAME] reload 실패, restart 시도..."
    pm2 restart "$APP_NAME" --update-env
  fi
else
  echo "[$APP_NAME] 프로세스가 없습니다. 새로 시작..."
  pm2 start "$ECOSYSTEM_FILE"
fi

# 상태 확인
pm2 show "$APP_NAME"
