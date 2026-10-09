#!/bin/bash
# Puts the bound task back in front of the agent after compaction or a resume (claude).
set -uo pipefail

INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

IFS=$'\037' read -r HOOK_session_id HOOK_sessionId HOOK_hook_event_name HOOK_tool_name HOOK_permission_mode HOOK_notification_type HOOK_source HOOK_trigger HOOK_transcript_path HOOK_stop_hook_active HOOK_command HOOK_file_path HOOK_pattern HOOK_path HOOK_url HOOK_task HOOK_plan HOOK_cwd HOOK_tool_use_id HOOK_agent_id <<EOF
$(printf '%s' "$INPUT" | awk '
function str(key,    k, i, s, j, c, out) {
  k = "\"" key "\""
  i = index(buf, k)
  if (!i) return ""
  s = substr(buf, i + length(k))
  sub(/^[[:space:]]*:[[:space:]]*/, "", s)
  if (s ~ /^true/) return "true"
  if (s ~ /^false/) return "false"
  if (substr(s, 1, 1) != "\"") return ""
  s = substr(s, 2)
  out = ""
  for (j = 1; j <= length(s); j++) {
    c = substr(s, j, 1)
    if (c == "\\") { j++; out = out substr(s, j, 1); continue }
    if (c == "\"") break
    out = out c
  }
  return out
}
function envelope_str(key,    whole, t, out) {
  whole = buf
  t = index(buf, "\"tool_input\"")
  if (t) buf = substr(buf, 1, t - 1)
  out = str(key)
  buf = whole
  return out
}
{ buf = buf $0 }
END {
  # Unit separator, not tab: IFS whitespace collapses empty fields, which
  # drops sessionId="" and shifts hook_event_name into the wrong variable.
  OFS = "\037"
  print str("session_id"), str("sessionId"), str("hook_event_name"), str("tool_name"), str("permission_mode"), str("notification_type"), str("source"), str("trigger"), str("transcript_path"), str("stop_hook_active"), str("command"), str("file_path"), str("pattern"), str("path"), str("url"), str("task"), str("plan"), str("cwd"), str("tool_use_id"), envelope_str("agent_id")
}
')
EOF


case "${HOOK_source:-}" in
  compact|resume) ;;
  *) exit 0 ;;
esac

SESSION_ID="${HOOK_session_id:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="${HOOK_sessionId:-}"
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ ${#SESSION_ID} -le 128 ] || exit 0


feature_on() {
  grep -Eq "\"$1\"[[:space:]]*:[[:space:]]*true" "${CODECAST_DIR:-$HOME/.codecast}/config.json" 2>/dev/null
}

feature_on work_enabled || exit 0
DIR="${CODECAST_DIR:-$HOME/.codecast}"
LOG="$DIR/task-context.log"

export PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v codecast >/dev/null 2>&1 || exit 0
# Silent to the agent when the CLI itself fails (an older one without the
# verb); the log, capped as the CLI caps it, says why.
codecast _task-context <<<"$INPUT" 2>/dev/null \
  || { rc=$?; [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 65536 ] && : >"$LOG"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SESSION_ID codecast _task-context exited $rc" >>"$LOG"; } 2>/dev/null
exit 0
