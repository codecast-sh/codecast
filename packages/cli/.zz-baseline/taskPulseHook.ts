// Claude Code UserPromptSubmit -> periodic task/plan reminder,
// installed to ~/.claude/hooks/task-pulse.sh (and inlined into codecast-prompt.sh).
import { HOOK_FEATURE_ON, HOOK_FIELDS_READ } from "./hookJson.js";

/** Assumes SESSION_ID is set. Returns instead of exiting. */
export const TASK_PULSE_JOB = `${HOOK_FEATURE_ON}
task_pulse_job() {
# Part of Tasks & Plans in Agent Features: off there, silent here.
feature_on work_enabled || return 0
PULSE_FILE="$HOME/.codecast/task-pulse/$SESSION_ID.json"
[ -f "$PULSE_FILE" ] || return 0

COUNTER_DIR="$HOME/.codecast/task-pulse/counters"
mkdir -p "$COUNTER_DIR"
COUNTER_FILE="$COUNTER_DIR/$SESSION_ID"
COUNT=0
[ -f "$COUNTER_FILE" ] && COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Emit every 8 turns
[ $((COUNT % 8)) -ne 0 ] && return 0

INPUT=$(cat "$PULSE_FILE" 2>/dev/null || true)
${HOOK_FIELDS_READ}
TASK_ID="\${HOOK_task:-}"
PLAN_ID="\${HOOK_plan:-}"
TASK=""
[ -n "$TASK_ID" ] && TASK="task $TASK_ID"
if [ -n "$PLAN_ID" ]; then
  if [ -n "$TASK" ]; then
    TASK="$TASK, plan $PLAN_ID"
  else
    TASK="plan $PLAN_ID"
  fi
fi
[ -z "$TASK" ] && return 0

echo "<task-reminder>You are working on $TASK. Check progress against acceptance criteria.</task-reminder>"
}
`;

export const TASK_PULSE_HOOK = `#!/bin/bash
# Periodic task/plan reminder — emits a short nudge every N user messages
set -uo pipefail

INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

${HOOK_FIELDS_READ}

SESSION_ID="\${HOOK_session_id:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${HOOK_sessionId:-}"
[ -z "$SESSION_ID" ] && exit 0
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#SESSION_ID} -le 128 ] || exit 0

${TASK_PULSE_JOB}
task_pulse_job
`;
