// Claude Code Bash tool -> file changes the transcript cannot carry, installed
// to ~/.claude/hooks/codecast-shell-changes.sh on PreToolUse, PostToolUse and
// PostToolUseFailure with the "Bash" matcher.
//
// The diff panel and `cast diff` read a session's edits out of its tool calls:
// an Edit carries old_string/new_string, a Write carries the content. A shell
// edit (sed -i, a python heredoc, rm, cat >) carries neither, so a session that
// worked through Bash showed no diff at all. This hook fills that hole from the
// working tree itself.
//
// PreToolUse: list the repository's dirty paths (tracked modifications and
// untracked files) and store each file's content as a git blob with
// `git hash-object -w`, recording "hash<TAB>path" per entry plus the HEAD sha.
// A blob for content the repository already holds costs nothing, so the write
// is only ever the new content; unreachable blobs fall to git's own gc.
// PostToolUse: list and hash again, then join the two listings. A path present
// on one side only was clean there, so its content at that moment is the HEAD
// tree's blob (clean means worktree == index == HEAD). Every path whose blob
// differs is written as "old<TAB>new<TAB>path" to
// ~/.codecast/shell-changes/<tool_use_id>; the daemon resolves the blobs with
// `git cat-file` when it syncs the tool result (shellChanges.ts) and attaches
// them to that message as file changes.
//
// Cost: two `git status` runs plus one hash pass per Bash call, a few hundred
// milliseconds on a large tree. Bounds keep the worst case short: no snapshot
// of a tree with more than MAX_ENTRIES dirty paths, no file over MAX_FILE
// bytes, and a repository rooted at $HOME (a dotfiles checkout) is skipped
// because its untracked listing is the whole home directory.
//
// Every step that can be a bash builtin is one: under load a process spawn
// costs hundreds of milliseconds, so the script holds its lists in variables
// and arrays and spawns only git, stat, and awk (see the note at the top of
// statusHook.ts on interpreter startup). Bash 3.2 (macOS /bin/bash) is the
// floor: no mapfile, no associative arrays, no NUL in variables.
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
case "$OSTYPE" in
  darwin*|*bsd*) STAT_FMT=-f; STAT_ARG='%z %N' ;;
  *) STAT_FMT=-c; STAT_ARG='%s %n' ;;
esac

# snapshot: prints one "hash<TAB>path" line per dirty path, "0" for a path git
# lists that is not a file (deleted). Fails when the tree is too dirty to
# snapshot or a file vanished mid-hash (the hash list would misalign).
snapshot() {
  local n=0 line p files=() small hashes h counted
  while IFS= read -r -d '' line; do
    p=\${line:3}
    [ -n "$p" ] || continue
    n=$((n + 1))
    [ $n -le $MAX_ENTRIES ] || return 1
    if [ -L "$ROOT/$p" ]; then
      continue
    elif [ -f "$ROOT/$p" ]; then
      files+=("$p")
    elif [ ! -e "$ROOT/$p" ]; then
      printf '0\\t%s\\n' "$p"
    fi
  done < <(git -C "$ROOT" status --porcelain=v1 -z -uall --no-renames 2>/dev/null)
  [ \${#files[@]} -gt 0 ] || return 0
  small=$(cd "$ROOT" && stat "$STAT_FMT" "$STAT_ARG" -- "\${files[@]}" 2>/dev/null \\
    | awk -v max="$MAX_FILE" '{ if ($1 + 0 <= max) { sub(/^[0-9]+ /, ""); print } }')
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
  # Stale leftovers: a pre listing whose call never reported back, a change
  # file the daemon never consumed. Rare sweep, off the hot path.
  if [ $((RANDOM % 50)) -eq 0 ]; then
    find "$DIR" -maxdepth 2 -type f \\( \\( -path "$PRE/*" -mmin +1440 \\) -o \\( ! -path "$PRE/*" -mtime +7 \\) \\) -delete 2>/dev/null
  fi
  { printf 'head\\t%s\\n' "$HEAD_SHA"; snapshot; } > "$PRE/$ID" || rm -f "$PRE/$ID"
  exit 0
fi

[ "$EVENT" = "PostToolUse" ] || [ "$EVENT" = "PostToolUseFailure" ] || exit 0
PREFILE="$PRE/$ID"
[ -f "$PREFILE" ] || exit 0
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
  awk -F'\\t' -v OFS='\\t' -v out="$DIR/$ID" -v root="$ROOT" '
    NF < 2 || $2 == "" { next }
    FILENAME == ARGV[1] { if (FNR == 1 && $1 == "head") next; pre[$2] = $1; seen[$2] = 1; next }
    FILENAME == ARGV[2] { post[$2] = $1; seen[$2] = 1; next }
    { tree[$2] = $1 }
    END {
      for (p in seen) {
        o = (p in pre) ? pre[p] : ((p in tree) ? tree[p] : "0")
        n = (p in post) ? post[p] : ((p in tree) ? tree[p] : "0")
        if (o == n) continue
        if (!started) { print "root", root > out; started = 1 }
        print o, n, p > out
      }
    }' "$PREFILE" "$POSTFILE" - <<< "$TREES"
fi
rm -f "$PREFILE" "$POSTFILE" 2>/dev/null
exit 0
`;
