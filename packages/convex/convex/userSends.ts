import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { recordSendFor } from "./lib/userSend";
import { createTeamFeedFilter } from "./privacy";
import { dayBounds } from "./lib/teamDay";

export const record = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    // Optional: jobs scheduled before the per-send log existed carry none.
    message_id: v.optional(v.id("messages")),
    user_id: v.id("users"),
    words: v.number(),
    by_person: v.boolean(),
    timestamp: v.number(),
  },
  handler: async (ctx, { conversation_id, message_id, by_person, timestamp, ...send }): Promise<void> => {
    const conversation = await ctx.db.get(conversation_id);
    if (conversation) await recordSendFor(ctx, conversation, send, by_person, timestamp, message_id);
  },
});

// A day of the busiest team stays far below this; the cap bounds the read.
const DAY_SEND_CAP = 3000;

export type PromptRow = {
  /** `ps:<message id>`: stable across a send rebuild, and a client key, so a
   *  row the next answer lacks is dropped from disk too. */
  _id: string;
  team_id: Id<"teams">;
  date: string;
  user_id: Id<"users">;
  conversation_id: Id<"conversations">;
  session_title: string;
  message_id: Id<"messages">;
  timestamp: number;
  words: number;
  text: string;
  clipped: boolean;
  /** Set on a decision answer: the question, and whether an option was picked. */
  decision?: { question: string; picked: boolean };
};

// The Prompts page: every message the team's people typed into sessions on
// one calendar day (in the viewer's zone), each with the session it went to.
// Rows come from the per-send log, so "typed" means what the Typed chart
// counts. A teammate's send shows only when its session is team-visible here
// (the profile feed's rule); the viewer always sees their own. Null when the
// viewer is not a member of the team.
export const teamDay = query({
  args: { team_id: v.id("teams"), date: v.string(), timezone: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ date: string; rows: PromptRow[] } | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const filter = await createTeamFeedFilter(ctx, args.team_id);
    if (!filter.memberships.some((m) => String(m.user_id) === String(viewer))) return null;
    const { start, end } = dayBounds(args.date, args.timezone);

    const sends = await ctx.db
      .query("user_sends")
      .withIndex("by_team_timestamp", (q) => q.eq("team_id", args.team_id).gte("timestamp", start).lt("timestamp", end))
      .take(DAY_SEND_CAP);

    const conversations = new Map<string, Doc<"conversations"> | null>();
    // Agent accounts send in their own name; the page is people's prompts.
    const bots = new Map<string, boolean>();
    const rows: PromptRow[] = [];
    for (const send of sends) {
      const sender = String(send.user_id);
      if (!bots.has(sender)) bots.set(sender, !!(await ctx.db.get(send.user_id))?.is_bot);
      if (bots.get(sender)) continue;
      const key = String(send.conversation_id);
      if (!conversations.has(key)) conversations.set(key, await ctx.db.get(send.conversation_id));
      const c = conversations.get(key);
      if (!c) continue;
      const mine = String(send.user_id) === String(viewer) || String(c.user_id) === String(viewer);
      if (!mine && !(String(c.team_id) === String(args.team_id) && filter.isVisible(c))) continue;
      rows.push({
        _id: `ps:${send.message_id}`,
        team_id: args.team_id,
        date: args.date,
        user_id: send.user_id,
        conversation_id: send.conversation_id,
        session_title: c.title || "Untitled session",
        message_id: send.message_id,
        timestamp: send.timestamp,
        words: send.words,
        text: send.text,
        clipped: send.clipped,
        ...(send.decision ? { decision: send.decision } : {}),
      });
    }
    return { date: args.date, rows };
  },
});

// ── The viewer's own sends, across every workspace (the Messages feed) ─────
//
// What the person typed, newest first, each with the session it went to, so
// the feed can open that session at the message. Rows come from the per-send
// log, so "typed" means what the Typed chart counts: no agent briefs, cast
// sends, trigger runs or workflow frames ever reach it. A decision answer
// shows only when the person wrote it; a picked option is a tap.

