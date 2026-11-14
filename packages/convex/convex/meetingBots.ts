// Meeting bots: a Recall.ai bot attends a meeting on another platform (Zoom,
// Google Meet, Teams, Webex, GoTo) and the meeting becomes an ordinary
// codecast call. The call is a transcripts row under `meet:<meet_id>`, so the
// calls page, `cast calls`, summaries, action items, call_ended triggers and
// live agent feeds all work on it unchanged; what is particular to a meeting
// bot lives here and in lib/recall.ts.
//
// The life of one bot:
//   send / cliSend      a meeting_bots row (requested) and a create job
//   createBot           Recall's create; the row learns its bot id
//   status webhook      joining, waiting room, in call, recording, ended
//                       Recording begins the call record; the end ends it.
//   realtime webhook    each finished line a person said, by speaker
// The sender owns the call (transcripts.canReadCall); a teammate Recall
// matched by email is filed under their codecast id and reads it too.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { httpAction } from "./_generated/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { meetRoomKey, parseRoomKey } from "@codecast/shared/contracts";
import { callsOffReason, recRoutingTeam } from "./callRooms";
import { beginCallRecord, claimRollingSummary, endTranscript, writeSegments } from "./transcripts";
import { verifyApiToken } from "./apiTokens";
import { insertRoomRow, relayLineToFeeds } from "./callChat";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { isTeamMember } from "./privacy";
import { callRecordingKey, callRecordingsBucketFromEnv, r2CopyFromUrl } from "./lib/r2";
import { syncCallVideo } from "./lib/callRecordingRuns";
import {
  MEETING_BOT_FINAL,
  BOT_NAME,
  MEETING_PLATFORM_NAMES,
  lineFromTranscriptData,
  meetingChatText,
  parseMeetingUrl,
  recallBotBody,
  recallFetch,
  recallSpeakerId,
  recallSubCodeWords,
  statusFromRecallEvent,
  verifyRecallRequest,
  type MeetingBotStatus,
  type MeetingPlatform,
  type RecallParticipant,
} from "./lib/recall";

/** How many times a create is asked of Recall when it may pass (no warm bot
 *  free, a 5xx, a rate limit), and how long apart. Recall refills its pool of
 *  warm bots every few minutes and asks for retries about every 30s. */
export const CREATE_RETRY_LIMIT = 8;
export const CREATE_RETRY_MS = 30_000;

/** Lines compared against a new one to drop a retried delivery of it. */
const DEDUPE_WINDOW = 12;

type MeetingBot = Doc<"meeting_bots">;

