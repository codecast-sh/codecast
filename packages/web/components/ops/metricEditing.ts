// Editing a watch: intervals, reader arguments, thresholds, its whole-life
// window, volume series previews, the HogQL builder and reader options. Pure.
import { CI_RUN_SERIES, parseVolumeQuery, volumeHistory, volumeLabel, volumeQueryText, volumeUnit, volumeValue, type VolumeQuery } from "@codecast/shared/contracts/volumeWatch";
import { DAY, fitStart, formatValue, HOUR, MIN, spanLabel, type Pt, type Win } from "./metricModel";
import type { OpsSource, OpsWatch } from "./opsTypes";

// ── Editing ──

export const INTERVALS = [
  { ms: MIN, label: "1m" },
  { ms: 5 * MIN, label: "5m" },
  { ms: 15 * MIN, label: "15m" },
  { ms: HOUR, label: "1h" },
  { ms: 6 * HOUR, label: "6h" },
  { ms: DAY, label: "1d" },
] as const;

export function intervalLabel(ms: number): string {
  return INTERVALS.find((i) => i.ms === ms)?.label ?? spanLabel(ms);
}

/** The reads-in-a-row choices a monitor offers, and the missed-read counts that mean missing data. */
export const EVAL_READS = [1, 2, 3, 5, 10] as const;
export const NO_DATA_AFTER = [2, 3, 5, 10] as const;

/** One argument field a reader declares, as a form shows it. */
export type ArgField = { key: string; type: "number" | "boolean" | "enum" | "text"; options?: string[]; required: boolean; description?: string; dflt?: string };

