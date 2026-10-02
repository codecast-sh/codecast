// When Changes days are rebuilt (docs/proposals/changes-page.md 7.7). Writes
// mark days dirty through lib/changesDirty.ts; this module owns the runs:
// rebuildDay for one marked day, the 6-hour reconcile that catches days no
// write marked, the two-week backfill when a team turns Changes on, and the
// paged continuation of a member's visibility change.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { runBuildDay, type BuildDayResult } from "./changes";
import { runProse } from "./changesProse";
import {
  BACKFILL_DAYS,
  BACKFILL_SPACING_MS,
  MEMBER_PAGE,
  RECONCILE_DAYS,
  changesZone,
  claimDirtyDay,
  finishDirtyDay,
  markDayDirty,
  rebuildDates,
  rescheduleStranded,
  withdrawAndMark,
} from "./lib/changesDirty";
import { addDays, dayBounds, localDate } from "./lib/teamDay";
import { isHarnessScratch, normalizeRepository } from "./lib/gitRefs";

const dayArgs = { team_id: v.id("teams"), repository: v.string(), date: v.string() };
const dayKey = v.object({ repository: v.string(), date: v.string() });

/** Commits per page when finding which days a team has work on. */
const DAYS_PAGE = 500;
const DAYS_PAGE_BYTES = 8 * 1024 * 1024;

// ── rebuildDay ───────────────────────────────────────────────────────────

/** The dates the run covers, or null when the team has Changes off (its dirty row goes). */
export const claimDay = internalMutation({
  args: dayArgs,
  handler: async (ctx, args): Promise<{ dates: string[] } | null> => {
    const zone = await claimDirtyDay(ctx, args);
    return zone ? { dates: rebuildDates(args.date, zone, Date.now()) } : null;
  },
});

export const finishDay = internalMutation({
  args: dayArgs,
  handler: async (ctx, args): Promise<void> => finishDirtyDay(ctx, args),
});

/**
 * Rebuild one marked team day: layer 0 for the day (and yesterday, in the
 * first hours after midnight), then each day's story and edition prose
 * (changesProse.ts), then the dirty row goes unless a mark arrived meanwhile
 * (prose waiting on a story to settle makes one). A run that throws leaves its
 * row for the reconcile.
 */
export const rebuildDay = internalAction({
  args: dayArgs,
  handler: async (ctx, args): Promise<{ built: BuildDayResult[] } | { skipped: string }> => {
    const claim: { dates: string[] } | null = await ctx.runMutation(internal.changesSchedule.claimDay, args);
    if (!claim) return { skipped: "Changes is off for this team" };
    const built: BuildDayResult[] = [];
    for (const date of claim.dates) built.push(await runBuildDay(ctx, { ...args, date }));
    for (const day of built) await runProse(ctx, { team_id: args.team_id, repository: day.repository, date: day.date, pending: day.pending });
    await ctx.runMutation(internal.changesSchedule.finishDay, args);
    return { built };
  },
});

// ── Finding days with work ───────────────────────────────────────────────

/** Teams with Changes on, each with the zone its day is cut in. */
export const changesTeams = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ team_id: Id<"teams">; timezone: string }>> => {
    const out: Array<{ team_id: Id<"teams">; timezone: string }> = [];
    for (const team of await ctx.db.query("teams").collect()) {
      if (!team.features?.changes) continue;
      const timezone = await changesZone(ctx, team._id);
      if (timezone) out.push({ team_id: team._id, timezone });
    }
    return out;
  },
});

export const teamZone = internalQuery({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<string | null> => changesZone(ctx, args.team_id),
});

/** One page of the (repository, team-local date) pairs the team's commits since `start` fall on. */
export const commitDaysPage = internalQuery({
  args: { team_id: v.id("teams"), timezone: v.string(), start: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ days: Array<{ repository: string; date: string }>; cursor: string; done: boolean }> => {
    const page = await ctx.db
      .query("commits")
      .withIndex("by_team_timestamp", (q) => q.eq("team_id", args.team_id).gte("timestamp", args.start))
      .paginate({ numItems: DAYS_PAGE, cursor: args.cursor, maximumBytesRead: DAYS_PAGE_BYTES });
    const days = new Map<string, { repository: string; date: string }>();
    for (const c of page.page) {
      if (!c.repository || isHarnessScratch({ branch: c.branch })) continue;
      const day = { repository: normalizeRepository(c.repository), date: localDate(c.timestamp, args.timezone) };
      days.set(`${day.repository}\n${day.date}`, day);
    }
    return { days: [...days.values()], cursor: page.continueCursor, done: page.isDone };
  },
});

