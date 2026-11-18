// A goal metric read over a window with a noise band (the goal layer design,
// "an executable done-when with a noise band"): one reading against the
// target lets a lucky week pass, so a metric that names a `window` ("3w") and
// a `noise` model ("poisson", "binomial:<n or mw-N>", "aa:<sd>", "ratio:mw-N")
// is read over that many non-overlapping periods with an 80% band around it:
// the mean of the period values, or for a share or a ratio the pooled total
// over total. The band is never narrower than the periods' own spread.
// It is met when the whole band clears the target, behind when the whole band
// misses it, and within noise otherwise. Beside the band it states the
// smallest change a 50/50 test could detect in 4 weeks at the current level
// (80% power, two-sided 5%), so a role stops reading noise as progress.
// Pure: initiative.ts reads through it, the server only gathers the points.

/** `phi` is a count's dispersion (quasi-Poisson: variance = phi × mean); absent is 1, plain Poisson. */
/** `ratio` is a value per unit of another series (dollars per intro): pooled as total over total, weighted by that series at each period. */
export type MetricNoise = { kind: "poisson"; phi?: number } | { kind: "binomial"; n?: number; series?: string } | { kind: "aa"; sd: number } | { kind: "ratio"; series: string };
export type MetricWindow = { count: number; unit: "d" | "w"; ms: number };

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** z for the two-sided 80% band the predicate reads (the 10th and 90th percentiles). */
export const BAND_Z = 1.2815515655446004;
/** z_{0.975} + z_{0.80}: a two-sided 5% test at 80% power. */
const MDE_Z = 1.959963984540054 + 0.8416212335729143;
export const MDE_WEEKS = 4;
const WINDOW_MAX_DAYS = 26 * 7;

/** "3w", "4w", "14d": a window of whole weeks or days, at most half a year. Null when it is not that shape. */
export function parseMetricWindow(text: string | null | undefined): MetricWindow | null {
  const m = (text ?? "").trim().toLowerCase().match(/^(\d{1,3})\s*([dw])$/);
  if (!m) return null;
  const count = Number(m[1]);
  const unit = m[2] as "d" | "w";
  const ms = count * (unit === "w" ? WEEK : DAY);
  return count >= 1 && ms <= WINDOW_MAX_DAYS * DAY ? { count, unit, ms } : null;
}

/** "poisson", "poisson:1.75" (overdispersed counts), "binomial:200", "binomial:mw-15", "aa:4.2". Null when it is not one of those. */
export function parseMetricNoise(text: string | null | undefined): MetricNoise | null {
  const t = (text ?? "").trim().toLowerCase();
  if (t === "poisson") return { kind: "poisson" };
  const qp = t.match(/^poisson:(\d+(?:\.\d+)?)$/);
  if (qp) {
    const phi = Number(qp[1]);
    return phi >= 1 && phi <= 100 ? (phi === 1 ? { kind: "poisson" } : { kind: "poisson", phi }) : null;
  }
  const bin = t.match(/^binomial:(?:(mw-\d+)|(\d+(?:\.\d+)?))$/);
  if (bin) {
    if (bin[1]) return { kind: "binomial", series: bin[1] };
    const n = Number(bin[2]);
    return n >= 1 ? { kind: "binomial", n } : null;
  }
  const ratio = t.match(/^ratio:(mw-\d+)$/);
  if (ratio) return { kind: "ratio", series: ratio[1]! };
  const aa = t.match(/^aa:(\d+(?:\.\d+)?)$/);
  if (aa && Number(aa[1]) > 0) return { kind: "aa", sd: Number(aa[1]) };
  return null;
}

/** What a write must say when a window or a noise model does not parse; null when both are fine. */
export function metricWindowNoiseError(window?: string | null, noise?: string | null): string | null {
  if (window && !parseMetricWindow(window)) return `A window is whole weeks or days, at most 26 weeks: "3w", "14d", not "${window}"`;
  if (noise && !parseMetricNoise(noise)) return `A noise model is poisson or poisson:<dispersion ≥ 1> (counts), binomial:<n> or binomial:mw-N (a rate and its denominator), ratio:mw-N (a value per unit of another series, pooled total over total), or aa:<sd> (a measured spread), not "${noise}"`;
  return null;
}

/**
 * The scale a share is written on: percent when its unit or target says "%"
 * or any value or the target is above 1 ("Reply rate=at least 50" over values
 * like 60), else a fraction. One rule for the band, the detectable change and noiseSd.
 */
