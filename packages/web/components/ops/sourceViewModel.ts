// The pure readings behind the source overview, the stream's occurrence rows,
// the Apps board's run form and a silent source's check: what each shows,
// worked out without React or the store, so each is tested on its own.
import { isCiRunRecord } from "@codecast/shared/contracts/signalFingerprint";
import { counterDays } from "./sourceHealth";
import { fixActionLabel, isRegressed } from "./issuesModel";
import { formatValue } from "./metricModel";
import { ingestEndpoint } from "./opsModel";
import type { Param } from "./appsModel";
import type { HistBin } from "./timelineModel";
import { sourceLastDay, type AttentionItem, type AttentionTask } from "./opsHomeModel";
import type { CreateOpsWatchInput } from "../../store/opsSlice";
import type { FixFacts } from "./opsModel";
import type { OpsGroup, OpsReplay, OpsSample, OpsSource, OpsWatch } from "./opsTypes";

const DAY = 86_400_000;

// ── The overview ──

/** Daily bars from the source's own day counter; a day before its first is unknown, not zero. */
export function dailyBins(source: Pick<OpsSource, "days">, now: number, days: number): HistBin[] {
  return counterDays(source, now, days).map((d) => {
    const parts: Record<string, number> = {};
    if (d.events) parts.events = d.events;
    if (d.dropped) parts.dropped = d.dropped;
    return { from: d.from, to: d.from + DAY, parts, total: (d.events ?? 0) + d.dropped, ...(d.events === null ? { unknown: true } : {}) };
  });
}

const HOUR = 3_600_000;

export type VolumeRange = "24h" | "7d" | "30d";

/**
 * A source's volume for a range, from its one counter (event_source_stats):
 * hours for 24h, days past it, so every range and the today figure measure
 * the same thing. Null for 24h while the source has no hour series yet (a
 * source counted before hours were kept); the caller draws its trails then.
 */
export function volumeBins(source: Pick<OpsSource, "days" | "hours">, now: number, range: VolumeRange): HistBin[] | null {
  if (range !== "24h") return dailyBins(source, now, range === "7d" ? 7 : 30);
  if (!source.hours) return null;
  const byHour = new Map(source.hours.map((h) => [h.hour, h.events]));
  const last = Math.floor(now / HOUR) * HOUR;
  return Array.from({ length: 24 }, (_, i) => {
    const from = last - (23 - i) * HOUR;
    const n = byHour.get(from) ?? 0;
    const parts: Record<string, number> = n ? { events: n } : {};
    return { from, to: from + HOUR, parts, total: n };
  });
}

/**
 * Today against a usual day, as a pace: today's count so far scaled to a
 * whole day, against the baseline, in percent ("+38"). Null without a
 * baseline, or in the first two hours of the UTC day when a pace says nothing.
 */
export function paceVsUsual(today: number, baseline: number | null, now: number): number | null {
  if (!baseline) return null;
  const start = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const elapsed = (now - start) / DAY;
  if (elapsed < 2 / 24) return null;
  return Math.round(((today / elapsed) / baseline - 1) * 100) || 0;
}

