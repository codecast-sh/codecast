// Where a trial project's decisions go (learning-loop.md LL12). A station of a
// trial run (a session the runner nested under the run's primary
// conversation) asks the way any session does, with `cast decide`; the
// decision rail notices whose run it serves and files it as a trial decision:
// flagged `trial`, bound to the run's task, in the trial's one stack, and
// asked of nobody's queue, inbox or ladder. A leaf, so sessionDecisions can
// read it without importing lineTrial's graph.
import type { Doc, Id } from "../_generated/dataModel";
import { nextShortId } from "../counters";

type Ctx = { db: any };

/** The trial project a task belongs to, or null when its project runs a real line. */
export async function trialProjectOf(ctx: Ctx, task: { project_id?: Id<"projects"> } | null | undefined): Promise<Doc<"projects"> | null> {
  const project = task?.project_id ? await ctx.db.get(task.project_id) : null;
  return project?.line_trial ? project : null;
}

/** The trial run a session works for: a station nested under a trial run's primary conversation, or that conversation itself. */
export async function trialStationOf(
  ctx: Ctx,
  conversation: Pick<Doc<"conversations">, "parent_conversation_id" | "is_workflow_primary" | "workflow_run_id"> | null | undefined,
): Promise<{ run: Doc<"workflow_runs">; task: Doc<"tasks">; project: Doc<"projects"> } | null> {
  if (!conversation) return null;
  const primary = conversation.is_workflow_primary
    ? conversation
    : conversation.parent_conversation_id ? await ctx.db.get(conversation.parent_conversation_id) : null;
  const run: Doc<"workflow_runs"> | null = primary?.is_workflow_primary && primary.workflow_run_id ? await ctx.db.get(primary.workflow_run_id) : null;
  const task: Doc<"tasks"> | null = run?.task_id ? await ctx.db.get(run.task_id) : null;
  const project = await trialProjectOf(ctx, task);
  return run && task && project ? { run, task, project } : null;
}

/** The trial's one stack: made with its first decision, reopened when its last answer closed it. */
export async function trialStackOf(ctx: Ctx, project: Doc<"projects">, now: number): Promise<Doc<"decision_stacks"> | null> {
  const trial = project.line_trial;
  if (!trial) return null;
  const stack: Doc<"decision_stacks"> | null = trial.stack_id ? await ctx.db.get(trial.stack_id) : null;
  if (stack) {
    if (stack.status === "done") await ctx.db.patch(stack._id, { status: "open", updated_at: now });
    return stack.status === "done" ? { ...stack, status: "open" } : stack;
  }
  const id: Id<"decision_stacks"> = await ctx.db.insert("decision_stacks", {
    short_id: await nextShortId(ctx.db, "ds"),
    title: `${project.title} trial`,
    team_id: project.team_id,
    scope_user_id: project.team_id ? undefined : trial.by,
    owner_user_id: trial.by,
    decision_ids: [],
    policy: {},
    client_key: `trial:${project._id}`,
    status: "open",
    created_at: now,
    updated_at: now,
  });
  await ctx.db.patch(project._id, { line_trial: { ...trial, stack_id: id } });
  return await ctx.db.get(id);
}

/** A trial decision resolved: its card row stops waiting (answered, or closed when withdrawn or dismissed). */
export async function settleTrialCard(ctx: Ctx, decisionId: Id<"session_decisions">, status: string, now: number): Promise<void> {
  const rows: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId)).collect();
  for (const row of rows) {
    if (row.status === "waiting") await ctx.db.patch(row._id, { status: status === "answered" ? "answered" : "closed", updated_at: now });
  }
}
