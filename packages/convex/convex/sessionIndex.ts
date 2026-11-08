// The viewer's sessions as a small directory the ⌘K palette searches on the
// device: who each session is to a person looking for it (its title, what it
// began as, its summary, its project) and when it last moved. The inbox cache
// keeps about a month of sessions; this keeps every one, a few hundred bytes
// each, so a session from August answers on the first keystroke.
//
// Read in pages, never subscribed: the range covers every session the viewer
// owns, and a live query over it would re-run on every heartbeat of every
// running one. The client reads the head on open and walks older pages once.
import { v } from "convex/values";
import { clipText } from "./lib/wellFormed";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./functions";
import type { Doc } from "./_generated/dataModel";

/** Rows read per page. Workers are read and skipped, so a page can return fewer. */
const SCAN_ROWS = 1500;
const TEXT_CUT = 160;

export type SessionIndexRow = {
  _id: string;
  title: string | null;
  first_prompt: string | null;
  idle_summary: string | null;
  project_path: string | null;
  agent_type: string;
  updated_at: number;
  message_count: number;
};

const cut = (text: string | null | undefined) => (text ? clipText(text, TEXT_CUT) : null);

function indexRowOf(conv: Doc<"conversations">): SessionIndexRow {
  return {
    _id: conv._id,
    title: cut(conv.title),
    first_prompt: cut(conv.first_prompt),
    idle_summary: cut(conv.idle_summary),
    project_path: conv.project_path ?? null,
    agent_type: conv.agent_type,
    updated_at: conv.updated_at,
    message_count: conv.message_count ?? 0,
  };
}

/** A session a person would look for by name: not a worker folded under
 *  another session, and not one that never got a message. */
function listed(conv: Doc<"conversations">): boolean {
  return !conv.is_subagent && !conv.parent_conversation_id && !conv.comment_fork_parent && (conv.message_count ?? 0) > 0;
}

/**
 * One page of the viewer's sessions, newest first, updated before `before`
 * and after `after` (both exclusive, both optional). `next` is where the next
 * older page starts, null once the range is read to its end.
 */
export const page = query({
  args: { before: v.optional(v.number()), after: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ rows: SessionIndexRow[]; next: number | null }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { rows: [], next: null };
    const scanned = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => {
        const mine = q.eq("user_id", userId);
        if (args.before != null && args.after != null) return mine.gt("updated_at", args.after).lt("updated_at", args.before);
        if (args.before != null) return mine.lt("updated_at", args.before);
        if (args.after != null) return mine.gt("updated_at", args.after);
        return mine;
      })
      .order("desc")
      .take(SCAN_ROWS);
    return {
      rows: scanned.filter(listed).map(indexRowOf),
      next: scanned.length < SCAN_ROWS ? null : scanned[scanned.length - 1].updated_at,
    };
  },
});
