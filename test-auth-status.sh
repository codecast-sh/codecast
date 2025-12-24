#!/bin/bash
# Test script for auth expired status display

set -e

CONFIG_DIR="$HOME/.codecast"
STATE_FILE="$CONFIG_DIR/daemon.state"
BACKUP_FILE="$CONFIG_DIR/daemon.state.backup"

echo "Testing auth expired status display..."
echo

# Backup existing state if it exists
if [ -f "$STATE_FILE" ]; then
  echo "Backing up existing daemon state..."
  cp "$STATE_FILE" "$BACKUP_FILE"
fi

# Create daemon state with authExpired=true
echo "Setting authExpired=true in daemon state..."
mkdir -p "$CONFIG_DIR"
cat > "$STATE_FILE" <<EOF
{
  "connected": false,
  "lastSyncTime": $(date +%s)000,
  "pendingQueueSize": 0,
  "timestamp": $(date +%s)000,
  "authExpired": true
}
EOF

# Run status command
echo "Running 'codecast status'..."
echo "---"
bun run packages/cli/src/index.ts status
echo "---"
echo

# Check if output contains "Auth: expired"
OUTPUT=$(bun run packages/cli/src/index.ts status 2>&1)
if echo "$OUTPUT" | grep -q "Auth: expired"; then
  echo "✅ PASS: Status correctly shows 'Auth: expired'"
else
  echo "❌ FAIL: Status does not show 'Auth: expired'"
  echo "Output: $OUTPUT"
  exit 1
fi

if echo "$OUTPUT" | grep -q "codecast auth"; then
  echo "✅ PASS: Status shows instruction to run 'codecast auth'"
else
  echo "❌ FAIL: Status does not show instruction to run 'codecast auth'"
  exit 1
fi

# Restore backup
if [ -f "$BACKUP_FILE" ]; then
  echo "Restoring original daemon state..."
  mv "$BACKUP_FILE" "$STATE_FILE"
else
  echo "Cleaning up test daemon state..."
  rm -f "$STATE_FILE"
fi

echo
echo "All tests passed!"
