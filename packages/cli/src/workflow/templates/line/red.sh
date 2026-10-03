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
  home="$(git rev-parse --abbrev-ref HEAD)"
  base="$(git merge-base HEAD $default_branch 2>/dev/null)"
  if [ -n "$base" ] && [ "$(git rev-parse HEAD)" != "$base" ]; then
    [ -z "$(git status --porcelain --untracked-files=no)" ] || { answer false "the worktree has uncommitted changes, so it cannot go to the base to show the miss"; exit 0; }
    trap 'git checkout -q "$home"' EXIT
    git checkout -q --detach "$base" || { answer false "could not check out the base $base"; exit 0; }
  fi
  if bash -c "$cmd" > "$dir/prove.log" 2>&1; then
    answer true "the prove command shows the miss on the base"
  else
    answer false "the prove command did not show the miss on the base: $(clean "$dir/prove.log")"
  fi
  exit 0
fi
[ -f "$dir/repro.sh" ] || { answer false "no repro.sh"; exit 0; }
if bash "$dir/repro.sh" > "$dir/red.log" 2>&1; then
  answer false "repro.sh passes before any fix, so it does not show the miss"
else
  answer true "repro.sh fails"
fi