function shapeBot(b: MeetingBot) {
  return {
    _id: b._id,
    meet_id: b.meet_id,
    room_key: meetRoomKey(b.meet_id),
    meeting_url: b.meeting_url,
    platform: b.platform,
    platform_name: MEETING_PLATFORM_NAMES[b.platform as MeetingPlatform] ?? b.platform,
    status: b.status,
    status_words: b.status_words ?? null,
    join_at: b.join_at ?? null,
    transcript_id: b.transcript_id ?? null,
    client_key: b.client_key ?? null,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

export type MeetingBotRow = ReturnType<typeof shapeBot>;

async function botByMeetId(ctx: any, meetId: string): Promise<MeetingBot | null> {
  return await ctx.db.query("meeting_bots").withIndex("by_meet_id", (q: any) => q.eq("meet_id", meetId)).first();
}

async function botByRecallId(ctx: any, botId: string): Promise<MeetingBot | null> {
  return await ctx.db.query("meeting_bots").withIndex("by_bot_id", (q: any) => q.eq("bot_id", botId)).first();
}

/** How far apart two bots for one meeting link may be scheduled and still be
 *  the same meeting (a recurring link reused next week is another one). */
const SAME_MEETING_WINDOW_MS = 30 * 60_000;

/** Teammates a shared bot attends for may read its call, the way a teammate
 *  it heard speak may (callRooms.canReadRoomlessCall reads recorded_people). */
async function shareCallWith(ctx: any, transcriptId: Id<"transcripts">, users: Id<"users">[]): Promise<void> {
  const t = await ctx.db.get(transcriptId);
  if (!t) return;
  const have = new Set((t.recorded_people ?? []).map(String));
  const add = users.filter((u) => !have.has(String(u)));
  if (add.length) await ctx.db.patch(t._id, { recorded_people: [...(t.recorded_people ?? []), ...add] });
}

/** One request for a bot, from the web or the CLI. Validates the link before
 *  a bot is paid for, files the call where the sender's own history finds it,
 *  and holds the calls feature gate every call path holds. */
export async function requestBot(
  ctx: any,
  userId: Id<"users">,
  args: {
    meeting_url: string;
    join_at?: number;
    feed_conversation_id?: Id<"conversations">;
    client_key?: string;
    // The calendar asked (meetingCalendar.ts): a teammate's bot already going
    // to this meeting attends for this person too, rather than a second bot.
    calendar_event_id?: string;
  },
): Promise<MeetingBotRow> {
  const parsed = parseMeetingUrl(args.meeting_url);
  if (!parsed.ok) throw new Error(parsed.reason);
  const teamId = await recRoutingTeam(ctx, userId);
  if (!teamId) throw new Error("Join a team before sending a bot to a meeting.");
  const off = await callsOffReason(ctx, teamId);
  if (off) throw new Error(off);
  const now = Date.now();
  if (args.calendar_event_id) {
    const sameMeeting: MeetingBot[] = await ctx.db
      .query("meeting_bots")
      .withIndex("by_url", (q: any) => q.eq("meeting_url", parsed.url))
      .collect();
    const shared = sameMeeting.find(
      (b) =>
        String(b.team_id) === String(teamId) &&
        !MEETING_BOT_FINAL.has(b.status as MeetingBotStatus) &&
        Math.abs((b.join_at ?? b.created_at) - (args.join_at ?? now)) < SAME_MEETING_WINDOW_MS,
    );
    if (shared) {
      if (String(shared.user_id) !== String(userId) && !(shared.also_for ?? []).some((u) => String(u) === String(userId))) {
        await ctx.db.patch(shared._id, { also_for: [...(shared.also_for ?? []), userId], updated_at: now });
        if (shared.transcript_id) await shareCallWith(ctx, shared.transcript_id, [userId]);
      }
      return shapeBot((await ctx.db.get(shared._id))!);
    }
  }
  // The same meeting asked for twice while its bot is still going is one bot.
  const mine: MeetingBot[] = await ctx.db
    .query("meeting_bots")
    .withIndex("by_user_created", (q: any) => q.eq("user_id", userId).gte("created_at", now - 24 * 60 * 60_000))
    .collect();
  // A calendar request was matched by time above: a recurring meeting reuses
  // its link, and tomorrow's occurrence is not today's bot.
  const open = args.calendar_event_id
    ? undefined
    : mine.find((b) => b.meeting_url === parsed.url && !MEETING_BOT_FINAL.has(b.status as MeetingBotStatus));
  if (open) {
    // The web's stub for this send waits on a row carrying its client key;
    // the open bot takes the newest key so that stub folds into it.
    if (args.client_key && open.client_key !== args.client_key) {
      await ctx.db.patch(open._id, { client_key: args.client_key });
      return shapeBot((await ctx.db.get(open._id))!);
    }
    return shapeBot(open);
  }
  const id = await ctx.db.insert("meeting_bots", {
    meet_id: crypto.randomUUID(),
    user_id: userId,
    team_id: teamId,
    meeting_url: parsed.url,
    platform: parsed.platform,
    status: "requested",
    ...(args.join_at && args.join_at > now ? { join_at: args.join_at } : {}),
    ...(args.feed_conversation_id ? { feed_conversation_id: args.feed_conversation_id } : {}),
    ...(args.client_key ? { client_key: args.client_key } : {}),
    ...(args.calendar_event_id ? { calendar_event_id: args.calendar_event_id } : {}),
    attempts: 0,
    created_at: now,
    updated_at: now,
  });
  await ctx.scheduler.runAfter(0, internal.meetingBots.createBot, { id });
  return shapeBot((await ctx.db.get(id))!);
}

export const send = mutation({
  args: { meeting_url: v.string(), join_at: v.optional(v.number()), client_key: v.optional(v.string()) },
  handler: async (ctx, args): Promise<MeetingBotRow> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await requestBot(ctx, userId, args);
  },
});

/** `cast call join <url>`: from a session, the meeting's words feed that
 *  session live, the way a session's own huddle does. */
export const cliSend = mutation({
  args: {
    api_token: v.string(),
    meeting_url: v.string(),
    join_at: v.optional(v.number()),
    session: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MeetingBotRow> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    let feed: Id<"conversations"> | undefined;
    if (args.session) {
      const conv = await findConversationByAnyRefWhere(
        ctx,
        args.session,
        (c: any) => String(c.user_id) === String(auth.userId) || String(c.owner_user_id) === String(auth.userId),
      );
      if (!conv) throw new Error(`No session found for "${args.session}"`);
      feed = conv._id;
    }
    return await requestBot(ctx, auth.userId, { meeting_url: args.meeting_url, join_at: args.join_at, feed_conversation_id: feed });
  },
});

export async function cancelBot(ctx: any, userId: Id<"users">, meetId: string): Promise<MeetingBotRow> {
  const bot = await botByMeetId(ctx, meetId);
  if (!bot || String(bot.user_id) !== String(userId)) throw new Error("Meeting bot not found");
  if (MEETING_BOT_FINAL.has(bot.status as MeetingBotStatus)) return shapeBot(bot);
  const now = Date.now();
  await ctx.db.patch(bot._id, { status: "cancelled", status_words: "Removed from the meeting.", updated_at: now });
  if (bot.bot_id) await ctx.scheduler.runAfter(0, internal.meetingBots.removeBot, { bot_id: bot.bot_id });
  await endCallOf(ctx, bot, now);
  return shapeBot((await ctx.db.get(bot._id))!);
}

export const cancel = mutation({
  args: { meet_id: v.string() },
  handler: async (ctx, args): Promise<MeetingBotRow> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await cancelBot(ctx, userId, args.meet_id);
  },
});

