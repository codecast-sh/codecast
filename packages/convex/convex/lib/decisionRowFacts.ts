// Facts the Decisions list sorts and filters by, stamped on every decision row
// a feed sends (sessionDecisions decisionRowsForViewer), so a row reads the
// same whichever feed brought it: `area_project_id`, the project its task sits
// in (the workspace's areas are its projects); `source_flow`, the name of the
// flow whose run asked it (null for a session's own `cast decide`); and, for a
// decision about a problem, `problem_findings` and `problem_reach`, its
// findings and the people they reached (the task's cause). Each task, run and
// flow is read once per call.
import type { Doc, Id } from "../_generated/dataModel";
import { contactsOf } from "@codecast/shared/contracts/problemReach";

type Ctx = { db: any };
type Row = Pick<Doc<"session_decisions">, "task_id" | "workflow_run_id">;

export type DecisionRowFacts = { area_project_id: string | null; source_flow: string | null; problem_findings: number | null; problem_reach: number | null };

export async function withDecisionFacts<T extends Row>(ctx: Ctx, rows: T[]): Promise<Array<T & DecisionRowFacts>> {
  const tasks = new Map<string, Promise<Doc<"tasks"> | null>>();
  const flows = new Map<string, Promise<string | null>>();
  const taskOf = (id: Id<"tasks">) => {
    const key = String(id);
    if (!tasks.has(key)) tasks.set(key, ctx.db.get(id));
    return tasks.get(key)!;
  };
  const flowOf = (id: Id<"workflow_runs">) => {
    const key = String(id);
    if (!flows.has(key)) {
      flows.set(key, (async () => {
        const run: Doc<"workflow_runs"> | null = await ctx.db.get(id);
        if (!run) return null;
        const flow: Doc<"workflows"> | null = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
        return flow?.label || flow?.name || run.workflow_name || null;
      })());
    }
    return flows.get(key)!;
  };
  const out: Array<T & DecisionRowFacts> = [];
  for (const r of rows) {
    const task = r.task_id ? await taskOf(r.task_id) : null;
    const source_flow = r.workflow_run_id ? await flowOf(r.workflow_run_id) : null;
    const cause = task?.cause;
    out.push({
      ...r, area_project_id: task?.project_id ? String(task.project_id) : null, source_flow,
      problem_findings: cause?.signal_count || null, problem_reach: contactsOf(cause?.fingerprints) || null,
    });
  }
  return out;
}
