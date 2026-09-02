// daemon.log report for `cast bench daemon`: loop freezes with laptop sleep
// excluded, ps snapshot and slow sync spawn histograms, and the boot blackout
// per restart. Everything here is pure parsing except readSleepWindows, which
// shells out to pmset on darwin.
//
// Why sleep is decided from pmset and not from the daemon's own lines: the
// daemon's classifyTickGap calls any low CPU gap "sleep", and the live log has a
// 25s recursiveWatcher freeze (2026-09-01T23:20:05) stamped "Sleep detected" two
// seconds later. pmset records the real sleep windows.

import { histogram, mean, type HistogramBucket } from "./stats.js";
import { spawnSync } from "../proc.js";

export interface ParsedLogLine {
  ts: number;
  level: string | null;
  message: string;
}

// log() in daemon.ts writes `[ISO] ` then an optional `[LEVEL] ` tag.
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (?:\[([A-Z]+)\] )?(.*)$/;

export function parseDaemonLogLine(line: string): ParsedLogLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const ts = Date.parse(m[1]);
  if (!Number.isFinite(ts)) return null;
  return { ts, level: m[2] ?? null, message: m[3] };
}

export interface LoopFreezeEvent {
  ts: number;
  lateMs: number;
  cpuMs: number;
  lastLog: string;
  hotStacks: string[];
}

const FREEZE_RE = /^\[LOOP-FREEZE\] event loop blocked (\d+)s \((\d+)ms CPU during the freeze\); last log before it: (.*)$/;
const HOT_STACKS_SEP = "; hot stacks: ";

export function parseLoopFreeze(ts: number, message: string): LoopFreezeEvent | null {
  const m = FREEZE_RE.exec(message);
  if (!m) return null;
  let rest = m[3];
  let hotStacks: string[] = [];
  // The "last log" text is a truncated copy of a previous line and can itself
  // be a LOOP-FREEZE line, so the outer hot stacks are the last separator.
  const sep = rest.lastIndexOf(HOT_STACKS_SEP);
  if (sep >= 0) {
    hotStacks = rest.slice(sep + HOT_STACKS_SEP.length).split(", ").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, sep);
  }
  return { ts, lateMs: Number(m[1]) * 1000, cpuMs: Number(m[2]), lastLog: rest, hotStacks };
}

/** The first hot stack entry with a source location; else the first entry. */
export function primaryStack(hotStacks: string[]): string | null {
  if (hotStacks.length === 0) return null;
  const located = hotStacks.find((s) => s.includes("@"));
  return stackName(located ?? hotStacks[0]);
}

function stackName(entry: string): string {
  return entry.replace(/\s+\d+%$/, "");
}

/** `[TAG]` when the last log line carried one, else its first word. */
export function lastLogTag(lastLog: string): string {
  const stripped = lastLog.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "");
  const tag = /^\[([A-Z-]+)\]/.exec(stripped);
  if (tag) return `[${tag[1]}]`;
  return stripped.split(/\s+/)[0] ?? "";
}

export interface PsSnapshotEvent { ts: number; args: string; tookMs: number; lines: number }
const PS_RE = /^\[PS-SNAPSHOT\] ps (.*) took (\d+)ms \((\d+) lines\)$/;
export function parsePsSnapshot(ts: number, message: string): PsSnapshotEvent | null {
  const m = PS_RE.exec(message);
  return m ? { ts, args: m[1], tookMs: Number(m[2]), lines: Number(m[3]) } : null;
}

export interface SlowSpawnEvent { ts: number; kind: string; blockedMs: number; command: string }
const SPAWN_RE = /^\[SLOW-SYNC-SPAWN\] (\w+) blocked the event loop (\d+)ms: (.*)$/;
export function parseSlowSpawn(ts: number, message: string): SlowSpawnEvent | null {
  const m = SPAWN_RE.exec(message);
  return m ? { ts, kind: m[1], blockedMs: Number(m[2]), command: m[3] } : null;
}

const START_RE = /^\[LIFECYCLE\] daemon_start: v(\S+) PID=(\d+)/;
const LISTEN_RE = /^Hook server listening on 127\.0\.0\.1:(\d+)$/;

// ── sleep windows ─────────────────────────────────────────────────────────────

export interface SleepWindow { start: number; end: number }

