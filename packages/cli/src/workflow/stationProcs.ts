// Ending a station's processes, all of them. A station's script runs in a
// process group of its own (commandStation.ts), but a group is not a fence: a
// script that turns on job control (`set -m`) or calls setsid puts its children
// in groups of their own, and a kill sent to the station's group misses them.
// Union's proof-tree.sh runs its command that way; when the station's group was
// killed, the command was left under init, spinning at 84% CPU for 36 hours
// (Nov 20). So a station's processes are its group, every descendant of a
// member, and every group such a descendant sits in, read from the process
// table while the tree is still linked, then ended TERM first and KILL after a
// grace, against the set read before the TERM (an orphan's link to the
// station is gone once its parent dies).
//
// A runner that dies by SIGKILL runs nothing on its way out, so each runner
// keeps the groups of its running stations on disk, and the next station any
// runner starts ends the groups a dead runner left (reapDeadRunnerStations).

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileAsync, spawn, spawnSync } from "../proc.js";
import { codecastPath } from "../codecastDir.js";
import { isPidAlive } from "../workspace/chrome.js";

type Proc = { pid: number; ppid: number; pgid: number; elapsedS: number };

const PS_ARGS = ["-ax", "-o", "pid=,ppid=,pgid=,etime="];

/** ps's etime, `[[dd-]hh:]mm:ss`, in seconds. */
export function etimeSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  return clock.split(":").map(Number).reduce((s, n) => s * 60 + n, 0) + Number(days) * 86_400;
}

export function parseProcs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const [pid, ppid, pgid, etime] = line.trim().split(/\s+/);
    if (pid && etime) procs.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), elapsedS: etimeSeconds(etime) });
  }
  return procs;
}

const listProcsSync = (): Proc[] => parseProcs(String(spawnSync("ps", PS_ARGS, { encoding: "utf-8", timeout: 15_000 }).stdout ?? ""));
const listProcs = async (): Promise<Proc[]> => {
  try { return parseProcs(String((await execFileAsync("ps", PS_ARGS, { encoding: "utf-8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout)); } catch { return []; }
};

/**
 * The processes of the station whose group is `group`: the group's members,
 * every descendant of one, and every member of a group a descendant sits in.
 * Never this process, its group, or init.
 */
export function stationProcs(group: number, procs: Proc[]): number[] {
  const children = new Map<number, number[]>();
  const members = new Map<number, number[]>();
  for (const p of procs) {
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
    members.set(p.pgid, [...(members.get(p.pgid) ?? []), p.pid]);
  }
  const pgidOf = new Map(procs.map((p) => [p.pid, p.pgid]));
  const own = new Set([process.pid, 1, 0]);
  const ownGroup = pgidOf.get(process.pid);
  const found = new Set<number>();
  const groups = new Set<number>();
  const queue = [...(members.get(group) ?? [])];
  groups.add(group);
  while (queue.length) {
    const pid = queue.pop()!;
    if (found.has(pid) || own.has(pid)) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
    const g = pgidOf.get(pid);
    if (g !== undefined && g !== ownGroup && !groups.has(g)) {
      groups.add(g);
      queue.push(...(members.get(g) ?? []));
    }
  }
  return [...found];
}

const signal = (pids: Iterable<number>, sig: NodeJS.Signals): void => {
  for (const pid of pids) try { process.kill(pid, sig); } catch { /* gone */ }
};
const groupAlive = (group: number): boolean => {
  try { process.kill(-group, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** How long a station's processes have between TERM and KILL. */
export const STATION_KILL_GRACE_MS = 10_000;

/**
 * End every process of the station in `group`: TERM, so a trap can clean up,
 * then KILL whatever is left after `graceMs`, including what the TERM
 * orphaned. Resolves once none of them is alive (or the KILL is sent).
 */
export async function endStation(group: number, graceMs = STATION_KILL_GRACE_MS): Promise<void> {
  if (process.platform === "win32") return;
  const first = stationProcs(group, await listProcs());
  signal(first, "SIGTERM");
  try { process.kill(-group, "SIGTERM"); } catch { /* gone */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (groupAlive(group) || first.some(isPidAlive))) await new Promise((r) => setTimeout(r, 100));
  if (!groupAlive(group) && !first.some(isPidAlive)) return;
  const left = new Set([...first.filter(isPidAlive), ...stationProcs(group, await listProcs())]);
  signal(left, "SIGKILL");
  try { process.kill(-group, "SIGKILL"); } catch { /* gone */ }
}

/**
 * Leftovers of a station whose script ended on its own: what still sits in its
 * group (a background job the script never waited for). A process that left
 * the group is kept here: a script that ended cleanly started it to outlive
 * it (a check watcher, a daemon), unlike a station cut off mid-way.
 */
export async function endGroupLeftovers(group: number, graceMs = STATION_KILL_GRACE_MS): Promise<void> {
  if (process.platform === "win32" || !groupAlive(group)) return;
  try { process.kill(-group, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(group)) await new Promise((r) => setTimeout(r, 100));
  try { process.kill(-group, "SIGKILL"); } catch { /* gone */ }
}

/**
 * The same, synchronously, for a runner on its way out ("exit" runs no async
 * work): TERM now, and a detached shell sends the KILL after the grace, since
 * this process will not be there to.
 */
export function endStationsOnExit(groups: Iterable<number>, graceMs = STATION_KILL_GRACE_MS): void {
  if (process.platform === "win32") return;
  const list = [...groups];
  if (!list.length) return;
  const procs = listProcsSync();
  const pids = [...new Set(list.flatMap((g) => stationProcs(g, procs)))];
  signal(pids, "SIGTERM");
  for (const g of list) try { process.kill(-g, "SIGTERM"); } catch { /* gone */ }
  if (!pids.length) return;
  try {
    spawn("sh", ["-c", `sleep ${Math.ceil(graceMs / 1000)}; kill -KILL ${pids.join(" ")} 2>/dev/null; exit 0`], { detached: true, stdio: "ignore" }).unref();
  } catch { /* nothing left to escalate with */ }
}

// ─── The runner's record of its stations ──────────────────

type StationRecord = { runner: number; groups: Array<{ pgid: number; at: number }> };

export const stationRecordDir = (): string => codecastPath("workflow-runs", "stations");
const recordFile = (pid = process.pid): string => path.join(stationRecordDir(), `${pid}.json`);

/** Write this runner's running station groups, or remove the record when none runs. */
export function recordStations(groups: Map<number, number>): void {
  const file = recordFile();
  try {
    if (!groups.size) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body: StationRecord = { runner: process.pid, groups: [...groups].map(([pgid, at]) => ({ pgid, at })) };
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
export async function reapDeadRunnerStations(dir = stationRecordDir()): Promise<number[]> {
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
  const procs = await listProcs();
  const ended: number[] = [];
  for (const { pgid, at } of dead.flatMap((r) => r.groups)) {
    if (!procs.some((p) => p.pgid === pgid)) continue;
    const leader = procs.find((p) => p.pid === pgid);
    if (leader && Date.now() - leader.elapsedS * 1000 > at + 5_000) continue;
    ended.push(pgid);
  }
  await Promise.all(ended.map((g) => endStation(g)));
  return ended;
}
