# The rebase station (the-line.md L12): a card waits hours for its answer and
# the default branch moves under it, so a Ship answer first puts the branch on
# the default branch as the remote has it and runs the project's check on what
# that makes. Prints {"rebased", "landed", "why"}.
#   exit 0: on the default branch and checked, or nothing of the change is left
#           on the branch because it is already there (landed: true, the run
#           goes to watch rather than shipping it twice)
#   exit 1: the rebase conflicted or the check failed on the rebased branch;
#           what happened goes on the task and the run goes back to implement
#   exit 2: no worktree here, or the default branch could not be fetched; ship
#           decides on the branch as it is
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

if ! git rebase --autostash "$upstream" > "$dir/rebase.log" 2>&1; then
  files="$(git diff --name-only --diff-filter=U | head -20 | tr '\n' ' ')"
  git rebase --abort > /dev/null 2>&1
  said="$(tail -n 5 "$dir/rebase.log" | tr '\n' ' ')"
  cast task comment $task_id "Shipping stopped: rebasing $br onto $upstream conflicted${files:+ in $files}. The branch is as it was before the rebase. Rebase it onto $upstream, resolve the conflict keeping the approved change, run the check, and hand off again. Git said: $said" -t review > /dev/null
  answer false false "rebase onto $upstream conflicted${files:+ in $files}"
  exit 1
fi

if [ "$(git rev-list --count "$upstream..HEAD")" = 0 ]; then
  # Every commit of the change is already on the default branch: it landed
  # another way (git drops a commit whose patch is already upstream). Where:
  # the first commit after the fork whose every file the change touched reads
  # as the change left it, which finds a hand landing that carried more too.
  fork="$(git merge-base "$was" "$upstream")"
  touched="$(git diff --name-only "$fork" "$was")"
  landed="$(git log --reverse --format=%H "$fork..$upstream" -- $touched | while read -r c; do
    same=1
    for f in $touched; do [ "$(git rev-parse -q --verify "$c:$f")" = "$(git rev-parse -q --verify "$was:$f")" ] || { same=0; break; }; done
    [ "$same" = 1 ] && { echo "$c"; break; }
  done)"
  cast task comment $task_id "Already on $target${landed:+ as ${landed:0:10}}: nothing of $br is left to ship, so the line goes on to watch." -t progress > /dev/null
  answer true true "already on $upstream${landed:+ as ${landed:0:10}}"
  exit 0
fi

if [ "$(git rev-parse HEAD)" != "$was" ]; then
  # The base moved: the approved change is checked again on what it now sits on.
  cmd=$line.commands.check
  if [ -n "$cmd" ] && ! bash -c "$cmd" > "$dir/rebase-check.log" 2>&1; then
    said="$(tail -n 30 "$dir/rebase-check.log")"
    git reset -q --keep "$was"
    cast task comment $task_id "Shipping stopped: after rebasing $br onto $upstream the project's check fails, so the change no longer fits the default branch as it is now. The branch is as it was before the rebase. Rebase it, make the check pass, and hand off again. The check said:
$said" -t review > /dev/null
    answer true false "the check fails on the branch rebased onto $upstream"
    exit 1
  fi
  # The branch on the remote is the one the ship command lands; it follows the rebase.
  git push -q --force-with-lease origin "HEAD:$br" > /dev/null 2>&1
fi
answer true false "on $upstream at $(git rev-parse --short HEAD)"
exit 0
