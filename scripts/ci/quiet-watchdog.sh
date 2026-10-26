#!/usr/bin/env bash
# Runs a command and watches its output. When the output stands still for
# <quiet seconds>, the run is hung: the cli suite froze for the rest of its
# 30-minute job on most runs since Oct 24 (ct-71000), past bun's own test
# timeouts, with no line saying where. So the watchdog prints what every
# process is doing (the tree, each one's state and kernel wait, the test file
# that was running), then stops the command so the job fails now.
#
#   quiet-watchdog.sh <quiet seconds> -- <command...>
#
# Exits with the command's status, or 124 when it was stopped for being quiet.
set -u
quiet=$1
shift
[ "${1:-}" = "--" ] && shift
log=$(mktemp)
trap 'rm -f "$log"' EXIT

"$@" > >(tee -a "$log") 2>&1 &
pid=$!

size=-1
still=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 15
  now=$(wc -c < "$log")
  if [ "$now" != "$size" ]; then size=$now; still=0; continue; fi
  still=$((still + 15))
  [ "$still" -lt "$quiet" ] && continue

  echo "::group::quiet-watchdog: no output for ${still}s, stopping the run"
  echo "last test file: $(grep -aoE 'src/[^ ]+\.test\.tsx?' "$log" | tail -1)"
  ps -eo pid,ppid,pgid,stat,etimes,wchan:32,args --forest 2>/dev/null | grep -v ' ps -eo ' | cut -c1-220
  for p in $(pgrep -f 'bun|tmux|node|git' 2>/dev/null); do
    [ -d "/proc/$p" ] || continue
    echo "--- $p $(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-160)"
    grep -E '^(State|Threads):' "/proc/$p/status" 2>/dev/null | tr '\n' ' '
    echo
    for t in /proc/"$p"/task/*; do echo "$(cat "$t/comm" 2>/dev/null) $(cat "$t/wchan" 2>/dev/null)"; done | sort | uniq -c
    sudo -n cat "/proc/$p/stack" 2>/dev/null | head -12
  done
  echo "::endgroup::"
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
  sleep 5
  pkill -KILL -P "$pid" 2>/dev/null
  kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  exit 124
done
wait "$pid"