export const cliCancel = mutation({
  args: { api_token: v.string(), meet_id: v.string() },
  handler: async (ctx, args): Promise<MeetingBotRow> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    return await cancelBot(ctx, auth.userId, args.meet_id);
  },
});

/** The bots I sent, newest first: the calls page shows the ones still on
 *  their way in, and the CLI lists them. */
export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MeetingBotRow[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("meeting_bots")
      .withIndex("by_user_created", (q: any) => q.eq("user_id", userId))
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));
    return rows.map(shapeBot);
  },
});

export const cliListMine = query({
  args: { api_token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MeetingBotRow[]> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const rows = await ctx.db
      .query("meeting_bots")
      .withIndex("by_user_created", (q: any) => q.eq("user_id", auth.userId))
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));
    return rows.map(shapeBot);
  },
});

// ── Recall calls ───────────────────────────────────────────────────────────

export const getForCreate = internalQuery({
  args: { id: v.id("meeting_bots") },
  handler: async (ctx, args): Promise<MeetingBot | null> => await ctx.db.get(args.id),
});

export const createBot = internalAction({
  args: { id: v.id("meeting_bots") },
  handler: async (ctx, args): Promise<void> => {
    const bot: MeetingBot | null = await ctx.runQuery(internal.meetingBots.getForCreate, { id: args.id });
    if (!bot || bot.status !== "requested" || bot.bot_id) return;
    const apiKey = process.env.RECALL_API_KEY;
    const site = process.env.CONVEX_SITE_URL;
    if (!apiKey || !site) {
      await ctx.runMutation(internal.meetingBots.recordCreate, {
        id: args.id,
        error: "Meeting bots are not set up on this server.",
        retry: false,
      });
      return;
    }
    const res = await recallFetch<{ id: string }>(apiKey, "/api/v1/bot/", {
      method: "POST",
      body: recallBotBody({ meetId: bot.meet_id, meetingUrl: bot.meeting_url, siteUrl: site, joinAt: bot.join_at }),
    });
    if (res.ok) {
      await ctx.runMutation(internal.meetingBots.recordCreate, { id: args.id, bot_id: res.data.id });
      return;
    }
    console.warn(`[meetingBots] create failed for ${bot.meet_id}: ${res.status} ${res.error}`);
    await ctx.runMutation(internal.meetingBots.recordCreate, {
      id: args.id,
      error: res.status === 400 ? "Recall refused this meeting link." : "No bot could be sent to the meeting.",
      retry: res.retry,
    });
  },
});

