// The load governor: how hard agent work may push this machine, decided before
// the work starts rather than after the machine is saturated.
//
// Every few seconds the daemon reads how busy the CPUs are and turns it into
// one level. "over" is the state the founder's Mac kept collapsing into (load
// 400 on 16 cores, 2026-10-24): every core pinned and the run queue many times
// the core count. At "over" two things happen:
//   - work that would START more load here (a watchdog revive, a workflow
//     resume, the warm pool, a trigger run) is held until the level drops;
//   - sessions nobody is watching (unattended) are confined to macOS background
//     priority (backgroundPriority.ts), heaviest first, as many as it takes to
//     bring the CPUs back under the bar.
//
// Confinement is graduated because background priority is a cage, not a lower
// priority: a confined process runs only on the efficiency cores and gives way
// to everything there, so it gets almost nothing even while the performance
// cores sit idle (measured 2026-10-26: 0.09 s of CPU in 8 s against 2.4 s for
// its neighbours). It is also the only lever macOS gives over a running
// process: nice and a QoS clamp applied afterwards change nothing. So the
// governor confines only the sessions whose CPU covers the excess, and lets
// them out, lightest first, whenever the CPUs have room. A pinned run queue on
// busy CPUs is the one case that still confines every unattended session at
// once.
//
// Room is read from the busy share alone, never the load average: confined
// work stays runnable, so its backlog keeps the load average high, and a
// release that waited on it never came (a whole day of 3-hour test runs on an
// idle-looking Mac, 2026-10-26).
import fs from "node:fs";
import os from "node:os";
import { codecastPath } from "./codecastDir.js";

export type LoadLevel = "calm" | "busy" | "over";

export interface LoadSample {
  at: number;
  /** Share of all CPU time that was busy since the previous sample, 0 to 1. */
  busy: number;
  /** One-minute load average per logical CPU. */
  loadPerCore: number;
}

/** An unattended session the governor may confine, with its recent CPU in percent of one core. */
export interface CageCandidate {
  id: string;
  cpu: number;
}

/** Busy share at or above this, held for OVER_HOLD_MS, is "over". */
export const OVER_BUSY = 0.85;
export const OVER_HOLD_MS = 10_000;
/** With the CPUs busy, a run queue this deep per core is "over" at once and
 *  confines every unattended session: the machine is already behind. Load
 *  alone never counts: it also counts blocked threads, so a large idle fleet
 *  keeps it high while the CPUs sit idle. */
export const OVER_LOAD_PER_CORE = 4;
/** Below this busy share the machine is "calm"; between the two it is "busy". */
export const CALM_BUSY = 0.6;
/** Confining aims to bring the busy share down to this, and below it confined
 *  sessions are let out. Between it and OVER_BUSY the confined set holds, so
 *  one session does not flap in and out at the edge. The bar is well above
 *  CALM_BUSY because confined work keeps the efficiency cores pinned (a
 *  quarter of a 16-core Mac) and counts toward the busy share itself. */
export const TARGET_BUSY = 0.75;
/** How long the machine must stay under the bar before the level steps down. */
export const RELEASE_HOLD_MS = 60_000;
/** How long the CPUs must have room before the next confined sessions are let out. */
export const RELEASE_STEP_MS = 30_000;
export const SAMPLE_INTERVAL_MS = 5_000;

/** What would add load here; each is held at "over". Human messages are never held. */
export type AdmitKind = "revive" | "workflow_resume" | "warm_pool" | "trigger";

export class LoadGovernor {
  level: LoadLevel = "calm";
  /** When the level last changed. */
  since = 0;
  last: LoadSample | null = null;
  /** Confined sessions, with the CPU each was using when it was confined. */
  private readonly caged = new Map<string, number>();
  private highSince: number | null = null;
  private quietSince: number | null = null;
  private roomSince: number | null = null;

  constructor(private readonly cores = os.cpus().length || 1) {}

