# The round station (personal.cast): puts the change onto origin's default
# branch as it is now, in the run's worktree, so the check and the reviewer
# judge exactly what Land pushes. Prints round.json: a fresh nonce for the
# round, the head it made, the main it sits on, and the Verdicts visit at
# which this round's reviewer may still be asked again.
#   exit 0: on origin's default branch
#   exit 1: the rebase conflicted; the branch is as it was
#   exit 2: no worktree here, no origin to fetch, or git refused to rebase
#   exit 4: nothing of the change is left above origin's default branch (the
#           session dropped it, or put it there itself): the run stops
# The person's checkout: the directory the station starts in, a linked worktree included.
root="$(git rev-parse --show-toplevel)"
dir=$run_dir
base=$default_branch
mkdir -p "$dir"
rm -f "$dir/round.json"

wt="$(cast ws path $worktree 2>/dev/null)"
if [ -z "$wt" ] || ! cd "$wt" 2>/dev/null; then
  echo "The run's worktree $worktree is not on this machine."
  exit 2
fi
if ! git fetch -q origin "$base" > "$dir/round-fetch.log" 2>&1; then
  echo "git fetch origin $base failed: $(tail -n 3 "$dir/round-fetch.log" | tr '\n' ' ')"
  exit 2
fi
main="$(git rev-parse "origin/$base")"
# The worktree is the change and nothing else: whatever a station left in it goes before the rebase.
git reset -q --hard && git clean -q -fd
# The person's checkout as the run began, once a run: a commit made there after it is the session's (after_fix.sh).
[ -s "$dir/checkout-$run_id" ] || git -C "$root" rev-parse HEAD > "$dir/checkout-$run_id" 2>/dev/null
if ! git rebase "origin/$base" > "$dir/round-rebase.log" 2>&1; then
  conflicted="$(git diff --name-only --diff-filter=U | head -20 | tr '\n' ' ')"
  git rebase --abort > /dev/null 2>&1
  if [ -z "$conflicted" ]; then
    echo "git would not rebase the change onto origin/$base: $(grep -m 1 -E '^(error|fatal):' "$dir/round-rebase.log")"
    exit 2
  fi
  echo "Rebasing the change onto origin/$base (${main:0:10}) conflicted in: $conflicted"
  echo "origin/$base changed those files since the change was made: $(git log --format='%h %s' "HEAD..origin/$base" -- $conflicted | head -5 | tr '\n' ';')"
  exit 1
fi
head="$(git rev-parse HEAD)"
# The worktree now holds the change on this main: record that as the change as last frozen, which the run's refreeze
# checks the worktree against. change.json is written by writeFrozenChange, one key per line.
sed -i.bak -E "s/^(  \"tip\": )\"[0-9a-f]*\"/\1\"$head\"/; s/^(  \"base\": )\"[0-9a-f]*\"/\1\"$main\"/" "$dir/change.json" && rm -f "$dir/change.json.bak"
if [ "$head" = "$main" ]; then
  echo "Nothing of the change is above origin/$base (${main:0:10}): it is there already."
  exit 4
fi
nonce="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
[ -n "$nonce" ] || nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
seen="$verdicts.visits"
printf '{"round": "%s", "head_sha": "%s", "main_sha": "%s", "verdicts_at": %d}\n' "$nonce" "$head" "$main" "$((seen + 1))" | tee "$dir/round.json"
