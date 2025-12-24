#!/usr/bin/env bash
#
# Test script to measure daemon memory usage
#
# Usage: ./test-daemon-memory.sh [duration_seconds]
#

set -euo pipefail

DURATION="${1:-60}"
CONFIG_DIR="${HOME}/.codecast"
PID_FILE="${CONFIG_DIR}/daemon.pid"
LOG_FILE="${CONFIG_DIR}/daemon.log"
MEMORY_THRESHOLD_MB=50
MEMORY_THRESHOLD_KB=$((MEMORY_THRESHOLD_MB * 1024))

echo "=== Daemon Memory Usage Test ==="
echo "Duration: ${DURATION} seconds"
echo "Threshold: ${MEMORY_THRESHOLD_MB}MB (${MEMORY_THRESHOLD_KB}KB)"
echo ""

cleanup() {
    if [ -f "$PID_FILE" ]; then
        DAEMON_PID=$(cat "$PID_FILE")
        echo "Stopping daemon (PID: $DAEMON_PID)..."
        kill "$DAEMON_PID" 2>/dev/null || true
        sleep 2
        kill -9 "$DAEMON_PID" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
}

trap cleanup EXIT

cleanup

echo "Starting daemon..."
cd packages/cli
bun run dist/daemon.js > /dev/null 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"
cd ../..

echo "Daemon started with PID: $DAEMON_PID"
echo "Waiting 5 seconds for daemon to initialize..."
sleep 5

if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "ERROR: Daemon failed to start or crashed"
    echo "Last 20 lines of daemon log:"
    tail -20 "$LOG_FILE" || true
    exit 1
fi

echo "Daemon is running. Monitoring memory usage..."
echo ""

SAMPLES=()
INTERVAL=1
COUNT=$DURATION

for ((i=1; i<=COUNT; i++)); do
    RSS=$(ps -p "$DAEMON_PID" -o rss= 2>/dev/null | tr -d ' ' || echo "0")

    if [ -z "$RSS" ] || [ "$RSS" = "0" ]; then
        echo "ERROR: Daemon process $DAEMON_PID not found"
        exit 1
    fi

    SAMPLES+=("$RSS")

    if [ $((i % 10)) -eq 0 ]; then
        RSS_MB=$(echo "scale=2; $RSS / 1024" | bc -l)
        echo "[$i/$COUNT] Current Memory: ${RSS_MB}MB (${RSS}KB)"
    fi

    sleep "$INTERVAL"
done

echo ""
echo "=== Results ==="

TOTAL=0
MIN=999999999
MAX=0
ABOVE_THRESHOLD=0

for rss in "${SAMPLES[@]}"; do
    TOTAL=$((TOTAL + rss))

    if [ "$rss" -gt "$MEMORY_THRESHOLD_KB" ]; then
        ABOVE_THRESHOLD=$((ABOVE_THRESHOLD + 1))
    fi

    if [ "$rss" -lt "$MIN" ]; then
        MIN="$rss"
    fi
    if [ "$rss" -gt "$MAX" ]; then
        MAX="$rss"
    fi
done

AVG=$((TOTAL / ${#SAMPLES[@]}))
AVG_MB=$(echo "scale=2; $AVG / 1024" | bc -l)
MIN_MB=$(echo "scale=2; $MIN / 1024" | bc -l)
MAX_MB=$(echo "scale=2; $MAX / 1024" | bc -l)

echo "Samples collected: ${#SAMPLES[@]}"
echo "Average Memory: ${AVG_MB}MB (${AVG}KB)"
echo "Min Memory: ${MIN_MB}MB (${MIN}KB)"
echo "Max Memory: ${MAX_MB}MB (${MAX}KB)"
echo "Samples above ${MEMORY_THRESHOLD_MB}MB: $ABOVE_THRESHOLD / ${#SAMPLES[@]}"
echo ""

if [ "$MAX" -lt "$MEMORY_THRESHOLD_KB" ]; then
    echo "✓ PASS: Peak memory usage (${MAX_MB}MB) is less than ${MEMORY_THRESHOLD_MB}MB"
    exit 0
else
    echo "✗ FAIL: Peak memory usage (${MAX_MB}MB) exceeds ${MEMORY_THRESHOLD_MB}MB"
    echo ""
    echo "Last 50 lines of daemon log:"
    tail -50 "$LOG_FILE" || true
    exit 1
fi