export const recordCreate = internalMutation({
  args: {
    id: v.id("meeting_bots"),
    bot_id: v.optional(v.string()),
    error: v.optional(v.string()),
    retry: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const bot = await ctx.db.get(args.id);
    if (!bot) return;
    const now = Date.now();
    if (args.bot_id) {
      // A cancel that landed while the create was in flight: take the bot
      // straight back out.
      if (bot.status === "cancelled") {
        await ctx.db.patch(bot._id, { bot_id: args.bot_id, updated_at: now });
        await ctx.scheduler.runAfter(0, internal.meetingBots.removeBot, { bot_id: args.bot_id });
        return;
      }
      await ctx.db.patch(bot._id, {
        bot_id: args.bot_id,
        status: bot.status === "requested" ? (bot.join_at && bot.join_at > now ? "scheduled" : "joining") : bot.status,
        updated_at: now,
      });
      return;
    }
    if (bot.status !== "requested") return;
    const attempts = (bot.attempts ?? 0) + 1;
    if (args.retry && attempts < CREATE_RETRY_LIMIT) {
      await ctx.db.patch(bot._id, { attempts, updated_at: now });
      await ctx.scheduler.runAfter(CREATE_RETRY_MS, internal.meetingBots.createBot, { id: bot._id });
      return;
    }
    await ctx.db.patch(bot._id, { attempts, status: "failed", status_words: args.error, updated_at: now });
  },
});

/** Take a bot out: a scheduled one is deleted, one already in the meeting is
 *  told to leave. Either answer that the bot is gone already is success. */
export const removeBot = internalAction({
  args: { bot_id: v.string() },
  handler: async (_ctx, args): Promise<void> => {
    const apiKey = process.env.RECALL_API_KEY;
    if (!apiKey) return;
    const del = await recallFetch(apiKey, `/api/v1/bot/${args.bot_id}/`, { method: "DELETE" });
    if (del.ok || del.status === 404) return;
    const leave = await recallFetch(apiKey, `/api/v1/bot/${args.bot_id}/leave_call/`, { method: "POST" });
    if (!leave.ok && leave.status !== 404) console.warn(`[meetingBots] could not remove ${args.bot_id}: ${leave.status} ${leave.error}`);
  },
});

// ── The call record ────────────────────────────────────────────────────────

/** The bot's call, begun on the first sign it is hearing the meeting. Its
 *  own feed session (sent from a session) hears it live; no agent face,
 *  since nobody in the other platform's meeting can see one. */
async function ensureCall(ctx: any, bot: MeetingBot, now: number): Promise<Doc<"transcripts"> | null> {
  if (bot.transcript_id) return await ctx.db.get(bot.transcript_id);
  const id: Id<"transcripts"> = await beginCallRecord(ctx, {
    roomKey: meetRoomKey(bot.meet_id),
    teamId: bot.team_id,
    userId: bot.user_id,
    routes: bot.feed_conversation_id
      ? [{ kind: "session", target: String(bot.feed_conversation_id), mode: "live", sent_seq: 0, face: false }]
      : [],
    announce: false,
  });
  await ctx.db.patch(id, { last_beat: now });
  await ctx.db.patch(bot._id, { transcript_id: id, updated_at: now });
  if (bot.also_for?.length) await shareCallWith(ctx, id, bot.also_for);
  return await ctx.db.get(id);
}

async function endCallOf(ctx: any, bot: MeetingBot, at: number): Promise<void> {
  if (!bot.transcript_id) return;
  const t = await ctx.db.get(bot.transcript_id);
  if (t && t.status === "live") await endTranscript(ctx, t, at);
}

/** A bot's row for a webhook: by our id in the metadata, else by Recall's. */
async function botForEvent(ctx: any, meetId: string | undefined, botId: string | undefined): Promise<MeetingBot | null> {
  const byMeet = meetId ? await botByMeetId(ctx, meetId) : null;
  if (byMeet) return byMeet;
  return botId ? await botByRecallId(ctx, botId) : null;
}

