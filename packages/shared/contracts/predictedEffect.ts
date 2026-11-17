// A task's predicted effect on a goal metric, and what the metric did after
// the task shipped (ct-96177; design "Goals agents can climb" section 4). The
// prediction is stated before the work, in one line a person or a station
// writes:
//
//   in-9:intros_a_week +5% by 2026-12-15 :: replay env score +6 on L2
//   in-9:dollars_per_intro -$40 in 21d :: sim-forward arm vs base
//
// After ship, at the read time, the server reads the metric over the window
// after ship against the same length before it (convex/predictions.ts) and
// judges it here. Both halves live on the task; a goal reads them from its
// tasks, so the record has one home. Pure: the CLI, the web and the server
// parse, judge and word it the same way.
import { formatSeriesValue } from "./initiative";
import { noiseSd } from "./metricStanding";

const DAY = 86_400_000;

export const PREDICTION_VERDICTS = ["held", "not_shown", "opposite", "unreadable"] as const;
export type PredictionVerdict = (typeof PREDICTION_VERDICTS)[number];
export const PREDICTION_VERDICT_WORDS: Record<PredictionVerdict, string> = { held: "held", not_shown: "not shown", opposite: "opposite", unreadable: "unreadable" };

export type PredictedEffect = {
  /** The goal metric, `in-N:key` (metricGoalRef). */
  goal_ref: string;
  direction: "up" | "down";
  /** How far, always positive: a share of the value before ship when `relative`, else in the metric's own unit. */
  size: number;
  relative: boolean;
  /** When to read it: a date, or a number of days after ship. Exactly one is set. */
  read_at?: number;
  read_days?: number;
  /** Which check or evidence predicted it, one line. */
  basis: string;
  set_at: number;
  /** The metric's live series when it was set (mw-N), so a renamed metric still reads. */
  series?: string;
};

export type RealisedEffect = {
  verdict: PredictionVerdict;
  value_before: number | null;
  value_after: number | null;
  delta: number | null;
  /** The move is inside the metric's noise band; null when there is no noise model and too few points to estimate one. */
  within_noise: boolean | null;
  /** Half width of the band the delta was judged against. */
  band: number | null;
  shipped_at: number | null;
  /** The window after ship that was read: [from, to]. The window before ends at shipped_at and is as long. */
  from: number | null;
  to: number | null;
  read_at: number;
  /** The series or reports it read ("mw-14"), and why when unreadable. */
  source?: string;
  note: string;
};

export const PREDICTION_READ = {
  /** The least time after ship before a read: a date that falls sooner waits for this. */
  min_after_days: 3,
  /** The longest window read on each side of ship. */
  max_window_days: 28,
  /** A prediction whose task never ships is read as unreadable after this. */
  never_shipped_days: 180,
  /** A task not shipped yet is looked at again after this. */
  recheck_days: 1,
} as const;

const BASIS_MAX = 240;
const PREDICT_RE = /^(\S+)\s+([+-])\s*(\$)?\s*(\d+(?:\.\d+)?)\s*(%|pp|pts?|points?)?\s+(?:by\s+(\d{4}-\d{2}-\d{2})|in\s+(\d+)\s*(d|days?|w|weeks?))\s*(?:::\s*([\s\S]*))?$/i;
export const PREDICT_FORMAT = "<in-N:metric_key> <+|-><size>[%] (by YYYY-MM-DD | in <N>d|w) :: <basis>, e.g. \"in-9:intros_a_week +5% by 2026-12-15 :: replay env +6 on L2\"";

/** Read one prediction line. `%` is relative to the value before ship; `pt`/`pp` or a bare number moves the metric itself. */
export function parsePrediction(text: string, now: number): { prediction: PredictedEffect } | { error: string } {
  const m = (text ?? "").trim().replace(/\s+/g, " ").match(PREDICT_RE);
  if (!m) return { error: `A prediction reads ${PREDICT_FORMAT}` };
  const [, ref, sign, , num, unit, date, count, span, basisRaw] = m;
  if (!/^in-\d+:[a-z0-9_]+$/i.test(ref)) return { error: `"${ref}" is not a goal metric ref (in-N:key, from cast goals)` };
  const size = Number(num);
  if (!(size > 0)) return { error: "A prediction moves the metric by more than 0" };
  const basis = (basisRaw ?? "").trim();
  if (!basis) return { error: `A prediction names its basis after "::": the check or evidence that predicts it. ${PREDICT_FORMAT}` };
  const out: PredictedEffect = { goal_ref: ref.toLowerCase(), direction: sign === "+" ? "up" : "down", size, relative: unit === "%", basis: basis.slice(0, BASIS_MAX), set_at: now };
  if (date) {
    const at = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(at)) return { error: `"${date}" is not a date` };
    if (at <= now) return { error: `The read date ${date} has passed` };
    out.read_at = at;
  } else {
    const days = Number(count) * (/^w/i.test(span) ? 7 : 1);
    if (!(days > 0)) return { error: "Read it at least one day after ship" };
    out.read_days = days;
  }
  return { prediction: out };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The prediction back in the line parsePrediction reads. */
export function predictionText(p: PredictedEffect): string {
  const when = p.read_at !== undefined ? `by ${isoDay(p.read_at)}` : `in ${p.read_days}d`;
  return `${p.goal_ref} ${p.direction === "up" ? "+" : "-"}${p.size}${p.relative ? "%" : ""} ${when} :: ${p.basis}`;
}

/** When a shipped task's prediction is read: its date or days after ship, never sooner than min_after_days after ship. */
export function predictionReadAt(p: Pick<PredictedEffect, "read_at" | "read_days">, shippedAt: number): number {
  const stated = p.read_at ?? shippedAt + (p.read_days ?? PREDICTION_READ.max_window_days) * DAY;
  return Math.max(stated, shippedAt + PREDICTION_READ.min_after_days * DAY);
}

