// Shared JSON-field extractor for Claude Code hook scripts.
//
// UserPromptSubmit used to spawn python3 once per hook (four processes in
// parallel). Under load, macOS /usr/bin/python3 startup alone is several
// seconds and blows Claude Code's hook timeout; the output is discarded.
// One awk pass starts in tens of milliseconds and pulls every envelope key
// we need. First match wins, so a megabyte `prompt` after the envelope is
// only scanned once, not once per key.

export const HOOK_FIELDS_AWK = String.raw`
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
{ buf = buf $0 }
END {
  # Unit separator, not tab: IFS whitespace collapses empty fields, which
  # drops sessionId="" and shifts hook_event_name into the wrong variable.
  OFS = "\037"
  print str("session_id"), str("sessionId"), str("hook_event_name"), str("tool_name"), str("permission_mode"), str("notification_type"), str("source"), str("trigger"), str("transcript_path"), str("stop_hook_active"), str("command"), str("file_path"), str("pattern"), str("path"), str("url"), str("task"), str("plan"), str("cwd"), str("tool_use_id")
}
`.trim();

/** Bash snippet: populate HOOK_* from $INPUT in one awk. */
export const HOOK_FIELDS_READ = `IFS=$'\\037' read -r HOOK_session_id HOOK_sessionId HOOK_hook_event_name HOOK_tool_name HOOK_permission_mode HOOK_notification_type HOOK_source HOOK_trigger HOOK_transcript_path HOOK_stop_hook_active HOOK_command HOOK_file_path HOOK_pattern HOOK_path HOOK_url HOOK_task HOOK_plan HOOK_cwd HOOK_tool_use_id <<EOF
$(printf '%s' "$INPUT" | awk '
${HOOK_FIELDS_AWK}
')
EOF
`;