export const applyStatus = internalMutation({
  args: {
    meet_id: v.optional(v.string()),
    bot_id: v.optional(v.string()),
    event: v.string(),
    sub_code: v.optional(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const bot = await botForEvent(ctx, args.meet_id, args.bot_id);
    if (!bot) return;
    // Done means Recall has finished with the meeting: its video is (or soon
    // will be) ready to copy onto the call.
    if (args.event === "bot.done" && bot.transcript_id && (args.bot_id ?? bot.bot_id) && !bot.video_status) {
      await ctx.db.patch(bot._id, { video_status: "saving", video_attempts: 0 });
      await ctx.scheduler.runAfter(0, internal.meetingBots.saveVideo, { id: bot._id });
    }
    const next = statusFromRecallEvent(args.event);
    if (!next) return;
    const now = Date.now();
    // A finished bot stays finished: Recall's done follows its call_ended,
    // and a cancel we made must not be undone by the bot's own exit.
    if (MEETING_BOT_FINAL.has(bot.status as MeetingBotStatus)) {
      if (bot.transcript_id) await ctx.db.patch(bot.transcript_id, { last_beat: now });
      return;
    }
    const words = recallSubCodeWords(args.sub_code);
    await ctx.db.patch(bot._id, {
      status: next,
      ...(words && (next === "ended" || next === "failed") ? { status_words: words } : {}),
      ...(args.bot_id && !bot.bot_id ? { bot_id: args.bot_id } : {}),
      updated_at: now,
    });
    if (next === "recording") {
      const t = await ensureCall(ctx, bot, now);
      if (t) await ctx.db.patch(t._id, { last_beat: now });
      return;
    }
    if (next === "ended" || next === "failed") {
      await endCallOf(ctx, bot, Math.min(args.at, now));
      return;
    }
    if (bot.transcript_id) await ctx.db.patch(bot.transcript_id, { last_beat: now });
  },
});

/** Who said a line: the teammate whose email Recall matched (a calendar
 *  invitee), filed under their codecast id so the call is theirs to read,
 *  else the name the meeting showed under an id stable for this bot. */
async function speakerOf(
  ctx: any,
  bot: MeetingBot,
  botId: string,
  participant: RecallParticipant,
): Promise<{ speaker_id: string; speaker_name: string }> {
  const name = (participant.name ?? "").trim() || "Someone";
  const email = (participant.email ?? "").trim().toLowerCase();
  if (email) {
    const user = await ctx.db.query("users").withIndex("email", (q: any) => q.eq("email", email)).first();
    if (user && (await isTeamMember(ctx, user._id, bot.team_id))) {
      return { speaker_id: String(user._id), speaker_name: user.name || name };
    }
  }
  return { speaker_id: recallSpeakerId(botId, participant), speaker_name: name };
}

export const applyTranscriptLine = internalMutation({
  args: {
    meet_id: v.optional(v.string()),
    bot_id: v.string(),
    participant: v.object({
      id: v.union(v.number(), v.string()),
      name: v.optional(v.union(v.string(), v.null())),
      email: v.optional(v.union(v.string(), v.null())),
      is_host: v.optional(v.union(v.boolean(), v.null())),
    }),
    words: v.array(
      v.object({
        text: v.optional(v.string()),
        start_timestamp: v.optional(v.union(v.object({ relative: v.optional(v.number()) }), v.null())),
        end_timestamp: v.optional(v.union(v.object({ relative: v.optional(v.number()) }), v.null())),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ written: boolean }> => {
    const bot = await botForEvent(ctx, args.meet_id, args.bot_id);
    if (!bot || bot.status === "cancelled") return { written: false };
    const now = Date.now();
    // Lines can reach us before the status webhook that says recording
    // began: they travel on separate channels.
    const t = await ensureCall(ctx, bot, now);
    if (!t || t.status !== "live") return { written: false };
    // Recall times words from the start of its recording, which is when it
    // began the call record (recording status), so no offset applies.
    const line = lineFromTranscriptData({ words: args.words as any }, 0);
    if (!line) return { written: false };
    const speaker = await speakerOf(ctx, bot, args.bot_id, args.participant);
    // A retried delivery of a line already written is dropped.
    const recent = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id))
      .order("desc")
      .take(DEDUPE_WINDOW);
    if (recent.some((s: any) => s.speaker_id === speaker.speaker_id && s.t0 === line.t0 && s.text === line.text)) {
      return { written: false };
    }
    await writeSegments(ctx, t, [{ ...speaker, ...line }]);
    await ctx.db.patch(t._id, { last_beat: now });
    // A finished line from Recall is what a scribe's quiet gap is: the
    // moment to ship the live routes their words.
    await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
      transcript_id: t._id,
      include_after_routes: false,
      reason: "flush",
    });
    const fresh = await ctx.db.get(t._id);
    if (fresh) await claimRollingSummary(ctx, fresh, now);
    return { written: true };
  },
});

