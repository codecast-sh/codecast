// The event stream's readings (the Ops Timeline tab): its query language,
// facets, time range, histogram, and the swimlanes' clustering in pixels.
// The URL carries the filter as one query string (`q`) and the range as one
// word (`win`), so a filtered view is a link. Pure: no React, no store.
import type { OpsEvent, OpsGroup, OpsSample, OpsSource } from "./opsTypes";
import { eventSourceName, isReleaseMarker } from "./opsModel";
import { knownSilence, requestLevel, requestLine } from "./sourceViewModel";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ── Facets ──

export const FACETS = ["source", "kind", "type", "level", "status"] as const;
export type Facet = (typeof FACETS)[number];

export const FACET_LABEL: Record<Facet, string> = { source: "Source", kind: "Kind", type: "Type", level: "Level", status: "Status" };

/** Severities. Anything else a vendor puts in its level field (request, rage_click, job) is a type of event, not how loud it is. */
export const LEVELS = new Set(["fatal", "critical", "error", "warning", "warn", "info", "log", "debug"]);

/** A raw level field split into a level and a type: `error` is a level, `rage_click` a type. */
export function splitLevel(raw: string | null | undefined): { level: string | null; type: string | null } {
  const v = raw?.toLowerCase() || null;
  if (!v) return { level: null, type: null };
  return LEVELS.has(v) ? { level: v, type: null } : { level: null, type: v };
}

/** What a row is under each facet: where it came from, what kind of thing, how loud, what happened to it. */
export function eventFacets(e: OpsEvent): Record<Facet, string | null> {
  const status = e.data?.transition ?? (isReleaseMarker(e) ? "deploy" : e.kind);
  return {
    source: eventSourceName(e),
    kind: isReleaseMarker(e) ? "deploy" : e.data?.group_kind ?? null,
    ...splitLevel(e.data?.level),
    status,
  };
}

/** The filter a query string names: facet values (any of, within a facet; all facets must hold) and free words. */
export type TimelineFilter = { facets: Record<Facet, Set<string>>; text: string };

const emptyFacets = (): Record<Facet, Set<string>> => ({ source: new Set(), kind: new Set(), type: new Set(), level: new Set(), status: new Set() });

/**
 * `source:web,api kind:error checkout failed`: a facet token is `<facet>:<a,b>`,
 * anything else is text. A value with a space is quoted (`source:"my app"`).
 */
export function parseTimelineQuery(q: string | null | undefined): TimelineFilter {
  const facets = emptyFacets();
  const words: string[] = [];
  const value = String.raw`(?:"[^"]*"|[^\s,"]+)`;
  const re = new RegExp(String.raw`(\w+):(${value}(?:,${value})*)|"[^"]*"|\S+`, "g");
  for (const m of (q ?? "").matchAll(re)) {
    const facet = m[1] as Facet | undefined;
    if (facet && (FACETS as readonly string[]).includes(facet)) {
      for (const v of m[2].match(new RegExp(value, "g")) ?? []) {
        const clean = v.replace(/^"|"$/g, "").trim();
        if (clean) facets[facet].add(clean);
      }
    } else words.push(m[0]);
  }
  return { facets, text: words.join(" ").trim() };
}

const quote = (v: string) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

export function formatTimelineQuery(f: TimelineFilter): string {
  const parts: string[] = [];
  for (const facet of FACETS) {
    const vals = [...f.facets[facet]];
    if (vals.length) parts.push(`${facet}:${vals.map(quote).join(",")}`);
  }
  if (f.text) parts.push(f.text);
  return parts.join(" ");
}

/** The query with one facet value turned on or off. */
export function toggleFacet(q: string | null | undefined, facet: Facet, value: string, only = false): string {
  const f = parseTimelineQuery(q);
  const set = f.facets[facet];
  if (only) {
    const was = set.size === 1 && set.has(value);
    set.clear();
    if (!was) set.add(value);
  } else if (!set.delete(value)) set.add(value);
  return formatTimelineQuery(f);
}

export function isEmptyFilter(f: TimelineFilter): boolean {
  return !f.text && FACETS.every((k) => f.facets[k].size === 0);
}

