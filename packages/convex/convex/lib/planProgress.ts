// Plan progress counts and the merged plan timeline, shared by the plan
// queries and mutations in plans.ts.

import { Id } from "../_generated/dataModel";

export async function recalcProgress(ctx: any, taskIds: Id<"tasks">[]) {
  let total = 0, done = 0, in_progress = 0, open = 0;
  let exec_done = 0, exec_done_with_concerns = 0, exec_blocked = 0, exec_needs_context = 0;

  for (const tid of taskIds) {
    const task = await ctx.db.get(tid);
    if (!task || task.status === "dropped") continue;
    // A subtask is never a plan's unit of progress (the parent is). Exclude any
    // that slipped into task_ids before that rule — matches tasks.recalcPlanProgress.
    if (task.parent_id) continue;
    total++;
    if (task.status === "done") done++;
    else if (task.status === "in_progress" || task.status === "in_review") in_progress++;
    else if (task.status === "open" || task.status === "backlog") open++;

    const es = (task as any).execution_status;
    if (es === "done") exec_done++;
    else if (es === "done_with_concerns") exec_done_with_concerns++;
    else if (es === "blocked") exec_blocked++;
    else if (es === "needs_context") exec_needs_context++;
  }

  return {
    total, done, in_progress, open,
    execution_status: {
      done: exec_done,
      done_with_concerns: exec_done_with_concerns,
      blocked: exec_blocked,
      needs_context: exec_needs_context,
    },
  };
}


// Merge legacy per-type arrays with new unified entries into a single sorted timeline.
// Deduplicates by timestamp+content to avoid showing entries written to both old and new.
export function mergePlanEntries(plan: any): Array<{
  type: string; timestamp: number; content: string;
  session_id?: string; author?: string; rationale?: string; path_or_url?: string;
}> {
  const seen = new Set<string>();
  const all: any[] = [];

  const add = (e: any) => {
    const key = `${e.timestamp}:${e.content}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(e);
  };

  // New unified entries (preferred)
  for (const e of (plan.entries || [])) add(e);

  // Legacy arrays
  for (const e of (plan.progress_log || [])) {
    add({ type: "progress", timestamp: e.timestamp, content: e.entry, session_id: e.session_id });
  }
  for (const e of (plan.decision_log || [])) {
    add({ type: "decision", timestamp: e.timestamp, content: e.decision, rationale: e.rationale, session_id: e.session_id });
  }
  for (const e of (plan.discoveries || [])) {
    add({ type: "discovery", timestamp: e.timestamp, content: e.finding, session_id: e.session_id });
  }
  for (const e of (plan.context_pointers || [])) {
    add({ type: "reference", timestamp: 0, content: e.label, path_or_url: e.path_or_url });
  }

  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
}