  /** The unattended sessions to hold at background priority now. */
  get confined(): string[] {
    return [...this.caged.keys()];
  }

  /** Feeds one sample and this machine's unattended sessions; returns the level after it. */
  observe(s: LoadSample, candidates: readonly CageCandidate[] = []): LoadLevel {
    this.last = s;
    const high = s.busy >= OVER_BUSY;
    this.highSince = high ? (this.highSince ?? s.at) : null;
    const deep = high && s.loadPerCore >= OVER_LOAD_PER_CORE;
    const held = high && s.at - this.highSince! >= OVER_HOLD_MS;
    this.steer(s, candidates, deep, held);
    if (this.level !== "over" && (deep || held)) return this.set("over", s.at);
    const target: LoadLevel = s.busy < CALM_BUSY ? "calm" : "busy";
    // Stepping down waits out a quiet spell, and "over" lasts while anything is confined; stepping up to busy is immediate.
    const rank = { calm: 0, busy: 1, over: 2 } as const;
    if (rank[target] < rank[this.level]) {
      if (high || (this.level === "over" && this.caged.size > 0)) { this.quietSince = null; return this.level; }
      this.quietSince ??= s.at;
      if (s.at - this.quietSince >= RELEASE_HOLD_MS) return this.set(target, s.at);
      return this.level;
    }
    this.quietSince = null;
    return rank[target] > rank[this.level] ? this.set(target, s.at) : this.level;
  }

  /** Confines the heaviest sessions while the CPUs are pinned, and lets the lightest out while they have room. */
  private steer(s: LoadSample, candidates: readonly CageCandidate[], deep: boolean, held: boolean): void {
    const unattended = new Set(candidates.map((c) => c.id));
    for (const id of this.caged.keys()) if (!unattended.has(id)) this.caged.delete(id);
    const free = candidates.filter((c) => !this.caged.has(c.id)).sort((a, b) => b.cpu - a.cpu);
    this.roomSince = s.busy < TARGET_BUSY ? (this.roomSince ?? s.at) : null;
    if (deep) {
      for (const c of free) this.caged.set(c.id, c.cpu);
      return;
    }
    if (held) {
      // Heaviest first until their CPU covers the excess; the next step waits a full hold to see the effect.
      const excess = (s.busy - TARGET_BUSY) * this.cores * 100;
      let shed = 0;
      for (const c of free) {
        if (shed > 0 && shed >= excess) break;
        this.caged.set(c.id, c.cpu);
        shed += Math.max(c.cpu, 1);
      }
      this.highSince = s.at;
      return;
    }
    if (this.roomSince === null || this.caged.size === 0 || s.at - this.roomSince < RELEASE_STEP_MS) return;
    // Lightest first while they fit the room, by the CPU they used before they were confined.
    const room = (TARGET_BUSY - s.busy) * this.cores * 100;
    let used = 0;
    for (const [id, cpu] of [...this.caged].sort((a, b) => a[1] - b[1])) {
      if (used > 0 && used + cpu > room) break;
      this.caged.delete(id);
      used += cpu;
    }
    this.roomSince = s.at;
  }

  /** Whether work of this kind may start here now. */
  admit(kind: AdmitKind): boolean {
    if (this.level === "over") return false;
    // A warm pool exists to save a cold start, which only matters with room to spare.
    if (kind === "warm_pool") return this.level === "calm";
    return true;
  }

  private set(level: LoadLevel, at: number): LoadLevel {
    this.level = level;
    this.since = at;
    this.quietSince = null;
    return level;
  }
}

type CpuTimes = { idle: number; total: number };

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Busy share between two cumulative readings; undefined when no time passed. */
export function busyBetween(a: CpuTimes, b: CpuTimes): number | undefined {
  const total = b.total - a.total;
  if (total <= 0) return undefined;
  return Math.min(1, Math.max(0, 1 - (b.idle - a.idle) / total));
}