// ── The meeting's video ────────────────────────────────────────────────────

/** How often, and how many times, a bot whose video Recall is still
 *  processing is looked at again before it is given up on. */
export const VIDEO_RETRY_MS = 60_000;
export const VIDEO_RETRY_LIMIT = 30;

type RecallRecording = {
  id: string;
  started_at?: string | null;
  completed_at?: string | null;
  media_shortcuts?: { video_mixed?: { status?: { code?: string }; data?: { download_url?: string | null } } | null } | null;
};

/** Copy the meeting's mixed video from Recall into the recordings bucket and
 *  file it as the call's video (a ready composite call_recordings row), so
 *  the call page plays it and `cast call snap` reads frames from it the way
 *  it does a huddle's. Recall's own copy expires after a week. */
export const saveVideo = internalAction({
  args: { id: v.id("meeting_bots") },
  handler: async (ctx, args): Promise<void> => {
    const bot: MeetingBot | null = await ctx.runQuery(internal.meetingBots.getForCreate, { id: args.id });
    if (!bot?.bot_id || !bot.transcript_id || bot.video_status !== "saving") return;
    const apiKey = process.env.RECALL_API_KEY;
    const bucket = callRecordingsBucketFromEnv();
    if (!apiKey || !bucket) {
      await ctx.runMutation(internal.meetingBots.recordVideo, { id: args.id, outcome: "failed" });
      return;
    }
    const res = await recallFetch<{ recordings?: RecallRecording[] }>(apiKey, `/api/v1/bot/${bot.bot_id}/`);
    const rec = res.ok ? res.data.recordings?.[0] : undefined;
    const video = rec?.media_shortcuts?.video_mixed;
    const url = video?.data?.download_url;
    const code = video?.status?.code;
    if (res.ok && (!rec || code === "failed" || code === "deleted")) {
      await ctx.runMutation(internal.meetingBots.recordVideo, { id: args.id, outcome: "none" });
      return;
    }
    if (!url || !rec) {
      // Still processing (or Recall did not answer): look again shortly.
      await ctx.runMutation(internal.meetingBots.recordVideo, { id: args.id, outcome: "retry" });
      return;
    }
    const startedAt = Date.parse(rec.started_at ?? "") || bot.updated_at;
    const endedAt = Date.parse(rec.completed_at ?? "") || undefined;
    const key = callRecordingKey({ transcriptId: String(bot.transcript_id), kind: "composite", requestedAt: startedAt });
    try {
      const { bytes } = await r2CopyFromUrl(bucket, key, url, { contentType: "video/mp4" });
      await ctx.runMutation(internal.meetingBots.recordVideo, {
        id: args.id,
        outcome: "saved",
        file: { r2_key: key, started_at: startedAt, ...(endedAt ? { ended_at: endedAt } : {}), size_bytes: bytes },
      });
    } catch (e) {
      console.warn(`[meetingBots] video copy for ${bot.meet_id} failed: ${e instanceof Error ? e.message : String(e)}`);
      await ctx.runMutation(internal.meetingBots.recordVideo, { id: args.id, outcome: "retry" });
    }
  },
});

