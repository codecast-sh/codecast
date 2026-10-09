import { describe, expect, test } from "bun:test";
import { ProcessLineage } from "./processLineage.js";
import { reapTargets, type ProcRow } from "./processTable.js";
import type { ProcessInfo } from "./resourceMonitor.js";

// One machine, two moments. While the agent (claude, 300) lived, its tool shell
// (400) ran in a session of its own, and a `cast check` (500) it ran started a
// shared tsc watcher (600) the same way. Then claude restarted in its pane: the
// shell and the watcher are both orphans now, and only the shell is its work.
const T0 = Date.parse("Fri Oct  9 10:00:00 2026");
const at = (s: number) => T0 + s * 1000;
const info = (pid: number, ppid: number, pgid: number, tty: string, started: number, command: string): ProcessInfo =>
  ({ pid, ppid, pgid, tty, startedAt: started, cpu: 0, rss: 0, command });
const row = (pid: number, ppid: number, pgid: number, started: number, command: string): ProcRow => ({
  pid, ppid, pgid, uid: 501, command, startedAt: new Date(started).toString(), capturedAtMs: at(3600),
});

const before = new Map([
  info(200, 1, 200, "??", at(0), "tmux"),
  info(250, 200, 250, "ttys066", at(1), "-bash"),
  info(300, 250, 300, "ttys066", at(2), "/Users/x/.codecast/bin/claude"),
  info(400, 300, 400, "??", at(60), "/bin/bash"),
  info(450, 400, 400, "??", at(61), "tail"),
  info(500, 400, 400, "??", at(62), "bun"),
  info(600, 500, 600, "??", at(63), "bun"),
].map((p) => [p.pid, p]));

const isAgent = (p: ProcessInfo) => /claude$/.test(p.command ?? "");

describe("ProcessLineage + reapTargets", () => {
  const lineage = new ProcessLineage();
  lineage.observe(before, isAgent);

  // After the restart: claude 300 is gone, a new claude 310 runs in the pane.
  const after: ProcRow[] = [
    row(200, 1, 200, at(0), "tmux"),
    row(250, 200, 250, at(1), "-bash"),
    row(310, 250, 310, at(3000), "/Users/x/.codecast/bin/claude"),
    row(400, 1, 400, at(60), "/bin/bash -c source ~/.claude/shell-snapshots/x.sh"),
    row(450, 400, 400, at(61), "tail -f log"),
    row(600, 1, 600, at(63), "bun cast check-watch"),
  ];
  const kill = (procs: ProcRow[], roots: number[], selfPid = 99999) =>
    reapTargets(procs, roots, { selfPid, uid: 501, descendsFrom: (r, t) => lineage.descendsFrom(r, t) }).targets.map((t) => t.pid);

  test("an orphaned tool shell goes with the pane it was seen under, its children with it", () => {
    expect(kill(after, [250]).sort()).toEqual([250, 310, 400, 450]);
  });

  test("a service that detached on its own is never claimed", () => {
    expect(kill(after, [250])).not.toContain(600);
  });

  test("without the lineage the orphan escapes, which is the leak", () => {
    expect(reapTargets(after, [250], { selfPid: 99999 }).targets.map((t) => t.pid)).not.toContain(400);
  });

  test("a recycled pid is no one's", () => {
    const recycled = after.map((r) => (r.pid === 400 ? row(400, 1, 400, at(3500), "/bin/bash") : r));
    expect(kill(recycled, [250])).not.toContain(400);
  });

  test("a group whose leader is in the tree comes with it, even at ppid 1", () => {
    const procs = [
      row(700, 1, 700, at(0), "tmux"),
      row(710, 700, 710, at(1), "bash -c bun run dev | tee"),
      row(720, 1, 710, at(2), "next-server"),
      row(730, 720, 710, at(3), "node postcss.js"),
      row(740, 1, 740, at(4), "unrelated"),
    ];
    expect(reapTargets(procs, [700], { selfPid: 99999, spare: [700] }).targets.map((t) => t.pid).sort()).toEqual([710, 720, 730]);
  });

  test("this process, its ancestors and their groups are never targets", () => {
    const procs = [
      row(800, 1, 800, at(0), "tmux"),
      row(810, 800, 810, at(1), "-bash"),
      row(820, 810, 820, at(2), "bun daemon.ts"),
      row(830, 820, 810, at(3), "worker in the shell's group"),
      row(840, 810, 840, at(4), "sleep"),
    ];
    expect(reapTargets(procs, [800], { selfPid: 820 }).targets.map((t) => t.pid)).toEqual([840]);
  });
});
