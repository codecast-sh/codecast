# The Land station (personal.cast): pushes the commit the round checked and
# the reviewer passed to origin's default branch, records it as the run's
# merge ($run_dir/merge.json), and brings the person's checkout up to it when
# that checkout is on the default branch. The run's worktree stays at the
# landed commit, where Deploy runs. Prints {"outcome", "sha", "note"} alone
# on stdout.
# Once the push succeeds ($run_dir/land-pushed-<run> names the head), nothing
# after it fails Land as "not landed": a record that fails or hangs is exit 5,
# and a checkout that does not catch up is only a note. A Land run again on a
# head origin already holds (a push whose answer was lost, a Land cut off and run
# again) goes straight to recording, but only when this run set out to push that
# head ($run_dir/land-pushing-<run>, written before the push): the session pushing
# the change itself while Check and Review ran left the run (exit 4).
# After the push the worktree is the landed commit exactly, with nothing a
# station left in it, since Deploy runs there.
# Its "moves" counts the rounds main moved under since the last landing, in
# this attempt: a resume, which starts Land's visits again, starts it again too.
#   exit 0: landed
#   exit 3: main moved since the round, or the change did: a new round
#   exit 5: pushed, but recording the landing on the run failed
#   exit 4: the head is on origin, and this run never pushed it: the change left the run
#   exit 6: the push's answer was lost and origin could not be read: whether it landed is unknown
#   exit 1: not landed, and why
# The person's checkout: the directory the station starts in, a linked worktree included.
root="$(git rev-parse --show-toplevel)"
dir=$run_dir
base=$default_branch
head="$round.json.head_sha"
main="$round.json.main_sha"
pushed="$dir/land-pushed-$run_id"
pushing="$dir/land-pushing-$run_id"
moves="$dir/land-moves-$run_id"
# Every network step is cut off, so Land ends itself and says what it knows before the station's own timeout
# (personal.cast): fetches 60s, the push 180s, the record 300s. The catch-up is never cut off: it moves the branch
# last (--ref-last), so even a kill of the station leaves at worst some of its files written with HEAD where it was,
# which running it again finishes.
mkdir -p "$dir"
# A note as a JSON string: control characters dropped, backslashes and quotes escaped (a quoted path keeps its quoting).
clean() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
# The note is cut (before escaping, so no escape is split) to keep the JSON well under the 800 characters the run's
# view shows of a station whole.
say() { printf '{"outcome": "%s", "sha": "%s", "note": "%s"}\n' "$1" "$2" "$(clean "$(printf '%s' "$3" | cut -c 1-600)")"; }
# A move: one more round main moved under since the last landing, in the JSON the graph reads.
moved() {
  local at=0 n=0 v="$land.visits"
  { read -r at n < "$moves"; } 2> /dev/null
  # Counted in Land's visits of this attempt: a count from more visits than this one is from before a resume.
  { [ -n "$n" ] && [ "${at:-0}" -lt "$v" ]; } || n=0
  n=$(( n + 1 ))
  echo "$v $n" > "$moves"
  printf '{"outcome": "moved", "sha": "", "moves": %d, "note": "%s"}\n' "$n" "$(clean "$(printf '%s' "$1" | cut -c 1-600)")"
  exit 3
}
# A command that may hang, cut off after $1 seconds.
within() {
  local secs=$1; shift
  "$@" & local p=$!
  ( sleep "$secs" && kill -TERM "$p" ) > /dev/null 2>&1 &
  local k=$!
  wait "$p"; local c=$?
  kill "$k" > /dev/null 2>&1; wait "$k" 2> /dev/null
  return $c
}

# A Land that set out to push this head (a resume after a lost answer) and cannot look again cannot tell whether it landed.
cannot_tell() {
  [ "$(cat "$pushing" 2> /dev/null)" = "$head" ] || return 0
  say unknown "$head" "the push of ${head:0:10} to origin/$base may have landed, and $1"
  exit 6
}
wt="$(cast ws path $worktree 2>/dev/null)"
if [ -z "$wt" ] || ! cd "$wt" 2>/dev/null; then
  cannot_tell "the run's worktree $worktree is not on this machine to check"
  say failed "" "the run's worktree $worktree is not on this machine"
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$head" ]; then
  moved "the change moved since the round checked ${head:0:10}"
