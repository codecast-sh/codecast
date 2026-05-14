// Fake `claude` binary for messaging-pipeline tests.
//
// Mimics the parts of the real claude CLI that the codecast daemon depends on:
//   - prints the `❯` prompt the daemon polls for in `tryStartedTmux`
//   - writes a JSONL file under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//     so daemon JSONL discovery can link the tmux pane to a conversation
//   - reads piped/typed user input and appends a user-message JSONL row
//   - optionally echoes an assistant reply (so the test can assert sync-back)
//
// Knobs (env vars on the spawned shim):
//   FAKE_CLAUDE_SESSION_ID    — JSONL UUID to use (default: random)
//   FAKE_CLAUDE_STARTUP_MS    — sleep before printing first prompt (default: 0)
//   FAKE_CLAUDE_TRUST_PROMPT  — if "1", show the trust dialog first (must be dismissed with Enter)
//   FAKE_CLAUDE_HANG          — if "1", never write JSONL or print a prompt (stuck-session sim)
//   FAKE_CLAUDE_FATAL         — if set, prints the value and exits 1 immediately
//
// Output schema is a minimal subset of Claude's real JSONL — the daemon only
// needs the file to exist with a valid UUID name to make discovery succeed.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

export interface ShimOptions {
  sessionId?: string;
  startupMs?: number;
  trustPrompt?: boolean;
  hang?: boolean;
  fatal?: string;
}

/**
 * Produces a self-contained bash script string. Caller writes it to a temp
 * file, chmods +x, and points tmux at it. The script imports nothing — keep
 * it portable so it runs on any CI runner with bash.
 */
export function buildShimScript(opts: ShimOptions = {}): string {
  const sessionId = opts.sessionId ?? randomUUID();
  const startupMs = opts.startupMs ?? 0;
  const trustPrompt = opts.trustPrompt ? 1 : 0;
  const hang = opts.hang ? 1 : 0;
  const fatal = opts.fatal ?? "";

  return `#!/usr/bin/env bash
# fake-claude shim — see fakeClaudeShim.ts for contract
set -u
SESSION_ID="\${FAKE_CLAUDE_SESSION_ID:-${sessionId}}"
STARTUP_MS="\${FAKE_CLAUDE_STARTUP_MS:-${startupMs}}"
TRUST_PROMPT="\${FAKE_CLAUDE_TRUST_PROMPT:-${trustPrompt}}"
HANG="\${FAKE_CLAUDE_HANG:-${hang}}"
FATAL="\${FAKE_CLAUDE_FATAL:-${fatal}}"

if [ -n "$FATAL" ]; then
  echo "$FATAL" 1>&2
  exit 1
fi

CWD="$(pwd)"
ENCODED_CWD="\${CWD//\\//-}"
PROJECT_DIR="$HOME/.claude/projects/$ENCODED_CWD"
JSONL_PATH="$PROJECT_DIR/$SESSION_ID.jsonl"
mkdir -p "$PROJECT_DIR"

write_jsonl() {
  printf '%s\\n' "$1" >> "$JSONL_PATH"
}

emit_meta() {
  write_jsonl '{"type":"agent-setting","agentSetting":"claude","sessionId":"'"$SESSION_ID"'"}'
  write_jsonl '{"type":"permission-mode","permissionMode":"auto","sessionId":"'"$SESSION_ID"'"}'
}

# JSON-escape: strip control chars (ESC/NAK from daemon's pre-paste clearing
# keys land in $line if bash read isn't in line-edit mode), then escape
# backslashes and double-quotes so the result is safe to embed in a JSON string.
json_escape() {
  printf '%s' "$1" \\
    | tr -d '\\000-\\010\\013-\\037\\177' \\
    | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}

emit_user_message() {
  local content="$1"
  local uuid
  uuid=$(uuidgen 2>/dev/null || echo "$(date +%s)-$RANDOM")
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  local escaped
  escaped=$(json_escape "$content")
  # Quote every interpolation: unquoted "$escaped" undergoes word-splitting
  # on spaces, which truncates the JSON line.
  write_jsonl '{"parentUuid":null,"isSidechain":false,"type":"user","userType":"external","cwd":"'"$CWD"'","sessionId":"'"$SESSION_ID"'","uuid":"'"$uuid"'","timestamp":"'"$ts"'","message":{"role":"user","content":"'"$escaped"'"}}'
}

emit_assistant_reply() {
  local content="$1"
  local uuid
  uuid=$(uuidgen 2>/dev/null || echo "$(date +%s)-$RANDOM")
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  local escaped
  escaped=$(json_escape "$content")
  write_jsonl '{"parentUuid":null,"isSidechain":false,"type":"assistant","sessionId":"'"$SESSION_ID"'","uuid":"'"$uuid"'","timestamp":"'"$ts"'","message":{"role":"assistant","content":[{"type":"text","text":"'"$escaped"'"}]}}'
}

if [ "$HANG" = "1" ]; then
  # Simulate a wedged claude: never write JSONL, never print prompt.
  trap 'exit 0' INT TERM
  while true; do sleep 60; done
fi

if [ "$STARTUP_MS" -gt 0 ]; then
  sleep $(awk "BEGIN { printf \\"%.3f\\", $STARTUP_MS / 1000 }")
fi

if [ "$TRUST_PROMPT" = "1" ]; then
  printf '\\n  Do you trust this folder?\\n  [Enter to accept]\\n  ❯ '
  read -r _trust
fi

emit_meta

# Disable bracketed paste in this terminal. tmux 3.x defaults bracketed paste
# on, which wraps long pastes with ESC[200~ ... ESC[201~. plain bash read
# treats those bytes as part of the line and never sees a clean LF terminator
# for very long pastes — so the user message would never make it into JSONL
# even though the bytes are sitting in the input buffer.
printf '\\033[?2004l'

# Strip bracketed-paste wrapper bytes if any slip through (defensive).
strip_paste_markers() {
  printf '%s' "$1" | LC_ALL=C sed -e 's/\\x1b\\[200~//g' -e 's/\\x1b\\[201~//g'
}

# Main loop: print prompt, read line, append to JSONL, echo a reply.
trap 'exit 0' INT TERM
while true; do
  printf '\\n❯ '
  if ! IFS= read -r line; then
    exit 0
  fi
  line=$(strip_paste_markers "$line")
  if [ -z "$line" ]; then continue; fi
  emit_user_message "$line"
  # Echo back so daemon JSONL watcher has something to sync.
  emit_assistant_reply "got it: $line"
done
`;
}

/**
 * Writes the shim to a temp file, chmods +x, returns the absolute path.
 * Caller is responsible for cleaning up via fs.unlinkSync.
 */
export function writeShimScript(opts: ShimOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-fake-claude-"));
  const scriptPath = path.join(dir, "claude");
  fs.writeFileSync(scriptPath, buildShimScript(opts), { mode: 0o755 });
  return scriptPath;
}

export function cleanupShimScript(scriptPath: string): void {
  try {
    fs.unlinkSync(scriptPath);
    fs.rmdirSync(path.dirname(scriptPath));
  } catch {}
}
