// The load governor: how hard agent work may push this machine, decided before
// the work starts rather than after the machine is saturated.
//
// Every few seconds the daemon reads how busy the CPUs are and turns it into
// one level. "over" is the state the founder's Mac kept collapsing into (load
// 400 on 16 cores, 2026-10-24): every core pinned and the run queue many times
// the core count. At "over" two things happen at once:
//   - sessions nobody is watching (unattended) run at macOS background
//     priority, which confines them and every process they start afterwards to
//     the efficiency cores (backgroundPriority.ts), so the person's own work
//     keeps the performance cores;
//   - work that would START more load here (a watchdog revive, a workflow
//     resume, the warm pool, a trigger run) is held until the level drops.
// Leaving "over" needs a sustained quieter spell, so the level does not flap at
// the edge and undo the relief every other tick.
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

/** Busy share at or above this, held for OVER_HOLD_MS, is "over". */
export const OVER_BUSY = 0.85;
export const OVER_HOLD_MS = 10_000;
/** With the CPUs busy, a run queue this deep per core is "over" at once: the
 *  machine is already behind. Load alone never counts: it also counts blocked
 *  threads, so a large idle fleet keeps it high while the CPUs sit idle. */
export const OVER_LOAD_PER_CORE = 4;
/** Below this busy share the machine is "calm"; between the two it is "busy". */
export const CALM_BUSY = 0.6;
/** Leaving "over" also needs the run queue drained below this per core. At
 *  "over" the unattended work is confined to the efficiency cores, so the busy
 *  share drops while that work still waits: busy alone would read the throttle
 *  as recovery, lift it, and land straight back at "over". */
export const RELEASE_LOAD_PER_CORE = 2;
/** Below this busy share the queue is blocked threads, not waiting work: "over" may end. */
export const IDLE_BUSY = 0.3;
/** How long the machine must stay under the bar before the level steps down. */
export const RELEASE_HOLD_MS = 60_000;
export const SAMPLE_INTERVAL_MS = 5_000;

/** What would add load here; each is held at "over". Human messages are never held. */
export type AdmitKind = "revive" | "workflow_resume" | "warm_pool" | "trigger";

export class LoadGovernor {
  level: LoadLevel = "calm";
  /** When the level last changed. */
  since = 0;
  private highSince: number | null = null;
  private lowSince: number | null = null;
  last: LoadSample | null = null;

  /** Feeds one sample; returns the level after it. */
  observe(s: LoadSample): LoadLevel {
    this.last = s;
    const high = s.busy >= OVER_BUSY;
    this.highSince = high ? (this.highSince ?? s.at) : null;
    const target: LoadLevel = s.busy < CALM_BUSY ? "calm" : "busy";
    if (this.level !== "over" && high && (s.loadPerCore >= OVER_LOAD_PER_CORE || s.at - this.highSince! >= OVER_HOLD_MS)) {
      return this.set("over", s.at);
    }
    // Stepping down from a higher level waits out a quiet spell; stepping up to busy is immediate.
    const rank = { calm: 0, busy: 1, over: 2 } as const;
    if (rank[target] < rank[this.level]) {
      const behind = this.level === "over" && s.loadPerCore >= RELEASE_LOAD_PER_CORE && s.busy >= IDLE_BUSY;
      if (high || behind) { this.lowSince = null; return this.level; }
      this.lowSince ??= s.at;
      if (s.at - this.lowSince >= RELEASE_HOLD_MS) return this.set(target, s.at);
      return this.level;
    }
    this.lowSince = null;
    return rank[target] > rank[this.level] ? this.set(target, s.at) : this.level;
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
    this.lowSince = null;
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
export function sampleLoad(now = Date.now()): { before: LoadLevel; after: LoadLevel } {
  const before = governor.level;
  const cur = readCpuTimes();
  const busy = prev ? busyBetween(prev, cur) : undefined;
  prev = cur;
  if (busy === undefined) return { before, after: before };
  const cpus = os.cpus().length || 1;
  const after = governor.observe({ at: now, busy, loadPerCore: os.loadavg()[0] / cpus });
  return { before, after };
}

/** One line for the log and the resource report. */
export function describeLoad(): string {
  const s = governor.last;
  if (!s) return governor.level;
  return `${governor.level} (busy ${Math.round(s.busy * 100)}%, load ${s.loadPerCore.toFixed(1)}/core)`;
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
