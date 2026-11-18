import { v } from "convex/values";
import { mutation } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessPlan, resolveSessionConversation } from "./lib/access";
import { resolveMessagingPolicy } from "@codecast/shared/contracts/messagingPolicy";

// The shared log of a plan (messaging policy "shared-log"): the plan's fact,
// fail and interface entries. A fact is stored as the plan's "discovery".
const LOG_TYPES: Record<string, string> = { discovery: "fact", fail: "fail", interface: "interface" };

/** What a session sees on its first read: the newest entries, not the whole history. */
export const FIRST_READ_LIMIT = 20;

export type LogEntry = { type: string; content: string; author?: string; session_id?: string; timestamp: number };

/**
 * The log entries a session has not read: newer than its cursor and not its
 * own. With no cursor yet, the newest FIRST_READ_LIMIT of them.
 * ponytail: the cursor is a timestamp, so two entries in the same millisecond
 * as the cursor would drop the second; an entry index if that ever shows up.
 */
export function unreadLogEntries(entries: any[], readAt: number | null, own: Set<string>): LogEntry[] {
  const fresh = entries
    .filter((e) => LOG_TYPES[e?.type] && (readAt == null || e.timestamp > readAt) && !(e.session_id && own.has(e.session_id)))
    .map((e) => ({
      type: LOG_TYPES[e.type],
      content: e.content,
      timestamp: e.timestamp,
      ...(e.author ? { author: e.author } : {}),
      ...(e.session_id ? { session_id: e.session_id } : {}),
    }));
  return readAt == null ? fresh.slice(-FIRST_READ_LIMIT) : fresh;
}

/**
 * The shared-log entries of the calling session's plan that it has not read,
 * once: the read moves the session's cursor past them. Empty for a session
 * with no plan, and for a plan on any other messaging policy. Called by the
 * CLI after each `cast` command (`/cli/plans/log/unread`).
 */
export const unread = mutation({
  args: { api_token: v.string(), session_id: v.string() },
  handler: async (ctx, args): Promise<{ plan_short_id?: string; entries: LogEntry[] }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const conv = await resolveSessionConversation(ctx, auth.userId, args.session_id);
    if (!conv?.active_plan_id) return { entries: [] };
    const plan: any = await ctx.db.get(conv.active_plan_id);
    if (!plan || resolveMessagingPolicy(plan.messaging_policy).delivery !== "plan-log") return { entries: [] };
    if (!(await canAccessPlan(ctx, auth.userId, plan))) return { entries: [] };

    const cursor = await ctx.db
      .query("plan_log_reads")
      .withIndex("by_conversation_plan", (q) => q.eq("conversation_id", conv._id).eq("plan_id", plan._id))
      .first();
    const all: any[] = plan.entries ?? [];
    const own = new Set([args.session_id, conv.session_id, String(conv._id)].filter(Boolean) as string[]);
    const entries = unreadLogEntries(all, cursor?.read_at ?? null, own);

    // Past every log entry, the session's own included, so nothing comes back.
    const newest = Math.max(0, ...all.filter((e) => LOG_TYPES[e?.type]).map((e) => e.timestamp));
    if (cursor && newest > cursor.read_at) await ctx.db.patch(cursor._id, { read_at: newest });
    else if (!cursor && newest > 0) {
      await ctx.db.insert("plan_log_reads", { conversation_id: conv._id, plan_id: plan._id, read_at: newest });
    }
    return { plan_short_id: plan.short_id, entries };
  },
});
