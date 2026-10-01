# Which eval surfaces the branch touches since it left the default branch
# (LE8). Prints {"surfaces": "<ids, space separated>"}; empty when the repo
# has no ./evals. A failing ./evals stale fails the node, and the line sends
# that to the eval station rather than skipping it.
cd "$(cast ws path $worktree)" || exit 1
surfaces=""
if [ -x ./evals ]; then
  surfaces="$(./evals stale --base $default_branch --list)" || exit 1
fi
printf '{"surfaces": "%s"}\n' "$(printf '%s' "$surfaces" | tr '\n' ' ' | sed 's/ *$//')"