// `2026-08-27 08:50:32 -0400 Sleep               \tEntering Sleep state ... 202 secs`
// "Wake Requests" lines do not match: the event name is followed by whitespace only.
const PMSET_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([-+]\d{4}) (Sleep|Wake|DarkWake)\s+\t(.*)$/;

export function parsePmsetSleepWindows(text: string): SleepWindow[] {
  const windows: SleepWindow[] = [];
  let open: { start: number; fallbackSecs: number | null } | null = null;
  const close = (end: number | null) => {
    if (!open) return;
    const fallback = open.fallbackSecs !== null ? open.start + open.fallbackSecs * 1000 : open.start;
    windows.push({ start: open.start, end: end ?? fallback });
    open = null;
  };
  for (const line of text.split("\n")) {
    const m = PMSET_RE.exec(line);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}${m[3].slice(0, 3)}:${m[3].slice(3)}`);
    if (!Number.isFinite(ts)) continue;
    if (m[4] === "Sleep") {
      close(null);
      const secs = /(\d+) secs\s*$/.exec(m[5]);
      open = { start: ts, fallbackSecs: secs ? Number(secs[1]) : null };
    } else {
      close(ts);
    }
  }
  close(null);
  return windows;
}

/** pmset sleep windows on darwin; [] elsewhere or when pmset fails. */
export function readSleepWindows(): SleepWindow[] {
  if (process.platform !== "darwin") return [];
  try {
    const r = spawnSync("pmset", ["-g", "log"], { encoding: "utf-8", timeout: 15_000, maxBuffer: 256 * 1024 * 1024 });
    return typeof r.stdout === "string" ? parsePmsetSleepWindows(r.stdout) : [];
  } catch {
    return [];
  }
}

// ── classification ────────────────────────────────────────────────────────────

export const SLEEP_OVERLAP_TOLERANCE_MS = 5_000;
/** Without pmset coverage a gap this long with under 1% CPU is sleep. */
export const SLEEP_FALLBACK_GAP_MS = 300_000;
export const SLEEP_FALLBACK_CPU_RATIO = 0.01;

export type FreezeKind = "freeze" | "sleep";

/**
 * A freeze covers [ts - lateMs, ts]. It is sleep when a pmset window overlaps
 * it (5s tolerance). When pmset has no window at all around that time, a gap of
 * five minutes or more with under 1% CPU is sleep. Everything else is a freeze.
 */
export function classifyFreeze(ev: LoopFreezeEvent, windows: SleepWindow[]): FreezeKind {
  const from = ev.ts - ev.lateMs;
  const covered = windows.some((w) => w.start - 6 * 3_600_000 <= ev.ts && w.end + 6 * 3_600_000 >= from);
  if (covered) {
    const overlaps = windows.some(
      (w) => w.start <= ev.ts + SLEEP_OVERLAP_TOLERANCE_MS && w.end >= from - SLEEP_OVERLAP_TOLERANCE_MS,
    );
    return overlaps ? "sleep" : "freeze";
  }
  if (ev.lateMs >= SLEEP_FALLBACK_GAP_MS && ev.cpuMs / ev.lateMs < SLEEP_FALLBACK_CPU_RATIO) return "sleep";
  return "freeze";
}

// ── the report ────────────────────────────────────────────────────────────────

export interface CountedEntry { key: string; count: number }
export interface HourRow { hour: string; count: number; totalMs: number; maxMs: number }
export interface BootRow { startedAt: string; version: string; pid: number; listeningAt: string | null; blackoutMs: number | null }
export interface SpawnGroup { command: string; count: number; meanMs: number | null; maxMs: number | null }

export interface LogReport {
  sinceMs: number;
  linesRead: number;
  sleepWindows: number;
  freezes: {
    rawCount: number;
    sleepCount: number;
    freezeCount: number;
    totalMs: number;
    maxMs: number;
    perHour: HourRow[];
    topStacks: CountedEntry[];
    topLastLog: CountedEntry[];
  };
  psSnapshot: { n: number; meanMs: number | null; maxMs: number | null; buckets: HistogramBucket[] };
  slowSpawn: { n: number; groups: SpawnGroup[] };
  boots: BootRow[];
}

export const PS_SNAPSHOT_EDGES_MS = [2000, 5000, 10000, 20000];

export function buildLogReport(
  lines: Iterable<string>,
  opts: { sinceMs: number; sleepWindows: SleepWindow[]; top?: number },
): LogReport {
  const top = opts.top ?? 8;
  const freezes: Array<LoopFreezeEvent & { kind: FreezeKind }> = [];
  const ps: PsSnapshotEvent[] = [];
  const spawns: SlowSpawnEvent[] = [];
  const boots: BootRow[] = [];
  let linesRead = 0;

  for (const raw of lines) {
    const parsed = parseDaemonLogLine(raw);
    if (!parsed || parsed.ts < opts.sinceMs) continue;
    linesRead++;
    const { ts, message } = parsed;
    if (message.startsWith("[LOOP-FREEZE]")) {
      const ev = parseLoopFreeze(ts, message);
      if (ev) freezes.push({ ...ev, kind: classifyFreeze(ev, opts.sleepWindows) });
    } else if (message.startsWith("[PS-SNAPSHOT]")) {
      const ev = parsePsSnapshot(ts, message);
      if (ev) ps.push(ev);
    } else if (message.startsWith("[SLOW-SYNC-SPAWN]")) {
      const ev = parseSlowSpawn(ts, message);
      if (ev) spawns.push(ev);
    } else if (message.startsWith("[LIFECYCLE] daemon_start")) {
      const m = START_RE.exec(message);
      if (m) boots.push({ startedAt: new Date(ts).toISOString(), version: m[1], pid: Number(m[2]), listeningAt: null, blackoutMs: null });
    } else if (message.startsWith("Hook server listening")) {
      const last = boots[boots.length - 1];
      if (LISTEN_RE.test(message) && last && last.listeningAt === null) {
        last.listeningAt = new Date(ts).toISOString();
        last.blackoutMs = ts - Date.parse(last.startedAt);
      }
    }
  }

  const real = freezes.filter((f) => f.kind === "freeze");
  const perHourMap = new Map<string, HourRow>();
  const stackCounts = new Map<string, number>();
  const lastLogCounts = new Map<string, number>();
  for (const f of real) {
    const hour = new Date(f.ts).toISOString().slice(0, 13);
    const row = perHourMap.get(hour) ?? { hour, count: 0, totalMs: 0, maxMs: 0 };
    row.count++;
    row.totalMs += f.lateMs;
    row.maxMs = Math.max(row.maxMs, f.lateMs);
    perHourMap.set(hour, row);
    const stack = primaryStack(f.hotStacks);
    if (stack) stackCounts.set(stack, (stackCounts.get(stack) ?? 0) + 1);
    const tag = lastLogTag(f.lastLog);
    if (tag) lastLogCounts.set(tag, (lastLogCounts.get(tag) ?? 0) + 1);
  }

  const spawnGroups = new Map<string, number[]>();
  for (const s of spawns) {
    const key = s.command.split(/\s+/)[0] ?? s.command;
    const arr = spawnGroups.get(key) ?? [];
    arr.push(s.blockedMs);
    spawnGroups.set(key, arr);
  }

  const psTook = ps.map((p) => p.tookMs);
  return {
    sinceMs: opts.sinceMs,
    linesRead,
    sleepWindows: opts.sleepWindows.length,
    freezes: {
      rawCount: freezes.length,
      sleepCount: freezes.length - real.length,
      freezeCount: real.length,
      totalMs: real.reduce((a, f) => a + f.lateMs, 0),
      maxMs: real.reduce((a, f) => Math.max(a, f.lateMs), 0),
      perHour: [...perHourMap.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      topStacks: topCounted(stackCounts, top),
      topLastLog: topCounted(lastLogCounts, top),
    },
    psSnapshot: {
      n: ps.length,
      meanMs: mean(psTook),
      maxMs: psTook.length ? Math.max(...psTook) : null,
      buckets: histogram(psTook, PS_SNAPSHOT_EDGES_MS),
    },
    slowSpawn: {
      n: spawns.length,
      groups: [...spawnGroups.entries()]
        .map(([command, ms]) => ({ command, count: ms.length, meanMs: mean(ms), maxMs: Math.max(...ms) }))
        .sort((a, b) => b.count - a.count),
    },
    boots,
  };
}

function topCounted(counts: Map<string, number>, top: number): CountedEntry[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, top);
}