/** A pace as the tile reads it: "+38% vs usual", "−12% vs usual", "as usual" inside ±5%. */
export function paceLabel(pct: number | null): string | null {
  if (pct === null) return null;
  if (Math.abs(pct) < 5) return "as usual";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toLocaleString()}% vs usual`;
}

/**
 * The stat panel's number: events in the last 24 hours from the same hourly
 * series the 24h chart draws, against the 24 hours before it. The comparison
 * shows only once the counter was running for the whole earlier window (its
 * first day at or before that window's start), so a new source never reads
 * as a drop. Null without an hour series (a source counted before hours were
 * kept); the caller falls back to its day counter then.
 */
export type Rolling24 = { last: number; prev: number | null; pct: number | null; vs: "spike" | "low" | "normal" | null };

export function rolling24(source: Pick<OpsSource, "days" | "hours">, now: number): Rolling24 | null {
  if (!source.hours) return null;
  const last = Math.floor(now / HOUR) * HOUR;
  const from = last - 23 * HOUR;
  const prevFrom = from - 24 * HOUR;
  let cur = 0;
  let before = 0;
  for (const h of source.hours) {
    if (h.hour >= from && h.hour <= last) cur += h.events;
    else if (h.hour >= prevFrom && h.hour < from) before += h.events;
  }
  const first = (source.days ?? []).reduce<string | null>((a, d) => (a === null || d.day < a ? d.day : a), null);
  const complete = !!first && Date.parse(`${first}T00:00:00Z`) <= prevFrom;
  if (!complete) return { last: cur, prev: null, pct: null, vs: null };
  const pct = before ? Math.round((cur / before - 1) * 100) : null;
  const vs = !before ? (cur >= 10 ? "spike" : null) : cur >= 3 * before && cur >= 10 ? "spike" : cur * 3 <= before && before >= 10 ? "low" : "normal";
  return { last: cur, prev: before, pct, vs };
}

/** A 24h change as the tile reads it: "+38% vs prior 24h", "as prior 24h" inside ±5%. */
export function rollingLabel(r: Rolling24): string | null {
  if (r.prev === null) return null;
  if (r.pct === null) return r.last ? "none the 24h before" : null;
  if (Math.abs(r.pct) < 5) return "same as prior 24h";
  return `${r.pct > 0 ? "+" : "−"}${Math.abs(r.pct).toLocaleString()}% vs prior 24h`;
}

/**
 * A source's last 24 hours, the one number every surface prints for it (the
 * overview's tile, the Ops home's table, the Settings row): the hour counter
 * the 24h chart draws, else, for a source counted before hours were kept, its
 * issues' hourly buckets and replays over the same rolling window.
 */
export function eventsLast24h(source: Pick<OpsSource, "_id" | "days" | "hours">, groups: readonly Pick<OpsGroup, "source_id" | "buckets">[], replays: readonly Pick<OpsReplay, "source_id" | "started_at">[], now: number): number {
  return rolling24(source, now)?.last ?? sourceLastDay(source._id, groups, replays, now).total;
}

/** Where one source's settings open: its row on Settings, Integrations, scrolled to and lit. */
export const sourceSettingsHref = (shortId: string | undefined) => `/settings/integrations#${shortId ? `source-${shortId}` : "product-sources"}`;

