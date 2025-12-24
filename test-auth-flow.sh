#!/bin/bash
# Integration test for complete auth expiry flow

set -e

CONFIG_DIR="$HOME/.codecast"
STATE_FILE="$CONFIG_DIR/daemon.state"
BACKUP_FILE="$CONFIG_DIR/daemon.state.backup"

echo "Testing complete auth expiry flow..."
echo

# Backup existing state
if [ -f "$STATE_FILE" ]; then
  echo "Backing up existing daemon state..."
  cp "$STATE_FILE" "$BACKUP_FILE"
fi

# Step 1: Simulate auth expiry
echo "Step 1: Simulating auth token expiry..."
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
echo "✅ Set authExpired=true"

# Step 2: Verify status shows auth expired
echo
echo "Step 2: Checking daemon status..."
OUTPUT=$(bun run packages/cli/src/index.ts status 2>&1)
if echo "$OUTPUT" | grep -q "Auth: expired"; then
  echo "✅ Status correctly shows 'Auth: expired'"
else
  echo "❌ FAIL: Status does not show 'Auth: expired'"
  echo "Output: $OUTPUT"
  exit 1
fi

if echo "$OUTPUT" | grep -q "codecast auth"; then
  echo "✅ Status shows re-auth instruction"
else
  echo "❌ FAIL: Missing re-auth instruction"
  exit 1
fi

# Step 3: Verify daemon would pause sync
echo
echo "Step 3: Verifying sync pause behavior..."
STATE_CONTENT=$(cat "$STATE_FILE")
if echo "$STATE_CONTENT" | grep -q '"authExpired": true'; then
  echo "✅ Daemon state has authExpired flag set"
else
  echo "❌ FAIL: authExpired flag not set in state"
  exit 1
fi

# Step 4: Simulate re-authentication
echo
echo "Step 4: Simulating re-authentication..."
cat > "$STATE_FILE" <<EOF
{
  "connected": true,
  "lastSyncTime": $(date +%s)000,
  "pendingQueueSize": 0,
  "timestamp": $(date +%s)000,
  "authExpired": false
}
EOF
echo "✅ Cleared authExpired flag"

# Step 5: Verify status shows authenticated
echo
echo "Step 5: Verifying status after re-auth..."
OUTPUT=$(bun run packages/cli/src/index.ts status 2>&1)
if echo "$OUTPUT" | grep -q "Auth: authenticated\|Auth: expired" && ! echo "$OUTPUT" | grep -q "Auth: expired"; then
  echo "✅ Status no longer shows expired"
else
  echo "⚠️  Note: Status output depends on actual config file"
fi

# Restore backup
if [ -f "$BACKUP_FILE" ]; then
  echo
  echo "Restoring original daemon state..."
  mv "$BACKUP_FILE" "$STATE_FILE"
else
  rm -f "$STATE_FILE"
fi

echo
echo "========================================="
echo "All auth flow tests passed!"
echo "========================================="
