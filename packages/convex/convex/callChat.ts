// Text chat alongside a huddle. One thread per room: the call stage shows it
// live, and the call page shows the same thread next to the transcript, so
// links and asides dropped mid-call are there when the recording is read
// later. Authorization is the room's own membership rule (grants admit a
// guest to the running huddle, not to the room's history).
//
// AGENTS ARE PARTICIPANTS. A session fed the live transcript (a route of kind
// "session", tracked in call_agent_feeds) takes part in this thread two ways:
//   - what it answers at the end of a turn is mirrored here as its own line
//     (mirrorAgentTurn, scheduled by managedSessions.updateAgentStatus when a
//     turn settles), so the room sees the reply without opening the session;
//   - a line a person types here is relayed into the session (post), so the
//     chat is a way to talk to the agent in text while the huddle runs.
// Both ride the transcript's own delivery identity: the agent speaks in the
// room as whoever fed it, the way its transcript chunks arrive as them.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { huddleChatLineHeader } from "@codecast/shared/contracts";
import { authorizeRoom } from "./callRooms";

const MAX_TEXT = 4000;
const PAGE = 200;
// A chat bubble, not a report: a long answer is clipped here and the row
// links to the session that holds the whole of it.
export const AGENT_LINE_MAX = 1800;
// Words land in the session by transcript sync a beat after the Stop hook
// settles the status, so the mirror waits before reading the newest reply,
// and looks once more if nothing new had landed yet.
const MIRROR_DELAY_MS = 4_000;
const MIRROR_RETRY_MS = 15_000;
const MIRROR_ATTEMPTS = 2;

export const list = query({
  args: { room_key: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) return null;
    const rows = await ctx.db
      .query("call_chat_messages")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .order("desc")
      .take(Math.min(args.limit ?? PAGE, PAGE));
    rows.reverse();
    const users = new Map<string, { name: string; image?: string }>();
    const agents = new Map<string, AgentIdentity | null>();
    for (const r of rows) {
      const key = String(r.user_id);
      if (!users.has(key)) {
        const u = await ctx.db.get(r.user_id);
        users.set(key, { name: u?.name ?? u?.email ?? "someone", image: u?.image ?? undefined });
      }
      if (r.agent_conversation_id && !agents.has(String(r.agent_conversation_id))) {
        agents.set(String(r.agent_conversation_id), await agentIdentity(ctx, r.agent_conversation_id));
      }
    }
    return rows.map((r) => {
      const u = users.get(String(r.user_id))!;
      const agent = r.agent_conversation_id ? agents.get(String(r.agent_conversation_id)) ?? null : null;
      return {
        _id: r._id,
        user_id: String(r.user_id),
        // An agent's line is the agent's: its name is the session's, and it
        // is never "mine" however the row is owned.
        user_name: agent ? agent.title : u.name,
        user_image: agent ? undefined : u.image,
        text: r.text,
        at: r._creationTime,
        mine: !agent && String(r.user_id) === String(userId),
        agent,
      };
    });
  },
});

type AgentIdentity = {
  conversation_id: string;
  short_id: string | null;
  title: string;
  agent_type: string;
};

async function agentIdentity(ctx: any, id: Id<"conversations">): Promise<AgentIdentity | null> {
  const conv: Doc<"conversations"> | null = await ctx.db.get(id);
  if (!conv) return null;
  return {
    conversation_id: String(conv._id),
    short_id: conv.short_id ?? null,
    title: conv.title || "agent session",
    agent_type: conv.agent_type,
  };
}

