// Backfill conversations.parked_wake_kind (lib/parkedWake.ts) for rows written
// before the wrapper kept it, repairing the `blocks` mirrors a blocker stamp
// rests on. Candidates come without a conversations scan, in phases: the
// spawners of live runs (workflow_runs.by_status, one phase per live status),
// then the sessions holding open tasks with a blocker or a wait. No index
// holds tasks by a non-empty blocked_by, so the tasks phase pages the table.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { LIVE_RUN_STATUSES, stampParkedWake, type ParkedWakeKind } from "./lib/parkedWake";

const PHASES = [...LIVE_RUN_STATUSES.map((s) => `runs:${s}` as const), "tasks" as const];
type Phase = (typeof PHASES)[number];
const RUN_PAGE = 100;
const TASK_PAGE = 500;

/**
 * One page of one phase. Start with no args (or `{ dry: true }`), then call
 * again with the returned `next` spread in until `next` is null. `numItems`
 * sizes each page (default 100 runs or 500 tasks) and rides `next`.
 */
export const backfill = internalMutation({
  args: {
    dry: v.optional(v.boolean()),
    phase: v.optional(v.union(...PHASES.map((p) => v.literal(p)))),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const phase: Phase = args.phase ?? PHASES[0];
    const cursor = args.cursor ?? null;
    const convIds = new Set<string>();
    let page: { page: any[]; isDone: boolean; continueCursor: string };
    if (phase === "tasks") {
      page = await ctx.db.query("tasks").paginate({ cursor, numItems: args.numItems ?? TASK_PAGE });
      for (const task of page.page) {
        if (isTerminalTaskStatus(task.status) || (!task.blocked_by?.length && !task.waits?.length)) continue;
        const bound = await ctx.db.query("conversations").withIndex("by_active_task", (q) => q.eq("active_task_id", task._id)).order("desc").take(20);
        for (const c of bound) convIds.add(String(c._id));
      }
    } else {
      const status = phase.slice("runs:".length) as (typeof LIVE_RUN_STATUSES)[number];
      page = await ctx.db.query("workflow_runs").withIndex("by_status", (q) => q.eq("status", status)).paginate({ cursor, numItems: args.numItems ?? RUN_PAGE });
      for (const run of page.page) if (run.spawner_conversation_id) convIds.add(String(run.spawner_conversation_id));
    }
    const stamped: Record<ParkedWakeKind, number> = { run: 0, blocker: 0, wait: 0, none: 0 };
    let repaired = 0;
    for (const ref of convIds) {
      const id = ctx.db.normalizeId("conversations", ref);
      const conv = id ? await ctx.db.get(id) : null;
      if (!conv) continue;
      const r = await stampParkedWake(ctx, ctx.db, conv, !!args.dry);
      if (r.changed) stamped[r.changed]++;
      repaired += r.repaired;
    }
    const after = PHASES[PHASES.indexOf(phase) + 1];
    const size = args.numItems === undefined ? {} : { numItems: args.numItems };
    const next = !page.isDone ? { phase, cursor: page.continueCursor, ...size } : after ? { phase: after, ...size } : null;
    return { dry: !!args.dry, phase, scanned: page.page.length, candidates: convIds.size, stamped, repaired, next };
  },
});