/** The daemon's one governor. */
export const governor = new LoadGovernor();

let prev: CpuTimes | null = null;

/** Takes one sample and feeds it in; returns the level before and after. */
export function sampleLoad(candidates: readonly CageCandidate[], now = Date.now()): { before: LoadLevel; after: LoadLevel } {
  const before = governor.level;
  const cur = readCpuTimes();
  const busy = prev ? busyBetween(prev, cur) : undefined;
  prev = cur;
  if (busy === undefined) return { before, after: before };
  const cpus = os.cpus().length || 1;
  const after = governor.observe({ at: now, busy, loadPerCore: os.loadavg()[0] / cpus }, candidates);
  return { before, after };
}

/** One line for the log and the resource report. */
export function describeLoad(): string {
  const s = governor.last;
  if (!s) return governor.level;
  const confined = governor.confined.length;
  return `${governor.level} (busy ${Math.round(s.busy * 100)}%, load ${s.loadPerCore.toFixed(1)}/core${confined ? `, ${confined} confined` : ""})`;
}

// ── What the CLI reads ───────────────────────────────────────────────────────
//
// `cast spawn` runs in a separate process from the daemon, so the daemon
// writes its level and the unattended sessions it knows of here, and spawn
// reads it to decide where a run nobody is watching starts.

export interface GovernorState {
  at: number;
  level: LoadLevel;
  /** Agent session ids on this machine nobody is watching (the server's answer). */
  unattended: string[];
}

/** Older than this, the daemon is gone or stalled: read as "not calm". */
export const GOVERNOR_STATE_STALE_MS = 60_000;

export const governorStateFile = () => codecastPath("load-governor.json");

let lastWritten = "";
let lastWrittenAt = 0;
export function writeGovernorState(unattended: readonly string[], now = Date.now()): void {
  const body = JSON.stringify({ level: governor.level, unattended: [...unattended].sort() });
  // Rewritten on a change, and every half of the stale window so readers can trust it.
  if (body === lastWritten && now - lastWrittenAt < GOVERNOR_STATE_STALE_MS / 2) return;
  const tmp = `${governorStateFile()}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: now, level: governor.level, unattended: [...unattended].sort() } satisfies GovernorState));
    fs.renameSync(tmp, governorStateFile());
    lastWritten = body;
    lastWrittenAt = now;
  } catch {}
}

export function readGovernorState(): GovernorState | null {
  try {
    return JSON.parse(fs.readFileSync(governorStateFile(), "utf8")) as GovernorState;
  } catch {
    return null;
  }
}

/**
 * Whether a spawn should start on the cloud host instead of here, and why.
 * Work nobody watches goes to the cloud unless this machine is calm: a run
 * started `--unattended`, or anything an unattended session starts. Two kinds
 * stay beside their spawner whatever the load, because their work lands in
 * its checkout: a worker sharing the spawner's checkout, and a worker that
 * merges back into it. An explicit machine choice always wins.
 */
export function cloudFirstReason(input: {
  unattendedFlag: boolean;
  spawnerSession: string | null | undefined;
  sharesSpawnerCheckout: boolean;
  mergesBack: boolean;
  machineChosen: boolean;
  state: GovernorState | null;
  now?: number;
}): string | null {
  if (input.machineChosen || input.sharesSpawnerCheckout || input.mergesBack) return null;
  const state = input.state;
  const spawnerUnattended = !!input.spawnerSession && !!state?.unattended.includes(input.spawnerSession);
  if (!input.unattendedFlag && !spawnerUnattended) return null;
  const fresh = !!state && (input.now ?? Date.now()) - state.at < GOVERNOR_STATE_STALE_MS;
  if (fresh && state!.level === "calm") return null;
  const who = input.unattendedFlag ? "an unattended run" : "started by an unattended session";
  return `${who}, and this machine is ${fresh ? state!.level : "of unknown load"}`;
}
