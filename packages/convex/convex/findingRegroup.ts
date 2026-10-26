// Findings grouping could not compare when they came in (docs/architecture/
// learning-loop.md LL9). A finding that says what happened joins the problem
// whose findings read the same; with no room in the team's budget, or an
// embedding that failed, nothing was compared. Filed as new, each such finding
// opened a problem of its own: 1,221 did on Oct 26 while Union's budget
// refused grouping from 05:25 to 13:44 UTC. Now the finding waits, held, and
// the sweep below groups it once there is room; `regroupRefused` is the pass
// that folds the problems the refused findings opened before this.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { groupingVerdict, vectorScope, evidenceAt } from "./findingGroups";
import { heldAsSignal, mergeProblemCore, placeHeldRow, takesFinding, type SignalInput } from "./signals";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { agentSimilarTextOf } from "@codecast/shared/contracts/agentJudges";

const BATCH = 20;

/** The scope a stored finding was filed in, as grouping reads it. */
function rowScope(row: Doc<"signals">): Record<string, unknown> {
  const ws = parseWorkspaceKey(row.workspace);
  return {
    ...(ws?.type === "team" ? { workspace: "team", team_id: ws.teamId } : { workspace: "personal" }),
    ...(row.project_id ? { project: String(row.project_id) } : {}),
  };
}

const keepVector = async (ctx: any, row: Doc<"signals">, vector: number[]) => {
  if (!row.subject || !row.workspace) return;
  if (await ctx.db.query("signal_vectors").withIndex("by_signal", (q: any) => q.eq("signal_id", row._id)).first()) return;
  await ctx.db.insert("signal_vectors", { workspace: row.workspace, scope: vectorScope(row.workspace, row.subject), signal_id: row._id, embedding: vector });
};

/** The oldest findings waiting for grouping, each as grouping reads it. */
export const awaitingPage = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_awaiting_grouping", (q: any) => q.gt("awaiting_grouping.since", 0)).take(args.limit);
    return rows.map((row) => ({ _id: row._id, user_id: row.user_id, signal: { ...heldAsSignal(row), similar_text: row.awaiting_grouping!.text } as SignalInput, scope: rowScope(row) }));
  },
});

/** A waiting finding placed where grouping decided: the judged problem, else a problem of its own; its words kept for the next one. */
export const placeAwaiting = internalMutation({
  args: { row_id: v.id("signals"), judged_task_id: v.optional(v.id("tasks")), similar: v.optional(v.boolean()), vector: v.array(v.float64()) },
  handler: async (ctx, args) => {
    const row: Doc<"signals"> | null = await ctx.db.get(args.row_id);
    if (!row?.awaiting_grouping || row.task_id) return null;
    await ctx.db.patch(row._id, { awaiting_grouping: undefined });
    const placed = await placeHeldRow(ctx, row, args.judged_task_id ?? null, false);
    await keepVector(ctx, row, args.vector);
    if (args.similar && placed.decision === "judge") await ctx.db.patch(row._id, { attach: "similar" });
    return placed;
  },
});

/** The sweep (crons.ts): group the waiting findings, oldest first, until the budget refuses again. */
export const groupAwaiting = internalAction({
  args: {},
  handler: async (ctx): Promise<{ placed: number; waiting: boolean }> => {
    const rows: Array<{ _id: Id<"signals">; user_id: Id<"users">; signal: SignalInput; scope: Record<string, unknown> }> = await ctx.runQuery(internal.findingRegroup.awaitingPage, { limit: BATCH });
    let placed = 0;
    for (const row of rows) {
      const verdict = await groupingVerdict(ctx, { user_id: row.user_id }, row.signal, row.scope);
      if (verdict.refused) return { placed, waiting: true };
      await ctx.runMutation(internal.findingRegroup.placeAwaiting, { row_id: row._id, judged_task_id: verdict.judged ?? undefined, similar: verdict.similar || undefined, vector: verdict.vector! });
      placed++;
    }
    if (rows.length === BATCH) await ctx.scheduler.runAfter(0, internal.findingRegroup.groupAwaiting, {});
    return { placed, waiting: false };
  },
});

/**
 * One page of a judge's findings filed between `after` and `until`, oldest
 * first: whether grouping ever compared each (a kept embedding), its grouping
 * words again, and whether its problem holds it alone and still waits in the
 * queue, the only kind the pass folds.
 */