/** The argument fields of a reader's declared input (its JSON Schema properties), required ones first. */
export function argFields(input: { properties?: Record<string, any>; required?: string[] } | undefined): ArgField[] {
  const req = new Set(input?.required ?? []);
  return Object.entries(input?.properties ?? {})
    .map(([key, p]): ArgField => {
      const types = p?.type === undefined ? [] : Array.isArray(p.type) ? p.type : [p.type];
      const t = types.find((x: string) => x !== "null");
      const type = Array.isArray(p?.enum) ? "enum" : t === "number" || t === "integer" ? "number" : t === "boolean" ? "boolean" : "text";
      return {
        key, type, required: req.has(key),
        ...(type === "enum" ? { options: p.enum.map(String) } : {}),
        ...(typeof p?.description === "string" ? { description: p.description } : {}),
        ...(p?.default !== undefined ? { dflt: String(p.default) } : {}),
      };
    })
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/** A reader watch's query (`name {json}`, contracts/ingest parseReaderQuery) from typed field values; empty fields are left out. */
export function readerQueryText(reader: string, fields: ArgField[], values: Record<string, string>): { query: string } | { error: string } {
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (!raw) {
      if (f.required) return { error: `${f.key} is required` };
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${f.key} is not a number` };
      args[f.key] = n;
    } else if (f.type === "boolean") args[f.key] = raw === "true";
    else args[f.key] = raw;
  }
  return { query: Object.keys(args).length ? `${reader} ${JSON.stringify(args)}` : reader };
}

/** The field values a saved reader query holds, for editing it again. */
export function readerQueryValues(query: string): { reader: string; values: Record<string, string> } | null {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(query.trim());
  if (!m) return null;
  let args: unknown = {};
  try { args = m[2] ? JSON.parse(m[2]) : {}; } catch { return null; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { reader: m[1], values: Object.fromEntries(Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) };
}

/** A threshold as a person typed it: a number, empty (no line), or null when it is not a number. */
export function parseThreshold(text: string): number | undefined | null {
  const t = text.trim().replace(/,/g, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A value as a round number for a dragged line: two significant digits past the span's scale. */
export function roundToScale(v: number, span: number): number {
  if (!Number.isFinite(span) || span <= 0) return v;
  const e = Math.floor(Math.log10(span)) - 2;
  // A fractional step divides by its inverse, so 99.6 reads 99.6, never 99.60000000000001.
  return e >= 0 ? Math.round(v / 10 ** e) * 10 ** e : Math.round(v * 10 ** -e) / 10 ** -e;
}

/** The first number a HogQL answer holds (the poll's own rule, sources/posthog hogqlScalar). */
export function hogqlFirstCell(body: { results?: unknown[] } | null | undefined): number | null {
  const row = Array.isArray(body?.results) ? body!.results[0] : null;
  const cell = Array.isArray(row) ? row[0] : row;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell === "string" && cell.trim() !== "") {
    const n = Number(cell);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── The watch's whole life ──

/**
 * The watch page's "All": from the earliest thing known about the watch, not
 * just the values held. The values may start later than the alert history
 * (a retention cut, a watch re-pointed): the announced transitions and the
 * issue's first sighting reach further, and the alert is counted over them.
 * `gap` is the stretch at the start with no values held, or null. Given the
 * series' `step`, a stray stretch of under three values cut off by a break
 * before the rest (fitStart) does not set the start: All begins at the
 * values, and `stray` names what it left out (how many, from when), so one
 * value weeks early never squeezes the rest into the last pixels.
 */
export function allWindow(input: { heldFrom: number | null; firstAnnounced: number | null; firstSeen: number | null; points: readonly Pt[]; now: number; step?: number }): { win: Win; gap: Win | null; stray: { at: number; count: number } | null } {
  const { heldFrom, firstAnnounced, firstSeen, points, now, step } = input;
  const firstPoint = points.length ? Math.min(...points.map((p) => p.at)) : null;
  const fitted = step !== undefined ? fitStart(points, step) : null;
  const history = [firstAnnounced, firstSeen].filter((x): x is number => x !== null && x > 0);
  // Only when the alert history does not itself reach back past the stray values: then they sit inside the window anyway.
  const strayCount = fitted !== null && firstPoint !== null && fitted > firstPoint && !history.some((x) => x <= firstPoint) ? points.filter((p) => p.at < fitted).length : 0;
  // The stray values are named, not drawn across: the alert history still reaches back when it began earlier.
  const held = strayCount ? fitted : heldFrom ?? firstPoint;
  const starts = [held, firstAnnounced, firstSeen].filter((x): x is number => x !== null && Number.isFinite(x) && x > 0);
  const from0 = starts.length ? Math.min(...starts, now - HOUR) : now - DAY;
  // A start at the first value leaves a little room before it, so that value is not on the axis.
  const from = strayCount && from0 === held ? from0 - (now - from0) * 0.02 : from0;
  // A gap shorter than a 50th of the window is not worth naming.
  const gapTo = held ?? now;
  const gap = gapTo - from > (now - from) / 50 ? { from, to: gapTo } : null;
  const stray = strayCount && firstPoint !== null && firstPoint < from ? { at: firstPoint, count: strayCount } : null;
  return { win: { from, to: now }, gap, stray };
}

/** Normalized query text, for telling two watches apart: a reader by its name and its arguments in key order, HogQL and insights by their words. */
export function queryIdentity(kind: string, query: string): string {
  const q = query.trim();
  if (kind === "reader") {
    const r = readerQueryValues(q);
    if (r) return `reader:${r.reader}:${JSON.stringify(Object.entries(r.values).sort(([a], [b]) => a.localeCompare(b)))}`;
  }
  return `${kind}:${q.replace(/\s+/g, " ").toLowerCase()}`;
}

/** The watch on a source that already reads this query, if any. */
export function duplicateWatch<W extends Pick<OpsWatch, "source_id" | "query_kind" | "query">>(watches: readonly W[], sourceId: string, kind: string, query: string): W | null {
  if (!query.trim()) return null;
  const id = queryIdentity(kind, query);
  return watches.find((w) => w.source_id === sourceId && queryIdentity(w.query_kind, w.query) === id) ?? null;
}

// ── Volume series (contracts/volumeWatch), previewed from the client's counters ──

/** A source's issues without the groups its own watches' alerts opened, as the server counts them. */
const issuesOnly = <G extends { kind?: string }>(groups: readonly G[]) => groups.filter((g) => g.kind !== "metric");

/** One series a source can be watched on, with its value now and the past its counters hold. */
export type VolumeOption = { query: string; label: string; value: number; points: Pt[]; unit: string | null; /** For open issues (a CI source's failing checks): the open ones' short ids, newest first, so the count opens them. */ open?: string[] };

type VolumeGroup = { first_seen: number; status: string; kind?: string; resolved_at?: number; short_id?: string; last_seen?: number };

type VolumeSource = Pick<OpsSource, "provider" | "hours" | "event_names" | "groups_open" | "ci_runs">;

/**
 * The series a source offers, read the way the poll will read them: its
 * events per hour, each named event per hour (the five busiest), issues
 * first seen in a day, and issues open. `groups` are the source's issues
 * the store holds.
 */
export function volumeOptions(source: VolumeSource, groups: readonly VolumeGroup[], now: number): VolumeOption[] {
  const ci = source.provider === "github";
  const input = { now, hours: source.hours, event_names: source.event_names, groups: issuesOnly(groups), groups_open: source.groups_open, ci_runs: source.ci_runs };
  const busiest = [...(source.event_names ?? [])]
    .map((e) => ({ name: e.name, n: e.buckets.reduce((t, b) => t + b.count, 0) }))
    .filter((e) => e.n > 0 && !isTestEventName(e.name))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  // A CI source leads with what a CI dashboard leads with: how often runs fail and how long they take.
  // Offered once the source has kept a run, so an empty series never reads as 0%.
  const runs: VolumeQuery[] = ci && source.ci_runs?.length ? CI_RUN_SERIES.map((series) => ({ series })) : [];
  const qs: VolumeQuery[] = [...runs, { series: "events" }, { series: "new_issues" }, { series: "open_issues" }, ...busiest.map((e) => ({ series: "events" as const, event: e.name }))];
  const open = issuesOnly(groups).filter((g) => g.status === "open" && g.short_id).sort((a, b) => (b.last_seen ?? b.first_seen) - (a.last_seen ?? a.first_seen)).map((g) => g.short_id!);
  return qs.map((q) => {
    const opens = q.series === "open_issues";
    return { query: volumeQueryText(q), label: volumeLabel(q, ci), value: volumeValue(q, input), points: opens ? openHistory(groups, now) : volumeHistory(q, input), unit: volumeUnit(q), ...(opens ? { open } : {}) };
  });
}

/** An event a test or a probe sends (codecast.test, a synthetic check, a smoke run): never a series worth offering. */
export function isTestEventName(name: string): boolean {
  return /(^|[._:\-\s])(test|tests|testing|synthetic|smoke|probe|ping|healthcheck|e2e)($|[._:\-\s])/i.test(name);
}

/**
 * How many of a source's issues stood open at the end of each of the last
 * `days` days, read off each issue's first sighting and resolve time: the
 * past a "Failing checks" or "Open issues" starter draws. An issue resolved
 * with no recorded time counts as open only while it is open now.
 */
export function openHistory(groups: readonly { first_seen: number; status: string; resolved_at?: number; kind?: string }[], now: number, days = 30): Pt[] {
  const gs = issuesOnly(groups);
  if (!gs.length) return [];
  const today = Math.floor(now / DAY) * DAY;
  const out: Pt[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const at = d ? today - (d - 1) * DAY : now;
    out.push({ at, value: gs.filter((g) => g.first_seen <= at && (g.status === "open" || (g.resolved_at !== undefined && g.resolved_at > at))).length });
  }
  return out;
}

/** A volume query's answer from the client's counters, as the sheet's preview reads it; null when the query does not parse. */
export function volumePreview(query: string, source: VolumeSource, groups: readonly VolumeGroup[], now: number): { value: number; points: Pt[]; unit: string | null } | null {
  const q = parseVolumeQuery(query);
  if ("error" in q) return null;
  const input = { now, hours: source.hours, event_names: source.event_names, groups: issuesOnly(groups), groups_open: source.groups_open, ci_runs: source.ci_runs };
  return { value: volumeValue(q, input), points: q.series === "open_issues" ? openHistory(groups, now) : volumeHistory(q, input), unit: volumeUnit(q) };
}

// ── HogQL from a pick (the New watch sheet's builder) ──

export const HOGQL_AGGS = [
  { key: "count", label: "count" },
  { key: "people", label: "people" },
] as const;
export const HOGQL_WINDOWS = [
  { key: "1h", label: "per hour", sql: "INTERVAL 1 HOUR" },
  { key: "24h", label: "per day", sql: "INTERVAL 1 DAY" },
] as const;
export type HogqlPick = { event: string; agg: (typeof HOGQL_AGGS)[number]["key"]; window: (typeof HOGQL_WINDOWS)[number]["key"] };

/** The HogQL a pick reads: one number, the event's count (or distinct people) over the last hour or day. */
export function hogqlOfPick(p: HogqlPick): string {
  const what = p.agg === "people" ? "count(DISTINCT person_id)" : "count()";
  const win = HOGQL_WINDOWS.find((w) => w.key === p.window)!.sql;
  return `SELECT ${what} FROM events WHERE event = '${p.event.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' AND timestamp > now() - ${win}`;
}

/** A watch name for a pick: "$exception per hour", "people with $pageview per day". */
export function nameOfPick(p: HogqlPick): string {
  const per = HOGQL_WINDOWS.find((w) => w.key === p.window)!.label;
  return p.agg === "people" ? `People with ${p.event} ${per}` : `${p.event} ${per}`;
}

/** The events a project's answer lists (`event, count` rows), busiest first. */
export function eventRows(body: { results?: unknown[] } | null | undefined): { event: string; count: number }[] {
  const rows = Array.isArray(body?.results) ? body!.results : [];
  const out: { event: string; count: number }[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== "string" || !r[0]) continue;
    const n = typeof r[1] === "number" ? r[1] : Number(r[1]);
    out.push({ event: r[0], count: Number.isFinite(n) ? n : 0 });
  }
  return out.sort((a, b) => b.count - a.count);
}

export const EVENTS_HOGQL = "SELECT event, count() AS n FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY n DESC LIMIT 100";

/** A change as a card names it when it starts at zero, where a percentage means nothing: "+11 from 0". */
export function changeFromZero(change: number, unit?: string | null): string {
  return `${change >= 0 ? "+" : "-"}${formatValue(Math.abs(change), unit)} from 0`;
}

/** The alert stretch under a moment, if any. */
export function bandAt(bands: readonly Win[], at: number): Win | null {
  return bands.find((b) => at >= b.from && at <= b.to) ?? null;
}

// ── Readers in the new watch sheet ──

/** The top-level field names an output hint shows: `{ key, value, points: [...] }` → key, value, points. */
export function hintFields(hint: string | undefined): string[] {
  if (!hint) return [];
  const t = hint.trim();
  const body = t.startsWith("{") ? t.slice(1, t.lastIndexOf("}") > 0 ? t.lastIndexOf("}") : undefined) : t;
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("[{(".includes(ch)) depth++;
    else if ("]})".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => /^\s*([A-Za-z_$][\w$]*)/.exec(s.split(":")[0])?.[1] ?? "").filter(Boolean);
}

/** Whether a reader answers a number a watch can poll: its hint shows a top-level value or dated points. Null when it declares no hint. */
export function readerAnswersNumber(r: { output_hint?: string }): boolean | null {
  const fields = hintFields(r.output_hint);
  if (!fields.length) return null;
  return fields.includes("value") || fields.includes("points");
}

/** The reader an argument says to pick from ("The key from metrics.list"), among the manifest's other readers. */
export function argSourceReader(description: string | undefined, readers: readonly { name: string }[], self: string): string | null {
  if (!description) return null;
  const hit = readers.filter((r) => r.name !== self && description.includes(r.name)).sort((a, b) => b.name.length - a.name.length)[0];
  return hit?.name ?? null;
}

export type ArgOption = { value: string; label: string; current: number | null; unit: string | null };

/**
 * The choices for an argument, from another reader's answer: its first list
 * of rows (the answer itself, or its first array field), each row's value
 * for the argument (the field of the same name, else id, else key), with its
 * name and current number when it has them.
 */
export function argOptions(body: unknown, key: string): ArgOption[] {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" ? Object.values(body as Record<string, unknown>).find(Array.isArray) : null;
  if (!Array.isArray(rows)) return [];
  const out: ArgOption[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const raw = row[key] ?? row.id ?? row.key;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const label = [row.name, row.title, row.label].find((x) => typeof x === "string" && x.trim()) as string | undefined;
    const v = typeof row.value === "number" && Number.isFinite(row.value) ? row.value : null;
    out.push({ value: String(raw), label: label ?? String(raw), current: v, unit: typeof row.unit === "string" && row.unit.trim() ? row.unit.trim() : null });
  }
  return out;
}
