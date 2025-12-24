#!/usr/bin/env bash
#
# Test script to measure daemon CPU usage when truly idle (sync paused)
#

set -euo pipefail

DURATION="${1:-60}"
CONFIG_DIR="${HOME}/.codecast"
PID_FILE="${CONFIG_DIR}/daemon.pid"
LOG_FILE="${CONFIG_DIR}/daemon.log"

echo "=== Daemon CPU Usage Test (Idle with Sync Paused) ==="
echo "Duration: ${DURATION} seconds"
echo ""

# Clean up function
cleanup() {
    if [ -f "$PID_FILE" ]; then
        DAEMON_PID=$(cat "$PID_FILE")
        echo "Stopping daemon (PID: $DAEMON_PID)..."
        kill "$DAEMON_PID" 2>/dev/null || true
        sleep 2
        kill -9 "$DAEMON_PID" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    # Restore environment
    unset CODECAST_PAUSED
}

trap cleanup EXIT

# Ensure no daemon is running
cleanup

# Start the daemon with sync paused (truly idle)
echo "Starting daemon with CODECAST_PAUSED=1 (truly idle)..."
cd packages/cli
export CODECAST_PAUSED=1
bun run dist/daemon.js > /dev/null 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"
cd ../..

echo "Daemon started with PID: $DAEMON_PID"
echo "Waiting 5 seconds for daemon to initialize..."
sleep 5

# Verify daemon is still running
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "ERROR: Daemon failed to start or crashed"
    echo "Last 20 lines of daemon log:"
    tail -20 "$LOG_FILE" || true
    exit 1
fi

echo "Daemon is running in PAUSED mode (idle). Monitoring CPU usage..."
echo ""

# Collect CPU samples
SAMPLES=()
INTERVAL=1
COUNT=$DURATION

for ((i=1; i<=COUNT; i++)); do
    CPU=$(ps -p "$DAEMON_PID" -o %cpu= 2>/dev/null | tr -d ' ' || echo "0.0")

    if [ -z "$CPU" ]; then
        echo "ERROR: Daemon process $DAEMON_PID not found"
        exit 1
    fi

    SAMPLES+=("$CPU")

    if [ $((i % 10)) -eq 0 ]; then
        echo "[$i/$COUNT] Current CPU: ${CPU}%"
    fi

    sleep "$INTERVAL"
done

echo ""
echo "=== Results ==="

TOTAL=0
MIN=999999
MAX=0
ABOVE_ONE=0

for cpu in "${SAMPLES[@]}"; do
    CPU_INT=$(echo "$cpu * 10" | bc -l | cut -d. -f1)
    TOTAL=$(echo "$TOTAL + $cpu" | bc -l)

    if [ "$CPU_INT" -gt 10 ]; then
        ABOVE_ONE=$((ABOVE_ONE + 1))
    fi

    if [ "$CPU_INT" -lt "$(echo "$MIN * 10" | bc -l | cut -d. -f1)" ]; then
        MIN="$cpu"
    fi
    if [ "$CPU_INT" -gt "$(echo "$MAX * 10" | bc -l | cut -d. -f1)" ]; then
        MAX="$cpu"
    fi
done

AVG=$(echo "scale=2; $TOTAL / ${#SAMPLES[@]}" | bc -l)

echo "Samples collected: ${#SAMPLES[@]}"
echo "Average CPU: ${AVG}%"
echo "Min CPU: ${MIN}%"
echo "Max CPU: ${MAX}%"
echo "Samples above 1%: $ABOVE_ONE / ${#SAMPLES[@]}"
echo ""

if (( $(echo "$AVG < 1.0" | bc -l) )); then
    echo "✓ PASS: Average CPU usage (${AVG}%) is less than 1%"
    exit 0
else
    echo "✗ FAIL: Average CPU usage (${AVG}%) exceeds 1%"
    echo ""
    echo "Last 30 lines of daemon log:"
    tail -30 "$LOG_FILE" || true
    exit 1
fi