/** Whether a row passes every facet but `skip` (a facet's own counts ignore its own selection), and the text. */
export function admits(e: OpsEvent, f: TimelineFilter, skip?: Facet): boolean {
  const v = eventFacets(e);
  for (const facet of FACETS) {
    if (facet === skip) continue;
    const set = f.facets[facet];
    if (set.size && !(v[facet] && set.has(v[facet]!))) return false;
  }
  if (f.text) {
    const hay = `${e.title} ${e.data?.group_short_id ?? ""} ${e.data?.release ?? ""} ${e.data?.environment ?? ""} ${e.meta?.deploy ?? ""}`.toLowerCase();
    for (const word of f.text.toLowerCase().split(/\s+/)) if (word && !hay.includes(word.replace(/^"|"$/g, ""))) return false;
  }
  return true;
}

/**
 * Each facet's values with how many rows in range would show with that value
 * picked, Datadog style: a facet's counts ignore its own selection, so picking
 * one value never zeroes its siblings.
 */
export function facetCounts(events: readonly OpsEvent[], f: TimelineFilter): Record<Facet, { value: string; n: number }[]> {
  const out = {} as Record<Facet, { value: string; n: number }[]>;
  for (const facet of FACETS) {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (!admits(e, f, facet)) continue;
      const v = eventFacets(e)[facet];
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    // A picked value stays listed at zero, so it can be turned off.
    for (const v of f.facets[facet]) if (!counts.has(v)) counts.set(v, 0);
    out[facet] = [...counts].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  }
  return out;
}

// ── Occurrences ──

/** What the stream's rows are: what changed (transitions), or each kept occurrence (the groups' samples). */
export type RowsView = "transitions" | "occurrences";

/**
 * An occurrence's level and type. A vendor's level field often names a type
 * (`request`, `rage_click`): the type stays the type, and the level comes
 * from what happened, so a 404 reads warning and a 502 error, never "request".
 */
export function sampleLevel(x: Pick<OpsSample, "level" | "message">, g?: Pick<OpsGroup, "kind" | "level">): { level: string | null; type: string | null } {
  const own = splitLevel(x.level);
  const theirs = splitLevel(g?.level);
  const type = own.type ?? theirs.type;
  const level = own.level ?? theirs.level;
  if (level) return { level, type };
  const req = requestLine(x.message);
  if (req) return { level: requestLevel(req), type: type ?? "request" };
  if (type === "rage_click" || type === "dead_click") return { level: "warning", type };
  // A failed CI check or job is an error: its occurrence is the failure, and the vendor sends no level for it.
  return { level: g && LOUD_KINDS.has(g.kind) ? "error" : null, type };
}

/** Issue kinds whose every kept occurrence is a failure. */
const LOUD_KINDS: ReadonlySet<string> = new Set(["error", "check", "job"]);

/** The Kind bucket of an occurrence whose issue this device does not hold (resolved long ago, or past the open feeder): still counted, never dropped from the facet. */
export const UNKNOWN_KIND = "other";

/** An occurrence under the facets that apply to it: its source, its issue's kind, its level and type. Status is a transition's. */
export function sampleFacets(x: Pick<OpsSample, "source_id" | "group_id" | "level"> & Partial<Pick<OpsSample, "message">>, sources: ReadonlyMap<string, Pick<OpsSource, "name">>, groups: ReadonlyMap<string, Pick<OpsGroup, "kind" | "level">>): Record<Facet, string | null> {
  const g = groups.get(x.group_id);
  return { source: sources.get(x.source_id)?.name ?? null, kind: g?.kind ?? UNKNOWN_KIND, ...sampleLevel(x, g), status: null };
}

/**
 * Kinds an occurrence list leaves out until the Kind facet names them: a
 * metric watch's reading is a poll, not something that happened, and a busy
 * watch would otherwise fill the list.
 */
export const OFF_BY_DEFAULT_KINDS = new Set(["metric"]);