export const shareScale = (unit?: string | null, target?: string | null, values: readonly number[] = []): number => {
  const t = Number((target ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
  return unit === "%" || /%/.test(target ?? "") || values.some((v) => v > 1) || t > 1 ? 100 : 1;
};

/**
 * One period's sampling spread at `value`: √value for counts, √(p(1−p)/n) for
 * a rate (in the value's own scale, percent or fraction; n from the spec or
 * from `n` when the spec names a denominator series), the measured sd for an
 * A/A. Null without a model, or a binomial with no n.
 */
export function noiseSd(value: number, noise?: string | MetricNoise | null, n?: number | null, scale?: number): number | null {
  const model = typeof noise === "string" ? parseMetricNoise(noise) : noise ?? null;
  if (!model || !Number.isFinite(value)) return null;
  if (model.kind === "poisson") return Math.sqrt((model.phi ?? 1) * Math.max(0, value));
  if (model.kind === "aa") return model.sd;
  if (model.kind === "ratio") return n && n > 0 ? value / Math.sqrt(n) : null;
  const size = model.n ?? n ?? null;
  if (!size || size <= 0) return null;
  const s = scale ?? shareScale(null, null, [value]);
  const p = Math.min(1, Math.max(0, value / s));
  return Math.sqrt((p * (1 - p)) / size) * s;
}

// ── The metric's period ─────────────────────────────────────────────────────

/**
 * How long one value of the metric counts over: the span its name or unit
 * states ("(7d)", "(30d)", "(24h)"), else a month for "a month", "monthly",
 * "/month"; a week for "a week", "/week", "weekly"; a day for "a day",
 * "/day", "daily". Otherwise the window's own unit, so "window 14d" reads 14
 * daily values: a metric that counts over another span names it.
 */
export function metricPeriodMs(words: string, window: MetricWindow): number {
  const t = words.toLowerCase();
  const span = t.match(/\(\s*(\d{1,3})\s*([dh])\s*\)/);
  if (span) return Math.max(DAY, Number(span[1]) * (span[2] === "d" ? DAY : DAY / 24));
  if (/\b(?:a|per|each)\s+month\b|\/\s*mo(?:nth)?\b|\bmonthly\b/.test(t)) return 30 * DAY;
  if (/\b(?:a|per|each)\s+week\b|\/\s*w(?:ee)?k\b|\bweekly\b|\bwow\b/.test(t)) return WEEK;
  if (/\b(?:a|per|each)\s+day\b|\/\s*day\b|\bdaily\b/.test(t)) return DAY;
  return window.unit === "w" ? WEEK : DAY;
}
const periodWord = (ms: number) => (ms === WEEK ? "week" : ms === DAY ? "day" : ms === 30 * DAY ? "month" : `${Math.round(ms / DAY)}-day span`);

type Pt = { at: number; value: number };

/**
 * The definition a watch's values are read under: a version (a reader's, or
 * one a person declared with `cast metrics redefine`) and the time it began.
 */
export type MetricDefinition = { version?: string; since?: number };
/**
 * A stored value counts under its watch's current definition: every value
 * while the watch has none; else a value tagged with that version, or an
 * untagged one read at or after the definition began (a reader that sends no
 * version, under a definition a person declared).
 */
export const ofVersion = (def: MetricDefinition) => (r: { at: number; version?: string }): boolean =>
  !def.version || r.version === def.version || (r.version === undefined && def.since !== undefined && r.at >= def.since);
/** A watch's definition as its row holds it. */
export const definitionOf = (w: { version?: string; version_since?: number }): MetricDefinition => ({ version: w.version, since: w.version_since });

/** A value a person removed (cast metrics points rm) stays removed: a reader re-sending it or a backfill re-reading it does not bring it back. */
export const notRemoved = (removals: ReadonlyArray<{ at: number; to?: number }> | undefined) => (p: { at: number }): boolean =>
  !(removals ?? []).some((r) => p.at >= r.at && p.at <= (r.to ?? r.at));

/** How far from its slot a value may sit: a quarter period, so two periods read overlap by at most half of one. */
export const SLOT_TOLERANCE = 0.25;

/**
 * `count` values one period apart, newest first, ending at the newest point:
 * for each slot the point nearest its time within SLOT_TOLERANCE of a period,
 * each point used once. A slot with no point near it is skipped, so a young
 * or sparse series reads fewer periods than asked rather than reusing one.
 */
export function windowSamples(points: readonly Pt[], periodMs: number, count: number): Pt[] {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const latest = sorted[sorted.length - 1]!.at;
  const used = new Set<number>();
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const t = latest - i * periodMs;
    let best: Pt | null = null;
    for (const p of sorted) {
      if (used.has(p.at) || Math.abs(p.at - t) > periodMs * SLOT_TOLERANCE) continue;
      if (!best || Math.abs(p.at - t) < Math.abs(best.at - t)) best = p;
    }
    if (best) { used.add(best.at); out.push(best); }
  }
  return out;
}

/** The times windowSamples looks for, newest first: what a server reads from history. */
export const windowSlotTimes = (latest: number, periodMs: number, count: number): number[] => Array.from({ length: count }, (_, i) => latest - i * periodMs);

// ── Special functions ───────────────────────────────────────────────────────

function lnGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const y = x - 1;
  let a = 0.9999999999998099;
  for (let i = 0; i < g.length; i++) a += g[i]! / (y + i + 1);
  const t = y + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lead = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(lead));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(lead) * h);
}

/** The x where P(a, x) = q: the q quantile of a Gamma(a, 1). */
export function gammaQuantile(q: number, a: number): number {
  let lo = 0, hi = Math.max(1, a);
  while (gammaP(a, hi) < q) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(a, mid) < q) lo = mid; else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, hi)) break;
  }
  return (lo + hi) / 2;
}

/** The exact (Garwood) two-sided band for a Poisson mean from `count` events, at z's coverage. */
export function poissonBand(count: number, z = BAND_Z): { low: number; high: number } {
  const tail = 1 - normalCdf(z);
  return { low: count <= 0 ? 0 : gammaQuantile(tail, count), high: gammaQuantile(1 - tail, count + 1) };
}

/** The Wilson score band for a share from `successes` of `n`, as fractions. */
export function wilsonBand(successes: number, n: number, z = BAND_Z): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const mid = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: p === 0 ? 0 : Math.max(0, mid - half), high: p === 1 ? 1 : Math.min(1, mid + half) };
}

