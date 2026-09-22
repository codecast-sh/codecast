// Claude Code lifecycle -> codecast agent-status reporter, installed to
// ~/.claude/hooks/codecast-status.sh. Kept in its own module so the mapping can
// be exercised by a real-shell regression test without importing the CLI entry
// point (which calls program.parse() on load).
//
// The event -> status mapping is bash + awk. The previous version spawned
// python3 per event; under machine load that interpreter startup blew Claude
// Code's hook timeout, the output was discarded, and the daemon never learned
// the session had started a turn — which is how a delivered message kept
// showing "hasn't reached the agent" in the web UI.
// python3 remains only for the AskUserQuestion sidecar (nested JSON dump).
import { HOOK_FIELDS_READ } from "./hookJson.js";
import { HOOK_TOKEN_READ } from "./hookIdentity.js";

/** Report STATUS to the daemon. Returns instead of exiting so a combined
 *  UserPromptSubmit script can run the other jobs after a successful curl. */
export const CODECAST_STATUS_EMIT = `
codecast_status_emit() {
[ -n "\${STATUS:-}" ] || return 0
ts=$(date +%s)
LT="\${CODECAST_LAUNCH_TOKEN:-}"
${HOOK_TOKEN_READ}

json_esc() {
  v=\$1
  v=\${v//\\\\/\\\\\\\\}
  v=\${v//\\\"/\\\\\\\"}
  printf '%s' "\$v"
}

FB="{\\"status\\":\\"$(json_esc "$STATUS")\\",\\"ts\\":$ts"
[ -n "\${PERM:-}" ] && FB="$FB,\\"permission_mode\\":\\"$(json_esc "$PERM")\\""
[ -n "\$LT" ] && FB="$FB,\\"launch_token\\":\\"$(json_esc "\$LT")\\""
[ -n "\${MESSAGE:-}" ] && FB="$FB,\\"message\\":\\"$(json_esc "$MESSAGE")\\""
[ -n "\${TRANSCRIPT_PATH:-}" ] && FB="$FB,\\"transcript_path\\":\\"$(json_esc "$TRANSCRIPT_PATH")\\""
[ -n "\${SESSION_BOUNDARY:-}" ] && FB="$FB,\\"session_boundary\\":\\"$(json_esc "$SESSION_BOUNDARY")\\""
[ -n "\${TURN_COMPLETED_AT:-}" ] && FB="$FB,\\"turn_completed_at\\":\\"$TURN_COMPLETED_AT\\""
FB="$FB}"

# Try HTTP push first (instant), fall back to file write (polled)
HOOK_PORT_FILE="$HOME/.codecast/hook-port"
if [ -f "$HOOK_PORT_FILE" ]; then
  PORT=$(cat "$HOOK_PORT_FILE" 2>/dev/null)
  if [ -n "$PORT" ]; then
    set -- -s -G "http://127.0.0.1:$PORT/hook/status" --connect-timeout 1 --max-time 2
    # Proves this post came from a hook this user installed. Without it the
    # daemon's route was writable by any local process and by a web page whose
    # browser still permits a plain loopback GET (hookIdentity.ts).
    [ -n "\$CODECAST_HOOK_TOKEN" ] && set -- "$@" -H "Authorization: Bearer \$CODECAST_HOOK_TOKEN"
    set -- "$@" --data-urlencode "session_id=$SESSION_ID"
    set -- "$@" --data-urlencode "status=$STATUS"
    set -- "$@" --data-urlencode "ts=$ts"
    [ -n "\${PERM:-}" ] && set -- "$@" --data-urlencode "permission_mode=$PERM"
    [ -n "\$LT" ] && set -- "$@" --data-urlencode "launch_token=\$LT"
    [ -n "\${MESSAGE:-}" ] && set -- "$@" --data-urlencode "message=$MESSAGE"
    [ -n "\${TRANSCRIPT_PATH:-}" ] && set -- "$@" --data-urlencode "transcript_path=$TRANSCRIPT_PATH"
    [ -n "\${SESSION_BOUNDARY:-}" ] && set -- "$@" --data-urlencode "session_boundary=$SESSION_BOUNDARY"
    [ -n "\${TURN_COMPLETED_AT:-}" ] && set -- "$@" --data-urlencode "turn_completed_at=$TURN_COMPLETED_AT"
    curl "$@" >/dev/null 2>&1 && return 0
  fi
fi

# Fallback: the daemon is unreachable (restart, port change, the boot window
# before its handler registers), so the event waits on disk. The spool is the
# append-only history the daemon replays in order and truncates; the single
# status file below is what a daemon from before the spool reads. That file
# alone used to be the whole fallback, so a burst during a restart collapsed
# to its last entry and lost any Stop behind it.
#
# "working" is PreToolUse, one per tool call: it stays out of the spool so a
# long turn cannot fill it with progress, and the file below still carries it.
# Both writes are shell builtins — one extra process per event is what blew
# Claude Code's hook timeout before (see the note at the top of this file).

# Both paths are built out of the session id, which arrives in the hook payload:
# an id of ../../elsewhere/evil writes them wherever it points, and the single
# status file has had that hole for as long as it has existed. Validate first,
# builtins only, against the shape the daemon enforces (isSafeStatusSessionId in
# statusSpool.ts): first character from [A-Za-z0-9_-] so no id starts with a
# dot, the rest from [A-Za-z0-9._-] so no id holds a separator, 128 characters
# at most. Real ids are uuids, so no real caller is turned away.
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#SESSION_ID} -le 128 ] || exit 0

STATUS_DIR="$HOME/.codecast/agent-status"
mkdir -p "$STATUS_DIR"
if [ "$STATUS" != "working" ]; then
  printf '%s\\n' "$FB" >> "$STATUS_DIR/$SESSION_ID.jsonl"
fi
printf '%s\\n' "$FB" > "$STATUS_DIR/$SESSION_ID.json"
}
`;