/** The longest text a feed row carries. The list shows a few lines and the
 *  client caches tens of thousands of rows, so a long paste ships its head;
 *  `fullText` reads the rest on demand. */
export const MY_SEND_SNIPPET = 600;
const MY_PAGE_MAX = 500;
const MY_SEARCH_MAX = 80;

export type MySendRow = {
  /** `ms:<message id>`. */
  _id: string;
  message_id: Id<"messages">;
  conversation_id: Id<"conversations">;
  session_title: string;
  /** The session's folder name, when it has one. */
  project?: string;
  timestamp: number;
  words: number;
  text: string;
  /** More text exists than `text` holds (fullText has it). */
  clipped: boolean;
  /** Set on a written decision answer: the question it answered. */
  question?: string;
};

async function toMyRows(ctx: { db: any }, sends: Doc<"user_sends">[]): Promise<MySendRow[]> {
  const conversations = new Map<string, Doc<"conversations"> | null>();
  const rows: MySendRow[] = [];
  for (const send of sends) {
    if (send.decision?.picked) continue;
    const key = String(send.conversation_id);
    if (!conversations.has(key)) conversations.set(key, await ctx.db.get(send.conversation_id));
    const c = conversations.get(key);
    if (!c) continue;
    const project = c.git_root || c.project_path;
    rows.push({
      _id: `ms:${send.message_id}`,
      message_id: send.message_id,
      conversation_id: send.conversation_id,
      session_title: c.title || "Untitled session",
      ...(project ? { project: project.split("/").filter(Boolean).pop() } : {}),
      timestamp: send.timestamp,
      words: send.words,
      text: send.text.slice(0, MY_SEND_SNIPPET),
      clipped: send.clipped || send.text.length > MY_SEND_SNIPPET,
      ...(send.decision ? { question: send.decision.question } : {}),
    });
  }
  return rows;
}

/** One page of the viewer's sends, newest first. `before` pages older
 *  (exclusive); `after` reads only what came since (the live tail, which
 *  keeps a subscription's read set to the sessions typed into lately).
 *  `nextBefore` is null once history is exhausted. */
export const mine = query({
  args: { before: v.optional(v.number()), after: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ rows: MySendRow[]; nextBefore: number | null }> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return { rows: [], nextBefore: null };
    const limit = Math.max(1, Math.min(args.limit ?? 200, MY_PAGE_MAX));
    const sends: Doc<"user_sends">[] = await ctx.db
      .query("user_sends")
      .withIndex("by_user_timestamp", (q) => {
        const base = q.eq("user_id", viewer);
        if (args.before !== undefined && args.after !== undefined) return base.gt("timestamp", args.after).lt("timestamp", args.before);
        if (args.before !== undefined) return base.lt("timestamp", args.before);
        if (args.after !== undefined) return base.gt("timestamp", args.after);
        return base;
      })
      .order("desc")
      .take(limit);
    const full = sends.length === limit;
    return { rows: await toMyRows(ctx, sends), nextBefore: full ? sends[sends.length - 1].timestamp : null };
  },
});

/** Full-text search over everything the viewer typed, best matches first. */
export const searchMine = query({
  args: { q: v.string() },
  handler: async (ctx, args): Promise<MySendRow[]> => {
    const viewer = await getAuthUserId(ctx);
    const q = args.q.trim();
    if (!viewer || q.length < 2) return [];
    const sends = await ctx.db
      .query("user_sends")
      .withSearchIndex("search_text", (s) => s.search("text", q).eq("user_id", viewer))
      .take(MY_SEARCH_MAX);
    return await toMyRows(ctx, sends);
  },
});

/** The whole logged text of one of the viewer's sends (up to SEND_TEXT_CAP). */
export const fullText = query({
  args: { message_id: v.id("messages") },
  handler: async (ctx, args): Promise<{ text: string; clipped: boolean } | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const send = await ctx.db.query("user_sends").withIndex("by_message", (q) => q.eq("message_id", args.message_id)).first();
    if (!send || String(send.user_id) !== String(viewer)) return null;
    return { text: send.text, clipped: send.clipped };
  },
});
