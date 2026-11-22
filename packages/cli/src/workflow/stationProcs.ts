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
// A runner that dies by SIGKILL runs nothing on its way out, so each runner
// keeps the groups of its running stations on disk, and the next station any
// runner starts ends the groups a dead runner left (reapDeadRunnerStations).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "../proc.js";
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

async function endTree(group: number, pick: (procs: ProcRow[]) => ProcRow[], graceMs: number): Promise<void> {
  const rows = await readTree(pick);
  // The group as a whole too: a member forked after the read takes the TERM.
  try { process.kill(-group, "SIGTERM"); } catch { /* gone */ }
  await killProcessTree(rows, graceMs);
  // What forked into the group during the grace, read and checked the same way.
  if (groupAlive(group)) await killProcessTree(await readTree(pick), 0);
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

type StationRecord = { runner: number; groups: Array<{ pgid: number; at: number }> };

export const stationRecordDir = (): string => codecastPath("workflow-runs", "stations");
const recordFile = (pid = process.pid): string => path.join(stationRecordDir(), `${pid}.json`);

/** Write this runner's running station groups (pgid and when it started), or remove the record when none runs. */
export function recordStations(groups: Array<{ pgid: number; at: number }>): void {
  const file = recordFile();
  try {
    if (!groups.length) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body: StationRecord = { runner: process.pid, groups };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* the record is a backstop; the station runs without it */ }
}

/**
 * End the station groups of runners that died without ending them (SIGKILL, a
 * crash below JS). A group whose leader is alive but started after the record
 * is another process's that took the id; a group with no leader left is still
 * the station's, since a group's id is not reused while it has a member.
 * Returns the groups it ended.
 */
export async function reapDeadRunnerStations(dir = stationRecordDir(), graceMs = STATION_KILL_GRACE_MS): Promise<number[]> {
  if (process.platform === "win32") return [];
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const dead: StationRecord[] = [];
  for (const f of files) {
    let rec: StationRecord;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); } catch { fs.rmSync(path.join(dir, f), { force: true }); continue; }
    if (rec.runner === process.pid || isPidAlive(rec.runner)) continue;
    dead.push(rec);
    fs.rmSync(path.join(dir, f), { force: true });
  }
  if (!dead.length) return [];
  const procs = await snapshotProcessTableAsync({ timeout: PS_TIMEOUT_MS });
  const ended: number[] = [];
  for (const { pgid, at } of dead.flatMap((r) => r.groups)) {
    if (!procs.some((p) => p.pgid === pgid)) continue;
    const leader = procs.find((p) => p.pid === pgid);
    // lstart has one second resolution; an unreadable start time proves nothing, so the group is left.
    if (leader && !(Date.parse(leader.startedAt ?? "") <= at + 5_000)) continue;
    ended.push(pgid);
  }
  await Promise.all(ended.map((g) => endStation(g, graceMs)));
  return ended;
}
