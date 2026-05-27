#!/usr/bin/env bash
# Bootstrap / refresh the codecast daemon on the remote Mac.
#   - overlays our (uncommitted) CLI source onto the Mac's codecast checkout
#   - removes the stale committed daemon.js that shadows daemon.ts under bun
#   - (re)starts the daemon from source with the remote-device flag
# Assumes the Mac already has: codecast source, bun, and ~/.codecast/config.json.
set -uo pipefail
source "$(dirname "$0")/../.env.cloud-test"
IP=${MAC_IP:-51.159.120.28}; MUSER=${MAC_USER:-m1}
KEY=~/.codecast/scaleway/d7_id_ed25519
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 $MUSER@$IP"
RSYNC_E="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
SRC=/Users/ashot/src/codecast/packages/cli/src
DEST=/Users/m1/work/codecast/packages/cli/src

echo "[1] overlay CLI source"
rsync -az -e "$RSYNC_E" --exclude '*.test.ts' "$SRC/" "$MUSER@$IP:$DEST/"

echo "[2] remove stale daemon.js shadow (bun resolves import('./daemon.js') to it, not daemon.ts)"
$SSH "rm -f $DEST/daemon.js"

echo "[3] (re)start daemon from source, remote-device flag (tmux on PATH via ~/.local/bin)"
$SSH 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; export CODECAST_REMOTE_DEVICE=1; cd /Users/m1/work/codecast/packages/cli; pkill -f "index.ts _daemon" 2>/dev/null; sleep 2; nohup bun run src/index.ts _daemon > /tmp/macdaemon.log 2>&1 & echo "  daemon pid $!"'
echo "[done] tail daemon.log: ssh $MUSER@$IP 'tail -f ~/.codecast/daemon.log'"
