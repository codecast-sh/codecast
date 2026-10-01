# The prove station's check (LE8): the miss shows before anyone fixes it.
# Prints {"red", "dir", "why"} and always exits 0, so the edges route on the
# answer. dir is the run's files, inside git's own directory for this
# worktree, so nothing there is ever committed; later stations read it as
# $red.json.dir.
cd "$(cast ws path $worktree)" || exit 1
dir="$(git rev-parse --absolute-git-dir)/cast-line"
mkdir -p "$dir"
answer() { printf '{"red": %s, "dir": "%s", "why": "%s"}\n' "$1" "$dir" "$2"; }
if [ $category = prompt ]; then
  # A prompt's miss is shown by its freezes failing on the base; the eval
  # station replays them on both sides and fails a freeze that already passes.
  if [ -s "$dir/freezes.txt" ]; then answer true "miss freezes listed"; else answer false "no freezes.txt naming the miss freezes"; fi
  exit 0
fi
[ -f "$dir/repro.sh" ] || { answer false "no repro.sh"; exit 0; }
if bash "$dir/repro.sh" > "$dir/red.log" 2>&1; then
  answer false "repro.sh passes before any fix, so it does not show the miss"
else
  answer true "repro.sh fails"
fi
