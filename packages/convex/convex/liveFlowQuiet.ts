// The quiet close of a live flow's bar (decision sd-1700): a problem under the
// bar waits for another finding, and one that gets none for the bar's
// quiet_days closes. So does one the line looked at and found nothing to
// change in (readiness not_actionable), which otherwise waits for a person to
// close it. The close is the time after which evidence is new
// (dissolved.fixed_at), so the next finding reopens the problem
// (signals.ts reopenAfterFix) and the findings it held stay its history.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./functions";
import { barWords, clearsBar, type FlowBar } from "./lib/linePriority";
import { retireOnClose } from "./findingGroups";
import { insertTaskComment, moveTaskStatus } from "./tasks";

const DAY_MS = 86_400_000;
/** Problems one call reads; a pass schedules its next page itself. */
const PAGE = 100;

/** When a problem last heard of its cause: it opened, a finding joined it, or its newest finding was seen. */
export const quietSince = (t: Pick<Doc<"tasks">, "created_at" | "cause">): number =>
  Math.max(t.created_at ?? 0, t.cause?.joined_at ?? 0, t.cause?.last_seen ?? 0);

/** Whether the quiet close takes a problem now: open, handed to nobody, with no live hold on it, quiet for the bar's
 *  days, and either ready but under the bar, or found to need no change. */
export function closesQuiet(t: Doc<"tasks">, bar: FlowBar, now: number): boolean {
  if (t.status !== "open" || t.source !== "signal" || t.assignee || t.ephemeral || !t.cause || now - quietSince(t) < bar.quiet_days * DAY_MS) return false;
  if (t.readiness === "not_actionable") return true;
  return t.readiness === "ready" && !t.workflow_run_id && !clearsBar(t, bar);
}

/** The close's note: what held it (the bar, or a look that found nothing to change), and that a new finding reopens it. */
export function quietWords(t: Pick<Doc<"tasks">, "cause" | "readiness">, bar: FlowBar): string {
  const score = t.cause?.scored?.score;
  const n = t.cause?.signal_count ?? 0;
  const held = t.readiness === "not_actionable" ? "the line found nothing to change" : `scored ${score} on ${n} finding${n === 1 ? "" : "s"}, under the flow's bar (${barWords(bar)})`;
  return `Closed quiet: ${held}, and no new finding in ${bar.quiet_days} days. A new finding reopens it.`;
}

async function closeQuiet(ctx: any, task: Doc<"tasks">, bar: FlowBar, now: number): Promise<void> {
  const note = quietWords(task, bar);
  await moveTaskStatus(ctx, task, "dropped", { actorUserId: task.user_id, now, closedAt: now, extra: { cause: { ...task.cause!, dissolved: { at: now, note, fixed_at: now, quiet: true } } } });
  await retireOnClose(ctx, (await ctx.db.get(task._id))!, now);
  await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: note });
}

/** One page of a live flow's open problems at one readiness: each the quiet close takes closes; the next page follows,
 *  then the next readiness. */
const SWEPT = ["ready", "not_actionable"] as const;

export const sweep = internalMutation({
  args: { flow: v.id("live_flows"), readiness: v.optional(v.union(v.literal("ready"), v.literal("not_actionable"))), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ closed: number }> => {
    const flow: any = await ctx.db.get(args.flow);
    if (!flow?.on || !flow.bar) return { closed: 0 };
    const now = Date.now();
    const readiness = args.readiness ?? SWEPT[0];
    const page = await ctx.db.query("tasks")
      .withIndex("by_workspace_source_status_readiness", (q: any) => q.eq("workspace", flow.workspace).eq("source", "signal").eq("status", "open").eq("readiness", readiness))
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
    let closed = 0;
    for (const t of page.page as Doc<"tasks">[]) {
      if (!closesQuiet(t, flow.bar, now)) continue;
      await closeQuiet(ctx, t, flow.bar, now);
      closed++;
    }
    const next = SWEPT[SWEPT.indexOf(readiness) + 1];
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.liveFlowQuiet.sweep, { flow: args.flow, readiness, cursor: page.continueCursor });
    else if (next) await ctx.scheduler.runAfter(0, internal.liveFlowQuiet.sweep, { flow: args.flow, readiness: next });
    if (closed) console.log(`live flow ${flow._id}: ${closed} problem${closed === 1 ? "" : "s"} closed quiet under ${barWords(flow.bar)}, ${flow.bar.quiet_days} days`);
    return { closed };
  },
});

/** The cron's pass: every live flow that is on and sets a bar. */
export const sweepAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const f of await ctx.db.query("live_flows").collect()) if (f.on && f.bar) await ctx.scheduler.runAfter(0, internal.liveFlowQuiet.sweep, { flow: f._id });
  },
});
