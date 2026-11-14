/**
 * Typecheck watchers admitted by memory, not by count. Measured on one
 * machine on 2026-11-13, live watchers ranged from 74 MB to 6.7 GB, so "one
 * slot each" either wasted the machine or swapped it. Each watcher records its
 * peak RSS (itself plus its tsc) at the end of every pass, keyed by (repo,
 * project) so a repo's worktrees learn together. A new watcher reserves p95 of
 * the recent clean peaks times 1.25, or the full ceiling while fewer than three
 * are known or since its last death by memory, and starts only when every live
 * watcher's hold plus that reservation fits in the machine's budget: total
 * memory minus a reserve for everything else. The reservation rule is ported
 * from pandora/engine/admission.py (MIT).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "./proc.js";
import { codecastPath } from "./codecastDir.js";
import { readLocalConfig } from "./config/readLocalConfig.js";
import { CHECK_HEAP_ENV, TSC_HEAP_MB, heapCapMb } from "./checkHeap.js";

const MiB = 2 ** 20;
const GiB = 2 ** 30;
export const FLOOR_BYTES = 512 * MiB;
export const MARGIN = 1.25;
export const HISTORY = 50;
export const MIN_SAMPLES = 3;
/**
 * What is kept for everything but typecheck watchers when nothing sets it: a
 * fixed 8 GB or a fifth of the machine, whichever is more. 65% once left a
 * 128 GB machine 45 GB for watchers and throttled every session (2026-11-14).
 */
export const RESERVE_FLOOR_BYTES = 8 * GiB;
export const RESERVE_SHARE = 0.2;
/** What a project nobody on this machine has measured is assumed to need when no other project has been measured either. */
export const DEFAULT_COLD_BYTES = 4 * GiB;
export const RESERVE_ENV = "CAST_CHECK_RESERVE_GB";

/** clean: a pass finished. oom: killed for memory, which starts the learning over. heap: tsc hit its own heap cap, a limit rather than a machine out of memory. */
export type PeakOutcome = "clean" | "oom" | "heap";
export interface Peak {
  at: number;
  bytes: number;
  outcome: PeakOutcome;
  root?: string;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

export type ProcTable = Map<number, { ppid: number; rssBytes: number }>;

/** Every process's parent and RSS, from one `ps`; empty when ps fails. */
export function procTable(): ProcTable {
  const table: ProcTable = new Map();
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf-8", timeout: 5_000 });
  for (const line of String(r.stdout ?? "").split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && Number.isFinite(ppid) && Number.isFinite(rss)) table.set(pid, { ppid, rssBytes: rss * 1024 });
  }
  return table;
}

const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/**
 * macOS's own figure for a process's memory (what Activity Monitor shows), now
 * and at its peak. Unlike RSS it counts compressed and swapped pages, so it does
 * not shrink when the machine is short of memory, which is when admission needs
 * it most. Null off macOS or when `footprint` cannot read the pid.
 */
export function footprintOf(pid: number): { now: number; peak: number } | null {
  if (process.platform !== "darwin" || !(pid > 0)) return null;
  const r = spawnSync("footprint", ["-p", String(pid)], { encoding: "utf-8", timeout: 5_000 });
  if (r.status !== 0) return null;
  const read = (key: string) => {
    const m = new RegExp(`^\\s*${key}:\\s*([\\d.]+)\\s*(B|KB|MB|GB)\\b`, "m").exec(String(r.stdout ?? ""));
    return m ? Number(m[1]) * UNIT[m[2]!]! : null;
  };
  const now = read("phys_footprint");
  return now === null ? null : { now, peak: read("phys_footprint_peak") ?? now };
}

/** The most the given pids have held, summed: their footprint peaks on macOS, else their RSS now. */
export function peakOfPids(pids: number[]): number {
  const live = pids.filter((p) => p > 0);
  const prints = live.map(footprintOf);
  if (live.length && prints.every(Boolean)) return prints.reduce((a, f) => a + f!.peak, 0);
  return rssOfPids(live);
}

/** Summed RSS of the given pids, from one cheap `ps -p`. */
export function rssOfPids(pids: number[]): number {
  const live = pids.filter((p) => p > 0);
  if (!live.length) return 0;
  const r = spawnSync("ps", ["-o", "rss=", "-p", live.join(",")], { encoding: "utf-8", timeout: 5_000 });
  return String(r.stdout ?? "").split("\n").reduce((a, l) => a + (Number(l.trim()) || 0) * 1024, 0);
}

