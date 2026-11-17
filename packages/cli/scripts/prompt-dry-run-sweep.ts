// Whatever a run left running dies with it: the watchdog that outlives a
// killed harness, and the sweep that finds a rep's processes by tag and cwd.
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ctx } from "./prompt-dry-run-context.ts";

// After the group, every process carrying the run's tag ($3) or standing in the run dir ($4): what left the group (setsid, nohup) dies too (runPids).
export const WATCHDOG = 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; kill -TERM -"$2" 2>/dev/null; sleep 5; kill -KILL -"$2" 2>/dev/null; { /bin/ps -xEwwo pid=,command= | awk -v t="DRY_RUN_TAG=$3" \'index($0, t) { print $1 }\'; /usr/sbin/lsof -a -d cwd -u "$(id -u)" -Fpn | awk -v r="$4" \'/^p/ { p = substr($0, 2) } /^n/ { n = substr($0, 2); if (n == r || index(n, r "/") == 1) print p }\'; } | grep -vx "$$" | xargs kill -KILL 2>/dev/null';

/**
 * Every process the rep left running, the harness's own excepted, found two
 * ways because each misses what the other sees: the run's tag in its
 * environment (macOS hides the environment of its own system binaries, so a
 * detached /bin/sleep or perl shows no tag), and a working directory inside
 * the run dir (lsof), which any binary keeps unless it moves. A system binary
 * that detaches and leaves the run dir outlives the sweep, still inside the
 * sandbox: it cannot listen, write outside the run dir or reach anything, and
 * the harness's loopback ports close when the harness exits.
 */
function runPids(): number[] {
  const { RUN_TAG, runDir } = ctx();
  return pidsOf(RUN_TAG, runDir);
}
export function pidsOf(tag: string, dir: string): number[] {
  // -x: a process that left its session (setsid) has no controlling terminal, and ps lists none of those without it.
  const tagged = (spawnSync("/bin/ps", ["-xEwwo", "pid=,command="], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? "").split("\n").filter((l) => l.includes(`DRY_RUN_TAG=${tag}`)).map((l) => Number(l.trim().split(/\s+/, 1)[0]));
  const run = fs.realpathSync(dir);
  const inRun: number[] = [];
  let pid = 0;
  for (const l of (spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-u", String(process.getuid?.() ?? ""), "-Fpn"], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "").split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && (l.slice(1) === run || l.slice(1).startsWith(`${run}/`))) inRun.push(pid);
  }
  return [...new Set([...tagged, ...inRun])].filter((p) => p && p !== process.pid);
}
/** Kills everything the run started, a process that left the agent's group (setsid, nohup, a tmux server) included. */
export function sweepRun(): number {
  const { fakeBin, fakeDir, RUN_TAG } = ctx();
  // The fake's calls carry the run's tag and stand in fakeDir, beside the run dir rather than in it.
  const pids = [...new Set([...runPids(), ...(fakeBin && fs.existsSync(fakeDir) ? pidsOf(RUN_TAG, fakeDir) : [])])];
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return pids.length;
}
