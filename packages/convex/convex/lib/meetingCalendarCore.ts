// The part of calendar meeting bots that runs inside a mutation: which
// meetings a person wants, bringing their bots in line, and the two switches.
// Kept apart from meetingCalendar.ts (which reads Google) so dispatch.ts can
// run the switches without loading the Google connector.
import type { Doc, Id } from "../_generated/dataModel";
import { cancelBot, requestBot } from "../meetingBots";
import { MEETING_BOT_FINAL, type MeetingBotStatus } from "./recall";

/** How far ahead the calendar is read: the meetings a person can switch on. */
export const CALENDAR_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** How far ahead a wanted meeting gets its bot. Recall guarantees an on-time
 *  join for a bot scheduled 10 or more minutes out; a day ahead keeps a
 *  reschedule from churning bots for meetings a week away. */
export const SCHEDULE_AHEAD_MS = 24 * 60 * 60_000;
/** The bot asks to join this long before the start, so it is there when
 *  the first person arrives. */
export const JOIN_LEAD_MS = 60_000;
/** A meeting already under way this long still gets its bot. */
export const LATE_JOIN_MS = 15 * 60_000;

type CalendarMeeting = Doc<"meeting_calendar_events">;
type MeetingBot = Doc<"meeting_bots">;

const joinAtFor = (startsAt: number, now: number) => Math.max(startsAt - JOIN_LEAD_MS, now);

async function prefsOf(ctx: any, userId: Id<"users">): Promise<Doc<"meeting_bot_prefs"> | null> {
  return await ctx.db.query("meeting_bot_prefs").withIndex("by_user", (q: any) => q.eq("user_id", userId)).first();
}

async function botOf(ctx: any, meetId: string | undefined): Promise<MeetingBot | null> {
  if (!meetId) return null;
  return await ctx.db.query("meeting_bots").withIndex("by_meet_id", (q: any) => q.eq("meet_id", meetId)).first();
}

/** Whether a meeting is wanted: the person's own switch, else their
 *  join-all setting. */
export function meetingWanted(m: Pick<CalendarMeeting, "choice">, joinAll: boolean): boolean {
  return m.choice === "on" || (m.choice !== "off" && joinAll);
}

/** This person no longer wants the bot on a meeting: their own bot that has
 *  not joined goes back (or passes to a teammate it also attends for); a
 *  teammate's bot simply stops attending for them. A bot already in the
 *  meeting stays: removing it is the Remove control's job, never a sweep's. */
async function letGo(ctx: any, userId: Id<"users">, bot: MeetingBot): Promise<void> {
  if (String(bot.user_id) !== String(userId)) {
    const rest = (bot.also_for ?? []).filter((u) => String(u) !== String(userId));
    if (rest.length !== (bot.also_for ?? []).length) await ctx.db.patch(bot._id, { also_for: rest, updated_at: Date.now() });
    return;
  }
  if (bot.status !== "requested" && bot.status !== "scheduled") return;
  const [heir, ...rest] = bot.also_for ?? [];
  if (heir) {
    await ctx.db.patch(bot._id, { user_id: heir, also_for: rest, updated_at: Date.now() });
    return;
  }
  await cancelBot(ctx, userId, bot.meet_id);
}

/** Bring one person's bots in line with their calendar and switches. */
export async function reconcileUser(ctx: any, userId: Id<"users">, now = Date.now()): Promise<void> {
  const joinAll = !!(await prefsOf(ctx, userId))?.join_all;
  const soon: CalendarMeeting[] = await ctx.db
    .query("meeting_calendar_events")
    .withIndex("by_user_starts", (q: any) => q.eq("user_id", userId).gte("starts_at", now - LATE_JOIN_MS).lte("starts_at", now + SCHEDULE_AHEAD_MS))
    .collect();
  for (const m of soon) {
    const bot = await botOf(ctx, m.meet_id);
    const live = bot && !MEETING_BOT_FINAL.has(bot.status as MeetingBotStatus) ? bot : null;
    if (!meetingWanted(m, joinAll)) {
      if (live) await letGo(ctx, userId, live);
      if (m.meet_id) await ctx.db.patch(m._id, { meet_id: undefined });
      continue;
    }
    const joinAt = joinAtFor(m.starts_at, now);
    // Moved since its bot was scheduled: a bot not yet joining is taken back
    // and a new one scheduled for the new time.
    if (live && String(live.user_id) === String(userId) && live.status === "scheduled" && live.join_at && Math.abs(live.join_at - joinAt) > JOIN_LEAD_MS) {
      await letGo(ctx, userId, live);
    } else if (live) {
      continue;
    }
    try {
      const row = await requestBot(ctx, userId, {
        meeting_url: m.meeting_url,
        ...(joinAt > now ? { join_at: joinAt } : {}),
        calendar_event_id: m.event_id,
      });
      await ctx.db.patch(m._id, { meet_id: row.meet_id });
    } catch (e) {
      // Calls off for the team, or no team: the switch stays as the person
      // set it, and the next sweep tries again.
      console.warn(`[meetingCalendar] no bot for ${m.event_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}


/** The person's switch on one meeting: "on", "off", or null to follow their
 *  join-all setting. */
export async function setMeetingChoiceFor(
  ctx: any,
  userId: Id<"users">,
  id: string,
  choice: "on" | "off" | null,
): Promise<void> {
  const rowId = ctx.db.normalizeId("meeting_calendar_events", id);
  const m = rowId ? await ctx.db.get(rowId) : null;
  if (!m || String(m.user_id) !== String(userId)) throw new Error("Meeting not found");
  await ctx.db.patch(m._id, { choice: choice ?? undefined, updated_at: Date.now() });
  await reconcileUser(ctx, userId);
}

export async function setJoinAllFor(ctx: any, userId: Id<"users">, joinAll: boolean): Promise<void> {
  const now = Date.now();
  const had = await prefsOf(ctx, userId);
  if (had) await ctx.db.patch(had._id, { join_all: joinAll, updated_at: now });
  else await ctx.db.insert("meeting_bot_prefs", { user_id: userId, join_all: joinAll, updated_at: now });
  await reconcileUser(ctx, userId, now);
}

export { prefsOf, botOf, letGo };
