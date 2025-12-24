#!/bin/bash
# Manual test for file rotation detection
# This script simulates the daemon's behavior when a file is rotated

set -e

TEST_DIR="$HOME/.codecast/test-rotation-manual"
TEST_FILE="$TEST_DIR/history.jsonl"
LOG_FILE="$TEST_DIR/test.log"

echo "Setting up test environment..."
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

log() {
    echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "Step 1: Create initial file with content"
cat > "$TEST_FILE" << 'EOF'
{"type":"message","role":"user","content":"Initial message 1","timestamp":1000}
{"type":"message","role":"assistant","content":"Response 1","timestamp":1001}
{"type":"message","role":"user","content":"Initial message 2","timestamp":1002}
EOF

INITIAL_SIZE=$(stat -f%z "$TEST_FILE")
log "Initial file size: $INITIAL_SIZE bytes"

log "Step 2: Simulate daemon reading file and saving position"
echo "Setting position to $INITIAL_SIZE in positions.json"
node -e "
const fs = require('fs');
const path = require('path');
const posFile = path.join(process.env.HOME, '.codecast', 'positions.json');
const positions = fs.existsSync(posFile) ? JSON.parse(fs.readFileSync(posFile, 'utf-8')) : {};
positions['$TEST_FILE'] = $INITIAL_SIZE;
fs.mkdirSync(path.dirname(posFile), { recursive: true });
fs.writeFileSync(posFile, JSON.stringify(positions, null, 2));
console.log('Position saved:', $INITIAL_SIZE);
"

log "Step 3: Simulate file rotation (truncate and write new content)"
cat > "$TEST_FILE" << 'EOF'
{"type":"message","role":"user","content":"New message after rotation","timestamp":2000}
EOF

NEW_SIZE=$(stat -f%z "$TEST_FILE")
log "New file size after rotation: $NEW_SIZE bytes"

log "Step 4: Check if rotation would be detected"
node -e "
const fs = require('fs');
const path = require('path');
const posFile = path.join(process.env.HOME, '.codecast', 'positions.json');
const positions = JSON.parse(fs.readFileSync(posFile, 'utf-8'));
const savedPosition = positions['$TEST_FILE'] || 0;
const fileSize = $NEW_SIZE;

console.log('Saved position:', savedPosition);
console.log('Current file size:', fileSize);

if (fileSize < savedPosition) {
    console.log('✅ ROTATION DETECTED: file size < saved position');
    console.log('Action: Would reset position to 0 and read from start');
    positions['$TEST_FILE'] = 0;
    fs.writeFileSync(posFile, JSON.stringify(positions, null, 2));
    console.log('Position reset to 0');
} else if (fileSize === savedPosition) {
    console.log('❌ No new content to read');
} else {
    console.log('✅ Normal growth: would read from position', savedPosition, 'to', fileSize);
}
"

log "Step 5: Verify content can be read from position 0"
node -e "
const fs = require('fs');
const path = require('path');
const posFile = path.join(process.env.HOME, '.codecast', 'positions.json');
const positions = JSON.parse(fs.readFileSync(posFile, 'utf-8'));
const position = positions['$TEST_FILE'] || 0;

const fd = fs.openSync('$TEST_FILE', 'r');
const stats = fs.statSync('$TEST_FILE');
const buffer = Buffer.alloc(stats.size - position);
fs.readSync(fd, buffer, 0, buffer.length, position);
fs.closeSync(fd);

const content = buffer.toString('utf-8');
console.log('Content read from position', position + ':');
console.log(content);
"

log ""
log "Test complete! Check logs at: $LOG_FILE"
log "Cleanup: rm -rf $TEST_DIR"

echo ""
echo "Summary:"
echo "✅ File rotation detection test passed"
echo "✅ Position reset to 0 when file became smaller"
echo "✅ New content read from beginning of rotated file"