export const CODECAST_STATUS_HOOK = `#!/bin/bash
# Reports Claude Code lifecycle events to codecast daemon via status files
set -uo pipefail

# Envelope keys sit at the front. A UserPromptSubmit payload can carry a
# megabyte prompt after them; copying all of it into the shell is wasted work
# except when we need the AskUserQuestion questions array for the sidecar.
INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
case "$INPUT" in
  *AskUserQuestion*) INPUT="$INPUT$(cat)" ;;
esac
[ -n "$INPUT" ] || exit 0

${HOOK_FIELDS_READ}

SESSION_ID="\${HOOK_session_id:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${HOOK_sessionId:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${GROK_SESSION_ID:-}"
[ -z "$SESSION_ID" ] && exit 0

# Same rule as isSafeStatusSessionId / the file-path guard below: do not build
# any path or sidecar name until the id is a plain session id.
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#SESSION_ID} -le 128 ] || exit 0

EVENT="\${HOOK_hook_event_name:-}"
PERM="\${HOOK_permission_mode:-}"
TOOL="\${HOOK_tool_name:-}"
STATUS=""
MESSAGE=""
SESSION_BOUNDARY=""
TURN_COMPLETED_AT=""
TRANSCRIPT_PATH=""

if [ "$EVENT" = "UserPromptSubmit" ]; then
  STATUS=thinking
elif [ "$EVENT" = "PreToolUse" ]; then
  # AskUserQuestion blocks the agent on a user prompt with no further hook
  # until it is answered, so it must report as waiting-for-input, not working.
  # The tool name is carried so the daemon classifies it via SKIP_TOOLS
  # without a transcript read (and never injects a permission Enter/Escape).
  if [ "$TOOL" = "AskUserQuestion" ]; then
    STATUS=permission_blocked
    MESSAGE=AskUserQuestion
  else
    STATUS=working
  fi
elif [ "$EVENT" = "PreCompact" ]; then
  STATUS=compacting
elif [ "$EVENT" = "Stop" ]; then
  STATUS=idle
  # The lead turn ended, whatever the daemon then makes of the settle. A
  # session the harness keeps alive for background work reports 'waiting'
  # from here on, and its status stops moving; this stamp is the per-turn
  # identity every completion-reactive consumer keys on so a second turn
  # under one unchanged status still announces once.
  TURN_COMPLETED_AT=$(date +%s)
elif [ "$EVENT" = "PermissionRequest" ]; then
  # Claude Code's first-class permission event (CC >= ~2.1.x). Unlike the
  # generic Notification ('Claude needs your permission', no tool name), it
  # carries the real tool_name + tool_input + permission_mode, so the daemon
  # can name the blocked tool and build a preview without parsing the
  # transcript. This is the authoritative source for the web Approve/Deny
  # card. AskUserQuestion arrives here too; tagged by name so the daemon
  # routes it to needs-input.
  if [ -n "$TOOL" ]; then
    PREV="\${HOOK_command:-}"
    [ -z "$PREV" ] && PREV="\${HOOK_file_path:-}"
    [ -z "$PREV" ] && PREV="\${HOOK_pattern:-}"
    [ -z "$PREV" ] && PREV="\${HOOK_path:-}"
    [ -z "$PREV" ] && PREV="\${HOOK_url:-}"
    if [ \${#PREV} -gt 300 ]; then
      PREV=$(printf '%s' "$PREV" | cut -c1-300)
    fi
    STATUS=permission_blocked
    if [ "$TOOL" = "AskUserQuestion" ]; then
      MESSAGE=AskUserQuestion
    elif [ -n "$PREV" ]; then
      MESSAGE="$TOOL: $PREV"
    else
      MESSAGE="$TOOL"
    fi
  fi
elif [ "$EVENT" = "Notification" ]; then
  NOTIF="\${HOOK_notification_type:-}"
  if [ "$NOTIF" = "permission_prompt" ]; then
    # Forward only transcript_path so the daemon resolves the real tool
    # from the transcript. The Notification message is a generic 'Claude
    # needs your permission' with no tool name — forwarding it would only
    # mislead the daemon's first-token tool extraction.
    STATUS=permission_blocked
    TRANSCRIPT_PATH="\${HOOK_transcript_path:-}"
  elif [ "$NOTIF" = "idle_prompt" ]; then
    STATUS=idle
  fi
elif [ "$EVENT" = "SessionStart" ]; then
  SOURCE="\${HOOK_source:-}"
  if [ "$SOURCE" = "compact" ]; then
    # An auto-compact runs INSIDE a turn that then resumes: the agent is
    # working, not settling.
    STATUS=working
  elif [ "$SOURCE" = "startup" ] || [ "$SOURCE" = "resume" ] || [ "$SOURCE" = "clear" ]; then
    # The only signal a resumed or cleared session emits before its first
    # prompt. It lands the pane at an idle prompt with no turn behind it,
    # so it settles the row as a SESSION BOUNDARY: the daemon and the
    # server read the flag and keep every completion-reactive consumer
    # (the needs-input push, the settle classifier, unread) out of it.
    STATUS=idle
    SESSION_BOUNDARY=1
  fi
elif [ "$EVENT" = "PostCompact" ]; then
  # A manual /compact swallows the turn boundary: it ends at an idle prompt
  # and emits no Stop, so this is the pane's only clearing signal. An auto
  # compact runs inside a turn that emits its own Stop, so it claims nothing.
  TRIGGER="\${HOOK_trigger:-}"
  if [ "$TRIGGER" = "manual" ]; then
    STATUS=idle
    SESSION_BOUNDARY=1
  fi
fi

# A pending AskUserQuestion buffers its whole turn (the reasoning prose AND the
# tool_use) out of the JSONL until it is answered, so the daemon cannot read the
# real questions from the transcript. Drop the full tool_input in a per-session
# sidecar (too large for the status URL) so the daemon builds a full-fidelity
# card — option descriptions, headers, multiSelect — instead of scraping the
# box-art menu. Written atomically; best-effort. SESSION_ID is already gated.
if [ "$TOOL" = "AskUserQuestion" ] && { [ "$EVENT" = "PreToolUse" ] || [ "$EVENT" = "PermissionRequest" ]; }; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/bin:$HOME/.local/bin:$PATH"
  printf '%s' "$INPUT" | SESSION_ID="$SESSION_ID" python3 -c "
import sys, json, os, tempfile, time
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sid = str(os.environ.get('SESSION_ID') or '')
if not sid:
    sys.exit(0)
try:
    qs = (d.get('tool_input') or {}).get('questions')
    if qs:
        dd = os.path.join(os.path.expanduser('~'), '.codecast', 'ask-input')
        os.makedirs(dd, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=dd)
        with os.fdopen(fd, 'w') as f:
            json.dump({'questions': qs, 'ts': int(time.time())}, f)
        os.replace(tmp, os.path.join(dd, sid + '.json'))
except Exception:
    pass
" 2>/dev/null || true
fi

${CODECAST_STATUS_EMIT}
codecast_status_emit
`;