/** RSS of `pid` and every process under it: the watcher and its tsc. */
export function treeRssBytes(pid: number, table: ProcTable = procTable()): number {
  if (!table.has(pid)) return 0;
  const children = new Map<number, number[]>();
  for (const [p, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), p]);
  let total = 0;
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    total += table.get(p)?.rssBytes ?? 0;
    stack.push(...(children.get(p) ?? []));
  }
  return total;
}

// ---------------------------------------------------------------------------
// The record: one JSON line per pass, per (repo, project)
// ---------------------------------------------------------------------------

export const peaksDir = (): string => codecastPath("typecheck", "peaks");

export function peaksPath(repo: string, project: string): string {
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 12);
  return path.join(peaksDir(), `${key}-${path.basename(repo)}--${project}.jsonl`);
}

/** Append one pass's peak; the file is cut back to HISTORY lines when it grows. Best effort. */
export function recordPeak(repo: string, project: string, peak: Peak): void {
  if (!(peak.bytes > 0)) return;
  try {
    fs.mkdirSync(peaksDir(), { recursive: true });
    const file = peaksPath(repo, project);
    fs.appendFileSync(file, `${JSON.stringify({ repo, project, ...peak })}\n`);
    if (fs.statSync(file).size > 32 * 1024) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, fs.readFileSync(file, "utf-8").trim().split("\n").slice(-HISTORY).join("\n") + "\n");
      fs.renameSync(tmp, file);
    }
  } catch {}
}

function parsePeaks(text: string): Array<Peak & { repo?: string; project?: string }> {
  const out: Array<Peak & { repo?: string; project?: string }> = [];
  for (const line of text.split("\n")) {
    try {
      const p = JSON.parse(line);
      if (typeof p?.bytes === "number" && p.bytes > 0 && (p.outcome === "clean" || p.outcome === "oom" || p.outcome === "heap")) out.push(p);
    } catch {}
  }
  return out.slice(-HISTORY);
}

export function readPeaks(repo: string, project: string): Peak[] {
  try {
    return parsePeaks(fs.readFileSync(peaksPath(repo, project), "utf-8"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/** The most a watcher can grow to: tsc's heap cap (raised by CAST_CHECK_HEAP_MB or the asker's NODE_OPTIONS) plus what node holds outside the heap. */
export function watcherCeilingBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(TSC_HEAP_MB, Number(env[CHECK_HEAP_ENV]) || 0, heapCapMb(env.NODE_OPTIONS) ?? 0) * MiB * MARGIN;
}

/**
 * What admission assumes for a project nobody has measured yet: the median of
 * what this machine's measured projects reach (their p95), else 4 GB; never
 * above the ceiling or half the budget. A flat ceiling (10 GB) for every
 * unmeasured project is what made every watcher look cold-sized at rollout.
 */
export function coldReservationBytes(budget: number, learnedP95s: number[] = [], env: NodeJS.ProcessEnv = process.env): number {
  const sorted = [...learnedP95s].filter((b) => b > 0).sort((a, b) => a - b);
  const estimate = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : DEFAULT_COLD_BYTES;
  return Math.max(FLOOR_BYTES, Math.min(estimate, watcherCeilingBytes(env), Math.max(budget / 2, FLOOR_BYTES)));
}

/**
 * The fewest watchers the machine runs whatever memory says: the count rule
 * that came before memory admission (one per 12 GB, 2 to 16). Memory only
 * ever adds watchers above it.
 */
export function countFloorWatchers(total = os.totalmem()): number {
  return Math.min(16, Math.max(2, Math.floor(total / GiB / 12)));
}

/** What a project is expected to reach: its p95 once warm, else the cold estimate (the ceiling since a death by memory). */
export function expectedBytes(peaks: Peak[], ceiling = watcherCeilingBytes(), cold = ceiling): number {
  const usable = usablePeaks(peaks);
  if (usable.length >= MIN_SAMPLES) return Math.min(ceiling, percentile(usable, 95));
  return diedOfMemory(peaks) ? ceiling : cold;
}

/** Nearest-rank percentile, defined for one sample (pandora/engine/admission.py). */
export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((q / 100) * sorted.length))) - 1]!;
}

/** The clean peaks that count: those since the last death by memory, which starts the learning over. */
export function usablePeaks(peaks: Peak[]): number[] {
  const lastOom = peaks.map((p) => p.outcome).lastIndexOf("oom");
  return peaks.slice(lastOom + 1).filter((p) => p.outcome === "clean").map((p) => p.bytes);
}

