/**
 * Typecheck watchers admitted by memory, not by count. Measured on one
 * machine on 2026-11-13, live watchers ranged from 74 MB to 6.7 GB, so "one
 * slot each" either wasted the machine or swapped it. Each watcher records its
 * peak RSS (itself plus its tsc) at the end of every pass, keyed by (repo,
 * project) so a repo's worktrees learn together. A new watcher reserves p95 of
 * the recent clean peaks times 1.25, or the full ceiling while fewer than three
 * are known or since its last death by memory, and starts only when every live
 * watcher's hold plus that reservation fits in what the machine can give:
 * what live watchers measure plus memory available now, never above total
 * memory minus a reserve for everything else (`admissionBudget`). The
 * reservation rule is ported from pandora/engine/admission.py (MIT).
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
 * macOS's own figure for each process's memory (what Activity Monitor shows),
 * now and at its peak, from one `footprint` report. Unlike RSS it counts
 * compressed and swapped pages, so it does not shrink when the machine is
 * short of memory, which is when admission needs it most. A pid footprint
 * cannot read is absent (footprint still exits 0 for the others).
 */
export function parseFootprints(text: string): Map<number, { now: number; peak: number }> {
  const out = new Map<number, { now: number; peak: number }>();
  let pid = 0;
  for (const line of text.split("\n")) {
    const head = /\[(\d+)\]:.*\bFootprint:/.exec(line);
    if (head) {
      pid = Number(head[1]);
      continue;
    }
    const m = /^\s*(phys_footprint|phys_footprint_peak):\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(line);
    if (!m || !pid) continue;
    const bytes = Number(m[2]) * UNIT[m[3]!]!;
    const f = out.get(pid) ?? { now: bytes, peak: bytes };
    if (m[1] === "phys_footprint") f.now = bytes;
    else f.peak = bytes;
    out.set(pid, f);
  }
  return out;
}

/** Footprints of the given pids from a single `footprint` call; empty off macOS or when it fails. */
export function footprintsOf(pids: number[]): Map<number, { now: number; peak: number }> {
  const live = pids.filter((p) => p > 0);
  if (process.platform !== "darwin" || !live.length) return new Map();
  const r = spawnSync("footprint", ["--noCategories", ...live.flatMap((p) => ["-p", String(p)])], { encoding: "utf-8", timeout: 5_000 });
  return r.status === 0 ? parseFootprints(String(r.stdout ?? "")) : new Map();
}

/** The most the given pids have held, summed: their footprint peaks on macOS, else their RSS now. */
export function peakOfPids(pids: number[]): number {
  const live = pids.filter((p) => p > 0);
  const prints = footprintsOf(live);
  if (live.length && live.every((p) => prints.has(p))) return live.reduce((a, p) => a + prints.get(p)!.peak, 0);
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

/** The most typecheck watchers may share on this machine: total memory less the reserve. What they may take now is `admissionBudget`, measured. */
export function budgetBytes(total = os.totalmem(), env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, total - reserveBytes(total, env));
}

// ---------------------------------------------------------------------------
// What the machine can give now, measured
// ---------------------------------------------------------------------------

export interface MachineMemory {
  /** RAM the machine can hand out without compressing or swapping anything. */
  availableBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  /** macOS's own verdict (kern.memorystatus_vm_pressure_level): 1 normal, 2 warn, 4 critical. Absent elsewhere. */
  pressureLevel?: number;
}

/**
 * macOS available memory from `vm_stat`: free, speculative and purgeable
 * pages, plus the inactive pages that are file-backed. The rest of the
 * inactive list is anonymous memory, reclaimed only by compressing or
 * swapping it, so counting it called a swapping machine 23 GB free.
 */
export function parseVmStat(text: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);
  const [free, inactive] = [pages("Pages free"), pages("Pages inactive")];
  if (!(page > 0) || !Number.isFinite(free) || !Number.isFinite(inactive)) return null;
  const fileBacked = pages("File-backed pages");
  const extra = (n: number) => (Number.isFinite(n) ? n : 0);
  return page * (free + extra(pages("Pages speculative")) + extra(pages("Pages purgeable")) + Math.min(inactive, Number.isFinite(fileBacked) ? fileBacked : inactive));
}

const SIZE_UNIT: Record<string, number> = { K: 1024, M: MiB, G: GiB };