/**
 * The q quantile of Student's t with `df` degrees of freedom: exact for 1 and
 * 2, else the Cornish-Fisher expansion (Abramowitz and Stegun 26.7.5), within
 * 1e-3 of the table from 3 up.
 */
export function tQuantile(q: number, df: number): number {
  if (df === 1) return Math.tan(Math.PI * (q - 0.5));
  if (df === 2) return (2 * q - 1) / Math.sqrt(2 * q * (1 - q));
  const z = normalQuantile(q);
  const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7, z9 = z ** 9;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3) + (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4);
}
function normalQuantile(q: number): number {
  let lo = -10, hi = 10;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (normalCdf(mid) < q) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26 through erf, accurate to ~1e-7.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// ── Minimum detectable effect ───────────────────────────────────────────────

/**
 * The smallest relative lift a 50/50 test over `periods` periods detects at
 * 80% power and two-sided 5%, at `level` per period: the variance under the
 * lift for counts and shares (so 37 a week over 4 weeks reads +52%), the
 * measured spread for an A/A, doubled for half the traffic in each arm. Null
 * when the level or the model cannot say.
 */
export function minimumDetectableLift(level: number, noise: MetricNoise, periods: number, opts: { n?: number | null; scale?: number } = {}): number | null {
  if (!(level > 0) || !(periods > 0)) return null;
  const z2 = MDE_Z * MDE_Z;
  if (noise.kind === "poisson") {
    const lam = (level * periods) / 2 / (noise.phi ?? 1);
    return (z2 + Math.sqrt(z2 * z2 + 8 * lam * z2)) / (2 * lam);
  }
  if (noise.kind === "aa") return (MDE_Z * 2 * noise.sd) / (Math.sqrt(periods) * level);
  // A ratio's change is a count's with its relative spread (readWindow reads it so); alone it says nothing.
  if (noise.kind === "ratio") return null;
  const size = noise.n ?? opts.n ?? null;
  if (!size) return null;
  const scale = opts.scale ?? 1;
  const p = level / scale;
  if (!(p > 0 && p < 1)) return null;
  const m = (size * periods) / 2;
  const b = z2 * (1 - 2 * p);
  const delta = (b + Math.sqrt(b * b + 8 * (m + z2) * z2 * p * (1 - p))) / (2 * (m + z2));
  return delta / p;
}

// ── The windowed reading ────────────────────────────────────────────────────

export type WindowStanding = "met" | "within_noise" | "behind" | "unknown";
/** One period the window read: the span its value counts over, the value, and for a pooled read the weight (the denominator) it carried. */
export type WindowPeriod = { from: number; to: number; value: number; weight?: number; partial?: boolean };
export type WindowRead = {
  /** Complete periods read, and the periods the window asks for. */
  periods: number;
  of: number;
  period: string;
  window: string;
  /** Each period read, newest first, with its dates; a partial current period is listed and never counted. */
  read: WindowPeriod[];
  /** How the periods combine: the mean of their values, or a pooled total over total (a share's successes over trials, a ratio's numerator over its denominator). */
  pooling: "mean" | "pooled";
  /** The window's value (the mean, or the pooled value) and its 80% band (null without a noise model). */
  mean: number;
  low: number | null;
  high: number | null;
  /** Where the band's width came from: the declared model, or the periods' own spread when that is wider (a t interval). */
  spread: "model" | "observed" | null;
  standing: WindowStanding;
  /** The smallest relative change a 4 week 50/50 test detects at this level, at the wider of the model's and the observed spread; null without a model. */
  mde: number | null;
  /** Why the standing is not the band's plain verdict: the window is not full yet, or the noise model cannot read these values. */
  note?: string;
  /** The denominator series a pooled read weighted its periods by. */
  by?: string;
  /** The periods are the source's own (cohort weeks dated by the reader), not samples of its polls. */
  cohort?: boolean;
  /** Stored values of an older definition the window left out. */
  dropped?: number;
  /** The target the band was judged against: the one in force at the window's end. */
  against?: number | null;
  /** Read from stored polls while the source's last read failed (its error): never met on that alone. */
  failing?: string;
};

/** A series whose value is the current period so far ("this week", "to date"): its newest value is a partial period. */
const PARTIAL_WORDS = /\b(?:so far|to date|[wmq]td|this (?:week|month|day|quarter))\b/i;

/**
 * A metric read over its window. Each period is the value at one slot; the
 * band is the declared model's, widened to a t interval on the periods' own
 * spread when that is wider (from two periods, where t is wide, as it should
 * be), so a band never claims more precision than the weeks themselves show. A share pools successes
 * over trials and a ratio pools its numerator over its denominator (the
 * denominator series' value at each slot), and the line says so.
 */
export function readWindow(args: {
  samples: readonly Pt[];
  denominators?: readonly Pt[] | null;
  target: number | null;
  direction: "at_least" | "at_most";
  window: MetricWindow;
  windowText: string;
  periodMs: number;
  noise: MetricNoise | null;
  unit?: string | null;
  targetText?: string | null;
  /** The newest value is the current period so far. */
  partialLatest?: boolean;
  /** The samples are the source's own dated periods, each dated by its start (a cohort week). */
  cohort?: boolean;
}): WindowRead | null {
  const { target, direction, window, noise, periodMs } = args;
  const finite = [...args.samples].filter((p) => Number.isFinite(p.value)).sort((a, b) => b.at - a.at);
  if (!finite.length) return null;
  const partial = args.partialLatest && finite.length ? finite[0]! : null;
  const samples = partial ? finite.slice(1) : finite;
  const of = Math.max(1, Math.round(window.ms / periodMs));
  const scale = shareScale(args.unit, args.targetText, finite.map((p) => p.value));
  const pooled = noise?.kind === "binomial" || noise?.kind === "ratio";
  const weights = noise?.kind === "binomial" && noise.n ? samples.map(() => noise.n!) : pooled ? denominatorsAt(samples, args.denominators ?? [], periodMs) : null;
  const read: WindowPeriod[] = [
    ...(partial ? [{ from: partial.at - periodMs, to: partial.at, value: partial.value, partial: true }] : []),
    ...samples.map((p, i) => ({ from: args.cohort ? p.at : p.at - periodMs, to: args.cohort ? p.at + periodMs : p.at, value: p.value, ...(weights ? { weight: weights[i]! } : {}) })),
  ].sort((a, b) => b.to - a.to);
  const k = samples.length;
  const base = { of, period: periodWord(periodMs), window: args.windowText, read, pooling: (pooled ? "pooled" : "mean") as WindowRead["pooling"] };
  if (!k) return { ...base, periods: 0, mean: partial!.value, low: null, high: null, spread: null, standing: "unknown", mde: null, note: "only the current period so far, which never counts" };
  const values = samples.map((p) => p.value);
  const plainMean = values.reduce((s, v) => s + v, 0) / k;
  let note: string | undefined;
  const counted = noise?.kind === "poisson" || noise?.kind === "binomial";
  if (counted && values.some((v) => v < 0)) note = `a ${noise!.kind} model cannot read negative values`;
  else if (noise?.kind === "binomial" && values.some((v) => v > scale)) note = `a share above ${scale === 100 ? "100%" : "1"} is not a binomial rate`;
  else if (pooled && !weights) note = `its denominator ${(noise as { series?: string }).series ?? ""} has no value at every period read`.replace("  ", " ");
  else if (pooled && weights!.some((w) => !(w > 0))) note = "a period with no denominator cannot be pooled";
  const total = weights ? weights.reduce((s, w) => s + w, 0) : 0;
  const mean = pooled && !note ? values.reduce((s, v, i) => s + v * weights![i]!, 0) / total : plainMean;
  // The periods' own spread: the sample sd of the values, and for a pooled read the ratio estimator's.
  const observedSe = k >= 2 ? (pooled && weights ? Math.sqrt((k / (k - 1)) * values.reduce((s, v, i) => s + ((v - mean) * weights[i]!) ** 2, 0)) / total : Math.sqrt(values.reduce((s, v) => s + (v - plainMean) ** 2, 0) / (k - 1) / k)) : 0;
  const tq = k >= 2 ? tQuantile(0.9, k - 1) : BAND_Z;
  const tBand = (se: number) => ({ low: mean - tq * se, high: mean + tq * se });
  let band: { low: number; high: number } | null = null;
  let modelSe = 0;
  if (!note && noise) {
    if (noise.kind === "poisson") {
      // Quasi-Poisson: the exact band on the count deflated by phi, scaled back.
      const phi = noise.phi ?? 1;
      const b = poissonBand((mean * k) / phi);
      band = { low: (b.low * phi) / k, high: (b.high * phi) / k };
      modelSe = Math.sqrt((phi * Math.max(mean, 0)) / k);
    } else if (noise.kind === "aa") {
      modelSe = noise.sd / Math.sqrt(k);
      band = { low: mean - BAND_Z * modelSe, high: mean + BAND_Z * modelSe };
    } else if (noise.kind === "binomial") {
      const w = wilsonBand((mean / scale) * total, total);
      band = { low: w.low * scale, high: w.high * scale };
      modelSe = Math.sqrt(((mean / scale) * (1 - mean / scale)) / total) * scale;
    } else {
      // A ratio over a Poisson denominator: its relative error is at least 1/√(the denominator's total).
      modelSe = Math.abs(mean) / Math.sqrt(total);
      band = { low: mean - BAND_Z * modelSe, high: mean + BAND_Z * modelSe };
    }
  }
  const observed = !!band && observedSe > modelSe;
  if (band && observed) {
    if (noise!.kind === "poisson") {
      // A count keeps its skewed shape: the exact band at the dispersion the periods show, widened by t over z for a spread read off few periods.
      const phi = (observedSe ** 2 * k) / Math.max(mean, 1e-12);
      const b = poissonBand((mean * k) / phi);
      const widen = tq / BAND_Z;
      band = { low: mean - (mean - (b.low * phi) / k) * widen, high: mean + ((b.high * phi) / k - mean) * widen };
    } else band = tBand(observedSe);
    if (noise!.kind === "binomial") band = { low: Math.max(0, band.low), high: Math.min(scale, band.high) };
    if (values.every((v) => v >= 0)) band = { low: Math.max(0, band.low), high: band.high };
  }
  let standing: WindowStanding = target === null || note
    ? "unknown"
    : band
      ? direction === "at_least"
        ? band.low >= target ? "met" : band.high < target ? "behind" : "within_noise"
        : band.high <= target ? "met" : band.low > target ? "behind" : "within_noise"
      : direction === "at_least" ? (mean >= target ? "met" : "behind") : (mean <= target ? "met" : "behind");
  // A target on the edge of what the model can say (no events at all, every
  // one a success) no band can ever clear: there the window itself decides.
  const edge = target !== null && band && counted && (direction === "at_most" ? target <= 0 : noise?.kind === "binomial" && target >= scale);
  if (edge && standing === "within_noise" && (direction === "at_most" ? mean <= target : mean >= target)) standing = "met";
  // One lucky period never passes: met needs the whole window read.
  if (standing === "met" && k < of) { standing = "within_noise"; note = `met needs all ${of} ${periodWord(periodMs)}s read`; }
  const mdePeriods = (MDE_WEEKS * WEEK) / periodMs;
  const sdPerPeriod = Math.max(modelSe, observedSe) * Math.sqrt(k);
  const mde = !noise || (note && !note.startsWith("met needs")) ? null : noise.kind === "ratio"
    // A ratio detects what a count with its relative spread would: 1/cv² events a period.
    ? minimumDetectableLift(mean ** 2 / Math.max(sdPerPeriod ** 2, 1e-12), { kind: "poisson" }, mdePeriods)
    : noise.kind === "poisson"
      ? minimumDetectableLift(mean, { kind: "poisson", phi: Math.max(noise.phi ?? 1, observed ? (sdPerPeriod ** 2) / Math.max(mean, 1e-12) : 0) }, mdePeriods)
      : noise.kind === "aa"
        ? minimumDetectableLift(mean, { kind: "aa", sd: Math.max(noise.sd, sdPerPeriod) }, mdePeriods)
        : minimumDetectableLift(mean, { kind: "binomial" }, mdePeriods, { n: (total / k) / (observed ? (observedSe / modelSe) ** 2 : 1), scale });
  return { ...base, periods: k, mean, low: band?.low ?? null, high: band?.high ?? null, spread: band ? (observed ? "observed" : "model") : null, standing, mde, ...(note ? { note } : {}) };
}

function denominatorsAt(samples: readonly Pt[], denoms: readonly Pt[], periodMs: number): number[] | null {
  const out: number[] = [];
  for (const s of samples) {
    let best: Pt | null = null;
    for (const d of denoms) if (Math.abs(d.at - s.at) <= periodMs * SLOT_TOLERANCE && (!best || Math.abs(d.at - s.at) < Math.abs(best.at - s.at))) best = d;
    if (!best) return null;
    out.push(best.value);
  }
  return out;
}

/** "±52%": a relative change as a person reads it, whole percent from 10 up. */
export function mdeWords(mde: number | null): string | null {
  if (mde === null || !Number.isFinite(mde)) return null;
  const pct = mde * 100;
  return `±${pct >= 10 ? Math.round(pct) : Number(pct.toPrecision(2))}%`;
}

// ── The metric as written and read ──────────────────────────────────────────

type SpecMetric = { name: string; target: string; series?: string; window?: string; noise?: string; guardrail?: boolean };
type WindowedMetric = { name: string; target: string; series?: string; window?: string; noise?: string };
type SeriesLike = { name: string; unit?: string | null; points: readonly Pt[]; history?: readonly Pt[]; cohorts?: readonly Pt[]; dropped?: number; last_error?: string | null };

/**
 * A metric as a person types it on the command line: `name=target`, then
 * `@mw-N` to read it live from a series, `window 3w` and `noise poisson` to
 * read it over a window with a noise band, and `guardrail` to mark it one:
 * "Intros a week=at least 60 @mw-14 window 3w noise poisson",
 * "Bounce rate=under 3% @mw-14 guardrail". Null when it is not that shape.
 */
export function parseMetricSpec(text: string): SpecMetric | null {
  const at = text.indexOf("=");
  if (at <= 0) return null;
  let rest = text.slice(at + 1);
  const take = (re: RegExp): string | undefined => {
    const m = rest.match(re);
    if (m) rest = rest.replace(re, " ");
    return m?.[1]?.toLowerCase();
  };
  const series = take(/(?:^|\s)@(mw-\d+)\b/i);
  // window, noise and guardrail are trailing words, in any order, and a window
  // or noise word counts only with a value that reads as one: "at most 3 noise
  // complaints" keeps its words.
  let window: string | undefined, noise: string | undefined, guardrail = false;
  for (;;) {
    const g = rest.match(/\s+guardrail\s*$/i);
    const w = rest.match(/\s+window\s+(\S+)\s*$/i);
    const n = rest.match(/\s+noise\s+(\S+)\s*$/i);
    if (g && !guardrail) { guardrail = true; rest = rest.slice(0, g.index); }
    else if (w && !window && parseMetricWindow(w[1])) { window = w[1]!.toLowerCase(); rest = rest.slice(0, w.index); }
    else if (n && !noise && parseMetricNoise(n[1])) { noise = n[1]!.toLowerCase(); rest = rest.slice(0, n.index); }
    else break;
  }
  const name = text.slice(0, at).trim(), target = rest.trim();
  if (!name || !target) return null;
  return { name, target, ...(series ? { series } : {}), ...(window ? { window } : {}), ...(noise ? { noise } : {}), ...(guardrail ? { guardrail: true } : {}) };
}
/** A metric back in the shape parseMetricSpec reads. */
export const metricSpec = (m: SpecMetric): string =>
  `${m.name}=${m.target}${m.series ? ` @${m.series}` : ""}${m.window ? ` window ${m.window}` : ""}${m.noise ? ` noise ${m.noise}` : ""}${m.guardrail ? " guardrail" : ""}`;

/**
 * A metric with a window read over it: from its live series (the newest
 * points and any history the server read for the slots), else from the one
 * reported value as a single period. Null when the metric names no window,
 * or nothing is there to read.
 */
export function metricBand(
  metric: WindowedMetric,
  /** The target in force at a time: a window is judged against the one in force at its end. */
  targetAt: (at: number) => number | null,
  direction: "at_least" | "at_most",
  series: SeriesLike | null | undefined,
  reported: { value: number; at: number } | null,
  lookup?: (ref: string) => SeriesLike | null | undefined,
): WindowRead | null {
  const plan = windowPlan(metric, series);
  if (!plan) return null;
  const { window, periodMs, slots, partialLatest } = plan;
  const noise = parseMetricNoise(metric.noise);
  // A source that dates its own periods (a reader's cohort weeks) is read by them, the newest first; its polls only feed the live value.
  const cohorts = series?.cohorts?.length ? [...series.cohorts].sort((a, b) => b.at - a.at).slice(0, plan.of) : null;
  const samples = cohorts ?? (series?.points.length ? windowSamples(seriesPool(series), periodMs, slots) : reported ? [{ at: reported.at, value: reported.value }] : []);
  const by = metricDenominatorRef(metric);
  const denomSeries = by ? lookup?.(by) : null;
  const denominators = denomSeries ? (cohorts && denomSeries.cohorts?.length ? denomSeries.cohorts : seriesPool(denomSeries)) : null;
  const newest = samples.length ? Math.max(...samples.map((p) => p.at)) : null;
  const target = newest === null ? null : targetAt(cohorts ? newest + periodMs : newest);
  const r = readWindow({ samples, denominators, target, direction, window, windowText: metric.window!, periodMs, noise, unit: series?.unit, targetText: metric.target, partialLatest: !cohorts && partialLatest && !!series?.points.length, cohort: !!cohorts });
  if (!r) return r;
  // Polls stand in for a source that is failing: say so, and never call it met on them alone.
  const failing = !cohorts && series?.points.length && series.last_error ? series.last_error : undefined;
  const held = failing && r.standing === "met" ? { standing: "within_noise" as const, note: r.note ?? "not met while its source fails" } : {};
  return { ...r, ...held, against: target, ...(by ? { by } : {}), ...(cohorts ? { cohort: true } : {}), ...(series?.dropped ? { dropped: series.dropped } : {}), ...(failing ? { failing } : {}) };
}

/** Every value a series holds: its newest points and the history read for a window's slots. */
export const seriesPool = (s: SeriesLike): Pt[] => [...s.points, ...(s.history ?? [])];

/**
 * How a metric's window reads its series: the period, how many slots back
 * from the newest value (one more when the newest is the current period so
 * far, which is read and never counted). One plan for the server's history
 * read, the web's feeder and the reading itself.
 */
export function windowPlan(metric: { name: string; window?: string }, series: { name: string; unit?: string | null } | null | undefined): { window: MetricWindow; periodMs: number; of: number; slots: number; partialLatest: boolean } | null {
  const window = parseMetricWindow(metric.window);
  if (!window) return null;
  const periodMs = metricPeriodMs(`${metric.name} ${series?.name ?? ""} ${series?.unit ?? ""}`, window);
  const of = Math.max(1, Math.round(window.ms / periodMs));
  const partialLatest = PARTIAL_WORDS.test(`${metric.name} ${series?.name ?? ""}`);
  return { window, periodMs, of, slots: of + (partialLatest ? 1 : 0), partialLatest };
}

/** The standing the band says, in the words every surface uses. */
export const STANDING_WORD: Record<WindowStanding, string> = { met: "met", within_noise: "within noise", behind: "behind", unknown: "" };

/** "over 3 weeks (mean 34, 80% band 29 to 40, detects ±52% in 4 weeks)", or "over 2 of 3 weeks (…)" while the series is young. */
export function bandWords(b: WindowRead, say: (n: number) => string): string {
  const value = b.pooling === "pooled" ? `pooled total over total${b.by ? ` by ${b.by}` : ""} ${say(b.mean)}` : `mean ${say(b.mean)}`;
  const band = b.low !== null && b.high !== null ? `, 80% band ${say(b.low)} to ${say(b.high)}${b.spread === "observed" ? ` from the ${b.period}s' own spread` : ""}` : "";
  const mde = mdeWords(b.mde);
  const partial = b.read.some((p) => p.partial) ? `; the current ${b.period} so far not counted` : "";
  const dropped = b.dropped ? `; ${b.dropped} value${b.dropped === 1 ? "" : "s"} of an older definition left out` : "";
  const failing = b.failing ? `; read from stored polls while its source fails (${b.failing})` : "";
  const unit = b.cohort ? `cohort ${b.period}` : b.period;
  const span = b.periods < b.of ? `${b.periods} of ${b.of} ${unit}s` : `${b.of} ${unit}${b.of === 1 ? "" : "s"}`;
  return `over ${span} (${value}${band}${mde ? `, detects ${mde} in ${MDE_WEEKS} weeks` : ""}${partial}${dropped}${failing}${b.note ? `; ${b.note}` : ""})`;
}

/** "11-10 to 11-17 37 · 11-04 to 11-11 22 (×13)": each period read with its dates (UTC), its value and any weight. */
export function periodsWords(b: WindowRead, say: (n: number) => string): string {
  const day = (t: number) => { const d = new Date(t); return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; };
  if (b.cohort) return b.read.map((p) => `${b.period} of ${day(p.from)} ${say(p.value)}${p.weight !== undefined ? ` (×${formatCount(p.weight)})` : ""}`).join(" · ");
  return b.read.map((p) => `${day(p.from)} to ${day(p.to)} ${say(p.value)}${p.weight !== undefined ? ` (×${formatCount(p.weight)})` : ""}${p.partial ? " (so far, not counted)" : ""}`).join(" · ");
}
const formatCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ── The target as written ───────────────────────────────────────────────────

export type MetricDirection = "at_least" | "at_most";
/** One dated point of a trajectory: the number in force on that day (UTC midnight). */
export type TrajectoryPoint = { value: number; at: number };
/**
 * A target read narrowly: a number with an optional unit and direction ("at
 * least 60", "under $250", "0.2%", "10,000", "16/week or more"), or a dated
 * trajectory of them ("at least 51.2%@2026-11-16 53.1%@2026-11-30"). The
 * target in force between two points is linear between them; before the
 * first it is the first, after the last the last.
 */
export type MetricTarget =
  | { kind: "number"; value: number; direction: MetricDirection; unit: string | null }
  | { kind: "trajectory"; points: TrajectoryPoint[]; direction: MetricDirection; unit: string | null };

const NUMBER = String.raw`(\$)?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*([km](?![a-z]))?`;
const UNIT = String.raw`(%|\s*\/\s*(?:day|week|wk|month|hour|year)\b|\s+(?:a|per)\s+(?:day|week|month|hour|year)\b)?`;
const ONE = new RegExp(`^${NUMBER}${UNIT}$`, "i");
const DATED = new RegExp(`^${NUMBER}${UNIT}@(\\d{4})-(\\d{2})-(\\d{2})$`, "i");
const LEAST_WORDS = /^(?:at least|>=|≥|>|over|above|min(?:imum)?)(?=[\s$\d-])\s*/i;
const MOST_WORDS = /^(?:at most|<=|≤|<|under|below|no more than|max(?:imum)?)(?=[\s$\d-])\s*/i;
const LEAST_TAIL = /\s+or\s+(?:more|higher|above|greater)$/i;
const MOST_TAIL = /\s+or\s+(?:less|fewer|lower|under|below)$/i;

const unitOf = (dollar: string | undefined, unit: string | undefined): string | null => {
  if (dollar) return "$";
  const u = unit?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (!u) return null;
  if (u === "%") return "%";
  return `/${u.replace(/^\/\s*|^(?:a|per) /, "").replace(/^wk$/, "week")}`;
};
const numberOf = (digits: string, scale: string | undefined): number => Number(digits.replace(/,/g, "")) * (scale?.toLowerCase() === "k" ? 1_000 : scale?.toLowerCase() === "m" ? 1_000_000 : 1);

/** The target read as a number or a trajectory, or null when its words are anything else ("1% higher (Cameron)", "judged per week"). */
export function parseMetricTarget(text: string | null | undefined): MetricTarget | null {
  let t = (text ?? "").trim().replace(/\s+/g, " ");
  let direction: MetricDirection | null = null;
  const lead = t.match(LEAST_WORDS) ?? t.match(MOST_WORDS);
  if (lead) { direction = LEAST_WORDS.test(t) ? "at_least" : "at_most"; t = t.slice(lead[0].length); }
  const tail = t.match(LEAST_TAIL) ?? t.match(MOST_TAIL);
  if (tail) {
    const d: MetricDirection = LEAST_TAIL.test(t) ? "at_least" : "at_most";
    if (direction && direction !== d) return null;
    direction = d;
    t = t.slice(0, tail.index);
  }
  const one = t.match(ONE);
  if (one) return { kind: "number", value: numberOf(one[2]!, one[3]), direction: direction ?? "at_least", unit: unitOf(one[1], one[4]) };
  const parts = t.split(/\s*(?:,|→|->|\s)\s*/).filter(Boolean);
  if (parts.length < 1) return null;
  const points: TrajectoryPoint[] = [];
  let unit: string | null | undefined;
  for (const part of parts) {
    const m = part.match(DATED);
    if (!m) return null;
    const at = Date.UTC(Number(m[5]), Number(m[6]) - 1, Number(m[7]));
    if (!Number.isFinite(at) || new Date(at).getUTCDate() !== Number(m[7])) return null;
    const u = unitOf(m[1], m[4]);
    if (unit !== undefined && u !== unit) return null;
    unit = u;
    if (points.length && at <= points[points.length - 1]!.at) return null;
    points.push({ value: numberOf(m[2]!, m[3]), at });
  }
  return { kind: "trajectory", points, direction: direction ?? "at_least", unit: unit ?? null };
}

/** The number a target holds at time `at`: the number itself, or a trajectory's linear value between its points. */
export function targetAt(target: MetricTarget, at: number): number {
  if (target.kind === "number") return target.value;
  const p = target.points;
  if (at <= p[0]!.at) return p[0]!.value;
  for (let i = 1; i < p.length; i++) {
    if (at <= p[i]!.at) return p[i - 1]!.value + ((p[i]!.value - p[i - 1]!.value) * (at - p[i - 1]!.at)) / (p[i]!.at - p[i - 1]!.at);
  }
  return p[p.length - 1]!.value;
}
/** The point a trajectory heads for next after `at`, else its last. */
export const nextTrajectoryPoint = (target: Extract<MetricTarget, { kind: "trajectory" }>, at: number): TrajectoryPoint => target.points.find((p) => p.at > at) ?? target.points[target.points.length - 1]!;

/** How long a trajectory target may be: a dozen dated points. */
export const TRAJECTORY_TARGET_MAX = 240;

/** Why a target is not read: its words are not a number with a direction. */
export const TARGET_UNREAD = "target isn't a number";

/** A dated target as a reading carries it: the number in force when the value was read, the point it heads for next, its last point and the standing against that. */
export type MetricTrajectory = { in_force: number; at: number; next: TrajectoryPoint; final: TrajectoryPoint; final_standing: WindowStanding; final_band?: WindowRead | null; unit: string | null };
const TRAJECTORY_WORD: Record<WindowStanding, string> = { met: "on trajectory", within_noise: "within noise of its trajectory", behind: "behind trajectory", unknown: "" };
/** A standing in the words every surface uses: against a trajectory it reads "on trajectory" or "behind trajectory". */
export const standingWord = (standing: WindowStanding, trajectory?: MetricTrajectory | null): string => (trajectory ? TRAJECTORY_WORD : STANDING_WORD)[standing];
/** "28 Dec": a trajectory point's day. */
export const pointDay = (at: number): string => { const d = new Date(at); return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`; };

// ── The executable done-when ────────────────────────────────────────────────

type PredicateMetric = { name: string; target: string; window?: string; noise?: string; guardrail?: boolean };
type PredicateReading = PredicateMetric & { standing: WindowStanding; band?: WindowRead | null; trajectory?: { final: TrajectoryPoint; final_standing: WindowStanding; final_band?: WindowRead | null } | null };

/**
 * Whether a goal's numbers make an executable done-when: at least one number
 * that is not a guardrail has a target that reads as a number, and every such
 * number names a window and a noise model. A number whose target does not
 * read stays out (doneWhenPredicate says which and why).
 */
export const isExecutableDoneWhen = (metrics: ReadonlyArray<PredicateMetric> | undefined): boolean => {
  const climbed = (metrics ?? []).filter((m) => !m.guardrail && parseMetricTarget(m.target));
  return climbed.length > 0 && climbed.every((m) => parseMetricWindow(m.window) && parseMetricNoise(m.noise));
};

/**
 * The executable done-when, when the goal's numbers make one: one clause per
 * climbed number with a readable target, the bound it reads and what that
 * bound says now (a trajectory is done at its final point), the numbers it
 * left out and why, and the verdict over the clauses. Met only when every
 * clause is; behind when any is; within noise otherwise.
 */
export function doneWhenPredicate(readings: readonly PredicateReading[], say: (r: PredicateReading, n: number) => string): { verdict: WindowStanding; clauses: Array<{ text: string; standing: WindowStanding }>; left_out: Array<{ name: string; why: string }> } | null {
  if (!isExecutableDoneWhen(readings)) return null;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const left_out = readings.filter((r) => !r.guardrail && !parseMetricTarget(r.target)).map((r) => ({ name: r.name, why: `${TARGET_UNREAD} ("${r.target}")` }));
  const clauses = readings.filter((r) => !r.guardrail && parseMetricTarget(r.target)).map((r) => {
    const target = parseMetricTarget(r.target)!;
    const upper = target.direction === "at_most";
    const band = r.trajectory ? r.trajectory.final_band ?? r.band : r.band;
    const standing = r.trajectory ? r.trajectory.final_standing : r.standing;
    const bound = band ? (upper ? band.high : band.low) : null;
    const now = band?.note ?? (bound === null ? "no reading yet" : `${upper ? "upper" : "lower"} bound now ${say(r, bound)}`);
    const goal = r.trajectory ? `${upper ? "at most" : "at least"} ${say(r, r.trajectory.final.value)} by ${day(r.trajectory.final.at)}, the end of its trajectory` : r.target;
    return { text: `${r.name} ${goal}, at the ${upper ? "upper" : "lower"} edge of its 80% band over ${r.window}, noise ${r.noise}: ${STANDING_WORD[standing] || "unread"} (${now})`, standing };
  });
  const verdict: WindowStanding = clauses.some((c) => c.standing === "behind") ? "behind" : clauses.every((c) => c.standing === "met") ? "met" : clauses.some((c) => c.standing === "unknown") ? "unknown" : "within_noise";
  return { verdict, clauses, left_out };
}

/** The denominator series a `binomial:mw-N` model names, or undefined. */
export const metricDenominatorRef = (m: { noise?: string }): string | undefined => {
  const n = parseMetricNoise(m.noise);
  return n?.kind === "binomial" || n?.kind === "ratio" ? n.series : undefined;
};

type ShapedMetric = { name: string; target: string; series?: string; guardrail?: boolean; window?: string; noise?: string };
/** A metric as a change compares it: its series, guardrail, window and noise are part of it. */
export const metricShape = (m: ShapedMetric) => [m.name.trim(), m.target.trim(), m.series?.trim().toLowerCase() ?? null, !!m.guardrail, m.window?.trim().toLowerCase() || null, m.noise?.trim().toLowerCase() || null];
/**
 * Metrics a change proposes, each keeping the window and noise the goal reads
 * it with when the change names it (by name) without its own, and its target
 * stays the same kind (a share stays a share): a retarget never drops how a
 * number is read, and a count turned rate never carries a count's model.
 */
export function keepMetricReads<T extends ShapedMetric>(held: readonly ShapedMetric[], proposed: readonly T[]): T[] {
  const byName = new Map(held.map((m) => [m.name.trim().toLowerCase(), m]));
  const share = (t: string) => /%/.test(t);
  return proposed.map((m) => {
    const h = byName.get(m.name.trim().toLowerCase());
    const keeps = h && share(h.target) === share(m.target);
    return { ...(keeps && h.window ? { window: h.window } : {}), ...(keeps && h.noise ? { noise: h.noise } : {}), ...m };
  });
}
