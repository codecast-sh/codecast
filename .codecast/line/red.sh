# The prove station's check (LE8): the miss shows before anyone fixes it.
# Prints {"red", "dir", "why"} and always exits 0, so the edges route on the
# answer. The run's files are $run_dir, never committed.
cd "$(cast ws path $worktree)" || exit 1
dir=$run_dir
mkdir -p "$dir"
clean() { tail -c 300 "$1" 2>/dev/null | tr -d '\000-\037\\"'; }
answer() { printf '{"red": %s, "dir": "%s", "why": "%s"}\n' "$1" "$dir" "$2"; }
if [ $category = prompt ]; then
  # A prompt's miss is shown by the project's prove command (LP4): it exits 0
  # only when every miss moment fails on the base and every guard passes.
  cmd=$line.commands.prove
  if [ -z "$cmd" ]; then
    cast task comment $task_id "This project's line profile names no prove command, so the prove station passed without showing the miss." -t progress
    answer true "no prove command; passed with a note"
    exit 0
  fi
  # The miss is shown on the base. A rerun reattaches this cause's branch with
  # the last round's commits on it, so the run's own worktree goes to the
  # merge base for the check and comes back to the branch after.
  # It always returns to the run's branch, even when an earlier station left
  # the worktree detached: returning to "wherever HEAD was" would leave it on
  # the base and send the builder to work there.
  home=$branch
  # The base is where the branch leaves the default branch as the remote has
  # it: a checkout's local copy can lag the remote by many commits, and the
  # project's prove command measures from the remote too.
  upstream=$default_branch
  git rev-parse --verify --quiet "origin/$default_branch" >/dev/null && upstream="origin/$default_branch"
  base="$(git merge-base "$home" $upstream 2>/dev/null)"
  if [ -n "$base" ] && [ "$(git rev-parse HEAD)" != "$base" ]; then
    [ -z "$(git status --porcelain --untracked-files=no)" ] || { answer false "the worktree has uncommitted changes, so it cannot go to the base to show the miss"; exit 0; }
    git checkout -q --detach "$base" || { answer false "could not check out the base $base"; exit 0; }
  fi
  trap 'git checkout -q "$home"' EXIT
  if bash -c "$cmd" > "$dir/prove.log" 2>&1; then
    answer true "the prove command shows the miss on the base"
  else
    answer false "the prove command did not show the miss on the base: $(clean "$dir/prove.log")"
  fi
  exit 0
fi
# A change to the line itself (line-map.md LX6) is shown on the line's own
# recorded runs, which the prove station names in its comment; there is no
# command to rerun, so the station passes with that note.
if [ $category = line ]; then
  answer true "a line cause: the prove comment names the recorded runs that show it"
  exit 0
fi
[ -f "$dir/repro.sh" ] || { answer false "no repro.sh"; exit 0; }
if bash "$dir/repro.sh" > "$dir/red.log" 2>&1; then
  answer false "repro.sh passes before any fix, so it does not show the miss"
else
  answer true "repro.sh fails"
fi
