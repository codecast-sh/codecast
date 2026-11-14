import { v } from "convex/values";
import { query } from "./functions";
import type { Doc } from "./_generated/dataModel";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf } from "./lib/ingestScope";
import { canAccessProject } from "./lib/access";
import { childConversations, newSessionPrice, priceRun, priceSession } from "./lib/sessionCost";

type Ctx = { db: any };
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * What a task has cost: its linked sessions, their direct children (subagents,
 * forks nested under them) and its workflow runs' station sessions, each
 * counted once. `list_usd` prices every counted session at API list price;
 * `billed_usd` is the money part: sessions on a metered provider key and the
 * runs' call nodes. Claude Code and Codex sessions spend subscription quota,
 * so their share of `list_usd` is an equivalent, never billed.
 *
 * Totals are a session's lifetime, so a session linked to two tasks counts in
 * full on each: there is no record of which of its turns served which task.
 */
export async function taskCost(ctx: Ctx, task: Doc<"tasks">) {
  const priced = newSessionPrice();
  const seen = new Set<string>();
  for (const id of task.conversation_ids ?? []) {
    await priceSession(ctx, await ctx.db.get(id), seen, priced);
    for (const child of await childConversations(ctx, id)) await priceSession(ctx, child, seen, priced);
  }
  const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  let callUsd = 0;
  for (const run of runs) {
    await priceRun(ctx, run, seen, priced);
    for (const n of run.node_statuses ?? []) callUsd += (n as { cost_usd?: number }).cost_usd ?? 0;
  }
  return {
    task: task.short_id,
    runs: runs.length,
    sessions: priced.sessions,
    tokens: priced.tokens,
    unpriced_tokens: priced.unpriced_tokens,
    /** Sessions with no token totals (Codex and other backends that report none). */
    uncounted: priced.uncounted,
    providers: priced.providers,
    list_usd: round(priced.usd),
    /** The subscription sessions' list price: an equivalent, never billed. */
    subscription_usd: round(priced.usd - priced.key.usd),
    billed_usd: round(priced.key.usd + callUsd),
  };
}

export type TaskCost = Awaited<ReturnType<typeof taskCost>>;

/** One task's cost (the task page header). */
export const cost = query({
  args: { ...scopeArgs, task: v.string() },
  handler: async (ctx, args): Promise<TaskCost | null> => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", args.task)).first();
    if (!task || task.workspace !== workspaceKey) return null;
    const project = task.project_id ? await ctx.db.get(task.project_id) : null;
    if (project && !(await canAccessProject(ctx, userId, project))) return null;
    return await taskCost(ctx, task);
  },
});
