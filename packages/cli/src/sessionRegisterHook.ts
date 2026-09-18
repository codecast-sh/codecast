// Claude Code SessionStart / UserPromptSubmit -> session-registry claim,
// installed to ~/.claude/hooks/session-register.sh.
import { HOOK_FIELDS_READ } from "./hookJson.js";

export const SESSION_REGISTER_HOOK = `#!/bin/bash
# Registers session-to-PID/TTY mapping for codecast daemon process discovery
set -uo pipefail

INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
[ -n "$INPUT" ] || INPUT=""

${HOOK_FIELDS_READ}

# Claude sends snake_case (session_id); grok runs these same hooks (it imports
# ~/.claude/settings.json) with a camelCase envelope (sessionId) and also exports
# GROK_SESSION_ID — accept all three so the claim is written for either client.
SESSION_ID="\${HOOK_session_id:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${HOOK_sessionId:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="\${GROK_SESSION_ID:-}"
[ -z "$SESSION_ID" ] && exit 0
case "$SESSION_ID" in
  ""|[!A-Za-z0-9_-]*|*[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ \${#SESSION_ID} -le 128 ] || exit 0

REGISTRY_DIR="$HOME/.codecast/session-registry"
# Fast path for UserPromptSubmit: a live claim for this session already names
# the process. Re-walking \`ps\` four times on every prompt is what stacked with
# python3 startup to blow the hook timeout. SessionStart still writes (the
# file is missing or the pid is dead).
if [ -f "$REGISTRY_DIR/$SESSION_ID.json" ]; then
  CLAIM=$(cat "$REGISTRY_DIR/$SESSION_ID.json" 2>/dev/null || true)
  OLD_PID=\${CLAIM#*\\"pid\\":}
  OLD_PID=\${OLD_PID%%,*}
  OLD_PID=\${OLD_PID%%\\}*}
  case "\$OLD_PID" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "\$OLD_PID" 2>/dev/null; then
        exit 0
      fi
      ;;
  esac
fi

# Walk up to find the agent process PID (claude, or grok running claude hooks)
CLAUDE_PID=""
CHECK_PID=\$PPID
for _ in 1 2 3 4; do
  [ -z "\$CHECK_PID" ] || [ "\$CHECK_PID" = "1" ] && break
  CMD=$(ps -o comm= -p "\$CHECK_PID" 2>/dev/null)
  if echo "\$CMD" | grep -qiE 'claude|grok|2\\.1\\.' 2>/dev/null; then
    CLAUDE_PID=\$CHECK_PID
    break
  fi
  CHECK_PID=$(ps -o ppid= -p "\$CHECK_PID" 2>/dev/null | tr -d ' ')
done

[ -z "\$CLAUDE_PID" ] && exit 0

TTY=$(ps -o tty= -p "\$CLAUDE_PID" 2>/dev/null | tr -d ' ')
[ -z "\$TTY" ] || [ "\$TTY" = "??" ] && exit 0

mkdir -p "$REGISTRY_DIR"
# launch_token: which LAUNCH wrote this claim. The daemon stamps it into the
# pane env at every spawn and resume, so a claim carrying a superseded token
# names a process the pane has already replaced (ct-49532). Empty for a session
# codecast did not launch, which stays as unfenced as it was before.
echo "{\\"pid\\":\$CLAUDE_PID,\\"tty\\":\\"\$TTY\\",\\"ts\\":$(date +%s),\\"term\\":\\"\${TERM_PROGRAM:-unknown}\\",\\"launch_token\\":\\"\${CODECAST_LAUNCH_TOKEN:-}\\"}" > "$REGISTRY_DIR/$SESSION_ID.json"
exit 0
`;
