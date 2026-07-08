// Claude Code lifecycle -> codecast agent-status reporter, installed to
// ~/.claude/hooks/codecast-status.sh. Kept in its own module so the mapping can
// be exercised by a real-shell regression test without importing the CLI entry
// point (which calls program.parse() on load).
export const CODECAST_STATUS_HOOK = `#!/bin/bash
# Reports Claude Code lifecycle events to codecast daemon via status files
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

EVENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hook_event_name',''))" 2>/dev/null)
NOTIF_TYPE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('notification_type',''))" 2>/dev/null)
SOURCE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('source',''))" 2>/dev/null)
PERM_MODE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('permission_mode',''))" 2>/dev/null)

# A pending AskUserQuestion buffers its whole turn (the reasoning prose AND the tool_use)
# out of the JSONL until it's answered, so the daemon can't read the real questions from
# the transcript. Drop the full tool_input in a per-session sidecar (too large for the
# status URL) so the daemon builds a full-fidelity card — option descriptions, headers,
# multiSelect — instead of scraping the box-art menu. Written atomically; best-effort.
if [ "$EVENT" = "PreToolUse" ] || [ "$EVENT" = "PermissionRequest" ]; then
  echo "$INPUT" | CC_SID="$SESSION_ID" python3 -c "
import sys, json, os, tempfile, time
try:
    d = json.load(sys.stdin)
    if d.get('tool_name') == 'AskUserQuestion':
        qs = (d.get('tool_input') or {}).get('questions')
        if qs:
            dd = os.path.join(os.path.expanduser('~'), '.codecast', 'ask-input')
            os.makedirs(dd, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=dd)
            with os.fdopen(fd, 'w') as f:
                json.dump({'questions': qs, 'ts': int(time.time())}, f)
            os.replace(tmp, os.path.join(dd, os.environ['CC_SID'] + '.json'))
except Exception:
    pass
" 2>/dev/null
fi

STATUS=""
EXTRA=""
case "$EVENT" in
  UserPromptSubmit) STATUS="thinking" ;;
  PreToolUse)
    # AskUserQuestion blocks the agent on a user prompt with no further hook
    # until it is answered, so it must report as waiting-for-input, not working.
    TOOL=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
    if [ "$TOOL" = "AskUserQuestion" ]; then
      STATUS="permission_blocked"
      EXTRA=',\"message\":\"AskUserQuestion\"'
    else
      STATUS="working"
    fi
    ;;
  PreCompact) STATUS="compacting" ;;
  Stop) STATUS="idle" ;;
  PermissionRequest)
    # Claude Code's first-class permission event (CC >= ~2.1.x). Unlike the generic
    # Notification ("Claude needs your permission", no tool name), it carries the
    # real tool_name + tool_input + permission_mode, so the daemon can name the
    # blocked tool and build a preview without parsing the transcript. This is the
    # authoritative source for the web Approve/Deny card. AskUserQuestion arrives
    # here too; we tag it by name so the daemon routes it to needs-input.
    TOOL=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
    if [ -n "$TOOL" ]; then
      STATUS="permission_blocked"
      # Build ,"message":"Tool: preview" with single-quoted python only — a literal
      # double quote here would close the bash -c "..." string (the bug the old
      # permission_prompt block had), so the JSON is emitted via json.dumps.
      EXTRA=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ti=d.get('tool_input') or {}
prev=''
for k in ('command','file_path','pattern','path','url'):
    v=ti.get(k)
    if isinstance(v,str) and v:
        prev=v
        break
tool=d.get('tool_name','')
msg=tool if not prev else tool+': '+prev
print(','+json.dumps({'message':msg[:300]})[1:-1])
" 2>/dev/null)
    fi
    ;;
  Notification)
    case "$NOTIF_TYPE" in
      permission_prompt)
        STATUS="permission_blocked"
        # Forward only transcript_path so the daemon resolves the real tool from
        # the transcript. The Notification message is now a generic "Claude needs
        # your permission" with no tool name, so forwarding it would only mislead
        # extraction. Emitted via json.dumps (single quotes only) — bare double
        # quotes inside this bash -c "..." string silently break it.
        EXTRA=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=d.get('transcript_path','')
print((','+json.dumps({'transcript_path':t})[1:-1]) if t else '')
" 2>/dev/null)
        ;;
      idle_prompt) STATUS="idle" ;;
    esac
    ;;
  SessionStart)
    [ "$SOURCE" = "compact" ] && STATUS="working"
    ;;
esac

[ -z "$STATUS" ] && exit 0

TS=$(date +%s)

# Try HTTP push first (instant), fall back to file write (polled)
HOOK_PORT_FILE="$HOME/.codecast/hook-port"
if [ -f "$HOOK_PORT_FILE" ]; then
  PORT=$(cat "$HOOK_PORT_FILE" 2>/dev/null)
  if [ -n "$PORT" ]; then
    URL="http://127.0.0.1:$PORT/hook/status?session_id=$SESSION_ID&status=$STATUS&ts=$TS"
    [ -n "$PERM_MODE" ] && URL="$URL&permission_mode=$PERM_MODE"

    if [ -n "$EXTRA" ]; then
      MSG=$(echo "$EXTRA" | python3 -c "import sys,json; d=json.loads('{'+sys.stdin.read().lstrip(',')+'}'); print(d.get('message',''))" 2>/dev/null)
      TP=$(echo "$EXTRA" | python3 -c "import sys,json; d=json.loads('{'+sys.stdin.read().lstrip(',')+'}'); print(d.get('transcript_path',''))" 2>/dev/null)
      [ -n "$MSG" ] && URL="$URL&message=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$MSG" 2>/dev/null)"
      [ -n "$TP" ] && URL="$URL&transcript_path=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$TP" 2>/dev/null)"
    fi

    curl -sG "$URL" --connect-timeout 1 --max-time 2 >/dev/null 2>&1 && exit 0
  fi
fi

# Fallback: write status file (existing path, daemon polls via chokidar)
STATUS_DIR="$HOME/.codecast/agent-status"
mkdir -p "$STATUS_DIR"
CC_STATUS="$STATUS" CC_PERM_MODE="$PERM_MODE" CC_EXTRA="$EXTRA" CC_TS="$TS" python3 -c "
import json, os
d = {'status': os.environ['CC_STATUS'], 'ts': int(os.environ['CC_TS'])}
pm = os.environ.get('CC_PERM_MODE', '')
if pm: d['permission_mode'] = pm
ex = os.environ.get('CC_EXTRA', '')
if ex:
    try:
        parsed = json.loads('{' + ex.lstrip(',') + '}')
        d.update(parsed)
    except: pass
print(json.dumps(d))
" > "$STATUS_DIR/$SESSION_ID.json"
exit 0
`;
