#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONVEX_DIR="$ROOT_DIR/packages/convex"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

usage() {
  cat <<EOF
Usage: ./scripts/logs.sh [sources...] [options]

Tail and merge logs from prod systems.

Sources (default: railway + convex):
  -r, --railway      Railway (web app) only
  -c, --convex       Convex (backend) only

Options:
  -e, --errors       Errors/warnings only
  -n, --lines N      Show N recent lines (Railway only, disables streaming)
  -s, --since TIME   Logs since TIME, e.g. 5m, 1h, 1d (Railway only)
  -h, --help         Show this help

Examples:
  ./scripts/logs.sh              # Stream Railway + Convex
  ./scripts/logs.sh -e           # Errors only
  ./scripts/logs.sh -r           # Railway only
  ./scripts/logs.sh -c           # Convex only
  ./scripts/logs.sh -r -n 50    # Last 50 Railway lines
  ./scripts/logs.sh -s 30m      # Railway logs from last 30 min
EOF
  exit 0
}

RAILWAY=false
CONVEX=false
EXPLICIT=false
ERRORS_ONLY=false
LINES=""
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--railway) RAILWAY=true; EXPLICIT=true; shift ;;
    -c|--convex)  CONVEX=true; EXPLICIT=true; shift ;;
    -e|--errors)  ERRORS_ONLY=true; shift ;;
    -n|--lines)   LINES="$2"; shift 2 ;;
    -s|--since)   SINCE="$2"; shift 2 ;;
    -h|--help)    usage ;;
    *)            echo "Unknown option: $1"; usage ;;
  esac
done

if ! $EXPLICIT; then
  RAILWAY=true
  CONVEX=true
fi

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

prefix_lines() {
  local label="$1"
  local color="$2"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if $ERRORS_ONLY; then
      case "$line" in
        *ERROR*|*error*|*Error*|*WARN*|*warn*|*Warn*|*FAILURE*|*failure*|*exception*|*Exception*|*panic*|*PANIC*) ;;
        *) continue ;;
      esac
    fi
    printf "${color}[%-7s]${RESET} %s\n" "$label" "$line"
  done
}

sources=()
$RAILWAY && sources+=(railway)
$CONVEX && sources+=(convex)

echo -e "${DIM}Streaming: ${sources[*]}${RESET}"
echo -e "${DIM}Ctrl+C to stop${RESET}"
echo ""

if $RAILWAY; then
  RAILWAY_ARGS=(logs)
  [[ -n "$LINES" ]] && RAILWAY_ARGS+=(--lines "$LINES")
  [[ -n "$SINCE" ]] && RAILWAY_ARGS+=(--since "$SINCE")
  (cd "$ROOT_DIR" && railway "${RAILWAY_ARGS[@]}" 2>&1) | prefix_lines "railway" "$GREEN" &
  PIDS+=($!)
fi

if $CONVEX; then
  (cd "$CONVEX_DIR" && npx convex logs 2>&1) | prefix_lines "convex" "$CYAN" &
  PIDS+=($!)
fi

wait
