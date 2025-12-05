#!/bin/bash
set -e

cd "$(dirname "$0")"

cleanup() {
    echo "Shutting down..."
    kill $CONVEX_PID $WEB_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "Installing dependencies..."
bun install

echo "Starting Convex backend..."
cd packages/convex
bun run dev &
CONVEX_PID=$!
cd ../..

sleep 3

echo "Starting web dashboard..."
cd packages/web
bun run dev &
WEB_PID=$!
cd ../..

echo ""
echo "================================"
echo "Dev servers running:"
echo "  Web:    http://localhost:3000"
echo "  Convex: running in background"
echo "================================"
echo ""
echo "Press Ctrl+C to stop all servers"

wait