/** Mark days dirty, spaced apart, newest first as given. `skip_final` passes over days whose edition is final. */
export const markDays = internalMutation({
  args: { team_id: v.id("teams"), days: v.array(dayKey), spacing_ms: v.number(), skip_final: v.boolean() },
  handler: async (ctx, args): Promise<number> => {
    if (!(await changesZone(ctx, args.team_id))) return 0;
    let marked = 0;
    for (const day of args.days) {
      if (args.skip_final) {
        const edition = await ctx.db
          .query("digests")
          .withIndex("by_team_repo_scope_date", (q) =>
            q.eq("team_id", args.team_id).eq("repository", day.repository).eq("scope", "day").eq("date", day.date))
          .first();
        if (edition?.status === "final") continue;
      }
      await markDayDirty(ctx, { team_id: args.team_id, ...day }, args.spacing_ms * marked);
      marked += 1;
    }
    return marked;
  },
});

/** Mark every day of the last `days` (today included) on which the team has commits. */
async function markRecentDays(ctx: ActionCtx, teamId: Id<"teams">, timezone: string, days: number, skipFinal: boolean): Promise<number> {
  const start = dayBounds(addDays(localDate(Date.now(), timezone), -(days - 1)), timezone).start;
  const found = new Map<string, { repository: string; date: string }>();
  let cursor: string | null = null;
  for (;;) {
    const page: { days: Array<{ repository: string; date: string }>; cursor: string; done: boolean } =
      await ctx.runQuery(internal.changesSchedule.commitDaysPage, { team_id: teamId, timezone, start, cursor });
    for (const d of page.days) found.set(`${d.repository}\n${d.date}`, d);
    if (page.done) break;
    cursor = page.cursor;
  }
  const list = [...found.values()].sort((a, b) => b.date.localeCompare(a.date) || a.repository.localeCompare(b.repository));
  if (!list.length) return 0;
  return await ctx.runMutation(internal.changesSchedule.markDays, { team_id: teamId, days: list, spacing_ms: BACKFILL_SPACING_MS, skip_final: skipFinal });
}

// ── Cron, backfill, member continuation ──────────────────────────────────

export const rescheduleStrandedDays = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => rescheduleStranded(ctx, Date.now()),
});

/** Every 6 hours (crons.ts): days of the last three with commits and no final edition, and rebuilds that died. */
export const reconcile = internalAction({
  args: {},
  handler: async (ctx): Promise<{ teams: number; marked: number; rescheduled: number }> => {
    const teams: Array<{ team_id: Id<"teams">; timezone: string }> = await ctx.runQuery(internal.changesSchedule.changesTeams, {});
    let marked = 0;
    for (const team of teams) marked += await markRecentDays(ctx, team.team_id, team.timezone, RECONCILE_DAYS, true);
    const rescheduled: number = await ctx.runMutation(internal.changesSchedule.rescheduleStrandedDays, {});
    return { teams: teams.length, marked, rescheduled };
  },
});

/** A team turned Changes on (lib/changesDirty.changesFlagChanged): its last two weeks, 5 seconds apart. */
export const backfill = internalAction({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<{ marked: number }> => {
    const timezone: string | null = await ctx.runQuery(internal.changesSchedule.teamZone, args);
    if (!timezone) return { marked: 0 };
    return { marked: await markRecentDays(ctx, args.team_id, timezone, BACKFILL_DAYS, false) };
  },
});

/** The rest of a member's story inputs after a visibility change, a page at a time. */
export const invalidateForMember = internalMutation({
  args: { owner_id: v.id("users"), team_id: v.id("teams"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.db
      .query("change_story_inputs")
      .withIndex("by_owner", (q) => q.eq("owner_id", args.owner_id).eq("team_id", args.team_id))
      .paginate({ numItems: MEMBER_PAGE, cursor: args.cursor });
    await withdrawAndMark(ctx, page.page);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.changesSchedule.invalidateForMember, { ...args, cursor: page.continueCursor });
    }
  },
});
