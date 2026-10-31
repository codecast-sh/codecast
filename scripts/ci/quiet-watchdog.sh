#!/usr/bin/env bash
# Runs a command and watches its output. When the output stands still for
# <quiet seconds>, the run is hung: the cli suite froze for the rest of its
# 30-minute job on most runs since Oct 24 (ct-71000), past bun's own test
# timeouts, with no line saying where. So the watchdog prints what every
# process is doing (the tree, each one's state and kernel wait, the test files
# and synchronous spawns in flight), then stops the command so the job fails now.
#
#   quiet-watchdog.sh <quiet seconds> -- <command...>
#
# Exits with the command's status, or 124 when it was stopped for being quiet.
set -u
quiet=$1
shift
[ "${1:-}" = "--" ] && shift
log=$(mktemp)
# Every synchronous spawn the tests make, as it starts and returns
# (packages/cli/src/test-helpers/spawnTrace.ts): the hang sat inside one.
export CODECAST_SPAWN_TRACE=$(mktemp)
trap 'rm -f "$log" "$CODECAST_SPAWN_TRACE"' EXIT

# The command writes straight into the log, a regular file, and tail streams
# it to the job. Through a pipe, bun 1.3.14 under --isolate registers fd 1 with
# epoll again for every test file's stdout and some file fails at load with
# "EEXIST: file already exists, epoll_ctl" (ct-71000). A regular file is never
# polled.
"$@" >> "$log" 2>&1 &
pid=$!
# A step's log on GitHub ends at the first line over 64 KiB: everything after
# it, results included, never reaches the job page. The ingest e2e tests print
# whole run outcomes on one line, so lines are capped before they reach it.
tail -n +1 -f --pid="$pid" "$log" | stdbuf -oL cut -c1-32000 &
tailpid=$!

# Lines of the trace ("<time> <pid> <what> <payload>") whose <what> is $1 and
# was not followed by $2 from the same pid, for pids that still exist.
in_flight() {
  awk -v begin="$1" -v end="$2" '$3==begin{s[$2]=$0} $3==end{delete s[$2]} END{for(p in s)print s[p]}' "$CODECAST_SPAWN_TRACE" 2>/dev/null |
    while read -r line; do
      set -- $line
      kill -0 "$2" 2>/dev/null && echo "$line" | cut -c1-300
    done
}

size=-1
still=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 15
  now=$(wc -c < "$log")
  if [ "$now" != "$size" ]; then size=$now; still=0; continue; fi
  still=$((still + 15))
  [ "$still" -lt "$quiet" ] && continue

  echo "::group::quiet-watchdog: no output for ${still}s, stopping the run"
  # Under --parallel a file's header and output reach the log only when the
  # file reports, so the log names finished files, never the hung one. The
  # spawn trace (spawnTrace.ts) holds one start and one end per test file and
  # per synchronous spawn from every worker; what started and has no end in a
  # process still alive is what is stuck.
  echo "test files started and not finished:"
  in_flight file-start file-done
  echo "synchronous spawns started and never returned:"
  in_flight start done
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
  # The first dump (Oct 26) found bun's main thread running, no wait and no
  # child, in a 27-line file. Its crash handler prints a bun.report link that
  # decodes to the native stack it was spinning in, so it gets a SIGSEGV first.
  for p in $(pgrep -x bun 2>/dev/null); do kill -SEGV "$p" 2>/dev/null; done
  sleep 5
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
  sleep 5
  pkill -KILL -P "$pid" 2>/dev/null
  kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  wait "$tailpid" 2>/dev/null
  exit 124
done
wait "$pid"
status=$?
wait "$tailpid" 2>/dev/null
exit "$status"
