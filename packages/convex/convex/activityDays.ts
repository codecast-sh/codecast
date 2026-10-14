import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ACTIVITY_DAY_MS, ACTIVITY_LIVE_DAYS, rollupActivityDay } from "./lib/activityDaily";
import { dayStartUtc } from "./lib/userSend";

// The rollup behind `user_activity_daily` (see lib/activityDaily.ts for why
// the profile cannot read a year of per-session rows).
//
// Two writers, both idempotent:
//   - the hourly sweep re-rolls the days that just left the live window for
//     everyone who was active in them, so a day settles within an hour of
//     leaving it and a late transcript sync corrects the day it belongs to;
//   - `backfill` walks a user's history day by day, for the one-time fill and
//     for repairing a stretch by hand.

/** Days the sweep re-rolls each run: the live window plus a day of slack. */
const SWEEP_DAYS = ACTIVITY_LIVE_DAYS + 2;

export const rollupDay = internalMutation({
  args: { user_id: v.id("users"), day_start: v.number() },
  handler: async (ctx, args) => {
    return await rollupActivityDay(ctx, args.user_id, dayStartUtc(args.day_start));
  },
});

/**
 * One batch of a user's history, newest day first. Returns the next day to do
 * (or null at the end) and stops early once it has read enough for one
 * transaction — a heavy day is hundreds of sessions, an empty one is three
 * index reads, so the batch is sized by sessions seen rather than by days.
 */
export const rollupDaysBatch = internalMutation({
  args: {
    user_id: v.id("users"),
    from_day: v.number(),
    until_day: v.number(),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const budget = args.budget ?? 400;
    let day = dayStartUtc(args.from_day);
    const until = dayStartUtc(args.until_day);
    let sessions = 0;
    let days = 0;
    while (day >= until) {
      const res = await rollupActivityDay(ctx, args.user_id, day);
      sessions += res.sessions;
      days++;
      day -= ACTIVITY_DAY_MS;
      if (sessions >= budget) break;
    }
    return { days, sessions, next_day: day >= until ? day : null };
  },
});

/** Everyone who could have activity to roll up, newest heartbeat first. */
export const rollupCandidates = internalQuery({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const since = args.since;
    return users
      .filter((u) => !since || (u.daemon_last_seen ?? 0) >= since || u._creationTime >= since)
      .map((u) => u._id);
  },
});

/**
 * Re-roll the days around the live window for everyone active in them. One
 * mutation per (user, day) keeps each transaction small; the users table is
 * small enough to walk in one read.
 */
export const sweep = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const days = args.days ?? SWEEP_DAYS;
    const today = dayStartUtc(Date.now());
    const since = today - days * ACTIVITY_DAY_MS;
    const users: Id<"users">[] = await ctx.runQuery(internal.activityDays.rollupCandidates, { since });
    let rolled = 0;
    for (const user_id of users) {
      for (let i = 0; i < days; i++) {
        await ctx.runMutation(internal.activityDays.rollupDay, {
          user_id,
          day_start: today - i * ACTIVITY_DAY_MS,
        });
        rolled++;
      }
    }
    return { users: users.length, rolled };
  },
});

/**
 * Fill (or repair) a stretch of history. `user_id` does one account; without it
 * every account is walked, each from today back `days`. Chunked through
 * `rollupDaysBatch` so no single transaction reads a year of sessions, and
 * re-scheduled when the chunk runs long rather than racing the action timeout.
 */
export const backfill = internalAction({
  args: {
    user_id: v.optional(v.id("users")),
    days: v.optional(v.number()),
    /** Resume point for the re-scheduled continuation. */
    start_index: v.optional(v.number()),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ users: number; done: number; sessions: number; more: boolean }> => {
    const days = args.days ?? 400;
    const today = dayStartUtc(Date.now());
    const until = today - days * ACTIVITY_DAY_MS;
    const users: Id<"users">[] = args.user_id
      ? [args.user_id]
      : await ctx.runQuery(internal.activityDays.rollupCandidates, {});
    const startedAt = Date.now();
    const SLICE_MS = 5 * 60_000;

    let sessions = 0;
    let index = args.start_index ?? 0;
    for (; index < users.length; index++) {
      let day: number | null = today;
      while (day !== null) {
        const res: { days: number; sessions: number; next_day: number | null } = await ctx.runMutation(
          internal.activityDays.rollupDaysBatch,
          { user_id: users[index], from_day: day, until_day: until, budget: args.budget },
        );
        sessions += res.sessions;
        day = res.next_day;
      }
      if (Date.now() - startedAt > SLICE_MS && index + 1 < users.length) {
        await ctx.scheduler.runAfter(0, internal.activityDays.backfill, {
          ...args,
          start_index: index + 1,
        });
        return { users: users.length, done: index + 1, sessions, more: true };
      }
    }
    return { users: users.length, done: index, sessions, more: false };
  },
});