export const post = mutation({
  args: { room_key: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // authorizeRoom (grant included): an invited guest in the live huddle can
    // talk in its chat, same as they can speak in its audio.
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot chat in this room: ${auth.reason}`);
    const text = args.text.trim().slice(0, MAX_TEXT);
    if (!text) return;
    await ctx.db.insert("call_chat_messages", {
      room_key: args.room_key,
      team_id: auth.teamId,
      user_id: userId,
      text,
    });
    // The agents in the room hear the line too. Relayed as the transcript's
    // routes deliver (as the feed's adder, off the request path), so a
    // session the poster could not message directly still hears its huddle,
    // and a relay that fails never loses the chat line itself.
    const live = await liveTranscriptFor(ctx, args.room_key);
    if (!live) return;
    const feeds: Doc<"call_agent_feeds">[] = await ctx.db
      .query("call_agent_feeds")
      .withIndex("by_transcript", (q) => q.eq("transcript_id", live._id))
      .collect();
    if (feeds.length === 0) return;
    const poster = await ctx.db.get(userId);
    const name = poster?.name ?? poster?.email ?? "Someone";
    for (const feed of feeds) {
      await ctx.scheduler.runAfter(0, internal.transcripts.deliverToSession, {
        as_user: feed.added_by,
        to: String(feed.conversation_id),
        body: `${huddleChatLineHeader(name)}\n\n**${name}**: ${text}`,
      });
    }
  },
});

async function liveTranscriptFor(ctx: any, roomKey: string): Promise<Doc<"transcripts"> | null> {
  const rows: Doc<"transcripts">[] = await ctx.db
    .query("transcripts")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  return rows.find((t) => t.status === "live") ?? null;
}

// The text of an assistant message as a chat line: the message's own prose,
// nothing from tool calls, clipped to a bubble. Empty when the turn ended on
// a tool call with no words, or on content the server cannot read.
export function agentLineText(m: { content?: string; is_encrypted?: boolean } | null | undefined): string {
  if (!m || m.is_encrypted) return "";
  const text = (m.content ?? "").trim();
  if (!text) return "";
  return text.length > AGENT_LINE_MAX ? `${text.slice(0, AGENT_LINE_MAX - 1).trimEnd()}…` : text;
}

/** A fed session settled a turn: show its reply in the huddle chat.
 *
 *  Reads the session's newest assistant message and posts it unless the feed
 *  already mirrored it (the watermark), so a settle republished for the same
 *  turn, or a turn that ended without words, posts nothing. The huddle may
 *  have ended between the settle and now; then the feed row is already gone
 *  and there is nothing to do. */
export const mirrorAgentTurn = internalMutation({
  args: { conversation_id: v.id("conversations"), attempt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const feed: Doc<"call_agent_feeds"> | null = await ctx.db
      .query("call_agent_feeds")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    if (!feed) return { mirrored: false, reason: "not_fed" };
    const transcript = await ctx.db.get(feed.transcript_id);
    if (!transcript || transcript.status !== "live") {
      await ctx.db.delete(feed._id);
      return { mirrored: false, reason: "huddle_over" };
    }
    // The newest assistant message with words: a turn usually ends on prose,
    // but the last row can be a bare tool call, so look a few rows back.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_role_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("role", "assistant"),
      )
      .order("desc")
      .take(4);
    const newest = recent.find((m) => agentLineText(m).length > 0) ?? null;
    const attempt = args.attempt ?? 0;
    if (!newest || String(newest._id) === String(feed.last_mirrored_message_id)) {
      if (attempt + 1 < MIRROR_ATTEMPTS) {
        await ctx.scheduler.runAfter(MIRROR_RETRY_MS, internal.callChat.mirrorAgentTurn, {
          conversation_id: args.conversation_id,
          attempt: attempt + 1,
        });
      }
      return { mirrored: false, reason: newest ? "already_mirrored" : "no_words" };
    }
    // The watermark must not run backwards: an older message that only now
    // became the "newest with words" (the real newest was a tool call) is
    // still older than what the room has seen.
    if (feed.last_mirrored_message_id) {
      const seen = await ctx.db.get(feed.last_mirrored_message_id);
      if (seen && (seen.timestamp ?? 0) >= (newest.timestamp ?? 0)) {
        return { mirrored: false, reason: "already_mirrored" };
      }
    }
    await ctx.db.insert("call_chat_messages", {
      room_key: feed.room_key,
      team_id: feed.team_id,
      user_id: feed.added_by,
      text: agentLineText(newest),
      agent_conversation_id: args.conversation_id,
      source_message_id: newest._id,
    });
    await ctx.db.patch(feed._id, { last_mirrored_message_id: newest._id });
    return { mirrored: true };
  },
});

/** Called from the status settle: is this session in a huddle, and if so
 *  arrange for its reply to be mirrored once the words have synced. One
 *  indexed read on the hot path; everything else runs later. */
export async function scheduleAgentTurnMirror(ctx: any, conversationId: Id<"conversations">): Promise<boolean> {
  const feed = await ctx.db
    .query("call_agent_feeds")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .first();
  if (!feed) return false;
  await ctx.scheduler.runAfter(MIRROR_DELAY_MS, internal.callChat.mirrorAgentTurn, {
    conversation_id: conversationId,
    attempt: 0,
  });
  return true;
}
