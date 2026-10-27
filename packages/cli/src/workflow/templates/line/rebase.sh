# The rebase station (the-line.md L12): a card waits hours for its answer and
# the default branch moves under it, so a Ship answer first puts the branch on
# the default branch as the remote has it and runs the project's check on what
# that makes. A failed run resumed onto the default branch (cast workflow
# resume --onto-main) runs it too, with the check left to the station it
# resumes at. Prints {"rebased", "landed", "why"}.
#   exit 0: on the default branch and checked, or nothing of the change is left
#           on the branch because it is already there (landed: true, the run
#           goes to watch rather than shipping it twice)
#   exit 1: the rebase conflicted or the check failed on the rebased branch;
#           what happened goes on the task and the run goes back to implement
#   exit 2: no worktree here, the default branch could not be fetched, or the
#           rebased branch could not be pushed; ship decides on the branch as it is
target=$default_branch
br=$branch
dir=$run_dir
mkdir -p "$dir"
clean() { printf '%s' "$1" | tr -d '\000-\037\\"'; }
answer() { printf '{"rebased": %s, "landed": %s, "why": "%s"}\n' "$1" "$2" "$(clean "$3")"; }

if ! cd "$(cast ws path $worktree)" 2>/dev/null; then
  answer false false "the run's worktree $worktree is not on this machine"
  exit 2
fi

if ! git fetch -q origin "$target"; then
  answer false false "git fetch origin $target failed"
  exit 2
fi
upstream="origin/$target"
was="$(git rev-parse HEAD)"
# The files the change touched since it forked from the default branch.
fork="$(git merge-base "$was" "$upstream")"
touched=()
while IFS= read -r f; do touched+=("$f"); done < <(git diff --name-only --no-renames "$fork" "$was")

if ! git rebase --autostash "$upstream" > "$dir/rebase.log" 2>&1; then
  files="$(git diff --name-only --diff-filter=U | head -20 | tr '\n' ' ')"
  git rebase --abort > /dev/null 2>&1
  # The default branch can already carry the change, reworked by edits made
  # after review (the shared tree committed while the card waited). It counts
  # as carried only when every file the change touched reads nearer the
  # reviewed branch on the default branch than at the fork: a file whose
  # reviewed edit never landed leaves a plain conflict. Nearer is not proof
  # the whole edit is there, and a rework of the change's own lines looks the
  # same as a part that never landed, so the run stops and names the files
  # that differ for a person to read, rather than asking for a conflict to be
  # resolved in favour of a change that is largely there already.
  apart() { git diff --numstat "$1" "$was" -- "$2" | awk '{ n += $1 + $2 } END { print n + 0 }'; }
  carries() { for f in "${touched[@]}"; do [ "$(apart "$1" "$f")" -lt "$(apart "$fork" "$f")" ] || return 1; done; }
  landed=""
  if [ "${#touched[@]}" -gt 0 ] && carries "$upstream"; then
    landed="$(git log --reverse --format=%H "$fork..$upstream" -- "${touched[@]}" | while read -r c; do carries "$c" && { echo "$c"; break; }; done)"
  fi
  if [ -n "$landed" ]; then
    # Each file that differs either holds the reviewed edit with more around
    # it, or does not hold it as written (reworked after review, or never
    # fully landed); the note names which, so nobody reads one as the other.
    idx="$dir/upstream.index"
    GIT_INDEX_FILE="$idx" git read-tree "$upstream"
    extra=""; missing=""
    for f in "${touched[@]}"; do
      [ "$(git rev-parse -q --verify "$upstream:$f")" = "$(git rev-parse -q --verify "$was:$f")" ] && continue
      if git diff --binary -U0 "$fork" "$was" -- "$f" | GIT_INDEX_FILE="$idx" git apply --cached --check -R --unidiff-zero - > /dev/null 2>&1; then extra="$extra$f "; else missing="$missing$f "; fi
    done
    rm -f "$idx"
    cast task comment $task_id "$upstream already carries most of $br as ${landed:0:10}, but not as reviewed.${extra:+ Holds the reviewed edit plus edits no review saw: $extra.}${missing:+ Does not hold the reviewed edit as written (reworked after review, or part of it never landed): $missing.} \`git diff ${was:0:10} $upstream -- $extra$missing\` shows each difference; read them before the task is done." -t review > /dev/null
    answer false false "mostly on $upstream as ${landed:0:10}, not as reviewed:${extra:+ more than reviewed in $extra}${missing:+ reviewed edit not as written in $missing}"
    exit 1
  fi
  said="$(tail -n 5 "$dir/rebase.log" | tr '\n' ' ')"
  cast task comment $task_id "Rebasing $br onto $upstream conflicted${files:+ in $files}. The branch is as it was before the rebase. Rebase it onto $upstream, resolve the conflict keeping the approved change, run the check, and hand off again. Git said: $said" -t review > /dev/null
  answer false false "rebase onto $upstream conflicted${files:+ in $files}"
  exit 1
fi

if [ "$(git rev-list --count "$upstream..HEAD")" = 0 ]; then
  # Every commit of the change is already on the default branch: it landed
  # another way (git drops a commit whose patch is already upstream). Where:
  # the first commit after the fork whose every file the change touched reads
  # as the change left it, which finds a hand landing that carried more too.
  landed="$([ "${#touched[@]}" -gt 0 ] && git log --reverse --format=%H "$fork..$upstream" -- "${touched[@]}" | while read -r c; do
    same=1
    for f in "${touched[@]}"; do [ "$(git rev-parse -q --verify "$c:$f")" = "$(git rev-parse -q --verify "$was:$f")" ] || { same=0; break; }; done
    [ "$same" = 1 ] && { echo "$c"; break; }
  done)"
  cast task comment $task_id "Already on $target${landed:+ as ${landed:0:10}}: nothing of $br is left to ship, so the flow goes on to watch." -t progress > /dev/null
  answer true true "already on $upstream${landed:+ as ${landed:0:10}}"
  exit 0
fi

if [ "$(git rev-parse HEAD)" != "$was" ]; then
  # The base moved: the approved change is checked again on what it now sits on.
  cmd=$line.commands.check
  if [ -n "$cmd" ] && ! bash -c "$cmd" > "$dir/rebase-check.log" 2>&1; then
    said="$(tail -n 30 "$dir/rebase-check.log")"
    git reset -q --keep "$was"
    cast task comment $task_id "After rebasing $br onto $upstream the project's check fails, so the change no longer fits the default branch as it is now. The branch is as it was before the rebase. Rebase it, make the check pass, and hand off again. The check said:
$said" -t review > /dev/null
    answer true false "the check fails on the branch rebased onto $upstream"
    exit 1
  fi
  # The branch on the remote is the one the ship command lands; it follows the rebase. A push the remote
  # refuses (the lease, the network, credentials) leaves the remote unrebased: ship then decides on the
  # branch as it is, knowingly, and the worktree goes back to match it.
  if ! git push -q --force-with-lease origin "HEAD:$br" > "$dir/rebase-push.log" 2>&1; then
    said="$(tail -n 3 "$dir/rebase-push.log" | tr '\n' ' ')"
    git reset -q --keep "$was"
    answer false false "push of the rebased branch failed: $said"
    exit 2
  fi
fi
answer true false "on $upstream at $(git rev-parse --short HEAD)"
exit 0
