#!/bin/bash

cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

INSTANCE="${1:-0}"
BASE_PORT=3200
PORT=$((BASE_PORT + INSTANCE))
SHUTTING_DOWN=false

if [ "$INSTANCE" = "0" ]; then
    HOSTNAME="local.codecast.sh"
else
    HOSTNAME="local.${INSTANCE}.codecast.sh"
fi

CONVEX_PID=""
WEB_PID=""
CONVEX_RESTARTS=0
WEB_RESTARTS=0
CONVEX_LAST_START=0
WEB_LAST_START=0
MAX_RAPID_RESTARTS=5
RAPID_WINDOW=60

log() { printf "\033[90m[%s]\033[0m %s\n" "$(date +%H:%M:%S)" "$*"; }
log_warn() { printf "\033[90m[%s]\033[0m \033[33m%s\033[0m\n" "$(date +%H:%M:%S)" "$*"; }
log_err() { printf "\033[90m[%s]\033[0m \033[31m%s\033[0m\n" "$(date +%H:%M:%S)" "$*"; }

cleanup() {
    SHUTTING_DOWN=true
    echo ""
    log "Shutting down..."
    [ -n "$CONVEX_PID" ] && kill $CONVEX_PID 2>/dev/null
    [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null
    sleep 1
    [ -n "$CONVEX_PID" ] && kill -9 $CONVEX_PID 2>/dev/null
    [ -n "$WEB_PID" ] && kill -9 $WEB_PID 2>/dev/null
    wait 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

kill_port() {
    local port=$1
    local pids
    pids=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$pids" ]; then
        log "Clearing port $port (pids: $pids)"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 0.5
        pids=$(lsof -ti :$port 2>/dev/null)
        [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
}

check_rapid_restarts() {
    local name=$1 count=$2 last_start=$3
    local now=$(date +%s)
    local elapsed=$((now - last_start))

    if [ $elapsed -lt $RAPID_WINDOW ] && [ $count -ge $MAX_RAPID_RESTARTS ]; then
        local backoff=$((count * 5))
        [ $backoff -gt 60 ] && backoff=60
        log_warn "$name crash-looping ($count restarts in ${elapsed}s), backing off ${backoff}s..."
        sleep $backoff
    fi
}

start_convex() {
    local now=$(date +%s)
    if [ $((now - CONVEX_LAST_START)) -gt $RAPID_WINDOW ]; then
        CONVEX_RESTARTS=0
    fi
    CONVEX_RESTARTS=$((CONVEX_RESTARTS + 1))
    CONVEX_LAST_START=$now

    check_rapid_restarts "convex" $CONVEX_RESTARTS $CONVEX_LAST_START
    $SHUTTING_DOWN && return

    cd "$ROOT_DIR/packages/convex"
    bun run dev &
    CONVEX_PID=$!
    cd "$ROOT_DIR"
    log "Convex started (pid $CONVEX_PID)"
}

start_web() {
    local now=$(date +%s)
    if [ $((now - WEB_LAST_START)) -gt $RAPID_WINDOW ]; then
        WEB_RESTARTS=0
    fi
    WEB_RESTARTS=$((WEB_RESTARTS + 1))
    WEB_LAST_START=$now

    check_rapid_restarts "web" $WEB_RESTARTS $WEB_LAST_START
    $SHUTTING_DOWN && return

    kill_port $PORT
    cd "$ROOT_DIR/packages/web"
    bun run dev -- -p $PORT -H 0.0.0.0 &
    WEB_PID=$!
    cd "$ROOT_DIR"
    log "Web started on port $PORT (pid $WEB_PID)"
}

# --- startup ---

log "Clearing old processes..."
pkill -f "convex dev" 2>/dev/null || true
kill_port $PORT
sleep 1

if ! grep -q "$HOSTNAME" /etc/hosts 2>/dev/null; then
    log_warn "$HOSTNAME not in /etc/hosts - run: sudo ./setup-hosts.sh"
fi

log "Installing dependencies..."
bun install

log "Starting Convex backend..."
start_convex
sleep 3

log "Starting web on port $PORT..."
start_web

echo ""
echo "================================"
echo "  Web:    http://${HOSTNAME}"
echo "  Alt:    http://localhost:${PORT}"
echo "  Convex: running in background"
echo "================================"
echo ""

# --- watchdog ---

while true; do
    sleep 5
    $SHUTTING_DOWN && break

    if [ -n "$CONVEX_PID" ] && ! kill -0 $CONVEX_PID 2>/dev/null; then
        log_err "Convex died (was pid $CONVEX_PID), restarting..."
        start_convex
    fi

    if [ -n "$WEB_PID" ] && ! kill -0 $WEB_PID 2>/dev/null; then
        log_err "Web died (was pid $WEB_PID), restarting..."
        start_web
    fi
done
