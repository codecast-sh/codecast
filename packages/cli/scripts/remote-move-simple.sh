#!/usr/bin/env bash
# Simple-case validation of move-to-remote: push a real CC session to the Mac,
# prove it's responsive + stateful there (recalls the codeword), then bring it
# back and prove it's still responsive locally.
set -uo pipefail

source /Users/ashot/src/codecast/packages/cli/.env.cloud-test
IP=51.159.120.28; MUSER=m1; KEY=~/.codecast/scaleway/d7_id_ed25519
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 $MUSER@$IP"
RSYNC_E="ssh -i $KEY -o StrictHostKeyChecking=accept-new"

SID="$1"                      # session id
# Canonicalize: macOS /tmp -> /private/tmp. CC encodes the PHYSICAL cwd, so we
# must resolve symlinks before building the project-dir slug.
LOCAL_CWD="$(cd /tmp/cc-simple-test && pwd -P)"
REMOTE_CWD="/Users/m1/work/cc-simple-test"
LOCAL_PROJ="$HOME/.claude/projects/$(echo "$LOCAL_CWD" | sed 's#/#-#g')"
REMOTE_PROJ="/Users/m1/.claude/projects/$(echo "$REMOTE_CWD" | sed 's#/#-#g')"

echo "=== PUSH: $LOCAL_CWD -> $MUSER@$IP:$REMOTE_CWD (session $SID) ==="

echo "[1] transfer worktree (rsync, excl node_modules)"
$SSH "mkdir -p $REMOTE_CWD"
rsync -az --delete -e "$RSYNC_E" --exclude node_modules --exclude .DS_Store \
  "$LOCAL_CWD/" "$MUSER@$IP:$REMOTE_CWD/"

echo "[2] relocate transcript JSONL into remote project dir"
$SSH "mkdir -p $REMOTE_PROJ"
# Target the DIRECTORY (trailing slash) so rsync lands the file inside it —
# avoids the file-vs-dir ambiguity that corrupts the dest into a directory.
rsync -az -e "$RSYNC_E" "$LOCAL_PROJ/$SID.jsonl" "$MUSER@$IP:$REMOTE_PROJ/"

echo "[3] resume on the Mac + test statefulness (expect BANANA)"
$SSH "export PATH=\"\$HOME/.local/bin:\$PATH\"; cd $REMOTE_CWD && claude -p --resume $SID 'What was the codeword? Reply with just the word.' --output-format json </dev/null 2>&1" \
  | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); print('  remote result:',repr(d.get('result','')[:80])); print('  session:',d.get('session_id'))
except Exception as e:
    print('  parse err:',e)"

echo ""
echo "=== add a NEW fact on the remote, then pull back and verify locally ==="
echo "[4] on remote: tell it a second codeword (KIWI), advancing the transcript"
$SSH "export PATH=\"\$HOME/.local/bin:\$PATH\"; cd $REMOTE_CWD && claude -p --resume $SID 'Remember a second codeword: KIWI. Reply with just: OK' --output-format json </dev/null 2>&1" \
  | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); print('  remote result:',repr(d.get('result','')[:40]))
except Exception as e: print('  parse err:',e)"

echo "[5] PULL: bring transcript + worktree back to local"
mkdir -p "$LOCAL_PROJ"
rsync -az -e "$RSYNC_E" "$MUSER@$IP:$REMOTE_PROJ/$SID.jsonl" "$LOCAL_PROJ/"
rsync -az --delete -e "$RSYNC_E" --exclude node_modules "$MUSER@$IP:$REMOTE_CWD/" "$LOCAL_CWD/"

echo "[6] resume LOCALLY + verify it recalls BOTH codewords (proves remote work came back)"
cd "$LOCAL_CWD" && claude -p --resume "$SID" 'List both codewords I told you, comma-separated.' --output-format json </dev/null 2>&1 \
  | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); print('  local result:',repr(d.get('result','')[:80]))
except Exception as e: print('  parse err:',e)"
