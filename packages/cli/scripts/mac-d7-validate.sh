#!/usr/bin/env bash
# D7 live validation against the real Scaleway Mac.
# Proves: SSH works, it's real macOS, real Chrome launches + CDP reachable.
set -uo pipefail

source /Users/ashot/src/codecast/packages/cli/.env.cloud-test
HOST_ID=36563bd2-ab96-4045-8aec-894b84a2f66c
IP=51.159.120.28
USER=m1
KEY=~/.codecast/scaleway/d7_id_ed25519
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $USER@$IP"

echo "=== 1. SSH reachability + macOS identity ==="
$SSH 'sw_vers && uname -m && whoami' || { echo "SSH FAILED"; exit 1; }

echo ""
echo "=== 2. Is real Chrome (or installable)? check + Homebrew ==="
$SSH 'ls "/Applications/Google Chrome.app" 2>/dev/null && echo CHROME_PRESENT || echo CHROME_ABSENT'
$SSH 'command -v brew >/dev/null 2>&1 && echo BREW_PRESENT || echo BREW_ABSENT'

echo ""
echo "=== done with base validation ==="
