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
// Everything is bash builtins, git and one awk join; no interpreter startup on
// the hot path (see the note at the top of statusHook.ts).
import { HOOK_FIELDS_READ } from "./hookJson.js";

export const SHELL_CHANGES_HOOK_FILE = "codecast-shell-changes.sh";

/** Where the hook leaves a call's changes; the daemon consumes from here. */
export const SHELL_CHANGES_DIR_NAME = "shell-changes";

export const CODECAST_SHELL_CHANGES_HOOK = `#!/bin/bash
# Records the files a Bash tool call changed on disk for codecast (shellChangesHook.ts)
set -uo pipefail

INPUT=$(dd bs=65536 count=1 2>/dev/null || true)
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

ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$ROOT" ] || exit 0
[ "$ROOT" != "$HOME" ] || exit 0

DIR="$HOME/.codecast/${SHELL_CHANGES_DIR_NAME}"
PRE="$DIR/pre"
mkdir -p "$PRE" 2>/dev/null || exit 0

MAX_FILE=1048576
MAX_ENTRIES=3000

if stat -f '%z' "$ROOT" >/dev/null 2>&1; then
  stat_sizes() { xargs -0 stat -f '%z %N' 2>/dev/null; }
else
  stat_sizes() { xargs -0 stat -c '%s %n' 2>/dev/null; }
fi

# snapshot OUT: one "hash<TAB>path" line per dirty path, "0" for a path git
# lists that is not a file (deleted). Fails when the tree is too dirty to
# snapshot or a file vanished mid-hash (the hash list would misalign).
snapshot() {
  local out=$1 paths="$1.paths" small="$1.small" hashes="$1.hashes" n=0 line p
  : > "$out"; : > "$paths"
  while IFS= read -r line; do
    p=\${line:3}
    [ -n "$p" ] || continue
    n=$((n + 1))
    [ $n -le $MAX_ENTRIES ] || return 1
    if [ -L "$ROOT/$p" ]; then
      continue
    elif [ -f "$ROOT/$p" ]; then
      printf '%s\\0' "$p" >> "$paths"
    elif [ ! -e "$ROOT/$p" ]; then
      printf '0\\t%s\\n' "$p" >> "$out"
    fi
  done < <(git -C "$ROOT" status --porcelain=v1 -z -uall --no-renames 2>/dev/null | tr '\\0' '\\n')
  if [ -s "$paths" ]; then
    (cd "$ROOT" && stat_sizes < "$paths") | awk -v max="$MAX_FILE" '{ if ($1 + 0 <= max) { sub(/^[0-9]+ /, ""); print } }' > "$small"
    if [ -s "$small" ]; then
      (cd "$ROOT" && git hash-object -w --stdin-paths < "$small") > "$hashes" 2>/dev/null
      [ "$(wc -l < "$hashes")" -eq "$(wc -l < "$small")" ] || return 1
      paste "$hashes" "$small" >> "$out"
    fi
  fi
  return 0
}

# tree_blobs SHA PATHS OUT: "hash<TAB>path" for the paths that exist in that tree.
tree_blobs() {
  local sha=$1 paths=$2 out=$3
  : > "$out"
  [ -s "$paths" ] || return 0
  tr '\\n' '\\0' < "$paths" | xargs -0 git -C "$ROOT" ls-tree -z "$sha" -- 2>/dev/null \\
    | tr '\\0' '\\n' | awk -F'\\t' -v OFS='\\t' '{ split($1, a, " "); print a[3], $2 }' > "$out"
}

cleanup() { rm -f "$@" 2>/dev/null; }

if [ "$EVENT" = "PreToolUse" ]; then
  # Stale leftovers: a pre listing whose call never reported back, a change
  # file the daemon never consumed. Rare sweep, off the hot path.
  if [ $((RANDOM % 50)) -eq 0 ]; then
    find "$PRE" -type f -mmin +1440 -delete 2>/dev/null
    find "$DIR" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null
  fi
  TMP="$PRE/$ID.tmp"
  HEAD_SHA=$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null) || HEAD_SHA=""
  if snapshot "$TMP.list"; then
    { printf 'head\\t%s\\n' "$HEAD_SHA"; cat "$TMP.list"; } > "$TMP" && mv -f "$TMP" "$PRE/$ID"
  fi
  cleanup "$TMP" "$TMP.list" "$TMP.list.paths" "$TMP.list.small" "$TMP.list.hashes"
  exit 0
fi

[ "$EVENT" = "PostToolUse" ] || [ "$EVENT" = "PostToolUseFailure" ] || exit 0
PREFILE="$PRE/$ID"
[ -f "$PREFILE" ] || exit 0
POST="$DIR/$ID.post"
PREHEAD=$(head -n 1 "$PREFILE" | cut -f2)
HEAD_SHA=$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null) || HEAD_SHA=""

if snapshot "$POST.list"; then
  # Paths on one side only were clean on the other: fetch their blob from the
  # tree that was HEAD at that moment.
  awk -F'\\t' -v OFS='\\t' '
    FNR == 1 && FILENAME == ARGV[1] && $1 == "head" { next }
    FILENAME == ARGV[1] { pre[$2] = 1; next }
    { post[$2] = 1 }
    END {
      for (p in pre) if (!(p in post)) print "post", p
      for (p in post) if (!(p in pre)) print "pre", p
    }' "$PREFILE" "$POST.list" > "$POST.needs"
  awk -F'\\t' '$1 == "pre" { print $2 }' "$POST.needs" > "$POST.needpre"
  awk -F'\\t' '$1 == "post" { print $2 }' "$POST.needs" > "$POST.needpost"
  if [ -n "$PREHEAD" ]; then tree_blobs "$PREHEAD" "$POST.needpre" "$POST.pretree"; else : > "$POST.pretree"; fi
  if [ -n "$HEAD_SHA" ]; then tree_blobs "$HEAD_SHA" "$POST.needpost" "$POST.posttree"; else : > "$POST.posttree"; fi
  awk -F'\\t' -v OFS='\\t' '
    FILENAME == ARGV[1] { if (FNR == 1 && $1 == "head") next; pre[$2] = $1; seen[$2] = 1; next }
    FILENAME == ARGV[2] { post[$2] = $1; seen[$2] = 1; next }
    FILENAME == ARGV[3] { ptree[$2] = $1; next }
    FILENAME == ARGV[4] { ntree[$2] = $1; next }
    END {
      for (p in seen) {
        o = (p in pre) ? pre[p] : ((p in ptree) ? ptree[p] : "0")
        n = (p in post) ? post[p] : ((p in ntree) ? ntree[p] : "0")
        if (o != n) print o, n, p
      }
    }' "$PREFILE" "$POST.list" "$POST.pretree" "$POST.posttree" | sort -t "$(printf '\\t')" -k3 > "$POST.changes"
  if [ -s "$POST.changes" ]; then
    { printf 'root\\t%s\\n' "$ROOT"; cat "$POST.changes"; } > "$POST.tmp" && mv -f "$POST.tmp" "$DIR/$ID"
  fi
fi
cleanup "$PREFILE" "$POST.list" "$POST.list.paths" "$POST.list.small" "$POST.list.hashes" \\
  "$POST.needs" "$POST.needpre" "$POST.needpost" "$POST.pretree" "$POST.posttree" "$POST.changes" "$POST.tmp"
exit 0
`;
