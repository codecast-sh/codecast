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
CONVEX_RESTARTS=0
CONVEX_LAST_START=0
MAX_RAPID_RESTARTS=5
RAPID_WINDOW=60
WEB_FAIL_COUNT=0
WEB_FAIL_THRESHOLD=3
HTTP_FAIL_COUNT=0
HTTP_FAIL_THRESHOLD=4
HTTP_CHECK_INTERVAL=30
LAST_HTTP_CHECK=0
WEB_STARTED_AT=0

log() { printf "\033[90m[%s]\033[0m %s\n" "$(date +%H:%M:%S)" "$*"; }
log_warn() { printf "\033[90m[%s]\033[0m \033[33m%s\033[0m\n" "$(date +%H:%M:%S)" "$*"; }
log_err() { printf "\033[90m[%s]\033[0m \033[31m%s\033[0m\n" "$(date +%H:%M:%S)" "$*"; }

kill_tree() {
    local pid=$1 sig=${2:-TERM}
    local children
    children=$(pgrep -P $pid 2>/dev/null)
    for child in $children; do
        kill_tree $child $sig
    done
    kill -$sig $pid 2>/dev/null
}

kill_port() {
    local port=$1
    local pids attempts=0
    pids=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$pids" ]; then
        log "Clearing port $port (pids: $pids)"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 0.5
        pids=$(lsof -ti :$port 2>/dev/null)
        [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
    while lsof -ti :$port >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ $attempts -ge 10 ]; then
            log_err "Port $port still in use after ${attempts}s, force killing"
            lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true
            sleep 1
            break
        fi
        sleep 1
    done
}

kill_web() {
    pkill -f "next dev -p $PORT" 2>/dev/null || true
    pkill -f "next-server" 2>/dev/null || true
    kill_port $PORT
}

cleanup() {
    SHUTTING_DOWN=true
    echo ""
    log "Shutting down..."
    [ -n "$CONVEX_PID" ] && kill_tree $CONVEX_PID
    kill_web
    sleep 1
    [ -n "$CONVEX_PID" ] && kill_tree $CONVEX_PID 9
    kill_port $PORT
    wait 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

check_rapid_restarts() {
    local name=$1 count=$2
    if [ $count -ge $MAX_RAPID_RESTARTS ]; then
        local backoff=$((count * 5))
        [ $backoff -gt 60 ] && backoff=60
        log_warn "$name crash-looping ($count restarts in ${RAPID_WINDOW}s window), backing off ${backoff}s..."
        sleep $backoff
    fi
}

start_convex() {
    local now=$(date +%s)
    if [ $((now - CONVEX_LAST_START)) -gt $RAPID_WINDOW ]; then
        CONVEX_RESTARTS=0
    fi
    CONVEX_LAST_START=$now
    CONVEX_RESTARTS=$((CONVEX_RESTARTS + 1))

    check_rapid_restarts "convex" $CONVEX_RESTARTS
    $SHUTTING_DOWN && return

    [ -n "$CONVEX_PID" ] && kill_tree $CONVEX_PID
    cd "$ROOT_DIR/packages/convex"
    bun run dev &
    CONVEX_PID=$!
    cd "$ROOT_DIR"
    log "Convex started (pid $CONVEX_PID)"
}

start_web() {
    $SHUTTING_DOWN && return

    kill_web
    cd "$ROOT_DIR/packages/web"
    "$ROOT_DIR/node_modules/.bin/next" dev -p $PORT -H 0.0.0.0 &
    cd "$ROOT_DIR"

    local attempts=0
    while [ $attempts -lt 30 ]; do
        sleep 1
        attempts=$((attempts + 1))
        if lsof -ti :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
            log "Web ready on port $PORT"
            WEB_FAIL_COUNT=0
            HTTP_FAIL_COUNT=0
            WEB_STARTED_AT=$(date +%s)
            return
        fi
    done
    log_warn "Web started but port $PORT not yet bound after ${attempts}s"
}

port_is_listening() {
    lsof -ti :$PORT -sTCP:LISTEN >/dev/null 2>&1
}

http_is_healthy() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:$PORT/api/health" 2>/dev/null)
    [ "$status" = "200" ]
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

    if ! port_is_listening; then
        WEB_FAIL_COUNT=$((WEB_FAIL_COUNT + 1))
        if [ $WEB_FAIL_COUNT -ge $WEB_FAIL_THRESHOLD ]; then
            log_err "Web not responding on port $PORT (${WEB_FAIL_COUNT} consecutive checks), restarting..."
            start_web
        fi
    else
        WEB_FAIL_COUNT=0
    fi

    now=$(date +%s)
    uptime=$((now - WEB_STARTED_AT))
    if port_is_listening && [ $uptime -gt 60 ] && [ $((now - LAST_HTTP_CHECK)) -ge $HTTP_CHECK_INTERVAL ]; then
        LAST_HTTP_CHECK=$now
        if ! http_is_healthy; then
            HTTP_FAIL_COUNT=$((HTTP_FAIL_COUNT + 1))
            log_warn "HTTP health check failed (${HTTP_FAIL_COUNT}/${HTTP_FAIL_THRESHOLD})"
            if [ $HTTP_FAIL_COUNT -ge $HTTP_FAIL_THRESHOLD ]; then
                log_err "Web server unhealthy (port open but not responding to HTTP), restarting..."
                HTTP_FAIL_COUNT=0
                start_web
            fi
        else
            HTTP_FAIL_COUNT=0
        fi
    fi
done
