#!/usr/bin/env bash
# A private, frozen Vite dev server for design rounds and screenshots, when the
# shared dev server on :3200 keeps reloading under other sessions' edits or
# heavy load (scripts/frozen-dev.config.ts: no HMR, no watcher, its own cache).
#
#   scripts/frozen-dev.sh start     # serve on 3216 + AGENT_RESOURCE_INDEX, in tmux
#   scripts/frozen-dev.sh restart   # pick up edits (the server never sees them)
#   scripts/frozen-dev.sh stop | status | url | log
#
# FROZEN_PORT overrides the port. The server runs in tmux session
# frozen-dev-<port>; its output is in /tmp/frozen-dev-<port>.log.
set -euo pipefail

web="$(cd "$(dirname "$0")/.." && pwd)"
port="${FROZEN_PORT:-$((3216 + ${AGENT_RESOURCE_INDEX:-0}))}"
session="frozen-dev-$port"
log="/tmp/frozen-dev-$port.log"
cache="$web/node_modules/.vite-frozen-$port"

running() { tmux has-session -t "$session" 2>/dev/null; }

start_server() {
  if running; then echo "already serving: http://localhost:$port"; return; fi
  tmux new-session -d -s "$session" -c "$web" \
    "FROZEN_PORT=$port FROZEN_CACHE_DIR=$cache bunx vite --config scripts/frozen-dev.config.ts 2>&1 | tee $log"
  echo "starting on http://localhost:$port (log: $log)"
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "http://localhost:$port/"; then echo "ready: http://localhost:$port"; return; fi
    sleep 1
  done
  echo "not answering yet; check $log" >&2
}

stop_server() {
  if running; then tmux kill-session -t "$session"; echo "stopped $session"; else echo "not running"; fi
}

case "${1:-start}" in
  start) start_server ;;
  stop) stop_server ;;
  # A frozen server serves the transforms it made first; restart drops them
  # (and its deps cache, which a dependency change would leave stale).
  restart) stop_server; rm -rf "$cache"; start_server ;;
  status) if running; then echo "serving: http://localhost:$port"; else echo "not running"; fi ;;
  url) echo "http://localhost:$port" ;;
  log) tail -n 60 "$log" ;;
  *) echo "usage: $0 start|stop|restart|status|url|log" >&2; exit 2 ;;
esac
