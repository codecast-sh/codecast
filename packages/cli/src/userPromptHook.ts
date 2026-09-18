// Claude Code UserPromptSubmit -> one process for all four codecast jobs.
// Installed to ~/.claude/hooks/codecast-prompt.sh. The other events still
// use the individual scripts (Stop, SessionStart, PreToolUse, …).
import { HOOK_FIELDS_READ } from "./hookJson.js";
import { CODECAST_STATUS_EMIT } from "./statusHook.js";
import { SESSION_REGISTER_JOB } from "./sessionRegisterHook.js";
import { TASK_PULSE_JOB } from "./taskPulseHook.js";
import { THREAD_STATE_JOB } from "./threadStateHook.js";

export const USER_PROMPT_HOOK_FILE = "codecast-prompt.sh";

export const USER_PROMPT_HOOK = `#!/bin/bash
# One UserPromptSubmit process: status, session-register, task-pulse, thread-state.
# Four separate scripts used to each spawn bash+awk; Claude waits for all of them.
set -uo pipefail

INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

${HOOK_FIELDS_READ}

SESSION_ID="\${HOOK_session_id:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${HOOK_sessionId:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${GROK_SESSION_ID:-}"
[ -z "$SESSION_ID" ] && exit 0
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#SESSION_ID} -le 128 ] || exit 0

EVENT="\${HOOK_hook_event_name:-}"
PERM="\${HOOK_permission_mode:-}"
TOOL="\${HOOK_tool_name:-}"
TRANSCRIPT="\${HOOK_transcript_path:-}"
STOP_ACTIVE="\${HOOK_stop_hook_active:-}"
MESSAGE=""
SESSION_BOUNDARY=""
TURN_COMPLETED_AT=""
TRANSCRIPT_PATH=""

${CODECAST_STATUS_EMIT}
${SESSION_REGISTER_JOB}
${TASK_PULSE_JOB}
${THREAD_STATE_JOB}

STATUS=thinking
codecast_status_emit
session_register_job
task_pulse_job
thread_state_job
`;