/** Swap and the kernel's pressure level from `sysctl vm.swapusage kern.memorystatus_vm_pressure_level`. */
export function parseDarwinSysctl(text: string): Pick<MachineMemory, "swapUsedBytes" | "swapTotalBytes" | "pressureLevel"> | null {
  const m = /total = ([\d.]+)([KMG])\s+used = ([\d.]+)([KMG])/.exec(text);
  if (!m) return null;
  const level = Number(/memorystatus_vm_pressure_level:\s*(\d+)/.exec(text)?.[1]);
  return { swapTotalBytes: Number(m[1]) * SIZE_UNIT[m[2]!]!, swapUsedBytes: Number(m[3]) * SIZE_UNIT[m[4]!]!, ...(level > 0 ? { pressureLevel: level } : {}) };
}

/** Linux: MemAvailable and swap from /proc/meminfo. */
export function parseMeminfo(text: string): MachineMemory | null {
  const kb = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? NaN) * 1024;
  const [available, swapTotal, swapFree] = [kb("MemAvailable"), kb("SwapTotal"), kb("SwapFree")];
  if (!Number.isFinite(available)) return null;
  const total = Number.isFinite(swapTotal) ? swapTotal : 0;
  return { availableBytes: available, swapTotalBytes: total, swapUsedBytes: Math.max(0, total - (Number.isFinite(swapFree) ? swapFree : total)) };
}

const MEMORY_TTL_MS = 2_000;
let lastMemory: { at: number; value: MachineMemory | null } | null = null;

/**
 * What the machine can give now: one `vm_stat` and one `sysctl` on macOS,
 * a file read on Linux, null elsewhere or when they fail. Kept for two
 * seconds, so one admission decision (which sizes the ask and the head of
 * the queue) measures once.
 */
export function readMachineMemory(now = Date.now()): MachineMemory | null {
  if (lastMemory && now - lastMemory.at < MEMORY_TTL_MS) return lastMemory.value;
  let value: MachineMemory | null = null;
  try {
    if (process.platform === "darwin") {
      const vm = spawnSync("vm_stat", [], { encoding: "utf-8", timeout: 5_000 });
      const sys = spawnSync("sysctl", ["vm.swapusage", "kern.memorystatus_vm_pressure_level"], { encoding: "utf-8", timeout: 5_000 });
      const available = parseVmStat(String(vm.stdout ?? ""));
      const swap = parseDarwinSysctl(String(sys.stdout ?? ""));
      if (available !== null && swap) value = { availableBytes: available, ...swap };
    } else if (process.platform === "linux") {
      value = parseMeminfo(fs.readFileSync("/proc/meminfo", "utf-8"));
    }
  } catch {}
  lastMemory = { at: now, value };
  return value;
}

/** The measuring admission calls, replaceable in tests. */
export const machineMemoryProbe = { read: (): MachineMemory | null => readMachineMemory() };

/** What admission leaves free for everything else to grow into: 2 GB or a twentieth of the machine, whichever is more. */
export function memoryMarginBytes(total: number): number {
  return Math.max(2 * GiB, Math.round(total * 0.05));
}

/**
 * The machine is short of memory: macOS says so (warn or critical), or swap
 * is more than half used while available memory is under twice the margin.
 * Swap alone is no signal: macOS grows its swap files as it goes and drains
 * them slowly, so a calm machine can show them nearly full.
 */
export function underPressure(m: MachineMemory, total: number): boolean {
  if ((m.pressureLevel ?? 0) >= 2) return true;
  return m.swapTotalBytes > 0 && m.swapUsedBytes > m.swapTotalBytes / 2 && m.availableBytes < 2 * memoryMarginBytes(total);
}

/**
 * The memory watchers may hold now: what live watchers measure (killing
 * them frees it) plus what the machine has available beyond the margin,
 * never above the cap (total less the reserve). Under pressure watchers get
 * no headroom at all: a new watcher only replaces older ones, and whatever
 * available memory falls short of twice the margin is taken back from them
 * too. Unmeasured (null), the cap alone. A fixed cap of 102 GB on a 128 GB
 * laptop whose other processes held 50 GB put it 21 GB into swap (2026-11-21).
 */
export function admissionBudget(input: { totalBytes: number; capBytes: number; watcherBytes: number; memory: MachineMemory | null }): { budgetBytes: number; pressure: boolean } {
  const { memory } = input;
  if (!memory) return { budgetBytes: input.capBytes, pressure: false };
  const margin = memoryMarginBytes(input.totalBytes);
  const pressure = underPressure(memory, input.totalBytes);
  const headroom = pressure ? Math.min(0, memory.availableBytes - 2 * margin) : memory.availableBytes - margin;
  return { budgetBytes: Math.max(0, Math.min(input.capBytes, input.watcherBytes + headroom)), pressure };
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
