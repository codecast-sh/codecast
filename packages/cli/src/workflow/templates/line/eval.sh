# The eval station (LE8): every surface the branch touches, replayed on the
# base and on the branch. The miss freezes prove named must fail on the base
# and pass on the branch; eval-result.json lands in the run's files for the
# card.
cd "$(cast ws path $worktree)" || exit 1
dir=$red.json.dir
set --
if [ -s "$dir/freezes.txt" ]; then
  while read -r freeze; do
    [ -n "$freeze" ] && set -- "$@" --freeze "$freeze"
  done < "$dir/freezes.txt"
fi
./evals line --base $default_branch --out "$dir/eval-result.json" "$@"