/** Whether an occurrence passes the filter: each facet it has a value for, and the words over its message, url, user and release. */
export function admitsSample(v: Record<Facet, string | null>, x: Pick<OpsSample, "message" | "url" | "release" | "environment" | "user">, f: TimelineFilter, skip?: Facet): boolean {
  if (skip !== "kind" && !f.facets.kind.size && v.kind && OFF_BY_DEFAULT_KINDS.has(v.kind)) return false;
  for (const facet of FACETS) {
    if (facet === skip || facet === "status") continue;
    const set = f.facets[facet];
    if (set.size && !(v[facet] && set.has(v[facet]!))) return false;
  }
  if (f.text) {
    const hay = `${x.message ?? ""} ${x.url ?? ""} ${x.release ?? ""} ${x.environment ?? ""} ${x.user?.email ?? ""} ${x.user?.name ?? ""} ${x.user?.id ?? ""}`.toLowerCase();
    for (const word of f.text.toLowerCase().split(/\s+/)) if (word && !hay.includes(word.replace(/^"|"$/g, ""))) return false;
  }
  return true;
}

/** A facet value with how many rows show with it picked. `off`: left out of the list until picked (OFF_BY_DEFAULT_KINDS), so its count is not part of the listed total. */
export type FacetRow = { value: string; n: number; off?: boolean; /** The rows with no value under this facet, so the group adds up to the rows kept. */ none?: boolean };

/**
 * facetCounts for occurrences: each facet's values with how many would show
 * with it picked. A kind the list leaves out by default is still offered,
 * marked off and listed last, so the counts of the values that are on add up
 * to the rows listed.
 */
export function sampleFacetCounts<T extends Pick<OpsSample, "message" | "url" | "release" | "environment" | "user">>(rows: readonly T[], facetsOf: (x: T) => Record<Facet, string | null>, f: TimelineFilter): Record<Facet, FacetRow[]> {
  const out = {} as Record<Facet, FacetRow[]>;
  for (const facet of FACETS) {
    const counts = new Map<string, number>();
    let none = 0;
    if (facet !== "status") {
      for (const x of rows) {
        const v = facetsOf(x);
        if (!admitsSample(v, x, f, facet)) continue;
        if (v[facet]) counts.set(v[facet]!, (counts.get(v[facet]!) ?? 0) + 1);
        else none++;
      }
      for (const v of f.facets[facet]) if (!counts.has(v)) counts.set(v, 0);
    }
    const off = (value: string) => facet === "kind" && !f.facets.kind.size && OFF_BY_DEFAULT_KINDS.has(value);
    out[facet] = [...counts].map(([value, n]) => (off(value) ? { value, n, off: true } : { value, n })).sort((a, b) => Number(!!a.off) - Number(!!b.off) || b.n - a.n || a.value.localeCompare(b.value));
    // The rows with no value close the group, so its counts add up to the rows kept.
    if (none && counts.size && !f.facets[facet].size) out[facet].push({ value: "", n: none, none: true });
  }
  return out;
}

// ── Time range ──

export const RANGE_PRESETS = [
  { key: "1h", ms: HOUR },
  { key: "6h", ms: 6 * HOUR },
  { key: "24h", ms: DAY },
  { key: "72h", ms: 3 * DAY },
  { key: "7d", ms: 7 * DAY },
  { key: "30d", ms: 30 * DAY },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["key"];

/** A range: a preset that ends now (and moves with it), or a fixed span from a brush, a cluster or a jump. */
export type TimeRange = { from: number; to: number; preset: RangePreset | null };

/** `win`: a preset ("24h"), or a fixed span as two epoch ms joined by "~" ("1730600000000~1730686400000"). */
export function parseRange(win: string | null | undefined, now: number, fallback: RangePreset = "24h"): TimeRange {
  const preset = RANGE_PRESETS.find((p) => p.key === win);
  if (preset) return { from: now - preset.ms, to: now, preset: preset.key };
  const m = /^(\d{10,})~(\d{10,})$/.exec(win ?? "");
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b > a) return { from: a, to: Math.min(b, now), preset: null };
  }
  const p = RANGE_PRESETS.find((x) => x.key === fallback)!;
  return { from: now - p.ms, to: now, preset: p.key };
}

export function formatRange(r: Pick<TimeRange, "from" | "to" | "preset">): string {
  return r.preset ?? `${Math.round(r.from)}~${Math.round(r.to)}`;
}

/** The smallest preset that holds every event of the last 30 days; a quiet month opens on 24h. */
export function fitPreset(events: readonly Pick<OpsEvent, "created_at">[], now: number): RangePreset {
  const widest = RANGE_PRESETS[RANGE_PRESETS.length - 1];
  let oldest = 0;
  for (const e of events) {
    const age = now - e.created_at;
    if (age >= 0 && age <= widest.ms) oldest = Math.max(oldest, age);
  }
  if (!oldest) return "24h";
  return (RANGE_PRESETS.find((p) => p.ms >= oldest) ?? widest).key;
}

