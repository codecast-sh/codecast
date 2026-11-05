// A source's volume rebuilt from what it already left behind. The day and hour
// series (event_source_stats.days and .hours) count what a source sent: the
// door's items, and since countLanded also the recordings a vendor import
// brings in and the issues those recordings show. Sources that only poll
// (PostHog, Sentry imports) had empty series before that, so this pass fills
// the last SOURCE_STAT_DAYS from their stored recordings and the last
// SOURCE_STAT_HOURS from their groups' hourly buckets. It merges by taking the
// larger count per day and hour, so it never adds to what the door already
// counted and running it twice changes nothing.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { patchSourceStats, SOURCE_STAT_DAYS, SOURCE_STAT_HOURS, type SourceStats } from "./lib/sourceStats";
import { utcDay } from "./lib/ingestGroups";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PAGE = 100;

type Counts = Record<string, number>;

/** One recording as volume: itself, and each issue it showed. */
export function recordingVolume(r: { started_at: number; group_ids: readonly unknown[] }): number {
  return 1 + r.group_ids.length;
}

/** `n` added under the day and, inside the hour window, the hour of `at`. */
export function addPoint(days: Counts, hours: Counts, at: number, n: number, now: number): void {
  if (!(n > 0) || at > now || at < now - SOURCE_STAT_DAYS * DAY_MS) return;
  const day = utcDay(at);
  days[day] = (days[day] ?? 0) + n;
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  if (hour >= Math.floor(now / HOUR_MS) * HOUR_MS - (SOURCE_STAT_HOURS - 1) * HOUR_MS) hours[hour] = (hours[hour] ?? 0) + n;
}

/** The counters with each day and hour raised to what was derived, never lowered. */
export function mergeVolume(prev: SourceStats, days: Counts, hours: Counts, now: number): SourceStats {
  const today = utcDay(now);
  const floorDay = utcDay(now - (SOURCE_STAT_DAYS - 1) * DAY_MS);
  const floorHour = Math.floor(now / HOUR_MS) * HOUR_MS - (SOURCE_STAT_HOURS - 1) * HOUR_MS;
  const byDay = new Map((prev.days ?? []).map((d) => [d.day, { ...d }]));
  for (const [day, n] of Object.entries(days)) {
    if (day === today || day < floorDay) continue;
    const d = byDay.get(day) ?? { day, events: 0, dropped: 0 };
    d.events = Math.max(d.events, n);
    byDay.set(day, d);
  }
  const byHour = new Map((prev.hours ?? []).filter((h) => h.hour >= floorHour).map((h) => [h.hour, { ...h }]));
  for (const [k, n] of Object.entries(hours)) {
    const hour = Number(k);
    if (hour < floorHour) continue;
    const h = byHour.get(hour) ?? { hour, events: 0 };
    h.events = Math.max(h.events, n);
    byHour.set(hour, h);
  }
  const merged = [...byHour.values()].sort((a, b) => a.hour - b.hour);
  // Today's count is never less than today's hours, so the day and hour series agree.
  const start = Date.parse(`${today}T00:00:00Z`);
  const hoursToday = merged.reduce((n, h) => (h.hour >= start ? n + h.events : n), 0);
  return {
    events_today: Math.max(prev.events_today ?? 0, days[today] ?? 0, hoursToday),
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    hours: merged,
  };
}

/**
 * One source, a page of recordings at a time; the last page adds the groups'
 * buckets and writes the merge. Counts ride the scheduler between pages.
 */
export const rebuildSourceVolume = internalMutation({
  args: { source_id: v.id("event_sources"), cursor: v.optional(v.union(v.string(), v.null())), days_json: v.optional(v.string()), hours_json: v.optional(v.string()), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return { done: true };
    const now = args.now ?? Date.now();
    const days: Counts = args.days_json ? JSON.parse(args.days_json) : {};
    const hours: Counts = args.hours_json ? JSON.parse(args.hours_json) : {};
    const page = await ctx.db
      .query("replays")
      .withIndex("by_source_started", (q: any) => q.eq("source_id", source._id).gte("started_at", now - SOURCE_STAT_DAYS * DAY_MS))
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
    for (const r of page.page) addPoint(days, hours, r.started_at, recordingVolume(r), now);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.sourceVolume.rebuildSourceVolume, { source_id: source._id, cursor: page.continueCursor, days_json: JSON.stringify(days), hours_json: JSON.stringify(hours), now });
      return { done: false };
    }
    // Occurrences outside recordings: the groups' hourly buckets (kept for 72 hours), recordings' own issues left to the pass above.
    const groups = await ctx.db
      .query("event_groups")
      .withIndex("by_source_last_seen", (q: any) => q.eq("source_id", source._id).gte("last_seen", now - SOURCE_STAT_HOURS * HOUR_MS))
      .collect();
    const fromGroups: Counts = {};
    const fromGroupHours: Counts = {};
    for (const g of groups) {
      if (g.kind === "replay_issue") continue;
      for (const b of g.buckets ?? []) addPoint(fromGroups, fromGroupHours, b.hour, b.count, now);
    }
    // Recordings and loose occurrences are different things, so they add; the merge with the door's own count takes the larger.
    for (const [k, n] of Object.entries(fromGroups)) days[k] = (days[k] ?? 0) + n;
    for (const [k, n] of Object.entries(fromGroupHours)) hours[k] = (hours[k] ?? 0) + n;
    await patchSourceStats(ctx, source, (prev) => mergeVolume(prev, days, hours, now), now);
    return { done: true };
  },
});

/** Every source (or one workspace's), each in its own run. */
export const rebuildAllSourceVolumes = internalMutation({
  args: { workspace: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = args.workspace
      ? await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", args.workspace)).collect()
      : await ctx.db.query("event_sources").collect();
    const now = Date.now();
    for (const s of rows) await ctx.scheduler.runAfter(0, internal.sourceVolume.rebuildSourceVolume, { source_id: s._id as Id<"event_sources">, now });
    return { scheduled: rows.length };
  },
});
