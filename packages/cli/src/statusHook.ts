// Claude Code lifecycle -> codecast agent-status reporter, installed to
// ~/.claude/hooks/codecast-status.sh. Kept in its own module so the mapping can
// be exercised by a real-shell regression test without importing the CLI entry
// point (which calls program.parse() on load).
//
// The whole event -> status mapping runs in ONE python3 process. The previous
// version spawned 6-8 python3 interpreters per event; under machine load those
// spawns alone blew Claude Code's hook timeout, the output was discarded, and
// the daemon never learned the session had started a turn — which is how a
// delivered message kept showing "hasn't reached the agent" in the web UI.
// The python program prints one tab-separated line:
//   session_id \t status \t url_query_string \t fallback_json
// and the shell around it does exactly one curl (or one fallback file write).
export const CODECAST_STATUS_HOOK = `#!/bin/bash
# Reports Claude Code lifecycle events to codecast daemon via status files
set -uo pipefail

INPUT=$(cat)

OUT=$(printf '%s' "$INPUT" | python3 -c "
import sys, json, os, tempfile, time, urllib.parse
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sid = str(d.get('session_id') or '')
if not sid:
    sys.exit(0)
ev = str(d.get('hook_event_name') or '')
tool = str(d.get('tool_name') or '')
status = ''
extra = {}
if ev == 'UserPromptSubmit':
    status = 'thinking'
elif ev == 'PreToolUse':
    # AskUserQuestion blocks the agent on a user prompt with no further hook
    # until it is answered, so it must report as waiting-for-input, not working.
    # The tool name is carried so the daemon classifies it via SKIP_TOOLS
    # without a transcript read (and never injects a permission Enter/Escape).
    if tool == 'AskUserQuestion':
        status = 'permission_blocked'
        extra['message'] = 'AskUserQuestion'
    else:
        status = 'working'
elif ev == 'PreCompact':
    status = 'compacting'
elif ev == 'Stop':
    status = 'idle'
elif ev == 'PermissionRequest':
    # Claude Code's first-class permission event (CC >= ~2.1.x). Unlike the
    # generic Notification ('Claude needs your permission', no tool name), it
    # carries the real tool_name + tool_input + permission_mode, so the daemon
    # can name the blocked tool and build a preview without parsing the
    # transcript. This is the authoritative source for the web Approve/Deny
    # card. AskUserQuestion arrives here too; tagged by name so the daemon
    # routes it to needs-input.
    if tool:
        status = 'permission_blocked'
        prev = ''
        ti = d.get('tool_input') or {}
        for k in ('command', 'file_path', 'pattern', 'path', 'url'):
            v = ti.get(k)
            if isinstance(v, str) and v:
                prev = v
                break
        extra['message'] = (tool if not prev else tool + ': ' + prev)[:300]
elif ev == 'Notification':
    nt = str(d.get('notification_type') or '')
    if nt == 'permission_prompt':
        # Forward only transcript_path so the daemon resolves the real tool
        # from the transcript. The Notification message is a generic 'Claude
        # needs your permission' with no tool name — forwarding it would only
        # mislead the daemon's first-token tool extraction.
        status = 'permission_blocked'
        tp = str(d.get('transcript_path') or '')
        if tp:
            extra['transcript_path'] = tp
    elif nt == 'idle_prompt':
        status = 'idle'
elif ev == 'SessionStart':
    if str(d.get('source') or '') == 'compact':
        status = 'working'
# A pending AskUserQuestion buffers its whole turn (the reasoning prose AND the
# tool_use) out of the JSONL until it is answered, so the daemon cannot read the
# real questions from the transcript. Drop the full tool_input in a per-session
# sidecar (too large for the status URL) so the daemon builds a full-fidelity
# card — option descriptions, headers, multiSelect — instead of scraping the
# box-art menu. Written atomically; best-effort.
if ev in ('PreToolUse', 'PermissionRequest') and tool == 'AskUserQuestion':
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
if not status:
    sys.exit(0)
ts = int(time.time())
pm = str(d.get('permission_mode') or '')
q = {'session_id': sid, 'status': status, 'ts': str(ts)}
if pm:
    q['permission_mode'] = pm
q.update(extra)
fb = {'status': status, 'ts': ts}
if pm:
    fb['permission_mode'] = pm
fb.update(extra)
print(sid + '\\t' + status + '\\t' + urllib.parse.urlencode(q) + '\\t' + json.dumps(fb))
" 2>/dev/null)

[ -z "$OUT" ] && exit 0
IFS=$'\\t' read -r SESSION_ID STATUS QS FALLBACK <<< "$OUT"
if [ -z "$SESSION_ID" ] || [ -z "$STATUS" ] || [ -z "$QS" ]; then exit 0; fi

# Try HTTP push first (instant), fall back to file write (polled)
HOOK_PORT_FILE="$HOME/.codecast/hook-port"
if [ -f "$HOOK_PORT_FILE" ]; then
  PORT=$(cat "$HOOK_PORT_FILE" 2>/dev/null)
  if [ -n "$PORT" ]; then
    curl -s "http://127.0.0.1:$PORT/hook/status?$QS" --connect-timeout 1 --max-time 2 >/dev/null 2>&1 && exit 0
  fi
fi

# Fallback: write status file (existing path, daemon polls via chokidar)
STATUS_DIR="$HOME/.codecast/agent-status"
mkdir -p "$STATUS_DIR"
printf '%s\\n' "$FALLBACK" > "$STATUS_DIR/$SESSION_ID.json"
exit 0
`;
