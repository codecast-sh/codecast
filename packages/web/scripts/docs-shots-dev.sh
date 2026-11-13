#!/usr/bin/env bash
# The docs shots dev server (lib/docsShots): the real web app over the Acme
# fixture world, no server, no account. Its own port, so its own origin,
# storage and outbox, apart from any dev server signed in to a real account.
# Idempotent: reuses a running server. Runs detached in tmux (docs-shots-web);
# its output is in /tmp/docs-shots-web.log.
#
#   packages/web/scripts/docs-shots-dev.sh          start or reuse, print the URL
#   packages/web/scripts/docs-shots-dev.sh stop
set -euo pipefail
PORT="${DOCS_SHOTS_PORT:-3290}"
SESSION=docs-shots-web
LOG=/tmp/docs-shots-web.log
WEB="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "stop" ]]; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  exit 0
fi

up() { curl -sf -o /dev/null "http://localhost:$PORT/" ; }
if ! up; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" -c "$WEB" \
    "VITE_DOCS_SHOTS=1 exec bunx vite --port $PORT --strictPort --host 127.0.0.1 >$LOG 2>&1"
  for _ in $(seq 1 180); do up && break; sleep 1; done
  up || { echo "docs shots server did not answer on :$PORT; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
fi
echo "http://localhost:$PORT"