/** The anchor a Settings row answers to, read back from a location hash: a source's short id, the section itself, or null. */
export function settingsAnchor(hash: string): { kind: "source"; id: string } | { kind: "section" } | null {
  const h = decodeURIComponent(hash.replace(/^#/, ""));
  if (h === "product-sources") return { kind: "section" };
  const m = /^source-(.+)$/.exec(h);
  return m ? { kind: "source", id: m[1] } : null;
}

/**
 * What a fix button says for an item with no issue behind it (an issue's row
 * reads its fix plan instead, GroupFixSlots), in the same words
 * (fixActionLabel): it names the task it starts on, and a closed task gets a
 * follow-up, since the press starts a session and never reopens anything.
 */
export function fixLabel(task: { status?: string; short_id?: string } | null | undefined, hasTask: boolean): string {
  if (!hasTask) return fixActionLabel("start", null, false)!;
  const closed = task?.status === "done" || task?.status === "dropped";
  return fixActionLabel(closed ? "followup" : "start", task?.short_id, false)!;
}

// ── A silent source: its watch and its fix ──

/** Hours of silence the overview offers to alert on: hourly reads in a row of an events-per-hour watch below 1. */
export const SILENCE_HOURS = 6;

/** A volume watch on a source's whole event count that alerts when it falls under one an hour: a silence watch. */
export function isSilenceWatch(w: Pick<OpsWatch, "query_kind" | "query" | "threshold" | "direction">): boolean {
  return w.query_kind === "volume" && w.query.trim() === "events" && w.direction === "below" && w.threshold != null && w.threshold <= 1;
}

/** The silence watch the overview makes in one press: events per hour under 1 for `hours` reads in a row. */
export function silenceWatchInput(source: Pick<OpsSource, "_id" | "name">, hours = SILENCE_HOURS): CreateOpsWatchInput {
  return { source: source._id, name: `${source.name} silent ${hours}h`, query_kind: "volume", query: "events", threshold: 1, direction: "below", interval_ms: HOUR, eval_reads: hours };
}

/** A fix session's facts for a source that stopped sending: what it is, when it last sent, what it used to send. */
export function silentSourceFacts(source: Pick<OpsSource, "name" | "short_id" | "provider" | "keyed">, lastAt: number | null, usual: number | null): FixFacts {
  const since = lastAt ? new Date(lastAt).toISOString() : null;
  return {
    groupRefs: [],
    title: `${source.name} stopped sending`,
    failure: [
      `Source ${source.name} (${source.short_id}, ${source.provider}${source.keyed ? ", sends with an ingest key" : ""}) has sent nothing ${since ? `since ${since}` : "yet"}.`,
      usual ? `Before that it sent about ${usual.toLocaleString()} events a day.` : null,
      "Find why the app stopped reporting (a removed SDK call, a rotated key, a broken deploy or job) and restore it.",
    ].filter(Boolean).join("\n"),
  };
}

/** Full 40-character commit hashes in a title cut to the 7 a person reads. */
export const shortShas = (title: string) => title.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, "$1");

/** An open issue as the home's row actions take it (OpsHome TaskChip, StartFix): its task, its fix session, its source. */
export function issueWorkItem(g: OpsGroup, task: AttentionTask | null | undefined): Extract<AttentionItem, { kind: "issue" }> {
  return {
    kind: "issue", key: `issue:${g._id}`, state: isRegressed(g) ? "regressed" : "new", severity: 1, at: g.last_seen, volume: g.count,
    sourceId: g.source_id, taskId: g.signal_task_id ?? null, task: task ?? null, sessionId: g.fix_conversation_id ?? null, group: g, replay: null, replays: 0,
  };
}

/** Where a watch alerts, as a comparison in the words the Metrics cards use: "line < 1", "line > 15%". Null for a plain series. */
export function watchLine(w: Pick<OpsWatch, "threshold" | "direction" | "unit">): string | null {
  if (w.threshold == null) return null;
  return `line ${w.direction === "above" ? ">" : "<"} ${formatValue(w.threshold, w.unit)}`;
}

// ── What an overview lists as a problem ──

/** A CI run filed as its own group (isCiRunRecord): drawn as a deploy on the chart, never listed as an open issue. */
export const isRunRecord = (g: Pick<OpsGroup, "kind" | "title">): boolean => isCiRunRecord(g);

/** An open group that is a problem now: not a check or metric that passes, not a superseded run record. */
export function isOpenProblem(g: Pick<OpsGroup, "status" | "kind" | "title" | "meta">): boolean {
  if (g.status !== "open") return false;
  if ((g.kind === "check" || g.kind === "metric") && g.meta?.ok === true) return false;
  return !isRunRecord(g);
}

// ── A silent source's history ──

/**
 * Days the counter cannot speak for, once the source's last event is known:
 * every day after that event's day had nothing (silence is known, not
 * unknown), and the day of the event had at least the one. Days before it
 * stay as they were (unknown or estimated).
 */
export function knownSilence(bins: readonly HistBin[], lastAt: number | null): HistBin[] {
  if (!lastAt) return [...bins];
  return bins.map((b) => {
    if (b.from > lastAt) return b.unknown ? { from: b.from, to: b.to, parts: {}, total: 0 } : b;
    if (lastAt >= b.from && lastAt < b.to && b.total === 0) return { from: b.from, to: b.to, parts: { estimated: 1 }, total: 1, estimated: true };
    return b;
  });
}

/**
 * What a source sent on a usual day before it went quiet: the median of the
 * days with any events in the 30 before its last one, from its issues' daily
 * counts (90 days kept) and its own day counter. Null when nothing says.
 */
export function usualBefore(source: Pick<OpsSource, "days">, groups: readonly Pick<OpsGroup, "days">[], lastAt: number | null): number | null {
  if (!lastAt) return null;
  const from = lastAt - 30 * DAY;
  const byDay = new Map<number, number>();
  const add = (at: number, n: number) => {
    if (at < from || at > lastAt + DAY) return;
    const k = Math.floor(at / DAY) * DAY;
    byDay.set(k, (byDay.get(k) ?? 0) + n);
  };
  for (const g of groups) for (const d of g.days ?? []) add(d.day, d.count);
  const counted = new Map<number, number>();
  for (const d of source.days ?? []) {
    const at = Date.parse(`${d.day}T00:00:00Z`);
    if (at >= from && at <= lastAt + DAY && d.events) counted.set(at, d.events);
  }
  for (const [k, n] of counted) byDay.set(k, Math.max(byDay.get(k) ?? 0, n));
  const xs = [...byDay.values()].filter((n) => n > 0).sort((a, b) => a - b);
  if (xs.length < 2) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

/** How a source's events reach codecast, for the overview's last tile. */
export function deliveryWord(source: Pick<OpsSource, "provider" | "keyed">): string {
  if (source.keyed) return "push";
  if (source.provider === "github") return "webhook";
  return "poll";
}

// ── Occurrence rows ──

/** A url as a row shows it: the path (and query), without the origin every row shares. */
export function shortUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/**
 * A failed request as a replay issue keeps it (shared/replay/issues.ts:
 * `GET https://host/path -> 404 (2026 ms)`): the method, the path without the
 * host every row shares, the status and the time. Null for any other message.
 */
export type RequestLine = { method: string; path: string; status: string; code: number | null; ms: number | null };

export function requestLine(message: string | undefined | null): RequestLine | null {
  const m = /^([A-Z]{3,7}) (\S+) -> (\S+)(?: \((\d+) ms\))?/.exec((message ?? "").split("\n")[0].trim());
  if (!m) return null;
  const code = /^\d{3}$/.test(m[3]) ? Number(m[3]) : null;
  return { method: m[1], path: shortUrl(m[2]) ?? m[2], status: m[3], code, ms: m[4] ? Number(m[4]) : null };
}

/** How loud a request's outcome is: a server error or no answer is an error, a refusal a warning. */
export function requestLevel(r: Pick<RequestLine, "code">): "error" | "warning" | "info" {
  if (r.code === null || r.code >= 500) return "error";
  return r.code >= 400 ? "warning" : "info";
}

export const sampleWho = (x: Pick<OpsSample, "user">) => x.user?.email ?? x.user?.name ?? x.user?.id ?? null;

/** The first line of a message, else the issue's title. */
export function sampleTitle(x: Pick<OpsSample, "message">, group?: Pick<OpsGroup, "title">): string {
  const line = (x.message ?? "").split("\n")[0].trim();
  return line || group?.title || "Occurrence";
}

/** A JSON text field pretty-printed, or null when empty or not JSON. */
export function prettyJson(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (v == null || (typeof v === "object" && !Object.keys(v).length)) return null;
    return JSON.stringify(v, null, 2);
  } catch {
    return text;
  }
}

// ── Running from the Apps board ──

type Values = Record<string, string | boolean>;

export const isNum = (t: string) => t === "number" || t === "integer";
export const isJson = (t: string) => t === "object" || t === "array";

/** The args a form's values make, typed by the schema, or what is wrong with them. Empty optional fields are left out. */
export function argsFromForm(params: readonly Param[], values: Values): { args: Record<string, unknown>; errors: string[] } {
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const p of params) {
    const raw = values[p.name];
    if (p.type === "boolean") {
      if (raw !== undefined) args[p.name] = !!raw;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (p.required) errors.push(`${p.name} is required`);
      continue;
    }
    if (isNum(p.type)) {
      const n = Number(text);
      if (!Number.isFinite(n)) errors.push(`${p.name} must be a number`);
      else args[p.name] = n;
    } else if (isJson(p.type)) {
      try {
        args[p.name] = JSON.parse(text);
      } catch {
        errors.push(`${p.name} is not JSON`);
      }
    } else args[p.name] = text;
  }
  return { args, errors };
}

/** The answer as a person reads it: JSON pretty-printed, anything else as sent. */
export function formatAnswer(text: string | undefined): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ── A silent source's check ──

/** A test that lands as a plain named event: it arrives on the stream and opens no issue. */
export function testEventCommand(convexUrl: string, keyVar = "$CODECAST_INGEST_KEY"): string {
  return [
    `curl -X POST ${ingestEndpoint(convexUrl)}/${keyVar} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"sdk":{"name":"curl","version":"1"},"items":[{"type":"event","name":"codecast.test","at":'$(date +%s000)'}]}'`,
  ].join("\n");
}

/** Whether the check saw an event land since it opened. */
export function arrivedSince(lastAt: number | null | undefined, openedAt: number): boolean {
  return !!lastAt && lastAt >= openedAt;
}

