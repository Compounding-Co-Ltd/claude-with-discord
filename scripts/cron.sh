#!/bin/bash
# cron.sh - Non-interactive crontab management for Claude
# Uses file-based approach to avoid TTY requirements
#
# Usage:
#   ./cron.sh list              - List all cron jobs
#   ./cron.sh add "SCHEDULE" "COMMAND"  - Add a new cron job
#   ./cron.sh remove INDEX      - Remove cron job at index (1-based)
#   ./cron.sh clear             - Remove all cron jobs

set -e

ACTION="${1:-list}"
USER=$(whoami)
CRON_DIR="/var/at/tabs"
USER_CRON="$CRON_DIR/$USER"
TEMP_FILE="/tmp/crontab_claude_$$"

cleanup() {
  rm -f "$TEMP_FILE" "${TEMP_FILE}.new"
}
trap cleanup EXIT

# Helper: Read current crontab safely
read_crontab() {
  if [ -f "$USER_CRON" ] && [ -r "$USER_CRON" ]; then
    cat "$USER_CRON"
  else
    # Fallback to crontab -l with timeout
    timeout 2 crontab -l 2>/dev/null || true
  fi
}

# Helper: Write crontab from file
write_crontab() {
  local file="$1"
  # Use crontab command with file argument (non-interactive)
  cat "$file" | crontab 2>/dev/null || crontab "$file"
}

case "$ACTION" in
  list)
    echo "=== Current Crontab ==="
    CURRENT=$(read_crontab)
    if [ -n "$CURRENT" ]; then
      echo "$CURRENT"
      echo ""
      echo "=== Indexed List (non-comment lines) ==="
      echo "$CURRENT" | grep -v '^#' | grep -v '^$' | nl -ba || echo "(no entries)"
    else
      echo "(empty)"
    fi
    ;;

  add)
    SCHEDULE="$2"
    COMMAND="$3"

    if [ -z "$SCHEDULE" ] || [ -z "$COMMAND" ]; then
      echo "Usage: $0 add \"SCHEDULE\" \"COMMAND\""
      echo "Example: $0 add \"0 */6 * * *\" \"cd /path && ./script.sh\""
      exit 1
    fi

    NEW_ENTRY="$SCHEDULE $COMMAND"

    # Get existing crontab to file
    read_crontab > "$TEMP_FILE"

    # Append new entry
    echo "$NEW_ENTRY" >> "$TEMP_FILE"

    # Install from file
    write_crontab "$TEMP_FILE"

    echo "Added: $NEW_ENTRY"
    echo ""
    echo "=== Updated Crontab ==="
    read_crontab
    ;;

  remove)
    INDEX="$2"

    if [ -z "$INDEX" ]; then
      echo "Usage: $0 remove INDEX"
      echo "Use '$0 list' to see indexes"
      exit 1
    fi

    # Get current crontab
    CURRENT=$(read_crontab)
    if [ -z "$CURRENT" ]; then
      echo "Crontab is empty"
      exit 1
    fi

    # Remove the line at INDEX (counting non-comment, non-empty lines)
    echo "$CURRENT" | awk -v idx="$INDEX" '
      /^#/ || /^$/ { print; next }
      { count++ }
      count != idx { print }
    ' > "$TEMP_FILE"

    write_crontab "$TEMP_FILE"

    echo "Removed entry at index $INDEX"
    echo ""
    echo "=== Updated Crontab ==="
    read_crontab || echo "(empty)"
    ;;

  clear)
    echo "" > "$TEMP_FILE"
    write_crontab "$TEMP_FILE" || crontab -r 2>/dev/null || true
    echo "Crontab cleared"
    ;;

  *)
    echo "Unknown action: $ACTION"
    echo "Usage: $0 {list|add|remove|clear}"
    exit 1
    ;;
esac
