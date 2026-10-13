import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    reapTargets(procs, roots, { selfPid, uid: 501, descendsFrom: (r, t, table) => lineage.descendsFrom(r, t, table) }).targets.map((t) => t.pid);

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

  test("a daemon restart keeps what the lineage knew", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-"));
    const file = path.join(dir, "process-lineage.json");
    await lineage.save(file);
    const restarted = ProcessLineage.load(file);
    const killAfterRestart = reapTargets(after, [250], { selfPid: 99999, uid: 501, descendsFrom: (r, t, table) => restarted.descendsFrom(r, t, table) }).targets.map((t) => t.pid);
    expect(killAfterRestart.sort()).toEqual([250, 310, 400, 450]);
    expect(killAfterRestart).not.toContain(600);
    // A missing or unreadable file is an empty lineage, never a throw.
    fs.writeFileSync(file, "{not json");
    expect(ProcessLineage.load(file).size).toBe(0);
    expect(ProcessLineage.load(path.join(dir, "absent.json")).size).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
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

// A background tool shell (`npm run dev`, 400) was seen under the agent with
// npm (410) in its group. Between two samples npm forked the server (420), and
// then the shell, npm and the agent all exited. The server was never seen under
// anyone; what it kept is the shell's group.
describe("a group outlives the members the lineage saw", () => {
  const seen = new Map([
    info(200, 1, 200, "??", at(0), "tmux"),
    info(250, 200, 250, "ttys066", at(1), "-bash"),
    info(300, 250, 300, "ttys066", at(2), "/Users/x/.codecast/bin/claude"),
    info(400, 300, 400, "??", at(60), "/bin/bash"),
    info(410, 400, 400, "??", at(61), "npm"),
  ].map((p) => [p.pid, p]));
  const lineage = new ProcessLineage();
  lineage.observe(seen, isAgent);
  const pane = [row(200, 1, 200, at(0), "tmux"), row(250, 200, 250, at(1), "-bash")];
  const kill = (procs: ProcRow[], l = lineage, selfPid = 99999) =>
    reapTargets(procs, [250], { selfPid, uid: 501, descendsFrom: (r, t, table) => l.descendsFrom(r, t, table) }).targets.map((t) => t.pid);

  test("a member born after the last sample goes with the group's owner", () => {
    expect(kill([...pane, row(420, 1, 400, at(70), "next-server")])).toContain(420);
  });

  test("the group survives a restart too", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-"));
    await lineage.save(path.join(dir, "l.json"));
    expect(kill([...pane, row(420, 1, 400, at(70), "next-server")], ProcessLineage.load(path.join(dir, "l.json")))).toContain(420);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a group id whose pid now leads something else is no one's", () => {
    // pid 400 alive again as a new program means group 400 emptied once.
    expect(kill([...pane, row(400, 1, 400, at(900), "other"), row(420, 1, 400, at(901), "child")])).toEqual([250]);
  });

  test("a group the lineage forgot (no member left in a sample) is no one's", () => {
    const l = new ProcessLineage();
    l.observe(seen, isAgent);
    l.observe(new Map([info(200, 1, 200, "??", at(0), "tmux"), info(250, 200, 250, "ttys066", at(1), "-bash")].map((p) => [p.pid, p])), isAgent);
    expect(kill([...pane, row(420, 1, 400, at(70), "next-server")], l)).toEqual([250]);
  });
});

describe("terminals", () => {
  const ttyRow = (pid: number, ppid: number, pgid: number, tty: string, command: string): ProcRow => ({ ...row(pid, ppid, pgid, at(pid), command), tty });
  const procs = [
    ttyRow(200, 1, 200, "??", "tmux"),
    ttyRow(250, 200, 250, "16/66", "-bash"),
    ttyRow(260, 1, 255, "16/66", "next-server"), // leader 255 gone
    ttyRow(270, 1, 270, "??", "bun cast check-watch"), // setsid: no terminal
    ttyRow(280, 1, 280, "16/67", "another pane's job"),
  ];

  test("whatever is on a terminal the session owns goes with it", () => {
    expect(reapTargets(procs, [250], { selfPid: 99999, terminals: ["16/66"] }).targets.map((t) => t.pid).sort()).toEqual([250, 260]);
  });

  test("a terminal this process sits on is never claimed", () => {
    // A daemon started from the pane, reparented but still on its terminal.
    const withSelf = [...procs, ttyRow(290, 1, 290, "16/66", "bun daemon.ts"), ttyRow(295, 290, 290, "16/66", "daemon worker")];
    expect(reapTargets(withSelf, [250], { selfPid: 290, terminals: ["16/66"] }).targets.map((t) => t.pid)).toEqual([250]);
  });

  test("no terminal is not a terminal", () => {
    expect(reapTargets(procs, [250], { selfPid: 99999, terminals: ["??", "?", "-"] }).targets.map((t) => t.pid)).toEqual([250]);
  });
});