/** A day to jump to: that whole local day, clipped to now. */
export function dayRange(dateValue: string, now: number): TimeRange | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!m) return null;
  const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (!Number.isFinite(from) || from > now) return null;
  return { from, to: Math.min(from + DAY, now), preset: null };
}

/** Ticks an axis this many pixels wide holds without labels touching (a label is about 64px). */
export const tickBudget = (px: number) => (px > 0 ? Math.max(2, Math.min(8, Math.floor(px / 64))) : 8);

/** The axis ticks for a range: a sensible step, aligned, at most `max` of them (fewer on a narrow axis). */
export function rangeTicks(r: Pick<TimeRange, "from" | "to">, max = 8): { x: number; at: number }[] {
  const span = r.to - r.from;
  const steps = [5 * 60_000, 10 * 60_000, 30 * 60_000, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];
  const step = steps.find((s) => span / s <= max) ?? 14 * DAY;
  const out: { x: number; at: number }[] = [];
  const tz = new Date().getTimezoneOffset() * 60_000;
  // Day steps align to local midnight; shorter ones to the clock.
  const align = (t: number) => (step >= DAY ? Math.ceil((t - tz) / step) * step + tz : Math.ceil(t / step) * step);
  for (let at = align(r.from); at <= r.to; at += step) out.push({ x: (at - r.from) / span, at });
  return out;
}

/** A row's time: with the date once a range spans more than two days, with seconds inside an hour. */
export function fmtTime(at: number, span: number): string {
  const d = new Date(at);
  if (span > 2 * 86_400_000) return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: span <= HOUR ? "2-digit" : undefined });
}

// ── Histogram ──

/** `unknown`: nothing was recorded for this span (before a counter's first day, past a list's reach), which is not a zero. */
export type HistBin = { from: number; to: number; parts: Record<string, number>; total: number; unknown?: boolean; /** The counter has nothing here, so the bar is drawn from what the client keeps (transitions, issues, replays): at least this many. */ estimated?: boolean };

/** A point some kept trail leaves: when, and how many it stands for. */
export type TrailPoint = { at: number; n: number };

/**
 * Bins the counter knows nothing of (before its first day) or counted zero
 * while something kept says otherwise, filled from those trails and marked
 * estimated, Grafana style: draw what is known, and mark a gap only where
 * nothing is. Each trail is summed per bin and the largest wins, since one
 * event can show in more than one of them.
 */
export function fillEstimates(bins: readonly HistBin[], trails: readonly (readonly TrailPoint[])[]): HistBin[] {
  return bins.map((b) => {
    if (!b.unknown && b.total > 0) return b;
    let est = 0;
    for (const trail of trails) {
      let n = 0;
      for (const p of trail) if (p.at >= b.from && p.at < b.to) n += p.n;
      est = Math.max(est, n);
    }
    return est > 0 ? { from: b.from, to: b.to, parts: { estimated: est }, total: est, estimated: true } : b;
  });
}

/** A bin width for a span: about `target` bars, on a round step. */
export function binWidth(span: number, target = 48): number {
  const steps = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
  return steps.find((s) => span / s <= target) ?? DAY;
}

/** What the stream chart's bars count: the server's volume series, or the transitions the list holds. */
export type StreamMode = "volume" | "transitions";
/** Raw occurrences are kept per hour for this long (GROUP_RULES.bucket_hours); a wider window counts per day. */
export const STREAM_BUCKET_REACH = 72 * HOUR;

/**
 * How the stream chart bins a window, and the time its bars span: whole bins,
 * so the first and last bar start and end on a bin edge. The lanes under the
 * chart draw on this same span, so a date is one vertical line through both.
 */
export function streamAxis(range: Pick<TimeRange, "from" | "to">, mode: StreamMode): { volume: boolean; daily: boolean; width: number; from: number; to: number } {
  const span = Math.max(1, range.to - range.from);
  const volume = mode === "volume" && span >= 6 * HOUR;
  const daily = volume && span > STREAM_BUCKET_REACH + HOUR;
  const base = binWidth(span);
  const width = !volume ? base : daily ? DAY : Math.max(base, HOUR);
  const from = Math.floor(range.from / width) * width;
  const n = Math.max(1, Math.ceil((range.to - from) / width));
  return { volume, daily, width, from, to: from + n * width };
}

