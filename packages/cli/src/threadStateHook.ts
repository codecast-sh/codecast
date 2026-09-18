// Claude Code Stop / UserPromptSubmit -> pinned thread-state reminder,
// installed to ~/.claude/hooks/thread-state.sh. Kept in its own module (like
// statusHook.ts) so a real-shell regression test can run it without importing
// the CLI entry point (which calls program.parse() on load).
//
// The stamp and mark files it reads are written by `cast state` — see
// stateCommand.ts (writeThreadStatePulse / clearThreadStatePulse).
import { THREAD_STATE_NUDGE_MSGS, THREAD_STATE_RECRUIT_MSGS } from "@codecast/shared/contracts";
import { HOOK_FIELDS_READ } from "./hookJson.js";

/** Assumes SESSION_ID, EVENT, TRANSCRIPT, STOP_ACTIVE. Returns instead of exiting. */
export const THREAD_STATE_JOB = `
thread_state_job() {
DIR="$HOME/.codecast/thread-state"

# Count user+assistant entries, the same unit the UI's "N messages since" uses.
# Transcripts are append-only JSONL: cache (size, count) and grep only the tail.
COUNT=0
count_messages() {
  [ -n "\${TRANSCRIPT:-}" ] && [ -f "$TRANSCRIPT" ] || { COUNT=0; return; }
  local size csize ccount skip new
  size=$(wc -c < "$TRANSCRIPT" 2>/dev/null || echo 0)
  size=\${size// /}
  case "\$size" in ''|*[!0-9]*) size=0 ;; esac
  mkdir -p "$DIR/counts"
  local cache="$DIR/counts/$SESSION_ID"
  if [ -f "\$cache" ]; then
    read -r csize ccount < "\$cache" || true
    case "\${csize:-}" in ''|*[!0-9]*) csize=0 ;; esac
    case "\${ccount:-}" in ''|*[!0-9]*) ccount=0 ;; esac
    if [ "\$csize" = "\$size" ]; then
      COUNT=\$ccount
      return
    fi
    if [ "\$csize" -gt 0 ] && [ "\$csize" -le "\$size" ]; then
      skip=\$((csize + 1))
      new=$(tail -c +"\$skip" "$TRANSCRIPT" 2>/dev/null | grep -cE '"type":"(user|assistant)"' || true)
      case "\${new:-}" in ''|*[!0-9]*) new=0 ;; esac
      COUNT=\$((ccount + new))
      echo "\$size \$COUNT" > "\$cache"
      return
    fi
  fi
  COUNT=$(grep -cE '"type":"(user|assistant)"' "$TRANSCRIPT" 2>/dev/null || true)
  case "\${COUNT:-}" in ''|*[!0-9]*) COUNT=0 ;; esac
  echo "\$size \$COUNT" > "\$cache"
}

# No stamp = the session has NEVER declared a state. Short exchanges stay
# quiet; a substantial thread ending its turn undeclared is asked ONCE (Stop
# only, held for one more step) to say who acts next — its own \`--status\` is
# what files it under Needs Input / Done / Dormant, and beats any classifier
# reading its prose. The recruit mark makes it once per session; a session that
# then declares gets the ordinary staleness reminders below.
if [ ! -f "$DIR/$SESSION_ID.json" ]; then
  [ "$EVENT" = "Stop" ] || return 0
  [ "\${STOP_ACTIVE:-false}" = "true" ] && return 0
  count_messages
  [ "$COUNT" -ge ${THREAD_STATE_RECRUIT_MSGS} ] || return 0
  mkdir -p "$DIR/recruited"
  RECRUIT="$DIR/recruited/$SESSION_ID"
  [ -f "$RECRUIT" ] && return 0
  : > "$RECRUIT"
  MSG="You are ending your turn without declaring who acts next. Run cast state --status done|blocked|dormant with one line saying where this stands (done = delivered, blocked = a human must act, dormant = a machine wakes you — name the wake), then stop. It decides where this session files in the inbox. The pin is already on the human's screen: run the command and stop, with no reply text about it."
  printf '{"decision":"block","reason":"%s"}\\n' "$MSG"
  return 0
fi

# The mark holds "<baseline> [nudged]". \`cast state\` deletes it on every write,
# so the first event after a write records where the thread stood, and the
# nudge fires on the crossing only, never after. An agent that keeps its state
# current is reminded again later; one that ignores this is not nagged twice.
mkdir -p "$DIR/counters"
MARK="$DIR/counters/$SESSION_ID"
if [ ! -f "$MARK" ]; then
  count_messages
  echo "$COUNT" > "$MARK"
  return 0
fi
read -r BASE NUDGED < "$MARK" || true
case "\${BASE:-}" in ''|*[!0-9]*) BASE=0 ;; esac
[ -n "\${NUDGED:-}" ] && return 0
count_messages
SINCE=$((COUNT - BASE))
[ "$SINCE" -ge ${THREAD_STATE_NUDGE_MSGS} ] || return 0

# A Stop hook that has already made the agent continue once must not do it again.
[ "$EVENT" = "Stop" ] && [ "\${STOP_ACTIVE:-false}" = "true" ] && return 0

echo "$BASE nudged" > "$MARK"
MSG="Your pinned state is $SINCE messages old. Before you stop, update it with cast state (and --status if that changed) so it says where this stands now, or clear it. The pin is already on the human's screen: run the command and stop, with no reply text about it."
if [ "$EVENT" = "Stop" ]; then
  printf '{"decision":"block","reason":"%s"}\\n' "$MSG"
else
  echo "<thread-state>$MSG</thread-state>"
fi
}
`;

export const THREAD_STATE_HOOK = `#!/bin/bash
# Pinned thread-state reminder — ONE short nudge once the thread has moved on
# past the state. Runs on Stop (the agent is about to end its turn: hold it for
# one more step, refreshing the state) and on UserPromptSubmit (fallback for a
# turn that never reached Stop, e.g. interrupted).
set -uo pipefail

# Envelope only. The transcript is counted from disk when we actually need it;
# grepping it on every UserPromptSubmit is what blew the hook timeout on long
# sessions (codecast project transcripts sit in the gigabytes).
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

EVENT="\${HOOK_hook_event_name:-}"
TRANSCRIPT="\${HOOK_transcript_path:-}"
STOP_ACTIVE="\${HOOK_stop_hook_active:-}"

${THREAD_STATE_JOB}
thread_state_job
`;
