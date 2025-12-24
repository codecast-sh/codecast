#!/usr/bin/env bash
#
# Test script to measure daemon CPU usage when idle
#
# Usage: ./test-daemon-cpu.sh [duration_seconds]
#

set -euo pipefail

DURATION="${1:-60}"
CONFIG_DIR="${HOME}/.codecast"
PID_FILE="${CONFIG_DIR}/daemon.pid"
LOG_FILE="${CONFIG_DIR}/daemon.log"

echo "=== Daemon CPU Usage Test ==="
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
}

trap cleanup EXIT

# Ensure no daemon is running
cleanup

# Start the daemon
echo "Starting daemon..."
cd packages/cli
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

echo "Daemon is running. Monitoring CPU usage..."
echo ""

# Collect CPU samples
SAMPLES=()
INTERVAL=1
COUNT=$DURATION

for ((i=1; i<=COUNT; i++)); do
    # Get CPU percentage for the daemon process
    # Using ps with -o %cpu to get CPU percentage
    CPU=$(ps -p "$DAEMON_PID" -o %cpu= 2>/dev/null | tr -d ' ' || echo "0.0")

    if [ -z "$CPU" ]; then
        echo "ERROR: Daemon process $DAEMON_PID not found"
        exit 1
    fi

    SAMPLES+=("$CPU")

    # Show progress every 10 seconds
    if [ $((i % 10)) -eq 0 ]; then
        echo "[$i/$COUNT] Current CPU: ${CPU}%"
    fi

    sleep "$INTERVAL"
done

echo ""
echo "=== Results ==="

# Calculate statistics
TOTAL=0
MIN=999999
MAX=0
ABOVE_ONE=0

for cpu in "${SAMPLES[@]}"; do
    # Convert to integer for comparison (multiply by 10 to preserve one decimal)
    CPU_INT=$(echo "$cpu * 10" | bc -l | cut -d. -f1)

    TOTAL=$(echo "$TOTAL + $cpu" | bc -l)

    # Check if above 1%
    if [ "$CPU_INT" -gt 10 ]; then
        ABOVE_ONE=$((ABOVE_ONE + 1))
    fi

    # Update min/max
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

# Check if test passed
if (( $(echo "$AVG < 1.0" | bc -l) )); then
    echo "✓ PASS: Average CPU usage (${AVG}%) is less than 1%"
    exit 0
else
    echo "✗ FAIL: Average CPU usage (${AVG}%) exceeds 1%"
    echo ""
    echo "Last 50 lines of daemon log:"
    tail -50 "$LOG_FILE" || true
    exit 1
fi
