// A goal metric read over a window with a noise band (the goal layer design,
// "an executable done-when with a noise band"): one reading against the
// target lets a lucky week pass, so a metric that names a `window` ("3w") and
// a `noise` model ("poisson", "binomial:<n or mw-N>", "aa:<sd>") is read as
// the mean of that many non-overlapping periods with an 80% band around it.
// It is met when the whole band clears the target, behind when the whole band
// misses it, and within noise otherwise. Beside the band it states the
// smallest change a 50/50 test could detect in 4 weeks at the current level
// (80% power, two-sided 5%), so a role stops reading noise as progress.
// Pure: initiative.ts reads through it, the server only gathers the points.

/** `phi` is a count's dispersion (quasi-Poisson: variance = phi × mean); absent is 1, plain Poisson. */
export type MetricNoise = { kind: "poisson"; phi?: number } | { kind: "binomial"; n?: number; series?: string } | { kind: "aa"; sd: number };
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
  const aa = t.match(/^aa:(\d+(?:\.\d+)?)$/);
  if (aa && Number(aa[1]) > 0) return { kind: "aa", sd: Number(aa[1]) };
  return null;
}

/** What a write must say when a window or a noise model does not parse; null when both are fine. */
export function metricWindowNoiseError(window?: string | null, noise?: string | null): string | null {
  if (window && !parseMetricWindow(window)) return `A window is whole weeks or days, at most 26 weeks: "3w", "14d", not "${window}"`;
  if (noise && !parseMetricNoise(noise)) return `A noise model is poisson or poisson:<dispersion ≥ 1> (counts), binomial:<n> or binomial:mw-N (a rate and its denominator), or aa:<sd> (a measured spread), not "${noise}"`;
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
 * `count` values one period apart, newest first, ending at the newest point:
 * for each slot the point nearest its time within half a period, each point
 * used once. A slot with no point near it is skipped, so a young series reads
 * fewer periods than asked rather than reusing one.
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
      if (used.has(p.at) || Math.abs(p.at - t) >= periodMs / 2) continue;
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
export type WindowRead = {
  /** Periods read, and the periods the window asks for. */
  periods: number;
  of: number;
  period: string;
  window: string;
  /** The window's mean per period, and its 80% band (null without a noise model). */
  mean: number;
  low: number | null;
  high: number | null;
  standing: WindowStanding;
  /** The smallest relative change a 4 week 50/50 test detects at this level; null without a model. */
  mde: number | null;
  /** Why the standing is not the band's plain verdict: the window is not full yet, or the noise model cannot read these values. */
  note?: string;
};

/**
 * A metric read over its window: the mean of the sampled periods, the band
 * its noise model puts around it, and the standing the band gives against
 * the target (the upper bound for a target to stay under). `denominators`
 * carries the denominator series' values at the same slots for a
 * `binomial:mw-N` model.
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
}): WindowRead | null {
  const { target, direction, window, noise } = args;
  const samples = args.samples.filter((p) => Number.isFinite(p.value));
  if (!samples.length) return null;
  const k = samples.length;
  const of = Math.max(1, Math.round(window.ms / args.periodMs));
  const mean = samples.reduce((s, p) => s + p.value, 0) / k;
  const scale = shareScale(args.unit, args.targetText, samples.map((p) => p.value));
  let band: { low: number; high: number } | null = null;
  let n: number | null = null;
  let note: string | undefined;
  const counted = noise?.kind === "poisson" || noise?.kind === "binomial";
  if (counted && samples.some((p) => p.value < 0)) note = `a ${noise!.kind} model cannot read negative values`;
  else if (noise?.kind === "binomial" && samples.some((p) => p.value > scale)) note = `a share above ${scale === 100 ? "100%" : "1"} is not a binomial rate`;
  else if (noise?.kind === "poisson") {
    // Quasi-Poisson: the exact band on the count deflated by phi, scaled back.
    const phi = noise.phi ?? 1;
    const b = poissonBand((mean * k) / phi);
    band = { low: (b.low * phi) / k, high: (b.high * phi) / k };
  } else if (noise?.kind === "aa") {
    const half = (BAND_Z * noise.sd) / Math.sqrt(k);
    band = { low: mean - half, high: mean + half };
  } else if (noise?.kind === "binomial") {
    const sizes = noise.n ? samples.map(() => noise.n!) : denominatorsAt(samples, args.denominators ?? [], args.periodMs);
    const total = sizes?.reduce((s, x) => s + x, 0) ?? 0;
    if (sizes && total > 0) {
      const wins = samples.reduce((s, p, i) => s + (p.value / scale) * sizes[i]!, 0);
      const w = wilsonBand(wins, total);
      band = { low: w.low * scale, high: w.high * scale };
      n = total / k;
    } else note = `its denominator ${noise.series ?? ""} has no value at every period read`.replace("  ", " ");
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
  if (standing === "met" && k < of) { standing = "within_noise"; note = `met needs all ${of} ${periodWord(args.periodMs)}s read`; }
  const mdePeriods = (MDE_WEEKS * WEEK) / args.periodMs;
  const mde = noise && !note?.includes("cannot") && !note?.includes("not a binomial") ? minimumDetectableLift(mean, noise, mdePeriods, { n, scale }) : null;
  return { periods: k, of, period: periodWord(args.periodMs), window: args.windowText, mean, low: band?.low ?? null, high: band?.high ?? null, standing, mde, ...(note ? { note } : {}) };
}

function denominatorsAt(samples: readonly Pt[], denoms: readonly Pt[], periodMs: number): number[] | null {
  const out: number[] = [];
  for (const s of samples) {
    let best: Pt | null = null;
    for (const d of denoms) if (Math.abs(d.at - s.at) < periodMs / 2 && (!best || Math.abs(d.at - s.at) < Math.abs(best.at - s.at))) best = d;
    if (!best || !(best.value > 0)) return null;
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
type SeriesLike = { name: string; unit?: string | null; points: readonly Pt[]; history?: readonly Pt[] };

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
  target: number | null,
  direction: "at_least" | "at_most",
  series: SeriesLike | null | undefined,
  reported: { value: number; at: number } | null,
  lookup?: (ref: string) => SeriesLike | null | undefined,
): WindowRead | null {
  const window = parseMetricWindow(metric.window);
  if (!window) return null;
  const noise = parseMetricNoise(metric.noise);
  const periodMs = metricPeriodMs(`${metric.name} ${series?.name ?? ""} ${series?.unit ?? ""}`, window);
  const of = Math.max(1, Math.round(window.ms / periodMs));
  const pool = (s: SeriesLike) => [...s.points, ...(s.history ?? [])];
  const samples = series?.points.length ? windowSamples(pool(series), periodMs, of) : reported ? [{ at: reported.at, value: reported.value }] : [];
  const denomSeries = noise?.kind === "binomial" && noise.series ? lookup?.(noise.series) : null;
  return readWindow({ samples, denominators: denomSeries ? pool(denomSeries) : null, target, direction, window, windowText: metric.window!, periodMs, noise, unit: series?.unit, targetText: metric.target });
}

/** The standing the band says, in the words every surface uses. */
export const STANDING_WORD: Record<WindowStanding, string> = { met: "met", within_noise: "within noise", behind: "behind", unknown: "" };

/** "over 3 weeks (mean 34, 80% band 29 to 40, detects ±52% in 4 weeks)", or "over 2 of 3 weeks (…)" while the series is young. */
export function bandWords(b: WindowRead, say: (n: number) => string): string {
  const over = b.periods < b.of ? `${b.periods} of ${b.of} ${b.period}s` : `${b.of} ${b.period}${b.of === 1 ? "" : "s"}`;
  const band = b.low !== null && b.high !== null ? `, 80% band ${say(b.low)} to ${say(b.high)}` : "";
  const mde = mdeWords(b.mde);
  return `over ${over} (mean ${say(b.mean)}${band}${mde ? `, detects ${mde} in ${MDE_WEEKS} weeks` : ""}${b.note ? `; ${b.note}` : ""})`;
}

/** Whether a goal's numbers make an executable done-when: every metric that is not a guardrail names a window and a noise model. */
export const isExecutableDoneWhen = (metrics: ReadonlyArray<{ window?: string; noise?: string; guardrail?: boolean }> | undefined): boolean => {
  const climbed = (metrics ?? []).filter((m) => !m.guardrail);
  return climbed.length > 0 && climbed.every((m) => parseMetricWindow(m.window) && parseMetricNoise(m.noise));
};

type PredicateReading = { name: string; target: string; window?: string; noise?: string; guardrail?: boolean; standing: WindowStanding; band?: WindowRead | null };

/**
 * The executable done-when, when the goal's numbers make one
 * (isExecutableDoneWhen): one clause per climbed number, the bound it reads
 * and what that bound says now, and the verdict over all of them. Met only
 * when every clause is; behind when any is; within noise otherwise.
 */
export function doneWhenPredicate(readings: readonly PredicateReading[], direction: (target: string) => "at_least" | "at_most", say: (r: PredicateReading, n: number) => string): { verdict: WindowStanding; clauses: Array<{ text: string; standing: WindowStanding }> } | null {
  if (!isExecutableDoneWhen(readings)) return null;
  const clauses = readings.filter((r) => !r.guardrail).map((r) => {
    const upper = direction(r.target) === "at_most";
    const bound = r.band ? (upper ? r.band.high : r.band.low) : null;
    const now = r.band?.note ?? (bound === null ? "no reading yet" : `${upper ? "upper" : "lower"} bound now ${say(r, bound)}`);
    return { text: `${r.name} ${r.target}, at the ${upper ? "upper" : "lower"} edge of its 80% band over ${r.window}, noise ${r.noise}: ${STANDING_WORD[r.standing] || "unread"} (${now})`, standing: r.standing };
  });
  const verdict: WindowStanding = clauses.some((c) => c.standing === "behind") ? "behind" : clauses.every((c) => c.standing === "met") ? "met" : clauses.some((c) => c.standing === "unknown") ? "unknown" : "within_noise";
  return { verdict, clauses };
}

/** The denominator series a `binomial:mw-N` model names, or undefined. */
export const metricDenominatorRef = (m: { noise?: string }): string | undefined => {
  const n = parseMetricNoise(m.noise);
  return n?.kind === "binomial" ? n.series : undefined;
};
