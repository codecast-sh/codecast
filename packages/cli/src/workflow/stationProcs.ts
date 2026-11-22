// Ending a station's processes, all of them. A station's script runs in a
// process group of its own (commandStation.ts), but a group is not a fence: a
// script that turns on job control (`set -m`) or calls setsid puts its children
// in groups of their own, and a kill sent to the station's group misses them.
// Union's proof-tree.sh runs its command that way; when the station's group was
// killed, the command was left under init, spinning at 84% CPU for 36 hours
// (Nov 20). So a station's processes are its group's whole tree
// (processGroupTree), read while the tree is still linked, then ended TERM
// first and KILL after a grace by killProcessTree, which KILLs only a process
// the table still identifies as the one it read (ct-49537).
//
// The contract this gives a station: one cut off (its timeout, a cancel on the
// web, its runner stopping or dying) ends everything it started, helpers it
// launched detached (setsid, `set -m`, nohup) included. A helper meant to
// outlive the station (a watcher, a dev server) is started outside it, as a
// launchd job or a service of its own. Only a script that ends on its own
// leaves running what it moved out of its group (endGroupLeftovers).
//
// A runner that dies by SIGKILL runs nothing on its way out, so each runner
// keeps the processes of its running stations on disk, and the next station
// any runner starts ends those a dead runner left that it can still prove are
// the same processes (reapDeadRunnerStations).

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "../proc.js";
import { codecastPath } from "../codecastDir.js";
import { isPidAlive } from "../workspace/chrome.js";
import { bornBeforeCaptureSecond, killProcessTree, processGroupTree, snapshotProcessTable, snapshotProcessTableAsync, type ProcRow } from "../processTable.js";

/** How long a station's processes have between TERM and KILL. */
export const STATION_KILL_GRACE_MS = 10_000;

