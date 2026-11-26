# The Landed step (personal.cast): Land's own JSON, which Deploy reads, once
# origin's default branch is still at the landed commit. A newer commit landed
# on top since is never deployed over: the step says so instead ("moved"), and
# the run stops there. A push whose record failed (Land's exit 5) passes as it is.
# Origin it cannot read (a fetch that fails or hangs) is no proof that nothing
# landed on top: the step fails (exit 1), and the run stops without deploying.
sha="$land.json.sha"
if [ "$land.exit_code" != 5 ]; then
  git fetch -q origin "$default_branch" > "$run_dir/landed-fetch.log" 2>&1 & f=$!
  ( sleep 60 && kill -TERM "$f" ) > /dev/null 2>&1 & k=$!
  wait "$f"; code=$?
  kill "$k" > /dev/null 2>&1; wait "$k" 2> /dev/null
  if [ "$code" -ne 0 ]; then
    [ "$code" -eq 143 ] && echo "git fetch origin $default_branch did not finish in 60s" || echo "git fetch origin $default_branch failed: $(tail -n 2 "$run_dir/landed-fetch.log" | tr '\n' ' ')"
    exit 1
  fi
  now="$(git rev-parse "origin/$default_branch")"
  if [ "$now" != "$sha" ]; then
    if git merge-base --is-ancestor "$sha" "$now"; then
      note="A newer commit landed on top of ${sha:0:10}, so this run deploys nothing rather than an older commit over it. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one."
    else
      note="origin/$default_branch moved to ${now:0:10}, which no longer holds ${sha:0:10}, so this run deploys nothing."
    fi
    printf '{"outcome": "moved", "sha": "%s", "note": "%s"}\n' "$sha" "$note"
    exit 0
  fi
fi
echo "$land.output"
