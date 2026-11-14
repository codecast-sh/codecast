// Meeting bots from a person's calendar: their connected Google Calendar's
// upcoming meetings with a link a bot can join, each with the person's own
// switch, and a join-all setting that is off unless they turn it on. Nothing
// joins a meeting until the person said so (decision sd-3233).
//
//   syncAll (cron)   reads each connected calendar a week ahead and files
//                    the meetings with links (meeting_calendar_events)
//   reconcileUser    a meeting the person wants that starts within a day gets
//                    a scheduled bot (meetingBots.requestBot, shared with any
//                    teammate's bot for the same meeting); one they no longer
//                    want, or that moved or vanished, has its bot taken back
//                    or rescheduled while it has not joined yet
// Outlook calendars need a Microsoft connection codecast does not have yet.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CALENDAR_EVENTS_SCOPE, googleAccessTokenForUser, googleScopeGranted } from "./googleOAuth";
import { MEETING_BOT_FINAL, meetingOfEvent, type GoogleCalendarEvent, type MeetingBotStatus } from "./lib/recall";
import { CALENDAR_WINDOW_MS, LATE_JOIN_MS, botOf, letGo, prefsOf, reconcileUser, setJoinAllFor, setMeetingChoiceFor } from "./lib/meetingCalendarCore";

type CalendarMeeting = Doc<"meeting_calendar_events">;

// ── Reading the calendar ───────────────────────────────────────────────────

export const calendarUsers = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"users">[]> => {
    const users = new Set<string>();
    for await (const row of ctx.db.query("google_installations")) {
      if (!row.pending_confirm_hash && googleScopeGranted(row.granted_scopes, CALENDAR_EVENTS_SCOPE)) users.add(String(row.scope_user_id));
    }
    return [...users] as Id<"users">[];
  },
});

type FiledMeeting = { event_id: string; title: string; starts_at: number; ends_at: number; meeting_url: string; platform: string };

async function syncUserCalendar(ctx: any, userId: Id<"users">): Promise<{ ok: boolean; error?: string }> {
  const token = await googleAccessTokenForUser(ctx, { user_id: String(userId), scope: CALENDAR_EVENTS_SCOPE });
  if (!token.ok) return { ok: false, error: token.error };
  const now = Date.now();
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date(now - LATE_JOIN_MS).toISOString(),
    timeMax: new Date(now + CALENDAR_WINDOW_MS).toISOString(),
    maxResults: "250",
    fields: "items(id,status,summary,start,end,hangoutLink,conferenceData/entryPoints,location,description,attendees(self,responseStatus))",
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!res.ok) return { ok: false, error: `Google Calendar answered ${res.status}` };
  const items: GoogleCalendarEvent[] = ((await res.json()) as any).items ?? [];
  const meetings: FiledMeeting[] = [];
  for (const e of items) {
    const m = meetingOfEvent(e);
    if (m) meetings.push({ event_id: e.id, title: m.title.slice(0, 200), starts_at: m.starts_at, ends_at: m.ends_at, meeting_url: m.url, platform: m.platform });
  }
  await ctx.runMutation(internal.meetingCalendar.applyCalendar, { user_id: userId, meetings, read_at: now });
  return { ok: true };
}

export const syncAll = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const users: Id<"users">[] = await ctx.runQuery(internal.meetingCalendar.calendarUsers, {});
    for (const u of users) {
      const out = await syncUserCalendar(ctx, u).catch((e) => ({ ok: false, error: String(e) }));
      if (!out.ok) console.warn(`[meetingCalendar] ${u}: ${out.error}`);
    }
  },
});

/** The calls page opened, or a calendar was just connected: read it now
 *  rather than at the next sweep. */
export const refreshMine = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, error: "signed_out" };
    return await syncUserCalendar(ctx, userId);
  },
});

/** One read of a person's calendar: what it lists now replaces what was
 *  filed (a meeting gone from it is gone here, its unjoined bot with it), the
 *  person's switches survive on the meetings that remain, and their bots are
 *  brought in line. */
