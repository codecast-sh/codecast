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
# Deliberately NOT using \`set -u\` or \`set -e\`: under back-to-back tmux paste
# bursts, transient subshell failures (e.g. uuidgen briefly unreachable, write
# to a draining pane) shouldn't crash the whole shim. Real claude survives
# these too; the goal is to mirror its resilience, not its strictness.
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
# keys land in $line if bash read isn't in line-edit mode), escape backslashes
# and double-quotes, then encode embedded newlines as \\n — multi-line pastes
# produce real newlines in the message and a raw newline inside a JSON string
# is invalid.
json_escape() {
  printf '%s' "$1" \\
    | tr -d '\\000-\\010\\013-\\037\\177' \\
    | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' \\
    | awk 'NR>1{printf "\\\\n"} {printf "%s", $0}'
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

# REQUEST bracketed paste, the way every real agent TUI does. tmux only emits
# the ESC[200~ / ESC[201~ wrapper (and only preserves newlines inside a paste)
# when the pane's application has asked for the mode, so a shim that disables
# it cannot exercise the daemon's multi-line injection at all — the linefeeds
# arrive as carriage returns and each line submits as its own message. With the
# mode on, the loop below accumulates every line between the markers into ONE
# message, mirroring a composer that renders a pasted block as one prompt.
printf '\\033[?2004h'

# CLEAR THE COMPOSER ON C-k, the way a real agent TUI does. Before pasting, the
# daemon types a probe char and then drains with C-a/C-k, and it refuses to
# paste until the probe is gone from the pane (the closed loop in
# drainTmuxComposer -- a paste into a dirty composer submits "qqq<message>").
# A bash read runs in the tty's canonical mode, where C-a and C-k are ordinary
# bytes: they echo as ^A^K and the probe never leaves the line, so every
# injection scenario failed AGENT_STDIN_NOT_READY against this shim. Making C-k
# the tty's kill character gives the line the one editing behaviour the drain
# depends on, and echoke (the macOS and Linux default) erases it from the
# display too.
stty kill '^K' 2>/dev/null || true
# DO NOT ECHO CONTROL BYTES. A real TUI runs raw with no echo, so the pane
# shows only the pasted text. The tty's default echoctl renders the paste
# markers as "^[[200~hello^[[201~" at the prompt, and the daemon's composer
# watcher (awaitTmuxComposerPayload) rightly reads that as foreign text: it
# drains, re-pastes twice and gives up AGENT_STDIN_NOT_READY. Without echoctl
# the raw ESC[200~ reaches tmux, which drops the unknown sequence.
stty -echoctl 2>/dev/null || true

has_paste_start() { case "$1" in *$'\\033'"[200~"*) return 0 ;; *) return 1 ;; esac; }
has_paste_end() { case "$1" in *$'\\033'"[201~"*) return 0 ;; *) return 1 ;; esac; }

# Strip bracketed-paste wrapper bytes, leaving the pasted payload.
strip_paste_markers() {
  printf '%s' "$1" | LC_ALL=C sed -e 's/\\x1b\\[200~//g' -e 's/\\x1b\\[201~//g'
}

submit() {
  [ -z "$1" ] && return 0
  emit_user_message "$1"
  # Echo back so daemon JSONL watcher has something to sync. Single-line only:
  # a multi-line echo would make the pane's own output look like stuck input to
  # the daemon's prompt scraper.
  emit_assistant_reply "got it: $(printf '%s' "$1" | head -1)"
}

# Main loop: print prompt, read a line (or a whole bracketed paste), append to
# JSONL, echo a reply. The read timeout inside the paste keeps a truncated
# paste (no end marker, e.g. the pane died mid-burst) from hanging the shim.
trap 'exit 0' INT TERM
while true; do
  printf '\\n❯ '
  if ! IFS= read -r line; then
    exit 0
  fi
  if has_paste_start "$line"; then
    pasted="$(strip_paste_markers "$line")"
    if ! has_paste_end "$line"; then
      while IFS= read -r -t 5 more; do
        pasted="$pasted
$(strip_paste_markers "$more")"
        has_paste_end "$more" && break
      done
    fi
    submit "$pasted"
    continue
  fi
  submit "$(strip_paste_markers "$line")"
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