export const isWarm = (peaks: Peak[]): boolean => usablePeaks(peaks).length >= MIN_SAMPLES;
const diedOfMemory = (peaks: Peak[]): boolean => peaks.some((p) => p.outcome === "oom");

/**
 * What a new watcher reserves: p95 of usable peaks x 1.25, within [floor,
 * ceiling]; `cold` (the ceiling unless admission caps it) while too few are known.
 */
export function reservationBytes(peaks: Peak[], ceiling = watcherCeilingBytes(), cold = ceiling): number {
  const usable = usablePeaks(peaks);
  // Since a death by memory the project has proven it needs more than it was given: the whole ceiling, never the cold cap.
  if (usable.length < MIN_SAMPLES) return diedOfMemory(peaks) ? ceiling : cold;
  return Math.min(ceiling, Math.max(FLOOR_BYTES, Math.ceil(percentile(usable, 95) * MARGIN)));
}

/**
 * What a live watcher holds against the budget: its live use (what it
 * measures now; while a pass runs, no less than the peak it reached). Only a watcher
 * still building its first pass, which has not reached its size yet, holds
 * what its project is expected to reach; headroom belongs to the reservation
 * a new watcher makes, not to the ones already running.
 */
export function holdBytes(w: { inProgress?: boolean; firstFinishedAt?: number; finishedAt?: number; peakRssBytes?: number }, measured: number, peaks: Peak[], ceiling = watcherCeilingBytes(), cold = ceiling): number {
  // Idle, it holds what it uses now. A pass in flight climbs back toward the peak it reached before, so it holds that.
  const seen = w.inProgress ? Math.max(measured, w.peakRssBytes ?? 0) : measured;
  // finishedAt: watchers from before firstFinishedAt existed (2026-10-15) still say a pass finished.
  return w.firstFinishedAt ?? w.finishedAt ? seen : Math.max(seen, expectedBytes(peaks, ceiling, cold));
}

/** The memory kept for everything else: CAST_CHECK_RESERVE_GB, else `check.reserve_gb`, else 8 GB or a fifth of the machine, whichever is more. */
export function reserveBytes(total = os.totalmem(), env: NodeJS.ProcessEnv = process.env): number {
  const set = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n * GiB : null;
  };
  return set(env[RESERVE_ENV]) ?? set(readLocalConfig()?.check?.reserve_gb) ?? Math.max(RESERVE_FLOOR_BYTES, Math.round(total * RESERVE_SHARE));
}

/** The memory typecheck watchers share on this machine. */
export function budgetBytes(total = os.totalmem(), env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, total - reserveBytes(total, env));
}

/**
 * Whether one more watcher fits: holds plus need within budget. The machine
 * always runs at least one, however small it is, or nothing could ever check.
 */
export function fitsBudget(holds: number[], need: number, budget: number): boolean {
  return holds.length === 0 || holds.reduce((a, b) => a + b, 0) + need <= budget;
}

export const fmtGb = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GB`;

// ---------------------------------------------------------------------------
// What the machine has learned, for `cast check-status`
// ---------------------------------------------------------------------------

export interface LearnedSize {
  repo: string;
  project: string;
  samples: number;
  lastBytes: number;
  lastAt: number;
  p95Bytes: number | null;
  reservationBytes: number;
  warm: boolean;
  ooms: number;
}

export function learnedSizes(ceiling = watcherCeilingBytes(), cold = ceiling): LearnedSize[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(peaksDir()).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: LearnedSize[] = [];
  for (const f of files) {
    let rows: ReturnType<typeof parsePeaks>;
    try {
      rows = parsePeaks(fs.readFileSync(path.join(peaksDir(), f), "utf-8"));
    } catch {
      continue;
    }
    const last = rows.at(-1);
    if (!last?.repo || !last.project) continue;
    const usable = usablePeaks(rows);
    out.push({
      repo: last.repo,
      project: last.project,
      samples: usable.length,
      lastBytes: last.bytes,
      lastAt: last.at,
      p95Bytes: usable.length ? percentile(usable, 95) : null,
      reservationBytes: reservationBytes(rows, ceiling, cold),
      warm: usable.length >= MIN_SAMPLES,
      ooms: rows.filter((r) => r.outcome === "oom").length,
    });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.project.localeCompare(b.project));
}
