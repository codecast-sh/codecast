// Claude Code PreToolUse -> Codecast-Session trailer, installed to
// ~/.claude/hooks/codecast-session-trailer.sh (HARNESS_HOOKS).
//
// It runs before every tool call, so the script itself only screens: a Bash
// call whose input mentions both "git" and "commit" goes to
// `cast _session-trailer` (sessionTrailer.ts), which decides and prints the
// rewrite; everything else exits in the shell without starting a process.
// Every failure exits 0 with no output, which Claude Code reads as "run the
// command unchanged": the trailer is never a reason for a commit to fail.
import { FIND_CAST_SH } from "./cloud/ghWrapper.js";
import type { CODECAST_HOOK_SCRIPTS } from "./codecastOwned.js";

export const SESSION_TRAILER_HOOK_FILE = "codecast-session-trailer.sh" satisfies (typeof CODECAST_HOOK_SCRIPTS)[number];

export const SESSION_TRAILER_HOOK = `#!/bin/bash
# Adds a Codecast-Session trailer to each git commit an agent runs.
# Off: CODECAST_SESSION_TRAILER=0, git config codecast.sessionTrailer false,
# or cast config session_trailer false.
case "\${CODECAST_SESSION_TRAILER:-}" in 0|false|off|no) exit 0 ;; esac
IFS= read -r -d '' INPUT || true
case "$INPUT" in
  *'"tool_name"'*'"Bash"'*) ;;
  *) exit 0 ;;
esac
case "$INPUT" in
  *git*commit*) ;;
  *) exit 0 ;;
esac
${FIND_CAST_SH}
[ -n "$CAST" ] || exit 0
printf '%s' "$INPUT" | "$CAST" _session-trailer
exit 0
`;