export const applyCalendar = internalMutation({
  args: {
    user_id: v.id("users"),
    read_at: v.number(),
    meetings: v.array(v.object({
      event_id: v.string(),
      title: v.string(),
      starts_at: v.number(),
      ends_at: v.number(),
      meeting_url: v.string(),
      platform: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const now = args.read_at;
    const filed: CalendarMeeting[] = await ctx.db
      .query("meeting_calendar_events")
      .withIndex("by_user_starts", (q: any) => q.eq("user_id", args.user_id))
      .collect();
    const byEvent = new Map(filed.map((m) => [m.event_id, m]));
    const seen = new Set<string>();
    for (const m of args.meetings) {
      seen.add(m.event_id);
      const had = byEvent.get(m.event_id);
      if (!had) {
        await ctx.db.insert("meeting_calendar_events", { user_id: args.user_id, ...m, updated_at: now });
        continue;
      }
      const changed = had.title !== m.title || had.starts_at !== m.starts_at || had.ends_at !== m.ends_at || had.meeting_url !== m.meeting_url;
      if (changed) await ctx.db.patch(had._id, { ...m, updated_at: now });
    }
    for (const had of filed) {
      if (seen.has(had.event_id)) continue;
      // Past meetings leave quietly; an upcoming one the calendar no longer
      // lists (cancelled, declined, moved off the window) takes its bot back.
      if (had.starts_at >= now - LATE_JOIN_MS) {
        const bot = await botOf(ctx, had.meet_id);
        if (bot && !MEETING_BOT_FINAL.has(bot.status as MeetingBotStatus)) await letGo(ctx, args.user_id, bot);
      }
      await ctx.db.delete(had._id);
    }
    await reconcileUser(ctx, args.user_id, Date.now());
  },
});

// ── The person's switches ──────────────────────────────────────────────────

export const setMeetingChoice = mutation({
  args: { id: v.id("meeting_calendar_events"), choice: v.union(v.literal("on"), v.literal("off"), v.null()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await setMeetingChoiceFor(ctx, userId, args.id, args.choice);
  },
});

export const setJoinAll = mutation({
  args: { join_all: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await setJoinAllFor(ctx, userId, args.join_all);
  },
});

// ── What the calls page reads ──────────────────────────────────────────────

/** The viewer's upcoming meetings with links, soonest first, as filed. Each
 *  row's bot (meet_id) is read from the meeting bots collection. */
export const listUpcoming = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("meeting_calendar_events")
      .withIndex("by_user_starts", (q: any) => q.eq("user_id", userId).gte("starts_at", Date.now() - 2 * 60 * 60_000))
      .take(100);
    return rows.map((m) => ({
      _id: m._id,
      event_id: m.event_id,
      title: m.title,
      starts_at: m.starts_at,
      ends_at: m.ends_at,
      meeting_url: m.meeting_url,
      platform: m.platform,
      choice: m.choice ?? null,
      meet_id: m.meet_id ?? null,
      updated_at: m.updated_at,
    }));
  },
});

/** The viewer's calendar connection and join-all setting. `calendar`:
 *  "connected" (a Google account with calendar access), "missing_scope"
 *  (Google connected without it: ask for the calendar grant) or
 *  "not_connected". */
export const MEETING_BOT_SETTINGS_ID = "meetingBotSettings";

export const getSettings = query({
  args: {},
  handler: async (ctx): Promise<Array<{ _id: string; calendar: "connected" | "missing_scope" | "not_connected"; join_all: boolean }>> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("google_installations").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId)).collect();
    const live = rows.filter((r) => !r.pending_confirm_hash);
    const calendar = live.some((r) => googleScopeGranted(r.granted_scopes, CALENDAR_EVENTS_SCOPE))
      ? "connected"
      : live.length ? "missing_scope" : "not_connected";
    // One row, so the calls page holds it in a collection and a join-all
    // press paints at once like every other switch.
    return [{ _id: MEETING_BOT_SETTINGS_ID, calendar, join_all: !!(await prefsOf(ctx, userId))?.join_all }];
  },
});