const PS_TIMEOUT_MS = 15_000;
const groupAlive = (group: number): boolean => {
  try { process.kill(-group, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const uniqueRows = (rows: ProcRow[]): ProcRow[] => [...new Map(rows.map((r) => [r.pid, r])).values()];

// A start time read in the second it printed cannot tell a process from the
// next one to take its pid, so killProcessTree never KILLs such a row
// (bornBeforeCaptureSecond). A station cut off in its first second would keep
// its TERM-ignoring processes, so the table is read again once that second is over.
const msUntilProvable = (rows: ProcRow[]): number => (rows.every(bornBeforeCaptureSecond) ? 0 : 1_050 - (Date.now() % 1_000));

async function readTree(pick: (procs: ProcRow[]) => ProcRow[]): Promise<ProcRow[]> {
  const rows = pick(await snapshotProcessTableAsync({ timeout: PS_TIMEOUT_MS }));
  const wait = msUntilProvable(rows);
  if (!wait) return rows;
  await new Promise((r) => setTimeout(r, wait));
  return pick(await snapshotProcessTableAsync({ timeout: PS_TIMEOUT_MS }));
}

async function endTree(group: number | null, pick: (procs: ProcRow[]) => ProcRow[], graceMs: number): Promise<void> {
  const rows = await readTree(pick);
  // The group as a whole too: a member forked after the read takes the TERM.
  if (group !== null) try { process.kill(-group, "SIGTERM"); } catch { /* gone */ }
  await killProcessTree(rows, graceMs);
  // What forked into the group during the grace, read and checked the same way.
  if (group !== null && groupAlive(group)) await killProcessTree(await readTree(pick), 0);
}

/**
 * End every process of the station in `group`: TERM, so a trap can clean up,
 * then KILL what is left after `graceMs`, including what the TERM orphaned.
 */
export async function endStation(group: number, graceMs = STATION_KILL_GRACE_MS): Promise<void> {
  if (process.platform === "win32") return;
  await endTree(group, (procs) => processGroupTree(procs, group), graceMs);
}

/**
 * Leftovers of a station whose script ended on its own: what still sits in its
 * group (a background job the script never waited for). A process that left
 * the group is kept here: a script that ended cleanly started it to outlive
 * it (a check watcher, a daemon), unlike a station cut off mid-way.
 */
export async function endGroupLeftovers(group: number, graceMs = STATION_KILL_GRACE_MS): Promise<void> {
  if (process.platform === "win32" || !groupAlive(group)) return;
  await endTree(group, (procs) => procs.filter((p) => p.pgid === group), graceMs);
}

// The KILL a runner on its way out leaves behind: after the grace, each pid
// that `ps` still prints with the group and start time it had at the TERM
// (sameProcess, in shell). A pid the kernel gave to another program meanwhile
// is left alone, and one that ended at the TERM is not there to match.
export const KILL_IF_SAME = [
  `sleep "$1"; shift`,
  `while [ $# -ge 2 ]; do`,
  `  [ "$(ps -o pgid=,lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')" = "$2" ] && kill -KILL "$1" 2>/dev/null`,
  `  shift 2`,
  `done`,
  `exit 0`,
].join("\n");

/**
 * The same, synchronously, for a runner on its way out ("exit" runs no async
 * work): TERM now, and a detached shell sends the identity-checked KILL after
 * the grace, since this process will not be there to.
 */
export function endStationsOnExit(groups: Iterable<number>, graceMs = STATION_KILL_GRACE_MS): void {
  if (process.platform === "win32") return;
  const list = [...groups];
  if (!list.length) return;
  const read = () => {
    const procs = snapshotProcessTable({ timeout: PS_TIMEOUT_MS });
    return uniqueRows(list.flatMap((g) => processGroupTree(procs, g)));
  };
  let rows = read();
  const wait = msUntilProvable(rows);
  if (wait) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    rows = read();
  }
  for (const r of rows) try { process.kill(r.pid, "SIGTERM"); } catch { /* gone */ }
  for (const g of list) try { process.kill(-g, "SIGTERM"); } catch { /* gone */ }
  const proven = rows.filter((r) => r.pid > 1 && r.pid !== process.pid && r.pgid !== undefined && bornBeforeCaptureSecond(r));
  if (!proven.length) return;
  try {
    spawn("sh", ["-c", KILL_IF_SAME, "sh", String(graceMs / 1000), ...proven.flatMap((r) => [String(r.pid), `${r.pgid} ${r.startedAt}`])], {
      detached: true,
      stdio: "ignore",
      // lstart is localized; the rows were read under C (processTable.ts).
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    }).unref();
  } catch { /* nothing left to escalate with */ }
}

// ─── The runner's record of its stations ──────────────────
//
// A record is read after its runner died, maybe days and a reboot later, when
// any pid or group id in it may name another program by then. So it names
// processes, never ids alone: each station process with its group and start
// time, read again while the station runs. The next station ends only a
// process that still matches one exactly, what descends from one, and the
// members of a group whose leader matched (provenTree). A group id with no
// leader proves nothing: an app that crashes leaves leaderless groups behind
// routinely (crash handlers), and one that took a recorded id would take the
// station's KILL. A record from before this boot or older than
// RECORD_MAX_AGE_MS is dropped unread.

/** One station process as a record names it: its pid, its group and its `ps lstart`. */
export type StationProc = { pid: number; pgid: number; start: string };
type StationRecord = { runner: number; written: number; groups: Array<{ pgid: number; procs: StationProc[] }> };

/** A record older than this is dropped: no station runs this long without its runner writing again. */
export const RECORD_MAX_AGE_MS = 2 * 24 * 3_600_000;

export const stationRecordDir = (): string => codecastPath("workflow-runs", "stations");
const recordFile = (pid = process.pid): string => path.join(stationRecordDir(), `${pid}.json`);

/** Write this runner's running stations with their processes, or remove the record when none runs. */
export function recordStations(groups: Array<{ pgid: number; procs: StationProc[] }>): void {
  const file = recordFile();
  try {
    if (!groups.length) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body: StationRecord = { runner: process.pid, written: Date.now(), groups };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* the record is a backstop; the station runs without it */ }
}

/** When this machine booted, in ms, or null when it cannot be read. */
export function bootTimeMs(): number | null {
  try {
    if (process.platform === "linux") {
      const btime = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf-8"))?.[1];
      return btime ? Number(btime) * 1000 : null;
    }
    const sec = /sec = (\d+)/.exec(execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf-8", timeout: 5_000 }))?.[1];
    return sec ? Number(sec) * 1000 : null;
  } catch { return null; }
}

const sameAs = (p: ProcRow, k: StationProc): boolean => p.pid === k.pid && p.pgid === k.pgid && p.startedAt === k.start;

/**
 * What `known` still proves in this read: each process that matches one by
 * pid, group and start time, every descendant of one, and every member of a
 * group one of them leads (a group id is not reused while its leader lives).
 * Never `self`, its group, or init.
 */
export function provenTree(procs: ProcRow[], known: StationProc[], self = process.pid): ProcRow[] {
  const selfGroup = procs.find((p) => p.pid === self)?.pgid;
  const found = new Map<number, ProcRow>();
  const queue = procs.filter((p) => known.some((k) => sameAs(p, k)));
  while (queue.length) {
    const p = queue.pop()!;
    if (found.has(p.pid) || p.pid === self || p.pid <= 1 || p.pgid === selfGroup) continue;
    found.set(p.pid, p);
    queue.push(...procs.filter((c) => c.ppid === p.pid || (p.pid === p.pgid && c.pgid === p.pid)));
  }
  return [...found.values()];
}

/** The processes of the running station in `group` as its record names them: its group's tree, and what `known` still proves. */
export async function readStationProcs(group: number, known: StationProc[]): Promise<StationProc[]> {
  const procs = await snapshotProcessTableAsync({ timeout: PS_TIMEOUT_MS });
  return uniqueRows([...processGroupTree(procs, group), ...provenTree(procs, known)])
    .filter((p): p is ProcRow & { pgid: number; startedAt: string } => p.pgid !== undefined && !!p.startedAt)
    .map((p) => ({ pid: p.pid, pgid: p.pgid, start: p.startedAt }));
}

/**
 * End the stations of runners that died without ending them (SIGKILL, a crash
 * below JS): the processes their records still prove (provenTree). Returns the
 * groups it ended processes of.
 */
export async function reapDeadRunnerStations(dir = stationRecordDir(), graceMs = STATION_KILL_GRACE_MS): Promise<number[]> {
  if (process.platform === "win32") return [];
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  if (!files.length) return [];
  const boot = bootTimeMs() ?? 0;
  const dead: StationRecord[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let rec: StationRecord;
    try { rec = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { fs.rmSync(file, { force: true }); continue; }
    const stale = !(rec.written > boot) || Date.now() - rec.written > RECORD_MAX_AGE_MS || !Array.isArray(rec.groups);
    if (!stale && (rec.runner === process.pid || isPidAlive(rec.runner))) continue;
    fs.rmSync(file, { force: true });
    if (!stale) dead.push(rec);
  }
  if (!dead.length) return [];
  const procs = await snapshotProcessTableAsync({ timeout: PS_TIMEOUT_MS });
  const ended: number[] = [];
  const ends: Promise<void>[] = [];
  for (const { pgid, procs: known = [] } of dead.flatMap((r) => r.groups)) {
    const rows = provenTree(procs, known);
    if (!rows.length) continue;
    ended.push(pgid);
    // The group as a whole takes the TERM only while its leader is proven, the group id with it.
    ends.push(endTree(rows.some((r) => r.pid === pgid) ? pgid : null, (now) => provenTree(now, known), graceMs));
  }
  await Promise.all(ends);
  return ended;
}