/** Points counted into bins across a range, stacked by `stack`'s key. */
export function histogram<T>(points: readonly T[], at: (p: T) => number, stack: (p: T) => string, weight: (p: T) => number, r: Pick<TimeRange, "from" | "to">, width = binWidth(r.to - r.from)): HistBin[] {
  const start = Math.floor(r.from / width) * width;
  const n = Math.max(1, Math.ceil((r.to - start) / width));
  const bins: HistBin[] = Array.from({ length: n }, (_, i) => ({ from: start + i * width, to: start + (i + 1) * width, parts: {}, total: 0 }));
  for (const p of points) {
    const t = at(p);
    if (t < r.from || t > r.to) continue;
    const i = Math.min(n - 1, Math.floor((t - start) / width));
    const k = stack(p);
    const w = weight(p);
    bins[i].parts[k] = (bins[i].parts[k] ?? 0) + w;
    bins[i].total += w;
  }
  return bins;
}

/**
 * Raw occurrences per hour from the groups' hourly buckets (kept 72 hours),
 * as points a histogram counts: the volume under the transitions, so a spike
 * that made no new group still shows. Stacked by the group's level, else kind.
 */
export function occurrencePoints(groups: readonly Pick<OpsGroup, "buckets" | "level" | "kind" | "source_id">[]): { at: number; key: string; n: number; source_id: string }[] {
  const out: { at: number; key: string; n: number; source_id: string }[] = [];
  for (const g of groups) {
    const key = (g.level ?? (g.kind === "error" ? "error" : g.kind)).toLowerCase();
    for (const b of g.buckets ?? []) out.push({ at: b.hour + HOUR / 2, key, n: b.count, source_id: g.source_id });
  }
  return out;
}

/**
 * Events per UTC day across a range, from the sources' own day counters
 * (event_source_stats.days, 30 days): the server's series, not the rows a
 * reader has loaded. A day before every source's first counted day is unknown.
 */
export function counterBins(sources: readonly Pick<OpsSource, "days">[], r: Pick<TimeRange, "from" | "to">): HistBin[] {
  const first = Math.floor(r.from / DAY) * DAY;
  const out: HistBin[] = [];
  const since = sources.map((s) => (s.days ?? []).reduce<string | null>((a, d) => (a === null || d.day < a ? d.day : a), null)).filter((x): x is string => !!x).sort()[0] ?? null;
  const totals = new Map<string, number>();
  for (const s of sources) for (const d of s.days ?? []) totals.set(d.day, (totals.get(d.day) ?? 0) + d.events);
  for (let from = first; from < r.to; from += DAY) {
    const day = new Date(from).toISOString().slice(0, 10);
    const known = !!since && day >= since;
    const n = totals.get(day) ?? 0;
    out.push({ from, to: from + DAY, parts: known && n ? { events: n } : {}, total: known ? n : 0, ...(known ? {} : { unknown: true }) });
  }
  return out;
}

/** Bins wholly older than the oldest row a list holds, while older rows may still exist: unknown, not empty. */
export function markUnloaded(bins: readonly HistBin[], oldestLoaded: number | null, more: boolean): HistBin[] {
  if (!more || oldestLoaded === null) return [...bins];
  return bins.map((b) => (b.to <= oldestLoaded && b.total === 0 ? { ...b, unknown: true } : b));
}

