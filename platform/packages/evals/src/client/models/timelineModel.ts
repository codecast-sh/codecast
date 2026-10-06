// The clock a run's story is told on. A run that plays out in its own time
// (union's sims run ten virtual days in under an hour) stamps some rows with
// the instant they truly happened and others only with when they were
// written, shifted back by the run's offset. These helpers place every row on
// the one clock, order them so a cause reads before its effect, and name
// each instant by its day from the run's start. Generalised from union's
// admin/sim virtualTime.ts and StoryFeed.

export type TimeLike = string | number | Date;

/** Milliseconds since the epoch, or NaN for a stamp that does not parse. */
export const msOf = (t: TimeLike): number => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

/**
 * The offset between a run's stored stamps and its own clock, tightened by the
 * rows whose true instant is known. `fallbackMs` is the structural answer (a
 * run's whole shift: its start minus its clock's now); it is right on average
 * but not exact, because a stored stamp also carries the real time that had
 * passed when the row was written, which no run-level constant removes.
 *
 * Each pin is one row's stored stamp and, where the run recorded it, the
 * instant it truly happened (union: a Slack message's `slack_ts`). The median
 * residual is taken, not the first: the error grows across a run, so the
 * midpoint is the best a single constant can do. On union's
 * simrun-20260813-4fee0178 (22 pinned rows, ~47 real minutes against 10
 * virtual days) it cut the median error from 17.6 to 7.4 minutes.
 */
export function calibrateOffsetMs(fallbackMs: number, pins: Iterable<{ stored: TimeLike; actual: TimeLike | null | undefined }>): number {
  const deltas: number[] = [];
  for (const p of pins) {
    if (p.actual === null || p.actual === undefined) continue;
    const actual = msOf(p.actual);
    const stored = msOf(p.stored);
    if (Number.isFinite(actual) && actual > 0 && Number.isFinite(stored)) deltas.push(stored - actual);
  }
  if (!deltas.length) return fallbackMs;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]!;
}

/** A row's instant on the run's clock: its true instant when known, else its stored stamp less the offset. Null when neither parses. */
export function onRunClock(stored: TimeLike, offsetMs: number, actual?: TimeLike | null): number | null {
  if (actual !== null && actual !== undefined) {
    const a = msOf(actual);
    if (Number.isFinite(a) && a > 0) return a;
  }
  const s = msOf(stored);
  return Number.isFinite(s) ? s - offsetMs : null;
}

/** Whole days from the run's start, floored, so a row stamped before it reads as day -1. */
export const dayIn = (origin: TimeLike, at: TimeLike): number => Math.floor((msOf(at) - msOf(origin)) / 86_400_000);

/** "D+3 14:00": days and time of day into the run. A row from before the start reads "D-1 17:00", never "D+-1". */
export function runClockLabel(origin: TimeLike, at: TimeLike): string {
  const minutes = Math.floor((msOf(at) - msOf(origin)) / 60_000);
  const d = Math.floor(minutes / 1440);
  const ofDay = minutes - d * 1440;
  return `${d < 0 ? `D${d}` : `D+${d}`} ${String(Math.floor(ofDay / 60)).padStart(2, "0")}:${String(ofDay % 60).padStart(2, "0")}`;
}

/**
 * The story in order. Two rows within `sameMs` of each other are one moment
 * read causally: a marker (the beat that provoked a line) before the line it
 * provoked, since the run stamps both from the same clock and the line loses
 * sub-second precision on the way.
 */
export function orderTimeline<T extends { at: TimeLike; marker?: unknown }>(items: readonly T[], sameMs = 2_000): T[] {
  const rank = (x: T) => (x.marker ? 0 : 1);
  return [...items].sort((a, b) => {
    const dt = msOf(a.at) - msOf(b.at);
    if (Math.abs(dt) > sameMs) return dt;
    return rank(a) - rank(b) || dt;
  });
}

/** How many rows each lane holds. */
export function laneCounts(items: readonly { lane: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of items) out[x.lane] = (out[x.lane] ?? 0) + 1;
  return out;
}
