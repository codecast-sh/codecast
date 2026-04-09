#!/bin/bash
# Hook: SubagentStop — parse agent output and update task status
# Receives hook event JSON on stdin with: subagent_type, last_assistant_message, agent_name
set -euo pipefail

INPUT=$(cat)

# Extract fields from hook event
AGENT_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent_name','') or d.get('subagent_type',''))" 2>/dev/null)
LAST_MSG=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('last_assistant_message',''))" 2>/dev/null)

# Extract task ID from agent name (e.g., "impl-ct-1234" or "review-ct-1234")
TASK_ID=$(echo "$AGENT_NAME" | grep -oE 'ct-[a-zA-Z0-9]+' | head -1)
[ -z "$TASK_ID" ] && exit 0  # Not a task-bound agent, skip

# Determine agent role from name prefix
ROLE="unknown"
case "$AGENT_NAME" in
  impl-*|implementer*) ROLE="implementer" ;;
  review-*|reviewer*)  ROLE="reviewer" ;;
  critic-*|critic*)    ROLE="critic" ;;
esac

# Parse status markers from the last message (case-insensitive, check from end)
STATUS="completed"
DETAIL=""

if echo "$LAST_MSG" | grep -qi "BLOCKED:"; then
  STATUS="blocked"
  DETAIL=$(echo "$LAST_MSG" | grep -oi "BLOCKED:.*" | head -1 | sed 's/BLOCKED: *//')
elif echo "$LAST_MSG" | grep -qi "NEEDS_CHANGES"; then
  STATUS="needs_changes"
  DETAIL=$(echo "$LAST_MSG" | grep -oi "NEEDS_CHANGES.*" | head -1)
elif echo "$LAST_MSG" | grep -qi "REJECT"; then
  STATUS="rejected"
  DETAIL=$(echo "$LAST_MSG" | grep -oi "REJECT.*" | head -1)
elif echo "$LAST_MSG" | grep -qi "## Review: PASS"; then
  STATUS="passed"
fi

# Update task based on role and status
case "$ROLE" in
  implementer)
    case "$STATUS" in
      blocked)
        cast task comment "$TASK_ID" "Agent blocked: $DETAIL" -t blocker 2>/dev/null || true
        ;;
      completed)
        # Implementer finished — task should already be marked done by the agent itself
        # Just log completion if the agent didn't update status
        cast task comment "$TASK_ID" "Implementer agent completed" -t progress 2>/dev/null || true
        ;;
    esac
    ;;
  reviewer)
    case "$STATUS" in
      passed)
        cast task comment "$TASK_ID" "Review: PASS" -t note 2>/dev/null || true
        ;;
      needs_changes)
        cast task comment "$TASK_ID" "Review: NEEDS_CHANGES — see reviewer comments" -t review 2>/dev/null || true
        ;;
      rejected)
        cast task comment "$TASK_ID" "Review: REJECT — $DETAIL" -t blocker 2>/dev/null || true
        ;;
    esac
    ;;
  critic)
    # Critics report findings as comments — the agent itself handles this
    cast task comment "$TASK_ID" "Critic sweep completed" -t progress 2>/dev/null || true
    ;;
esac