/** Stack order and ink for levels and kinds: loud at the bottom. */
export const STACK_ORDER = ["fatal", "critical", "error", "warning", "warn", "job", "check", "replay_issue", "metric", "info", "log", "debug"];
export const STACK_INK: Record<string, string> = {
  fatal: "var(--sol-magenta)",
  critical: "var(--sol-magenta)",
  error: "var(--sol-red)",
  warning: "var(--sol-orange)",
  warn: "var(--sol-orange)",
  job: "var(--sol-orange)",
  check: "var(--sol-cyan)",
  replay_issue: "var(--sol-violet)",
  metric: "var(--sol-violet)",
  info: "var(--sol-blue)",
  log: "var(--sol-yellow)",
  debug: "var(--sol-text-dim)",
  new: "var(--sol-red)",
  regressed: "var(--sol-magenta)",
  spike: "var(--sol-orange)",
  resolved: "var(--sol-green)",
  check_failed: "var(--sol-red)",
  check_recovered: "var(--sol-green)",
  job_failed: "var(--sol-orange)",
  metric_alert: "var(--sol-violet)",
  metric_recovered: "var(--sol-green)",
  deploy: "var(--sol-green)",
  unmatched: "color-mix(in srgb, var(--sol-text-dim) 28%, transparent)",
  estimated: "color-mix(in srgb, var(--sol-text-muted) 45%, transparent)",
};

/** What a series is called where a person reads it: a legend, a tooltip. */
export const SERIES_LABEL: Record<string, string> = {
  fatal: "fatal",
  error: "errors",
  warning: "warnings",
  warn: "warnings",
  info: "info",
  log: "logs",
  debug: "debug",
  job: "failed jobs",
  check: "checks",
  metric: "metric alerts",
  replay: "replays started",
  replay_issue: "replay issues",
  rage_click: "rage clicks",
  dead_click: "dead clicks",
  events: "events",
  dropped: "dropped",
  new: "new",
  regressed: "regressed",
  spike: "spiked",
  resolved: "resolved",
  check_failed: "checks failed",
  check_recovered: "checks recovered",
  job_failed: "jobs failed",
  metric_alert: "metrics alerting",
  metric_recovered: "metrics recovered",
  deploy: "deploys",
  unmatched: "not matching the filter",
  estimated: "estimated",
};
export const seriesLabel = (k: string) => SERIES_LABEL[k] ?? k.replace(/_/g, " ");

/** The top of a count axis: the max rounded up to 1, 2 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (max <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  // Fine steps keep the tallest bar near the top: 260 reads against 300, not 500.
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (Number.isInteger(m * p) && m * p >= max) return m * p;
  return 10 * p;
}

/** The leading run of unknown bins: where "no data before" ends, or null when the series starts known. */
export function unknownUntil(bins: readonly HistBin[]): number | null {
  let i = 0;
  while (i < bins.length && bins[i].unknown) i++;
  return i === 0 ? null : i === bins.length ? Infinity : bins[i].from;
}

export function stackKeys(bins: readonly HistBin[]): string[] {
  const keys = new Set<string>();
  for (const b of bins) for (const k of Object.keys(b.parts)) keys.add(k);
  const rank = (k: string) => {
    const i = STACK_ORDER.indexOf(k);
    return i < 0 ? STACK_ORDER.length : i;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ── Lanes in pixels ──

/**
 * Marks (x in 0..1 across a track `widthPx` wide) merged where their pills
 * would touch: closer than `minPx`. A cluster is placed at its first mark.
 * Measured in pixels, so a narrow window clusters more instead of overlapping.
 */
export function clusterByPixels<T extends { x: number }>(marks: readonly T[], widthPx: number, minPx: number): { x: number; marks: T[] }[] {
  const sorted = [...marks].sort((a, b) => a.x - b.x);
  const out: { x: number; marks: T[] }[] = [];
  const gap = widthPx > 0 ? minPx / widthPx : 0.05;
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.x - last.x < gap) last.marks.push(m);
    else out.push({ x: m.x, marks: [m] });
  }
  return out;
}

/** A cluster's span in time, for a click that narrows the stream to its marks. */
export function clusterSpan(marks: readonly { event: Pick<OpsEvent, "created_at"> }[]): { from: number; to: number } {
  const ts = marks.map((m) => m.event.created_at);
  const from = Math.min(...ts);
  const to = Math.max(...ts);
  // A single moment widens to a minute either side, so the list shows it.
  return to - from < 60_000 ? { from: from - 60_000, to: to + 60_000 } : { from, to };
}

/** Whether a group passes the stream's kind, type and level facets (the volume read from its buckets). */
export function admitsGroup(g: Pick<OpsGroup, "kind" | "level">, f: TimelineFilter): boolean {
  const { level, type } = splitLevel(g.level);
  const { kind, level: levels, type: types } = f.facets;
  return (!kind.size || kind.has(g.kind)) && (!levels.size || (!!level && levels.has(level))) && (!types.size || (!!type && types.has(type)));
}

