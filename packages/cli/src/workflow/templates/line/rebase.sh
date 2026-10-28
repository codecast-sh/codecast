# The rebase station (the-line.md L12): a card waits hours for its answer and
# the default branch moves under it, so a Ship answer first puts the branch on
# the default branch as the remote has it and runs the project's check on what
# that makes. A failed run resumed onto the default branch (cast workflow
# resume --onto-main) runs it too, with the check left to the station it
# resumes at. Prints {"rebased", "landed", "why"}.
#   exit 0: on the default branch and checked, or nothing of the change is left
#           on the branch because it is already there (landed: true, the run
#           goes to watch rather than shipping it twice)
#   exit 1: the rebase conflicted, git refused to start it (a lock, a dirty
#           index), or the check failed on the rebased
#           branch; what happened goes on the task and the run goes back to
#           implement, or stops where the flow has no implement
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

# An untracked file the default branch has since begun to track blocks the
# checkout (git refuses to overwrite it). A worktree starts with copies of the
# main tree's untracked agent files, which is how one usually gets there, but
# it may be work the agent wrote too. Each moves into this attempt's folder in
# the run's directory so the rebase can go on, and back into the worktree on
# every path that leaves the branch as it was.
aside=()
back="$dir/aside/$(date +%Y%m%d-%H%M%S)"
while IFS= read -r f; do aside+=("$f"); done < <(comm -12 <(git -c core.quotePath=off ls-files --others --exclude-standard | sort) <(git -c core.quotePath=off ls-tree -r --name-only "$upstream" | sort))
for f in "${aside[@]}"; do mkdir -p "$back/$(dirname "$f")" && mv "$f" "$back/$f"; done
restore() { for f in "${aside[@]}"; do mkdir -p "$(dirname "$f")" && mv "$back/$f" "$f"; done; }
[ "${#aside[@]}" -eq 0 ] || cast task comment $task_id "Moved ${#aside[@]} untracked file(s) that $upstream tracks out of the run's worktree, into $back, so the rebase could check $upstream out; they go back if the branch stays as it was: ${aside[*]}" -t progress > /dev/null

if ! git rebase --autostash "$upstream" > "$dir/rebase.log" 2>&1; then
  conflicted=()
  while IFS= read -r f; do conflicted+=("$f"); done < <(git diff --name-only --diff-filter=U | head -20)
  git rebase --abort > /dev/null 2>&1
  restore
  said="$(tail -n 5 "$dir/rebase.log" | tr '\n' ' ')"
  if [ "${#conflicted[@]}" -eq 0 ]; then
    # No file conflicted: git refused before replaying anything (a lock, a
    # dirty index), so it is no conflict to resolve. Git's own first
    # complaint says what to fix.
    why="$(grep -m 1 -E '^(error|fatal):' "$dir/rebase.log" | sed -E 's/^(error|fatal): //')"
    [ -n "$why" ] || why="$said"
    cast task comment $task_id "Rebasing $br onto $upstream could not start, so nothing of the change was tried and the branch is as it was. Git said: $(tr '\n' ' ' < "$dir/rebase.log") Fix that in the run's worktree $worktree; the rebase then has to run again." -t review > /dev/null
    answer false false "rebase could not start: $why"
    exit 1
  fi
  # The default branch changed these files after the branch forked, and one of
  # those commits may already carry the change, reworked after review (the
  # shared tree is committed while a change waits for its answer). Which side
  # holds what is for whoever resolves it to read, so the note names the
  # commits and asks to keep both sides, never to overwrite the default branch.
  where=""
  for f in "${conflicted[@]}"; do
    where="$where${where:+; }$f: $(git log --format='%h %s' "$fork..$upstream" -- "$f" | head -5 | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')"
  done
  names="${conflicted[*]}"
  cast task comment $task_id "Rebasing $br onto $upstream conflicted${names:+ in $names}. The branch is as it was before the rebase. $upstream changed those files after the branch forked ($where), and one of those commits may already carry part or all of this change, reworked after review. Rebase onto $upstream keeping both sides: drop the branch's side of a hunk only where $upstream already holds it, and never overwrite $upstream's own edits. Say on the task what $upstream already had. Then run the check and hand off again. Git said: $said" -t review > /dev/null
  answer false false "rebase onto $upstream conflicted${names:+ in $names} ($where)"
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
    restore
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
    restore
    answer false false "push of the rebased branch failed: $said"
    exit 2
  fi
fi
answer true false "on $upstream at $(git rev-parse --short HEAD)"
exit 0