export const recordVideo = internalMutation({
  args: {
    id: v.id("meeting_bots"),
    outcome: v.union(v.literal("saved"), v.literal("none"), v.literal("failed"), v.literal("retry")),
    file: v.optional(v.object({
      r2_key: v.string(),
      started_at: v.number(),
      ended_at: v.optional(v.number()),
      size_bytes: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const bot = await ctx.db.get(args.id);
    if (!bot || bot.video_status !== "saving" || !bot.transcript_id) return;
    if (args.outcome === "retry") {
      const attempts = (bot.video_attempts ?? 0) + 1;
      if (attempts >= VIDEO_RETRY_LIMIT) {
        await ctx.db.patch(bot._id, { video_status: "failed", video_attempts: attempts });
        return;
      }
      await ctx.db.patch(bot._id, { video_attempts: attempts });
      await ctx.scheduler.runAfter(VIDEO_RETRY_MS, internal.meetingBots.saveVideo, { id: bot._id });
      return;
    }
    if (args.outcome !== "saved" || !args.file) {
      await ctx.db.patch(bot._id, { video_status: args.outcome === "none" ? "none" : "failed" });
      return;
    }
    const call = await ctx.db.get(bot.transcript_id);
    if (!call) return;
    const sender = await ctx.db.get(bot.user_id);
    const now = Date.now();
    const f = args.file;
    await ctx.db.insert("call_recordings", {
      transcript_id: call._id,
      room_key: call.room_key,
      team_id: call.team_id,
      kind: "composite",
      status: "ready",
      r2_key: f.r2_key,
      started_by: bot.user_id,
      ...(sender?.name ? { started_by_name: sender.name } : {}),
      requested_at: f.started_at,
      started_at: f.started_at,
      ...(f.ended_at ? { ended_at: f.ended_at, duration_ms: Math.max(0, f.ended_at - f.started_at) } : {}),
      size_bytes: f.size_bytes,
      stop_reason: "ended",
      ...(call.short_id ? { call_short_id: call.short_id } : {}),
      call_started_at: call.started_at,
      updated_at: now,
    });
    await syncCallVideo(ctx, call._id);
    await ctx.db.patch(bot._id, { video_status: "saved" });
  },
});

// ── The meeting's chat ─────────────────────────────────────────────────────

/** How many of the call's newest chat lines a meeting chat line is compared
 *  with, to drop the bot's own messages coming back as the meeting saw them. */
const ECHO_WINDOW = 20;

/** A line someone wrote in the meeting's own chat: it joins the call's chat
 *  under the name the meeting showed (or their codecast name when Recall
 *  matched them to a teammate), and reaches the agents fed the call, the way
 *  a line typed in a huddle's chat does. The bot's own messages are dropped. */
export const applyChatLine = internalMutation({
  args: {
    meet_id: v.optional(v.string()),
    bot_id: v.string(),
    participant: v.object({
      id: v.union(v.number(), v.string()),
      name: v.optional(v.union(v.string(), v.null())),
      email: v.optional(v.union(v.string(), v.null())),
    }),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<{ written: boolean }> => {
    const bot = await botForEvent(ctx, args.meet_id, args.bot_id);
    if (!bot || bot.status === "cancelled") return { written: false };
    const text = args.text.trim().slice(0, 4000);
    if (!text || (args.participant.name ?? "").trim() === BOT_NAME) return { written: false };
    const now = Date.now();
    const t = await ensureCall(ctx, bot, now);
    if (!t || t.status !== "live") return { written: false };
    const recent = await ctx.db
      .query("call_chat_messages")
      .withIndex("by_transcript", (q: any) => q.eq("transcript_id", t._id))
      .order("desc")
      .take(ECHO_WINDOW);
    if (recent.some((r: any) => r.agent_conversation_id && meetingChatText(r.text, bot.platform) === text)) {
      return { written: false };
    }
    const speaker = await speakerOf(ctx, bot, args.bot_id, args.participant);
    const teammate = !speaker.speaker_id.startsWith("recall:");
    await insertRoomRow(ctx, {
      room_key: t.room_key,
      team_id: t.team_id,
      user_id: teammate ? (speaker.speaker_id as Id<"users">) : bot.user_id,
      text,
      transcript_id: t._id,
      ...(teammate ? {} : { author_name: speaker.speaker_name }),
    });
    await ctx.db.patch(t._id, { last_beat: now });
    await relayLineToFeeds(ctx, t._id, speaker.speaker_name, text);
    return { written: true };
  },
});

export const botForCall = internalQuery({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<MeetingBot | null> => {
    const t = await ctx.db.get(args.transcript_id);
    const parsed = t ? parseRoomKey(t.room_key) : null;
    return parsed?.kind === "meet" ? await botByMeetId(ctx, parsed.meetId) : null;
  },
});

/** An agent fed the meeting answered (callChat.mirrorAgentTurn): the bot
 *  says it in the meeting's chat, where the people on the other platform
 *  read. Only while the bot is in the meeting, and only on platforms that
 *  give bots a chat. Best effort: the reply is in the call's chat either way. */
export const sayInMeeting = internalAction({
  args: { transcript_id: v.id("transcripts"), texts: v.array(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const bot: MeetingBot | null = await ctx.runQuery(internal.meetingBots.botForCall, { transcript_id: args.transcript_id });
    const apiKey = process.env.RECALL_API_KEY;
    if (!bot?.bot_id || !apiKey || !["in_call", "recording"].includes(bot.status)) return;
    for (const raw of args.texts) {
      const message = meetingChatText(raw, bot.platform);
      if (!message) continue;
      const res = await recallFetch(apiKey, `/api/v1/bot/${bot.bot_id}/send_chat_message/`, {
        method: "POST",
        body: { to: "everyone", message },
      });
      if (!res.ok) console.warn(`[meetingBots] chat to ${bot.meet_id} failed: ${res.status} ${res.error}`);
    }
  },
});

export const beat = internalMutation({
  args: { meet_id: v.optional(v.string()), bot_id: v.string() },
  handler: async (ctx, args) => {
    const bot = await botForEvent(ctx, args.meet_id, args.bot_id);
    if (bot?.transcript_id) await ctx.db.patch(bot.transcript_id, { last_beat: Date.now() });
  },
});

// ── Webhooks ───────────────────────────────────────────────────────────────

async function verified(request: Request): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  const raw = await request.text();
  const check = await verifyRecallRequest({ secret: process.env.RECALL_VERIFICATION_SECRET, headers: request.headers, body: raw });
  if (!check.ok) {
    console.warn(`[meetingBots] refused a Recall request: ${check.reason}`);
    return { ok: false, response: new Response(check.reason, { status: 401 }) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: new Response("bad json", { status: 400 }) };
  }
}

/** Recall's account webhook: bot status changes. */
export const statusWebhook = httpAction(async (ctx, request) => {
  const v = await verified(request);
  if (!v.ok) return v.response;
  const event = String(v.body?.event ?? "");
  if (!event.startsWith("bot.")) return new Response("ignored", { status: 200 });
  const data = v.body?.data ?? {};
  const updatedAt = Date.parse(data?.data?.updated_at ?? "");
  await ctx.runMutation(internal.meetingBots.applyStatus, {
    meet_id: data?.bot?.metadata?.meet_id ?? undefined,
    bot_id: data?.bot?.id ?? undefined,
    event,
    sub_code: data?.data?.sub_code ?? undefined,
    at: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  });
  return new Response("ok", { status: 200 });
});

/** The bot's real-time endpoint: finished transcript lines and who joined.
 *  Recall sends a bot's next event only after this one answers, so the
 *  handler does one mutation and returns. */
export const realtimeWebhook = httpAction(async (ctx, request) => {
  const v = await verified(request);
  if (!v.ok) return v.response;
  const event = String(v.body?.event ?? "");
  const data = v.body?.data ?? {};
  const botId: string | undefined = data?.bot?.id;
  const meetId: string | undefined = data?.bot?.metadata?.meet_id;
  if (!botId) return new Response("ignored", { status: 200 });
  if (event === "transcript.data") {
    const inner = data?.data ?? {};
    const p = inner.participant ?? {};
    await ctx.runMutation(internal.meetingBots.applyTranscriptLine, {
      meet_id: meetId,
      bot_id: botId,
      participant: { id: p.id ?? "unknown", name: p.name ?? null, email: p.email ?? null, is_host: p.is_host ?? null },
      words: (inner.words ?? []).map((w: any) => ({
        text: typeof w?.text === "string" ? w.text : undefined,
        start_timestamp: w?.start_timestamp ? { relative: Number(w.start_timestamp.relative) || 0 } : null,
        end_timestamp: w?.end_timestamp ? { relative: Number(w.end_timestamp.relative) || 0 } : null,
      })),
    });
    return new Response("ok", { status: 200 });
  }
  if (event === "participant_events.chat_message") {
    const inner = data?.data ?? {};
    const p = inner.participant ?? {};
    const text = typeof inner.data?.text === "string" ? inner.data.text : "";
    // Only what the whole meeting saw; a direct message to the bot is not
    // the room talking.
    const to = String(inner.data?.to ?? "everyone").toLowerCase();
    if (text && (to === "everyone" || to === "")) {
      await ctx.runMutation(internal.meetingBots.applyChatLine, {
        meet_id: meetId,
        bot_id: botId,
        participant: { id: p.id ?? "unknown", name: p.name ?? null, email: p.email ?? null },
        text,
      });
      return new Response("ok", { status: 200 });
    }
  }
  await ctx.runMutation(internal.meetingBots.beat, { meet_id: meetId, bot_id: botId });
  return new Response("ok", { status: 200 });
});
