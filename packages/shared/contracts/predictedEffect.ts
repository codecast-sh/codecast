// A task's predicted effect, and what it did after the task shipped
// (ct-96177; design "Goals agents can climb" section 4). The prediction is
// stated before the work, in one line a person or a station writes, and names
// where the effect is read: a goal metric (`in-N:key`), a metric series
// directly (`mw-N`), or an environment (`env:<product>/<name>`):
//
//   in-9:intros_a_week +5% by 2026-12-15 :: <basis>
//   mw-17 +3pt in 21d :: <basis>
//   env:union/second-side-replay +0.02 :: <basis>
//
// A metric or series is read over the window after ship against as long
// before it; an env, as its first attempt after ship paired against its last
// before (convex/predictions.ts). When it is set, a prediction is checked
// against what its target can detect over that read (`readable`, `mde`): one
// smaller than that is recorded, read, and always judged unreadable, since no
// outcome of it could teach anything. Both halves live on the task; a goal
// reads them from its tasks, so the record has one home. Pure: the CLI, the
// web and the server parse, judge and word it the same way.
import { formatSeriesValue } from "./initiative";
import { MDE_WEEKS, mdeWords, metricPeriodMs, minimumDetectableLift, noiseSd, parseMetricNoise, parseMetricWindow } from "./metricStanding";
import { isEnvKey } from "./envs";

const DAY = 86_400_000;

export const PREDICTION_VERDICTS = ["held", "not_shown", "opposite", "unreadable"] as const;
export type PredictionVerdict = (typeof PREDICTION_VERDICTS)[number];
export const PREDICTION_VERDICT_WORDS: Record<PredictionVerdict, string> = { held: "held", not_shown: "not shown", opposite: "opposite", unreadable: "unreadable" };

/** Where an effect is read: a goal metric, a metric series, or an environment. */
export type PredictionTarget = "metric" | "series" | "env";
export function targetKind(ref: string): PredictionTarget | null {
  if (/^in-\d+:[a-z0-9_]+$/.test(ref)) return "metric";
  if (/^mw-\d+$/.test(ref)) return "series";
  return ref.startsWith("env:") && isEnvKey(ref.slice(4)) ? "env" : null;
}
const TARGET_NOUN: Record<PredictionTarget, string> = { metric: "metric", series: "series", env: "environment" };