fi
within 60 git fetch -q origin "$base" > "$dir/land-fetch.log" 2>&1; code=$?
if [ "$code" -ne 0 ]; then
  said="$(tail -n 3 "$dir/land-fetch.log" | tr '\n' ' ')"
  [ "$code" -eq 143 ] && said="it did not finish in 60s"
  cannot_tell "origin could not be read to check: $said"
  say failed "" "git fetch origin $base failed: $said"
  exit 1
fi
now="$(git rev-parse "origin/$base")"
if git merge-base --is-ancestor "$head" "$now"; then
  # Already on origin: this run's push, when it set out to push this head; else someone else put it there.
  if [ "$(cat "$pushing" 2>/dev/null)" != "$head" ]; then
    say left "" "${head:0:10} reached origin/$base by a push this run did not make"
    exit 4
  fi
else
  [ "$now" = "$main" ] || moved "$base moved to ${now:0:10} since the round put the change on ${main:0:10}"
  printf '%s\n' "$head" > "$pushing"
  within 180 git push -q origin "$head:refs/heads/$base" > "$dir/land-push.log" 2>&1; code=$?
  if [ "$code" -ne 0 ]; then
    said="$(tail -n 3 "$dir/land-push.log" | tr '\n' ' ')"
    [ "$code" -eq 143 ] && said="it did not finish in 180s"
    # Only a push main moved under; a remote that refused it ([remote rejected], a protected branch) is no new round.
    [ "$code" -ne 143 ] && grep -qE '\[rejected\]|non-fast-forward|fetch first|stale info' "$dir/land-push.log" && { rm -f "$pushing"; moved "origin refused the push because $base moved: $said"; }
    # A push can land on origin and lose its answer (a dropped connection, or one cut off): origin holding the head is the fact.
    if ! within 60 git fetch -q origin "$base" > /dev/null 2>&1; then
      say unknown "$head" "the push of ${head:0:10} to origin/$base may have landed: its answer was lost ($said), and origin could not be read to check"
      exit 6
    fi
    if ! git merge-base --is-ancestor "$head" "origin/$base"; then
      # A push cut off may still complete on origin after this look: only a push that answered is known to have failed.
      if [ "$code" -eq 143 ]; then
        say unknown "$head" "the push of ${head:0:10} to origin/$base was cut off ($said) and is not on origin yet, but may still land"
        exit 6
      fi
      rm -f "$pushing"
      say failed "" "git push origin $base failed: $said"
      exit 1
    fi
  fi
fi
printf '%s\n' "$head" > "$pushed"
git reset -q --hard "$head" && git clean -q -fd
rm -f "$moves"
# What origin holds now is the fact: the commit that carries the change, as the run's merge.
within 300 cast flow landed --branch "$head" --as "$branch" --base "$base" --since "$main" --out "$dir/merge.json" --run "$run_id" > "$dir/land-landed.log" 2>&1; code=$?
if [ "$code" -ne 0 ]; then
  said="$(tail -n 1 "$dir/land-landed.log")"
  [ "$code" -eq 143 ] && said="it did not finish in 300s"
  say unrecorded "$head" "the push to origin/$base succeeded at ${head:0:10}, but recording it on the run failed: $said"
  exit 5
fi
what="pushed $base at ${head:0:10}"

# The person's checkout follows, only when it is on the default branch; `cast land level` keeps every local edit.
on="$(git -C "$root" symbolic-ref -q --short HEAD)"
if [ "$on" != "$base" ]; then
  note="$what; $root is on ${on:-a detached HEAD}, not $base, so it was left as it is"
else
  # Never cut off, and the branch moves last (--ref-last): see above. A commit the person makes meanwhile wins, and
  # level puts back everything it wrote; its own words say so.
  level="$(cd "$root" && cast land level --checkout "$root" --to "$head" --ref-last 2>&1)"
  code=$?
  # Its reason and the files it names, cut so the whole note fits what the run's view shows of a station.
  level="$(printf '%s\n' "$level" | grep -v '^[[:space:]]*$' | sed -e 's/^[[:space:]]*//' | tr '\n' ' ' | sed -e 's/ *$//' | cut -c 1-240)"
  if [ "$code" -eq 0 ]; then
    note="$what; caught up $root"
  else
    status="$(git -C "$root" status --short --branch 2> /dev/null | head -n 6 | tr '\n' ';' | cut -c 1-120)"
    note="Run \`cd $(printf %q "$root") && cast land level --checkout . --to ${head:0:12} --ref-last\` to finish catching up the checkout once what level said is dealt with; it keeps every edit of yours. $what; $root was not caught up: $level. git status there: $status"
  fi
fi
say landed "$head" "$note"
exit 0
