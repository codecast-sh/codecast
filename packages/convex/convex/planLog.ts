import { v } from "convex/values";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessPlan, canAccessTask, isSameWorkspace, resolveSessionConversation, workspaceForResource } from "./lib/access";
import { childConversations, newSessionPrice, priceSession } from "./lib/sessionCost";
import { isConversationOwner } from "./privacy";
import type { Doc } from "./_generated/dataModel";
import { resolveMessagingPolicy } from "@codecast/shared/contracts/messagingPolicy";

// The shared log of a plan (messaging policy "shared-log"): the plan's fact,
// fail and interface entries. A fact is stored as the plan's "discovery".
const LOG_TYPES: Record<string, string> = { discovery: "fact", fail: "fail", interface: "interface" };

/** What a session sees on its first read: the newest entries, not the whole history. */
export const FIRST_READ_LIMIT = 20;

export type LogEntry = {
  type: string; content: string; author?: string; session_id?: string; timestamp: number;
  /** The writer's checkout: short HEAD, "+dirty" with uncommitted changes. */
  commit?: string;
  /** The writing session as other agents name it (`cast send <session>`), and its title. */
  session?: string; title?: string;
};

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
      ...(e.commit ? { commit: e.commit } : {}),
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
    // Only the session's owner reads it: a teammate who can see it must not move its cursor.
    if (!conv?.active_plan_id || !(await isConversationOwner(ctx, auth.userId, conv))) return { entries: [] };
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
    // One person's agents share a name, so each entry names its session too:
    // only one the reader may see, through the same access check.
    const writers = new Map<string, any>();
    for (const e of entries) {
      if (!e.session_id) continue;
      if (!writers.has(e.session_id)) writers.set(e.session_id, await resolveSessionConversation(ctx, auth.userId, e.session_id));
      const w = writers.get(e.session_id);
      if (!w) continue;
      e.session = w.short_id ?? String(w._id).slice(0, 7);
      if (w.title) e.title = w.title;
    }

    // Past every log entry, the session's own included, so nothing comes back.
    const newest = Math.max(0, ...all.filter((e) => LOG_TYPES[e?.type]).map((e) => e.timestamp));
    if (cursor && newest > cursor.read_at) await ctx.db.patch(cursor._id, { read_at: newest });
    else if (!cursor && newest > 0) {
      await ctx.db.insert("plan_log_reads", { conversation_id: conv._id, plan_id: plan._id, read_at: newest });
    }
    return { plan_short_id: plan.short_id, entries };
  },
});

/** The numbers that compare runs of plans under different messaging policies (`cast plan eval`). */
export function summarizeRun(plan: any, tasks: any[], now = Date.now()) {
  const live = tasks.filter((t) => t.status !== "dropped");
  const done = live.filter((t) => t.status === "done");
  const starts = tasks.map((t) => t.started_at).filter((n): n is number => typeof n === "number");
  const startedAt = starts.length ? Math.min(...starts) : null;
  const finished = live.length > 0 && done.length === live.length;
  const endAt = finished ? Math.max(...done.map((t) => t.closed_at ?? t.updated_at)) : now;
  const minutes = (ms: number) => Math.round(ms / 6000) / 10;
  const entries: Record<string, number> = {};
  for (const e of plan.entries ?? []) {
    const type = LOG_TYPES[e.type] ?? e.type;
    entries[type] = (entries[type] ?? 0) + 1;
  }
  return {
    plan: plan.short_id as string,
    policy: resolveMessagingPolicy(plan.messaging_policy).name,
    tasks: live.length,
    done: done.length,
    blocked: live.filter((t) => t.execution_status === "blocked" || t.execution_status === "needs_context").length,
    retries: tasks.reduce((n, t) => n + (t.retry_count ?? 0), 0),
    finished,
    /** First task start to last task close, or to now while tasks are open. */
    wall_minutes: startedAt == null ? null : minutes(endAt - startedAt),
    /** Each done task's start to close, summed: wall time times how parallel the run was. */
    task_minutes: minutes(done.reduce((n, t) => n + (t.started_at ? (t.closed_at ?? t.updated_at) - t.started_at : 0), 0)),
    /** Plan entries by type, a fact counted as "fact". */
    entries,
  };
}

/**
 * summarizeRun plus what the run's sessions spent: the plan's bound sessions
 * (the lead among them) and every task's linked sessions, with their subagents,
 * each counted once.
 * ponytail: a session's totals are its lifetime, as in taskCost.ts, so a lead
 * that did other work before the plan counts that too.
 */
export const telemetry = query({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const plan = await ctx.db.query("plans").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id)).first();
    if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) return null;
    const tasks: Array<Doc<"tasks"> & { started_at?: number }> = [];
    for (const id of plan.task_ids ?? []) {
      const t = await ctx.db.get(id);
      if (!t || !isSameWorkspace(t, workspaceForResource(plan)) || !(await canAccessTask(ctx, auth.userId, t))) continue;
      // Nothing stamps tasks.started_at: a task starts when its status first moves to in_progress.
      const history = await ctx.db.query("task_history").withIndex("by_task_id", (q) => q.eq("task_id", t._id)).collect();
      const started = history.filter((h) => h.field === "status" && h.new_value === "in_progress").map((h) => h.created_at);
      tasks.push({ ...t, started_at: t.started_at ?? (started.length ? Math.min(...started) : undefined) });
    }
    const priced = newSessionPrice();
    const seen = new Set<string>();
    for (const id of [...(plan.session_ids ?? []), ...tasks.flatMap((t) => t.conversation_ids ?? [])]) {
      await priceSession(ctx, await ctx.db.get(id), seen, priced);
      for (const child of await childConversations(ctx, id)) await priceSession(ctx, child, seen, priced);
    }
    return {
      ...summarizeRun(plan, tasks),
      sessions: priced.sessions,
      /** Sessions that reported no tokens (Codex and other backends without usage). */
      uncounted: priced.uncounted,
      tokens: priced.tokens,
      list_usd: Math.round(priced.usd * 100) / 100,
    };
  },
});
