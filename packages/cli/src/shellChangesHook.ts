import { HOOK_FIELDS_READ } from "./hookJson.js";

export const SHELL_CHANGES_HOOK_FILE = "codecast-shell-changes.sh";

/** Where the hook leaves a call's changes; the daemon consumes from here. */
export const SHELL_CHANGES_DIR_NAME = "shell-changes";

export const CODECAST_SHELL_CHANGES_HOOK = `#!/bin/bash
# Records the files a Bash tool call changed on disk for codecast (shellChangesHook.ts)
set -uo pipefail

# The whole payload, capped. Not dd with count=1: that is ONE read() on the
# pipe, and Claude Code writes the PostToolUse payload (tool_response included)
# in more than one piece, so a single read stopped before tool_use_id.
INPUT=$(head -c 1048576 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

${HOOK_FIELDS_READ}

[ "\${HOOK_tool_name:-}" = "Bash" ] || exit 0
EVENT="\${HOOK_hook_event_name:-}"
ID="\${HOOK_tool_use_id:-}"
CWD="\${HOOK_cwd:-}"

# The id names a file below; accept only a plain token.
case "$ID" in ""|*[!A-Za-z0-9_-]*) exit 0 ;; esac
[ \${#ID} -le 128 ] || exit 0
[ -n "$CWD" ] && [ -d "$CWD" ] || exit 0

# One git call names both the repository root and the commit at HEAD (the
# second line is empty on an unborn branch).
ROOT=""
HEAD_SHA=""
{ IFS= read -r ROOT; IFS= read -r HEAD_SHA; } < <(git -C "$CWD" rev-parse --show-toplevel HEAD 2>/dev/null)
[ -n "$ROOT" ] && [ -d "$ROOT" ] || exit 0
[ "$ROOT" != "$HOME" ] || exit 0

DIR="$HOME/.codecast/${SHELL_CHANGES_DIR_NAME}"
PRE="$DIR/pre"
[ -d "$PRE" ] || mkdir -p "$PRE" 2>/dev/null || exit 0

MAX_FILE=1048576
MAX_ENTRIES=3000
MAX_SNAPSHOT_BYTES=8388608
case "$OSTYPE" in
  darwin*|*bsd*) STAT_FMT=-f; STAT_ARG='%z %N' ;;
  *) STAT_FMT=-c; STAT_ARG='%s %n' ;;
esac

# snapshot: prints one "hash<TAB>path" line per dirty path, "0" for a path git
# lists that is not a file (deleted). Fails when the tree is too dirty to
# snapshot or a file vanished mid-hash (the hash list would misalign).
snapshot() {
  local n=0 line p files=() small sizes hashes h counted statusfile
  statusfile="$PRE/$ID.status"
  git -C "$ROOT" status --porcelain=v1 -z -uall --no-renames > "$statusfile" 2>/dev/null || return 1
  while IFS= read -r -d '' line; do
    p=\${line:3}
    [ -n "$p" ] || continue
    n=$((n + 1))
    [ $n -le $MAX_ENTRIES ] || return 1
    if [ -L "$ROOT/$p" ]; then
      printf 'skip\\t%s\\n' "$p"
    elif [ -f "$ROOT/$p" ]; then
      files+=("$p")
    elif [ ! -e "$ROOT/$p" ]; then
      printf '0\\t%s\\n' "$p"
    fi
  done < "$statusfile"
  rm -f "$statusfile"
  [ \${#files[@]} -gt 0 ] || return 0
  sizes=$(cd "$ROOT" && stat "$STAT_FMT" "$STAT_ARG" -- "\${files[@]}" 2>/dev/null) || return 1
  small=$(awk -v max="$MAX_FILE" -v budget="$MAX_SNAPSHOT_BYTES" '{ if ($1 + 0 <= max) { total += $1; if (total > budget) exit 1; sub(/^[0-9]+ /, ""); print } }' <<< "$sizes") || return 1
  while IFS=' ' read -r size p; do
    [ "$size" -le "$MAX_FILE" ] || printf 'skip\\t%s\\n' "$p"
  done <<< "$sizes"
  [ -n "$small" ] || return 0
  hashes=$(cd "$ROOT" && git hash-object -w --stdin-paths <<< "$small" 2>/dev/null) || return 1
  # Pair paths with hashes line by line; a short hash list (git stopped at a
  # file it could not open) leaves a path unpaired, and the snapshot fails.
  # Read loops, never \${var//pattern/}: bash 3.2's pattern substitution takes
  # seconds on a few kilobytes.
  counted=0
  while IFS= read -r p && IFS= read -r h <&3; do
    printf '%s\\t%s\\n' "$h" "$p"
    counted=$((counted + 1))
  done <<< "$small" 3<<< "$hashes"
  n=0
  while IFS= read -r p; do n=$((n + 1)); done <<< "$small"
  [ "$counted" -eq "$n" ] || return 1
  return 0
}

if [ "$EVENT" = "PreToolUse" ]; then
  if [ $((RANDOM % 50)) -eq 0 ]; then
    find "$PRE" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null
  fi
  rm -f "$PRE/$ID"
  if { printf 'head\\t%s\\n' "$HEAD_SHA"; snapshot && printf 'complete\\n'; } > "$PRE/$ID.tmp"; then
    mv "$PRE/$ID.tmp" "$PRE/$ID"
  else
    rm -f "$PRE/$ID.tmp"
  fi
  exit 0
fi

[ "$EVENT" = "PostToolUse" ] || [ "$EVENT" = "PostToolUseFailure" ] || exit 0
PREFILE="$PRE/$ID"
[ -f "$PREFILE" ] || exit 0
[ "$(tail -n 1 "$PREFILE")" = "complete" ] || { rm -f "$PREFILE"; exit 0; }
POSTFILE="$DIR/$ID.post"
IFS= read -r PREHEAD < "$PREFILE"
PREHEAD=\${PREHEAD#head*	}
[ "$PREHEAD" = "head" ] && PREHEAD=""

if POSTLIST=$(snapshot); then
  printf '%s\\n' "$POSTLIST" > "$POSTFILE"
  # Paths on one side only were clean on the other: their blob then is the one
  # in the tree that was HEAD at that moment. A path is never on both lists.
  needpre=()
  needpost=()
  while IFS=$'\\t' read -r side p; do
    [ -n "$p" ] || continue
    if [ "$side" = "pre" ]; then needpre+=("$p"); else needpost+=("$p"); fi
  done < <(awk -F'\\t' -v OFS='\\t' '
    NF < 2 || $2 == "" { next }
    FILENAME == ARGV[1] { if (FNR == 1 && $1 == "head") next; pre[$2] = 1; next }
    { post[$2] = 1 }
    END {
      for (p in pre) if (!(p in post)) print "post", p
      for (p in post) if (!(p in pre)) print "pre", p
    }' "$PREFILE" "$POSTFILE")
  TREES=""
  if [ \${#needpre[@]} -gt 0 ] && [ -n "$PREHEAD" ]; then
    while IFS= read -r -d '' line; do TREES="$TREES\${line#* * }"$'\\n'; done \\
      < <(git -C "$ROOT" ls-tree -z "$PREHEAD" -- "\${needpre[@]}" 2>/dev/null)
  fi
  if [ \${#needpost[@]} -gt 0 ] && [ -n "$HEAD_SHA" ]; then
    while IFS= read -r -d '' line; do TREES="$TREES\${line#* * }"$'\\n'; done \\
      < <(git -C "$ROOT" ls-tree -z "$HEAD_SHA" -- "\${needpost[@]}" 2>/dev/null)
  fi
  awk -F'\\t' -v OFS='\\t' -v out="$DIR/$ID.tmp" -v root="$ROOT" '
    NF < 2 || $2 == "" { next }
    FILENAME == ARGV[1] { if (FNR == 1 && $1 == "head") next; pre[$2] = $1; seen[$2] = 1; next }
    FILENAME == ARGV[2] { post[$2] = $1; seen[$2] = 1; next }
    { tree[$2] = $1 }
    END {
      for (p in seen) {
        o = (p in pre) ? pre[p] : ((p in tree) ? tree[p] : "0")
        n = (p in post) ? post[p] : ((p in tree) ? tree[p] : "0")
        if (o == n) continue
        if (!started) { print "root", root, "2" > out; started = 1 }
        print o, n, p > out
      }
    }' "$PREFILE" "$POSTFILE" - <<< "$TREES" && {
      [ ! -f "$DIR/$ID.tmp" ] || mv "$DIR/$ID.tmp" "$DIR/$ID"
    }
fi
rm -f "$PREFILE" "$POSTFILE" 2>/dev/null
exit 0
`;