export type PredictedEffect = {
  /** Where it is read: `in-N:key`, `mw-N` or `env:<product>/<name>` (the field keeps its first name). */
  goal_ref: string;
  /** The goal it serves (`in-N`), so the goal lists it whatever its target. */
  goal?: string;
  /** Whether the target can detect a move this size over the read, and what it can detect: a share of its level for a metric or series, a score for an env. Absent when the target has no noise model to say. */
  readable?: boolean;
  mde?: number;
  direction: "up" | "down";
  /** How far, always positive: a share of the value before ship when `relative`, else in the metric's own unit. */
  size: number;
  relative: boolean;
  /** When to read it: a date, or a number of days after ship. An env without either is read at its first attempt after ship. */
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
const PREDICT_RE = /^(\S+)\s+([+-])\s*(\$)?\s*(\d+(?:\.\d+)?)\s*(%|pp|pts?|points?)?(?:\s+(?:by\s+(\d{4}-\d{2}-\d{2})|in\s+(\d+)\s*(d|days?|w|weeks?)))?\s*(?:::\s*([\s\S]*))?$/i;
export const PREDICT_FORMAT = "<in-N:metric_key | mw-N | env:<product>/<name>> <+|-><size>[%|pt] [by YYYY-MM-DD | in <N>d|w] :: <basis>, e.g. \"mw-17 +3pt in 21d :: <basis>\"";

/** Read one prediction line. `%` is relative to the value before ship; `pt`/`pp` or a bare number moves the metric itself. */
export function parsePrediction(text: string, now: number): { prediction: PredictedEffect } | { error: string } {
  const m = (text ?? "").trim().replace(/\s+/g, " ").match(PREDICT_RE);
  if (!m) return { error: `A prediction reads ${PREDICT_FORMAT}` };
  const [, ref, sign, , num, unit, date, count, span, basisRaw] = m;
  const kind = targetKind(ref.toLowerCase());
  if (!kind) return { error: `"${ref}" is not a place an effect is read: a goal metric (in-N:key), a metric series (mw-N) or an environment (env:<product>/<name>), from cast goals --brief` };
  const size = Number(num);
  if (!(size > 0)) return { error: "A prediction moves the metric by more than 0" };
  const basis = (basisRaw ?? "").trim();
  if (!basis) return { error: `A prediction names its basis after "::": the check or evidence that predicts it. ${PREDICT_FORMAT}` };
  const out: PredictedEffect = { goal_ref: ref.toLowerCase(), direction: sign === "+" ? "up" : "down", size, relative: unit === "%", basis: basis.slice(0, BASIS_MAX), set_at: now };
  if (date) {
    // Read once the stated day is over (UTC), so "by" includes the whole day.
    const day = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(day) || isoDay(day) !== date) return { error: `"${date}" is not a date` };
    const at = day + DAY;
    if (at <= now) return { error: `The read date ${date} has passed` };
    out.read_at = at;
  } else if (count) {
    const days = Number(count) * (/^w/i.test(span) ? 7 : 1);
    if (!(days > 0)) return { error: "Read it at least one day after ship" };
    out.read_days = days;
  } else if (kind !== "env") out.read_days = PREDICTION_READ.max_window_days;
  return { prediction: out };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The prediction back in the line parsePrediction reads. */
export function predictionText(p: PredictedEffect): string {
  const when = p.read_at !== undefined ? ` by ${isoDay(p.read_at - DAY)}` : p.read_days !== undefined ? ` in ${p.read_days}d` : "";
  return `${p.goal_ref} ${p.direction === "up" ? "+" : "-"}${p.size}${p.relative ? "%" : ""}${when} :: ${p.basis}`;
}

/** When a shipped task's prediction is read: its date or days after ship, never sooner than min_after_days after ship. One with neither (an env) is read from ship on, at its first attempt after it. */
export function predictionReadAt(p: Pick<PredictedEffect, "read_at" | "read_days">, shippedAt: number): number {
  if (p.read_at === undefined && p.read_days === undefined) return shippedAt;
  const stated = p.read_at ?? shippedAt + p.read_days! * DAY;
  return Math.max(stated, shippedAt + PREDICTION_READ.min_after_days * DAY);
}

/** How long a read runs on each side of ship, as known before ship: the stated days, the time to the stated date, capped at the read window. */
export function predictionSpanMs(p: Pick<PredictedEffect, "read_at" | "read_days">, now: number): number {
  const cap = PREDICTION_READ.max_window_days * DAY;
  return Math.min(cap, p.read_days !== undefined ? p.read_days * DAY : p.read_at !== undefined ? Math.max(DAY, p.read_at - now) : cap);
}

/** The two windows a read compares: after ship up to the read, capped, and as long before ship. */
export function predictionWindows(shippedAt: number, readAt: number): { before: [number, number]; after: [number, number] } {
  const from = Math.max(shippedAt, readAt - PREDICTION_READ.max_window_days * DAY);
  const span = readAt - from;
  return { before: [shippedAt - span, shippedAt], after: [from, readAt] };
}

export type WindowPoint = { at: number; value: number; n?: number };
type Stats = { mean: number; sd: number | null };
function stats(points: readonly WindowPoint[]): Stats | null {
  let w = 0, sum = 0;
  for (const p of points) { const n = p.n ?? 1; w += n; sum += p.value * n; }
  if (!w) return null;
  const mean = sum / w;
  if (points.length < 3) return { mean, sd: null };
  const v = points.reduce((s, p) => s + (p.value - mean) ** 2, 0) / (points.length - 1);
  return { mean, sd: Math.sqrt(v) };
}

const Z = 1.96;
/** How long one value of a metric counts over (metricStanding's period: "37/week" is a week), with a week when its words name none. */
export const readingPeriodMs = (m: { name?: string; window?: string } | null | undefined, unit?: string | null): number =>
  metricPeriodMs(`${m?.name ?? ""} ${unit ?? ""}`, parseMetricWindow(m?.window) ?? { count: 1, unit: "w", ms: 7 * DAY });

/**
 * Judge a prediction from the metric's points in the two windows.
 *
 * The noise of one reading is the metric's stated model (metricStanding
 * noiseSd), else the spread of its readings before ship. Readings of a gauge
 * are not independent (an hourly "intros a week" repeats the same week), so a
 * window's mean averages only as many independent readings as the window holds
 * periods (`independent`, readingPeriodMs), and the band shrinks by its square root.
 *
 * Held means the metric moved the predicted way past that band and by at least
 * half the predicted size; opposite, the other way past the band; anything else
 * is not shown. With no band (no model, too few points, or a flat window) the
 * half-size bar alone decides and within_noise is null.
 */
export function judgePrediction(
  p: Pick<PredictedEffect, "direction" | "size" | "relative">,
  input: { before: readonly WindowPoint[]; after: readonly WindowPoint[]; noise?: string | null; n?: number | null; independent?: number },
): Pick<RealisedEffect, "verdict" | "value_before" | "value_after" | "delta" | "within_noise" | "band" | "note"> {
  const b = stats(input.before), a = stats(input.after);
  const none = (note: string) => ({ verdict: "unreadable" as const, value_before: b?.mean ?? null, value_after: a?.mean ?? null, delta: null, within_noise: null, band: null, note });
  if (!b || !a) return none(`The metric has no reading ${!b && !a ? "before or after ship" : !b ? "before ship" : "after ship"}`);
  if (p.relative && Math.abs(b.mean) < 1e-9) return none("A move in percent cannot be read against a value of 0 before ship");
  const delta = a.mean - b.mean;
  const k = Math.sqrt(Math.max(1, input.independent ?? 1));
  const modelled = [noiseSd(b.mean, input.noise, input.n), noiseSd(a.mean, input.noise, input.n)];
  const sds = modelled.every((s) => s !== null) ? (modelled as number[]) : b.sd !== null ? [b.sd, a.sd ?? b.sd] : null;
  const raw = sds ? (Z * Math.sqrt(sds[0] ** 2 + sds[1] ** 2)) / k : null;
  const band = raw && raw > 0 ? raw : null;
  const toward = p.direction === "up" ? delta : -delta;
  const predicted = p.relative ? (Math.abs(b.mean) * p.size) / 100 : p.size;
  const within_noise = band === null ? null : Math.abs(delta) <= band;
  const verdict: PredictionVerdict =
    toward > 0 && toward > (band ?? 0) && toward >= predicted / 2 ? "held"
    : toward < 0 && -toward > (band ?? predicted / 2) ? "opposite"
    : "not_shown";
  const how = band === null ? "no noise band; held needs half the predicted move" : `noise band ±${round(band)}`;
  return { verdict, value_before: b.mean, value_after: a.mean, delta, within_noise, band, note: `${round(b.mean)} before, ${round(a.mean)} after (${how})` };
}

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

/** "held: 37/week → 43/week (+6; predicted +5%), outside ±4" for a terminal, a brief or a card. */
export function realisedLine(p: Pick<PredictedEffect, "direction" | "size" | "relative"> & Partial<Pick<PredictedEffect, "goal_ref" | "readable" | "mde">>, r: RealisedEffect, unit?: string | null): string {
  const said = `predicted ${p.direction === "up" ? "+" : "-"}${p.relative ? `${p.size}%` : formatSeriesValue(p.size, unit === "$" ? "$" : null)}`;
  if (r.value_before === null || r.value_after === null || r.delta === null) return `${PREDICTION_VERDICT_WORDS.unreadable}: ${r.note}`;
  // Read, but smaller than its place detects: what it did, and why it counts for nothing.
  const tooSmall = r.verdict === "unreadable" && p.goal_ref ? unreadableWords(p as Pick<PredictedEffect, "goal_ref" | "readable" | "mde">) : null;
  if (r.verdict === "unreadable" && !tooSmall) return `${PREDICTION_VERDICT_WORDS.unreadable}: ${r.note}`;
  const f = (n: number) => formatSeriesValue(n, unit);
  const d = `${r.delta >= 0 ? "+" : "-"}${formatSeriesValue(Math.abs(r.delta), unit === "$" ? "$" : null)}`;
  const band = r.band === null ? "" : r.within_noise ? `, inside ±${formatSeriesValue(r.band, null)}` : `, outside ±${formatSeriesValue(r.band, null)}`;
  return `${PREDICTION_VERDICT_WORDS[r.verdict]}: ${f(r.value_before)} → ${f(r.value_after)} (${d}; ${said})${band}${tooSmall ? `; ${tooSmall}` : ""}`;
}

/** One task's prediction as a goal lists it, with the unit of the metric it names. */
export type GoalPredictionRow = {
  short_id: string; title: string; status: string; predicted: PredictedEffect; realised: RealisedEffect | null; unit: string | null;
  /** In words, for a terminal that prints them as sent: what was predicted ("in-9:intros_a_week +5% in 14d"), and what the read found, without its verdict. */
  said: string; reading: string | null;
};

/** The words a goal's list prints for one prediction. */
export function predictionWords(p: PredictedEffect, r: RealisedEffect | null, unit: string | null): Pick<GoalPredictionRow, "said" | "reading"> {
  const unreadable = unreadableWords(p);
  const when = p.read_days !== undefined ? " after ship" : p.read_at === undefined ? " at the first attempt after ship" : "";
  return { said: `${predictionText(p).split(" :: ")[0]}${when}${unreadable ? `, ${unreadable}` : ""}`, reading: r ? realisedLine(p, r, unit).replace(/^[a-z ]+: /, "") : null };
}

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

// ── Whether a prediction can be read at its target ──

const WEEK = 7 * DAY;

/**
 * The smallest relative change a before/after read detects at a metric (80%
 * power, two-sided 5%), from its windowed reading: `span` of the read on each
 * side, the metric's `period`. A read with a span of S on each side carries the
 * information of a 50/50 test over 2S, so this is metricStanding's
 * minimumDetectableLift over that many periods; a binomial whose n lives in a
 * denominator series rescales the band's own four-week figure by the same
 * ratio. Null when the metric has no noise model to say.
 */
export function readMde(band: { mean: number; mde: number | null } | null | undefined, noise: string | null | undefined, periodMs: number, spanMs: number, scale?: number): number | null {
  if (!band || !(periodMs > 0) || !(spanMs > 0)) return null;
  const periods = (2 * spanMs) / periodMs;
  const model = parseMetricNoise(noise);
  const direct = model && (model.kind !== "binomial" || model.n) ? minimumDetectableLift(band.mean, model, periods, { scale }) : null;
  if (direct !== null) return direct;
  return band.mde !== null ? band.mde * Math.sqrt((MDE_WEEKS * WEEK) / periodMs / periods) : null;
}

/**
 * The smallest score change a paired read of an env detects: from its latest
 * attempt's paired interval, else twice its A/A spread, else its own interval
 * taken twice. Expressed through the A/A form of minimumDetectableLift (at
 * level 1 over 4 periods it is the z sum times one standard error).
 */
export function envMde(a: { paired_ci95?: number[]; ci95?: number[]; noise?: { aa_sd: number } } | null | undefined): number | null {
  if (!a) return null;
  const half = (ci?: number[]) => (ci && ci.length === 2 ? (ci[1]! - ci[0]!) / 2 / 1.96 : null);
  const se = half(a.paired_ci95) ?? (a.noise ? a.noise.aa_sd * Math.SQRT2 : null) ?? (half(a.ci95) !== null ? half(a.ci95)! * Math.SQRT2 : null);
  return se && se > 0 ? minimumDetectableLift(1, { kind: "aa", sd: se }, 4) : null;
}

/** How far the prediction moves its target, in the unit its detectable change is in: a share of the level for a metric or series, a score for an env. Null when that cannot be taken. */
export function predictedMove(p: Pick<PredictedEffect, "size" | "relative">, kind: PredictionTarget, level: number | null): number | null {
  if (kind === "env") return p.relative ? (level === null ? null : (Math.abs(level) * p.size) / 100) : p.size;
  if (p.relative) return p.size / 100;
  return level ? p.size / Math.abs(level) : null;
}

/** The readability a prediction carries: readable when its move reaches what the target detects, nothing when the target cannot say. */
export function readability(p: Pick<PredictedEffect, "size" | "relative" | "goal_ref">, mde: number | null, level: number | null): Pick<PredictedEffect, "readable" | "mde"> {
  const kind = targetKind(p.goal_ref);
  const move = kind ? predictedMove(p, kind, level) : null;
  return mde === null || move === null ? {} : { readable: move >= mde, mde };
}

/** "±164%" for a metric or series, "±0.031" for an env. */
export const detectsWords = (kind: PredictionTarget, mde: number): string => (kind === "env" ? `±${mde.toFixed(3)}` : mdeWords(mde) ?? `±${mde}`);

/** "unreadable at this metric (detects ±164%)" when the prediction is smaller than its target can see; null otherwise. */
export function unreadableWords(p: Pick<PredictedEffect, "goal_ref" | "readable" | "mde">): string | null {
  const kind = targetKind(p.goal_ref);
  return p.readable === false && kind && p.mde !== undefined ? `unreadable at this ${TARGET_NOUN[kind]} (detects ${detectsWords(kind, p.mde)})` : null;
}

/**
 * Judge an env prediction from its last attempt before ship and first after:
 * the paired delta over the cases both scored when there is one, else the
 * difference of means. Held, opposite and not shown as for a metric, against
 * the paired interval's half width.
 */
export function judgeEnvPrediction(
  p: Pick<PredictedEffect, "direction" | "size" | "relative">,
  read: { before: number; after: number; delta: number; half: number | null; note: string },
): Pick<RealisedEffect, "verdict" | "value_before" | "value_after" | "delta" | "within_noise" | "band" | "note"> {
  const toward = p.direction === "up" ? read.delta : -read.delta;
  const predicted = p.relative ? (Math.abs(read.before) * p.size) / 100 : p.size;
  const band = read.half && read.half > 0 ? read.half : null;
  const verdict: PredictionVerdict =
    toward > 0 && toward > (band ?? 0) && toward >= predicted / 2 ? "held"
    : toward < 0 && -toward > (band ?? predicted / 2) ? "opposite"
    : "not_shown";
  return { verdict, value_before: read.before, value_after: read.after, delta: read.delta, within_noise: band === null ? null : Math.abs(read.delta) <= band, band, note: read.note };
}
