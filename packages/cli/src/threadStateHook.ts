// Claude Code Stop / UserPromptSubmit -> pinned thread-state reminder,
// installed to ~/.claude/hooks/thread-state.sh. Kept in its own module (like
// statusHook.ts) so a real-shell regression test can run it without importing
// the CLI entry point (which calls program.parse() on load).
//
// The stamp and mark files it reads are written by `cast state` — see
// stateCommand.ts (writeThreadStatePulse / clearThreadStatePulse).
import { THREAD_STATE_NUDGE_MSGS } from "@codecast/shared/contracts";

export const THREAD_STATE_HOOK = `#!/bin/bash
# Pinned thread-state reminder — ONE short nudge once the thread has moved on
# past the state. Runs on Stop (the agent is about to end its turn: hold it for
# one more step, refreshing the state) and on UserPromptSubmit (fallback for a
# turn that never reached Stop, e.g. interrupted).
set -uo pipefail

INPUT=$(cat)
IFS=$'\\t' read -r SESSION_ID EVENT TRANSCRIPT STOP_ACTIVE < <(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('\\t'.join([str(d.get('session_id','')), str(d.get('hook_event_name','')), str(d.get('transcript_path','')), 'true' if d.get('stop_hook_active') else 'false']))
" 2>/dev/null)
[ -z "\${SESSION_ID:-}" ] && exit 0

DIR="$HOME/.codecast/thread-state"
# No stamp = no pinned state. A session that never ran \`cast state\` is never
# nudged about it — the reminder maintains what exists, it doesn't recruit.
[ -f "$DIR/$SESSION_ID.json" ] || exit 0

# Messages in the transcript now: user + assistant entries, tool calls included —
# the same unit the UI's "N messages since" is counted in.
COUNT=0
if [ -n "\${TRANSCRIPT:-}" ] && [ -f "$TRANSCRIPT" ]; then
  COUNT=$(grep -cE '"type":"(user|assistant)"' "$TRANSCRIPT" 2>/dev/null || echo 0)
fi

# The mark holds "<baseline> [nudged]". \`cast state\` deletes it on every write,
# so the first event after a write records where the thread stood, and the
# nudge fires on the crossing only, never after. An agent that keeps its state
# current is reminded again later; one that ignores this is not nagged twice.
mkdir -p "$DIR/counters"
MARK="$DIR/counters/$SESSION_ID"
if [ ! -f "$MARK" ]; then
  echo "$COUNT" > "$MARK"
  exit 0
fi
read -r BASE NUDGED < "$MARK" || true
case "\${BASE:-}" in ''|*[!0-9]*) BASE=0 ;; esac
[ -n "\${NUDGED:-}" ] && exit 0
SINCE=$((COUNT - BASE))
[ "$SINCE" -ge ${THREAD_STATE_NUDGE_MSGS} ] || exit 0

# A Stop hook that has already made the agent continue once must not do it again.
[ "$EVENT" = "Stop" ] && [ "\${STOP_ACTIVE:-false}" = "true" ] && exit 0

echo "$BASE nudged" > "$MARK"
MSG="Your pinned state is $SINCE messages old. Before you stop, update it with cast state (and --status if that changed) so it says where this stands now, or clear it."
if [ "$EVENT" = "Stop" ]; then
  python3 -c 'import json,sys; print(json.dumps({"decision":"block","reason":sys.argv[1]}))' "$MSG"
else
  echo "<thread-state>$MSG</thread-state>"
fi
`;

