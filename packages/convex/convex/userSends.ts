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
