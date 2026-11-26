# The After the fix station (personal.cast): what the session's deploy fix
# left, read from git alone. Deploy runs again from the landed commit only when
# the frozen change holds no commit the landed one lacks (the fix lived outside
# the repository, or nothing changed), origin's default branch is still the
# landed commit, and, for a change of the session's own edits, the person's
# checkout holds no commit origin lacks. A change with something new comes
# round to be checked, reviewed and landed. Prints {"next", "note"}:
#   deploy:   Deploy again from the landed commit (the worktree goes back to it)
#   round:    the fix is in the change
#   unpushed: the fix is committed in the person's checkout, which this run cannot take
#   moved:    origin moved past the landed commit by a push this run did not make
# Run as the `committed` station, after a brief whose change could not be frozen again, it reads only whether the
# session committed its fix in the person's checkout (unpushed), and otherwise fails with the freeze's own error.
# The person's checkout: the directory the station starts in, a linked worktree included.
root="$(git rev-parse --show-toplevel)"
dir=$run_dir
base=$default_branch
landed="$landed.json.sha"
clean() { printf '%s' "$1" | tr -d '\000-\037\\"'; }
say() { printf '{"next": "%s", "note": "%s"}\n' "$1" "$(clean "$2")"; exit 0; }
wt="$(cast ws path $worktree 2>/dev/null)"
if [ -z "$wt" ] || ! cd "$wt" 2>/dev/null; then
  echo "The run's worktree $worktree is not on this machine."
  exit 2
fi
git fetch -q origin "$base" > "$dir/after-fix-fetch.log" 2>&1 || { echo "git fetch origin $base failed: $(tail -n 2 "$dir/after-fix-fetch.log" | tr '\n' ' ')"; exit 2; }
now="$(git rev-parse "origin/$base")"
# The session's own edits ship uncommitted: a commit it made in the person's checkout is one this run cannot take.
unpushed() {
  local ahead
  grep -qE '"source": "(session|checkout)"' "$dir/change.json" 2>/dev/null || return 0
  # Only commits made since the run began (round.sh records the checkout's HEAD): the person's own earlier ones are not the fix.
  since="$(cat "$dir/checkout-$run_id" 2>/dev/null)"
  ahead="$(git -C "$root" rev-list --count "origin/$base..HEAD" ${since:+"^$since"} 2>/dev/null || echo 0)"
  [ "$ahead" -gt 0 ] || return 0
  # Back to where they start: the run's baseline, or what origin holds of the checkout when that is later (a landing
  # the checkout caught up to), so the reset uncommits only them.
  local back mb
  if [ -n "$since" ]; then
    mb="$(git -C "$root" merge-base HEAD "origin/$base" 2>/dev/null)"
    back="$since"
    [ -n "$mb" ] && git -C "$root" merge-base --is-ancestor "$since" "$mb" 2>/dev/null && back="$mb"
    back="\`git reset --soft ${back:0:12}\`"
  else
    back="\`git reset --soft origin/$base\`; this also uncommits any earlier unpushed commits"
  fi
  say unpushed "$ahead commit(s) made in your checkout since this run began that origin/$base lacks. This run ships uncommitted edits only, so it can't take them, and it $1. To ship them, turn them back into uncommitted edits ($back) and Ship again."
  return 0
}
if [ "$station_id" = committed ]; then
  unpushed "landed and deployed nothing of them"
  echo "$last_error"
  exit 1
fi
# The change holds something new when merging it into the landed commit changes the landed tree (or cannot merge).
merged="$(git merge-tree --write-tree "$landed" HEAD 2>/dev/null | head -n 1)"
[ -n "$merged" ] && [ "$merged" = "$(git rev-parse "$landed^{tree}")" ] || say round "the fix is in the change: it is checked, reviewed and landed before Deploy runs again"
unpushed "deployed nothing more"
if [ "$now" != "$landed" ]; then
  git merge-base --is-ancestor "$landed" "$now" && say moved "A newer commit landed on top of ${landed:0:10}, so this run deploys nothing rather than an older commit over it. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one."
  say moved "origin/$base moved to ${now:0:10}, which no longer holds ${landed:0:10}, so this run deploys nothing."
fi
git reset -q --hard "$landed" && git clean -q -fd || exit 2
say deploy "the fix left nothing new to land: Deploy runs again from ${landed:0:10}"
