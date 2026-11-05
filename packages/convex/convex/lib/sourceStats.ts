// A source's counters (event_source_stats): the rows every batch, poll and
// import adds to, and the source and group views every reader returns. Moved
// out of ingest.ts so the door, replays and the vendor sources share one writer.
import type { Doc, Id } from "../_generated/dataModel";
import { HOUR_MS, pruneBuckets, utcDay } from "./ingestGroups";

/** The fields that move on every batch and poll, kept off the source row. */
const STAT_KEYS = ["counters_day", "events_today", "dropped_today", "event_names", "groups_open", "last_event_at", "last_poll_at", "days", "hours", "group_counts", "groups_counted_at", "ci_runs", "old_key_last_at", "old_key_events"] as const;
export type SourceStats = Partial<Pick<Doc<"event_source_stats">, (typeof STAT_KEYS)[number]>>;

function pickStats(row: Partial<Record<(typeof STAT_KEYS)[number], unknown>>): SourceStats {
  const out: Record<string, unknown> = {};
  for (const k of STAT_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out as SourceStats;
}

async function statsRow(ctx: any, sourceId: Id<"event_sources">): Promise<Doc<"event_source_stats"> | null> {
  return await ctx.db.query("event_source_stats").withIndex("by_source", (q: any) => q.eq("source_id", sourceId)).first();
}

/** A source's counters: their own row, else the fields a source made before that table still carries. */
export async function sourceStats(ctx: any, source: Doc<"event_sources">): Promise<SourceStats> {
  return pickStats((await statsRow(ctx, source._id)) ?? source);
}

/**
 * The one write of a source's counters. `patch` sees the current counters
 * (already rolled to today when the day changed), so a caller adds to what is
 * there. Never touches the source row.
 */
export async function patchSourceStats(ctx: any, source: Doc<"event_sources">, patch: (prev: SourceStats) => SourceStats, now = Date.now()): Promise<SourceStats> {
  const row = await statsRow(ctx, source._id);
  const stored = pickStats(row ?? source);
  const prev = rollStats(stored, now);
  // A roll is written with the patch: left unwritten, every later write rolls again and today's count restarts at its last batch.
  const rolled: SourceStats = prev.counters_day !== stored.counters_day ? { counters_day: prev.counters_day, events_today: prev.events_today, dropped_today: prev.dropped_today } : {};
  const next: SourceStats = { ...rolled, ...patch(prev) };
  // A move of today's counters is written into the day series too, so volume over time reads from one row.
  if ("events_today" in next || "dropped_today" in next) next.days = withDayCounters({ ...prev, ...next }, now);
  // And into the hour series, for a 24 hour chart of the same count; countLanded writes its own hours for dated points.
  const added = (next.events_today ?? prev.events_today ?? 0) - (prev.events_today ?? 0);
  if (added > 0 && !("hours" in next)) next.hours = withHourCount(prev.hours, now, added, now);
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert("event_source_stats", { source_id: source._id, workspace: source.workspace, ...prev, ...next });
  return { ...prev, ...next };
}

/** How many UTC days of counters a source keeps (event_source_stats.days). */
export const SOURCE_STAT_DAYS = 30;

/** Today's counters folded into the day series, oldest first, cut to SOURCE_STAT_DAYS. */
export function withDayCounters(stats: SourceStats, now: number): NonNullable<SourceStats["days"]> {
  const day = utcDay(now);
  const kept = (stats.days ?? []).filter((d) => d.day !== day && d.day < day);
  return [...kept, { day, events: stats.events_today ?? 0, dropped: stats.dropped_today ?? 0 }].slice(-SOURCE_STAT_DAYS);
}

/** How many hours of counts a source keeps (event_source_stats.hours): a 24 hour chart and the day before it. */
export const SOURCE_STAT_HOURS = 48;

/** `n` added to the hour holding `at`, oldest first, cut to the last SOURCE_STAT_HOURS before `now`. */
export function withHourCount(hours: SourceStats["hours"], at: number, n: number, now: number): NonNullable<SourceStats["hours"]> {
  const hour = Math.floor(Math.min(at, now) / HOUR_MS) * HOUR_MS;
  const floor = Math.floor(now / HOUR_MS) * HOUR_MS - (SOURCE_STAT_HOURS - 1) * HOUR_MS;
  const out = (hours ?? []).filter((h) => h.hour >= floor).map((h) => ({ ...h }));
  if (hour < floor || n <= 0) return out;
  const hit = out.find((h) => h.hour === hour);
  if (hit) hit.events += n;
  else out.push({ hour, events: n });
  return out.sort((a, b) => a.hour - b.hour);
}

/**
 * What a source sent that did not come through the ingest door, counted where
 * the door counts its items: a recording imported, the issues a recording
 * showed, a watch's reading. Each point lands on the day (and, inside
 * SOURCE_STAT_HOURS, the hour) it happened, so a backfilled recording from
 * last week adds to last week rather than to today. A patch for
 * patchSourceStats; points older than SOURCE_STAT_DAYS are not counted.
 */
export function countLanded(prev: SourceStats, points: readonly { at: number; n: number }[], now: number): SourceStats {
  const today = utcDay(now);
  const floorDay = utcDay(now - (SOURCE_STAT_DAYS - 1) * 86_400_000);
  let eventsToday = prev.events_today ?? 0;
  let hours = prev.hours;
  const days = new Map((prev.days ?? []).map((d) => [d.day, { ...d }]));
  let last = prev.last_event_at ?? 0;
  for (const p of points) {
    if (!(p.n > 0)) continue;
    const at = Math.min(p.at, now);
    const day = utcDay(at);
    if (day < floorDay) continue;
    hours = withHourCount(hours, at, p.n, now);
    last = Math.max(last, at);
    if (day === today) eventsToday += p.n;
    else {
      const d = days.get(day) ?? { day, events: 0, dropped: 0 };
      d.events += p.n;
      days.set(day, d);
    }
  }
  return {
    events_today: eventsToday,
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    hours: hours ?? [],
    ...(last ? { last_event_at: last } : {}),
  };
}

/**
 * The *_today counters on a new UTC day start from what today's hour and day
 * series already hold: nothing on a real new day, and on a row whose roll was
 * never written (counters_day stuck on an old day) the count the hours kept,
 * so today's day entry equals the sum of today's hours.
 */
export function rollStats(stats: SourceStats, now: number): SourceStats {
  const day = utcDay(now);
  if (stats.counters_day === day) return stats;
  const start = Date.parse(`${day}T00:00:00Z`);
  const hoursToday = (stats.hours ?? []).reduce((n, h) => (h.hour >= start ? n + h.events : n), 0);
  const entry = (stats.days ?? []).find((d) => d.day === day);
  return { ...stats, counters_day: day, events_today: Math.max(hoursToday, entry?.events ?? 0), dropped_today: entry?.dropped ?? 0 };
}

/** A source as any reader sees it, counters included: never the key hash or the manifest. */
export function sourceView(row: Doc<"event_sources">, stats: SourceStats = pickStats(row), now = Date.now()) {
  const { ingest_key_hash: _hash, manifest_json: _manifest, old_key_hash: _old, old_key_prefix, old_key_until, ...rest } = row;
  const oldKey = old_key_until && old_key_until > now ? { old_key_prefix, old_key_until } : {};
  return { ...rest, ...oldKey, events_today: 0, dropped_today: 0, groups_open: 0, ...rollStats(stats, now), keyed: !!row.ingest_key_hash };
}

export async function sourceViewOf(ctx: any, row: Doc<"event_sources">) {
  return sourceView(row, await sourceStats(ctx, row));
}

/** A group as lists show it: buckets cut to the window as of now. */
export function groupView(row: Doc<"event_groups">, now: number) {
  return { ...row, buckets: pruneBuckets(row.buckets, now) };
}
