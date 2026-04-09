#!/bin/bash
# Hook: PostCompact — re-inject current task/plan context after compaction
# Outputs context that gets injected as additionalContext into the session
set -euo pipefail

# Try task context first, then plan context
TASK_CTX=$(cast task context --current 2>/dev/null) || true
PLAN_CTX=$(cast plan context --current 2>/dev/null) || true

if [ -z "$TASK_CTX" ] && [ -z "$PLAN_CTX" ]; then
  exit 0  # No binding, nothing to inject
fi

echo "## Re-grounding after context compaction"
echo ""

if [ -n "$PLAN_CTX" ]; then
  echo "$PLAN_CTX"
  echo ""
fi

if [ -n "$TASK_CTX" ]; then
  echo "$TASK_CTX"
  echo ""
fi

echo "Re-read the above to reground yourself. Do not rely on memory of earlier conversation."
