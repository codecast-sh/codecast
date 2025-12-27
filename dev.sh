#!/bin/bash
set -e

cd "$(dirname "$0")"

INSTANCE="${1:-0}"
BASE_PORT=3200
PORT=$((BASE_PORT + INSTANCE))

if [ "$INSTANCE" = "0" ]; then
    HOSTNAME="local.codecast.sh"
else
    HOSTNAME="local.${INSTANCE}.codecast.sh"
fi

cleanup() {
    echo "Shutting down..."
    kill $CONVEX_PID $WEB_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "Clearing old processes..."
pkill -f "convex dev" 2>/dev/null || true
lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
sleep 1

if ! grep -q "$HOSTNAME" /etc/hosts 2>/dev/null; then
    echo "WARNING: $HOSTNAME not in /etc/hosts"
    echo "Run once: sudo ./setup-hosts.sh"
    echo ""
fi

echo "Installing dependencies..."
bun install

echo "Starting Convex backend..."
cd packages/convex
bun run dev &
CONVEX_PID=$!
cd ../..

sleep 3

echo "Starting web dashboard on port $PORT..."
cd packages/web
bun run dev -- -p $PORT -H 0.0.0.0 &
WEB_PID=$!
cd ../..

echo ""
echo "================================"
echo "Dev servers running:"
echo "  Web:    http://${HOSTNAME}"
echo "  Alt:    http://localhost:${PORT}"
echo "  Convex: running in background"
echo "================================"
echo ""
echo "Press Ctrl+C to stop all servers"

wait