/** The two windows a read compares: after ship up to the read, capped, and as long before ship. */
export function predictionWindows(shippedAt: number, readAt: number): { before: [number, number]; after: [number, number] } {
  const from = Math.max(shippedAt, readAt - PREDICTION_READ.max_window_days * DAY);
  const span = readAt - from;
  return { before: [shippedAt - span, shippedAt], after: [from, readAt] };
}

export type WindowPoint = { at: number; value: number; n?: number };
type Stats = { mean: number; sd: number | null; count: number };
function stats(points: readonly WindowPoint[]): Stats | null {
  let w = 0, sum = 0;
  for (const p of points) { const n = p.n ?? 1; w += n; sum += p.value * n; }
  if (!w) return null;
  const mean = sum / w;
  if (points.length < 3) return { mean, sd: null, count: points.length };
  const v = points.reduce((s, p) => s + (p.value - mean) ** 2, 0) / (points.length - 1);
  return { mean, sd: Math.sqrt(v), count: points.length };
}

const Z = 1.96;

/**
 * Judge a prediction from the metric's points in the two windows. The band is
 * the metric's noise model when it states one (metricStanding noiseSd), else
 * the spread of its readings before ship; with neither, a move of at least half
 * the predicted size counts and within_noise stays null.
 */
export function judgePrediction(
  p: Pick<PredictedEffect, "direction" | "size" | "relative">,
  input: { before: readonly WindowPoint[]; after: readonly WindowPoint[]; noise?: string | null; n?: number | null },
): Pick<RealisedEffect, "verdict" | "value_before" | "value_after" | "delta" | "within_noise" | "band" | "note"> {
  const b = stats(input.before), a = stats(input.after);
  if (!b || !a) {
    const missing = !b && !a ? "before or after ship" : !b ? "before ship" : "after ship";
    return { verdict: "unreadable", value_before: b?.mean ?? null, value_after: a?.mean ?? null, delta: null, within_noise: null, band: null, note: `The metric has no reading ${missing}` };
  }
  const delta = a.mean - b.mean;
  const modelled = [noiseSd(b.mean, input.noise, input.n), noiseSd(a.mean, input.noise, input.n)];
  const sds = modelled.every((s) => s !== null) ? (modelled as number[]) : b.sd !== null ? [b.sd, a.sd ?? b.sd] : null;
  const band = sds ? Z * Math.sqrt(sds[0] ** 2 + sds[1] ** 2) : null;
  const toward = p.direction === "up" ? delta : -delta;
  const predicted = p.relative ? (Math.abs(b.mean) * p.size) / 100 : p.size;
  const within_noise = band === null ? null : Math.abs(delta) <= band;
  const bar = band ?? predicted / 2;
  const verdict: PredictionVerdict = Math.abs(delta) <= bar || delta === 0 ? "not_shown" : toward > 0 ? "held" : "opposite";
  const how = band === null ? "no noise model, judged against half the predicted move" : `noise band ±${round(band)}`;
  return { verdict, value_before: b.mean, value_after: a.mean, delta, within_noise, band, note: `${round(b.mean)} before, ${round(a.mean)} after (${how})` };
}

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

/** "held: 37/week → 43/week (+6; predicted +5%), outside ±4" for a terminal, a brief or a card. */
export function realisedLine(p: Pick<PredictedEffect, "direction" | "size" | "relative">, r: RealisedEffect, unit?: string | null): string {
  const said = `predicted ${p.direction === "up" ? "+" : "-"}${p.relative ? `${p.size}%` : formatSeriesValue(p.size, unit === "$" ? "$" : null)}`;
  if (r.verdict === "unreadable" || r.value_before === null || r.value_after === null || r.delta === null) return `${PREDICTION_VERDICT_WORDS.unreadable}: ${r.note}`;
  const f = (n: number) => formatSeriesValue(n, unit);
  const d = `${r.delta >= 0 ? "+" : "-"}${formatSeriesValue(Math.abs(r.delta), unit === "$" ? "$" : null)}`;
  const band = r.band === null ? "" : r.within_noise ? `, inside ±${formatSeriesValue(r.band, null)}` : `, outside ±${formatSeriesValue(r.band, null)}`;
  return `${PREDICTION_VERDICT_WORDS[r.verdict]}: ${f(r.value_before)} → ${f(r.value_after)} (${d}; ${said})${band}`;
}

/** One task's prediction as a goal lists it, with the unit of the metric it names. */
export type GoalPredictionRow = { short_id: string; title: string; status: string; predicted: PredictedEffect; realised: RealisedEffect | null; unit: string | null };

export type PredictionTally = { open: number; held: number; not_shown: number; opposite: number; unreadable: number };
export function predictionTally(rows: ReadonlyArray<{ predicted?: unknown; realised?: Pick<RealisedEffect, "verdict"> | null }>): PredictionTally {
  const t: PredictionTally = { open: 0, held: 0, not_shown: 0, opposite: 0, unreadable: 0 };
  for (const r of rows) if (r.predicted) t[r.realised?.verdict ?? "open"]++;
  return t;
}

/** "4 of 9 predictions held (2 opposite), 3 open"; empty when there are none. Unreadable reads count against nothing. */
export function hitRateWords(t: PredictionTally): string {
  const read = t.held + t.not_shown + t.opposite;
  const parts = [
    read ? `${t.held} of ${read} prediction${read === 1 ? "" : "s"} held${t.opposite ? ` (${t.opposite} opposite)` : ""}` : "",
    t.open ? `${t.open} open` : "",
    t.unreadable ? `${t.unreadable} unreadable` : "",
  ].filter(Boolean);
  return parts.join(", ");
}