/** Whether a filter asks for more than a server series can split by: words, a status, or (for the day counters) any facet past source. */
export function filterBeyond(f: TimelineFilter, series: "groups" | "counter"): boolean {
  if (f.text || f.facets.status.size) return true;
  return series === "counter" && (f.facets.kind.size + f.facets.type.size + f.facets.level.size > 0);
}

/** A moment as every panel prints it: "Nov 3, 11:55:03 AM", the table's format with seconds. */
export function fmtStamp(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

// ── The filtered volume ──

/** The key of what the counter counted that the filter leaves out, drawn faint behind the matching bars. */
export const UNMATCHED = "unmatched";

/**
 * A counter's bins with the filter's own rows drawn over them: each bin's
 * matching rows stacked by their key at the bottom, and what the counter
 * counted beyond them as one faint `unmatched` part on top, so the bars show
 * where the filtered thing started against the whole. The matched count is
 * never more than the bin holds; a bin the counter could not see stays unknown.
 */
export function overlayBins(total: readonly HistBin[], rows: readonly { at: number; key: string }[]): { bins: HistBin[]; matched: number } {
  let matched = 0;
  const bins = total.map((b) => {
    const parts: Record<string, number> = {};
    let n = 0;
    for (const r of rows) {
      if (r.at < b.from || r.at >= b.to) continue;
      parts[r.key] = (parts[r.key] ?? 0) + 1;
      n++;
    }
    matched += n;
    const rest = Math.max(0, b.total - n);
    if (rest) parts[UNMATCHED] = rest;
    return { ...b, parts, total: Math.max(b.total, n) };
  });
  return { bins, matched };
}

// ── The rest at the vendor ──

/**
 * Where a source's vendor lists every event in a window, when the stream can
 * only hold the samples codecast kept: PostHog's events explorer or Sentry's
 * issue stream, over the same time range (and, for Sentry, the same level).
 * Null for a source whose vendor has no such page here.
 */
export function vendorStreamUrl(source: Pick<OpsSource, "provider" | "vendor_web_url" | "config">, r: Pick<TimeRange, "from" | "to">, f?: TimelineFilter): string | null {
  const org = source.config?.org;
  const base = (source.vendor_web_url ?? (source.provider === "sentry" && org ? `https://sentry.io/organizations/${encodeURIComponent(org)}/issues/` : ""))?.replace(/\/+$/, "");
  if (!base) return null;
  const iso = (t: number) => new Date(t).toISOString();
  if (source.provider === "posthog") {
    const q = { kind: "DataTableNode", full: true, source: { kind: "EventsQuery", select: ["*", "event", "person", "timestamp"], orderBy: ["timestamp DESC"], after: iso(r.from), before: iso(r.to) } };
    return `${base}/activity/explore#q=${encodeURIComponent(JSON.stringify(q))}`;
  }
  if (source.provider === "sentry") {
    const params = new URLSearchParams({ start: iso(r.from).slice(0, 19), end: iso(r.to).slice(0, 19), utc: "true" });
    const level = f ? [...f.facets.level] : [];
    if (level.length) params.set("query", level.map((l) => `level:${l}`).join(" OR "));
    return `${base}/?${params}`;
  }
  return null;
}

/** The recording that showed an issue nearest a moment: one running then, else the closest start. */
export function nearestReplay<R extends { group_ids: readonly string[]; started_at: number; duration_ms?: number | null }>(replays: readonly R[], groupId: string, at: number): R | null {
  let best: R | null = null;
  let gap = Infinity;
  for (const r of replays) {
    if (!r.group_ids.includes(groupId)) continue;
    const end = r.started_at + (r.duration_ms ?? 0);
    const d = at < r.started_at ? r.started_at - at : at > end ? at - end : 0;
    if (d < gap) {
      gap = d;
      best = r;
    }
  }
  return best;
}

/**
 * The stream's events per day past the buckets' reach: the sources' day
 * counters, with the days a counter has no record of drawn from what the
 * stream keeps (the listed rows, the issues' hourly buckets) and marked
 * estimated. The chart draws these and the list's "kept of N" counts them,
 * so the two never disagree.
 */
export function streamDayBins(sources: readonly Pick<OpsSource, "_id" | "days" | "last_event_at">[], groups: readonly OpsGroup[], sourceIds: ReadonlySet<string> | null, filter: TimelineFilter, range: Pick<TimeRange, "from" | "to">, rows: readonly { at: number }[]): HistBin[] {
  const inScope = sources.filter((s) => !sourceIds || sourceIds.has(s._id));
  const gs = groups.filter((g) => (!sourceIds || sourceIds.has(g.source_id)) && admitsGroup(g, filter));
  const filled = fillEstimates(counterBins(inScope, range), [rows.map((p) => ({ at: p.at, n: 1 })), occurrencePoints(gs)]);
  // Past the newest sign of life from every source in scope nothing arrived: those days are silence, not missing data.
  const lastAt = Math.max(0, ...inScope.map((s) => s.last_event_at ?? 0), ...groups.filter((g) => !sourceIds || sourceIds.has(g.source_id)).map((g) => g.last_seen));
  return knownSilence(filled, lastAt || null);
}

/** Bins narrowed to the rows that match a filter: the unmatched rest dropped, so the scale follows what matches. */
export function matchedOnly(bins: readonly HistBin[]): HistBin[] {
  return bins.map((b) => {
    if (!(UNMATCHED in b.parts)) return b;
    const parts = { ...b.parts };
    delete parts[UNMATCHED];
    return { ...b, parts, total: Object.values(parts).reduce((n, x) => n + x, 0) };
  });
}

// ── Folding repeats in the occurrence list ──

/** A run shorter than this stays as its rows: folding two rows saves nothing. */
export const FOLD_MIN = 3;

/** One line of the occurrence list: a kept occurrence, or the occurrences of one issue inside a burst folded into one line. */
export type OccurrenceItem<T> = { kind: "one"; sample: T } | { kind: "run"; key: string; samples: T[]; from: number; to: number };

/** A burst is occurrences no further apart than this, spanning no more than FOLD_SPAN: two issues interleaving inside it fold into one line each. */
export const FOLD_GAP = 10 * 60_000;
export const FOLD_SPAN = HOUR;

/**
 * Each issue's occurrences inside a burst folded into one line with their
 * count and time span (Datadog's patterns, Sentry's grouped stream): two
 * errors interleaving through the same minutes read as two lines,
 * "eg-118 × 57, 9:05 to 10:06", never 114 alternating rows. A burst is a
 * stretch of occurrences each within FOLD_GAP of the one before, at most
 * FOLD_SPAN long. A line sits where its issue's newest occurrence in the
 * burst sat, so the list stays newest first, and is keyed by that row, so
 * expanding it holds while older pages load under it. An issue seen fewer
 * than `min` times in a burst keeps its rows.
 */
export function foldRepeats<T extends Pick<OpsSample, "_id" | "group_id" | "at">>(samples: readonly T[], min = FOLD_MIN): OccurrenceItem<T>[] {
  const out: OccurrenceItem<T>[] = [];
  for (let i = 0; i < samples.length; ) {
    let j = i + 1;
    while (j < samples.length && Math.abs(samples[j - 1].at - samples[j].at) <= FOLD_GAP && Math.abs(samples[i].at - samples[j].at) <= FOLD_SPAN) j++;
    const burst = samples.slice(i, j);
    const by = new Map<string, T[]>();
    for (const x of burst) by.set(x.group_id, [...(by.get(x.group_id) ?? []), x]);
    for (const x of burst) {
      const run = by.get(x.group_id)!;
      if (run.length < min) out.push({ kind: "one", sample: x });
      else if (run[0] === x) {
        const ats = run.map((r) => r.at);
        out.push({ kind: "run", key: `run:${x._id}`, samples: run, from: Math.min(...ats), to: Math.max(...ats) });
      }
    }
    i = j;
  }
  return out;
}

/** The ids the list's keys walk, in order: a folded run is its newest row until it is opened, then every row in it. */
export function foldedIds<T extends Pick<OpsSample, "_id">>(items: readonly OccurrenceItem<T>[], expanded: ReadonlySet<string>): string[] {
  return items.flatMap((it) => (it.kind === "one" ? [it.sample._id] : expanded.has(it.key) ? it.samples.map((x) => x._id) : [it.samples[0]._id]));
}