export const refusedPage = internalQuery({
  args: { workspace: v.string(), source: v.string(), after: v.number(), until: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows: Doc<"signals">[] = await ctx.db.query("signals")
      .withIndex("by_workspace_source_created", (q: any) => q.eq("workspace", args.workspace).eq("source", args.source).gt("created_at", args.after).lte("created_at", args.until))
      .take(args.limit);
    const out = [];
    for (const row of rows) {
      const compared = !!(await ctx.db.query("signal_vectors").withIndex("by_signal", (q: any) => q.eq("signal_id", row._id)).first());
      out.push({ _id: row._id, created_at: row.created_at, user_id: row.user_id, task_id: row.task_id ?? null, compared, signal: { ...heldAsSignal(row), similar_text: agentSimilarTextOf(row) } as SignalInput, scope: rowScope(row) });
    }
    return out;
  },
});

/** Keep a refused finding's words for the next one, and fold its problem into the one grouping named when it holds that finding alone and waits in the queue. */
export const regroupApply = internalMutation({
  args: { row_id: v.id("signals"), vector: v.array(v.float64()), judged_task_id: v.optional(v.id("tasks")), dry_run: v.boolean() },
  handler: async (ctx, args): Promise<{ decision: string; task?: string; into?: string }> => {
    const row: Doc<"signals"> | null = await ctx.db.get(args.row_id);
    if (!row) return { decision: "gone" };
    if (!args.dry_run) await keepVector(ctx, row, args.vector);
    const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
    const into: Doc<"tasks"> | null = args.judged_task_id ? await ctx.db.get(args.judged_task_id) : null;
    if (!task?.short_id || !into?.short_id || String(into._id) === String(task._id)) return { decision: "kept" };
    const alone = (await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).take(2)).length === 1;
    if (task.status !== "open" || !alone) return { decision: "moved on", task: task.short_id, into: into.short_id };
    const now = Date.now();
    if (!takesFinding(into, evidenceAt(row) ?? now, now)) return { decision: "kept", task: task.short_id };
    if (args.dry_run) return { decision: "would fold", task: task.short_id, into: into.short_id };
    await mergeProblemCore(ctx, row.user_id, task.short_id, into.short_id);
    return { decision: "folded", task: task.short_id, into: into.short_id };
  },
});

const tallyArg = v.object({ compared: v.number(), folded: v.number(), kept: v.number(), already: v.number() });

/**
 * The pass over the findings a judge filed while grouping was refused, oldest
 * first so each can join one filed before it (its words are kept as it goes):
 * each is compared now and, where grouping names another problem, the problem
 * it opened alone folds into that one. It continues in pages by itself and
 * stops where the budget refuses again; each page logs its tally. Run it with
 * `dry_run` and a `max` first: a dry run keeps no words, so it folds nothing
 * into a problem the same pass opened.
 */
export const regroupRefused = internalAction({
  args: { workspace: v.string(), source: v.string(), since: v.number(), until: v.number(), dry_run: v.boolean(), max: v.optional(v.number()), after: v.optional(v.number()), tally: v.optional(tallyArg) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const tally = args.tally ?? { compared: 0, folded: 0, kept: 0, already: 0 };
    let after = args.after ?? args.since - 1;
    const page: Array<{ _id: Id<"signals">; created_at: number; user_id: Id<"users">; task_id: Id<"tasks"> | null; compared: boolean; signal: SignalInput; scope: Record<string, unknown> }> =
      await ctx.runQuery(internal.findingRegroup.refusedPage, { workspace: args.workspace, source: args.source, after, until: args.until, limit: BATCH });
    for (const r of page) {
      if (args.max !== undefined && tally.compared >= args.max) break;
      after = r.created_at;
      if (r.compared || !r.signal.similar_text || !r.signal.subject) { tally.already++; continue; }
      const verdict = await groupingVerdict(ctx, { user_id: r.user_id }, r.signal, r.scope, { exclude: r.task_id ?? undefined });
      if (verdict.refused) {
        console.log(`[regroupRefused] stopped: the budget refused at ${after}`, JSON.stringify(tally));
        return { ...tally, after, stopped: "the budget refused" };
      }
      const out = await ctx.runMutation(internal.findingRegroup.regroupApply, { row_id: r._id, vector: verdict.vector!, judged_task_id: verdict.judged ?? undefined, dry_run: args.dry_run });
      tally.compared++;
      if (out.decision === "folded" || out.decision === "would fold") tally.folded++;
      else tally.kept++;
      if (args.dry_run && out.decision === "would fold") console.log(`[regroupRefused] ${out.task} would fold into ${out.into}`);
    }
    console.log(`[regroupRefused] ${args.dry_run ? "dry run " : ""}through ${after}:`, JSON.stringify(tally));
    const more = page.length === BATCH && (args.max === undefined || tally.compared < args.max);
    if (more) await ctx.scheduler.runAfter(0, internal.findingRegroup.regroupRefused, { ...args, after, tally });
    return { ...tally, after, more };
  },
});
