// Where a trial project's decisions go (learning-loop.md LL12). A station of a
// trial run (a session the runner nested under the run's primary
// conversation) asks the way any session does, with `cast decide`; the
// decision rail notices whose run it serves and files it as a trial decision:
// flagged `trial`, bound to the run's task, in the trial's one stack, and
// asked of nobody's queue, inbox or ladder. A leaf, so sessionDecisions can
// read it without importing lineTrial's graph.
import type { Doc, Id } from "../_generated/dataModel";
import { nextShortId } from "../counters";
import { passwordHash } from "./artifactGates";
import { newSecret } from "./slug";

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

/**
 * The role a trial run's decision belongs to when it is not the trial owner's:
 * a judge-route run (its graph is the project's judge route) asks about a fix
 * to the judges every conversation is graded by, which is the role the trial
 * names as that route's decider (`line_trial.judge.decides`, set by `cast line
 * trial on --judge-decides <role>`). Null for a product run, a trial that names
 * no decider, or a decider no longer active: the decision is then the owner's.
 */
export async function trialDeciderOf(
  ctx: Ctx,
  project: Doc<"projects">,
  run: Pick<Doc<"workflow_runs">, "workflow_name"> | null | undefined,
): Promise<Doc<"org_roles"> | null> {
  const judge = project.line_trial?.judge;
  if (!judge?.decides || !run || run.workflow_name !== judge.name) return null;
  const role: Doc<"org_roles"> | null = await ctx.db.get(judge.decides);
  return role?.status === "active" ? role : null;
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

/**
 * Every page a trial decision attaches (its report, its option pages) quotes
 * customer text, so it is password gated here, on the rail every trial ask
 * and edit passes, rather than by the agent that published it. The trial
 * keeps one page password, made with its first gated page. A page already
 * carrying a password keeps it.
 */
export async function gateTrialPages(ctx: Ctx, project: Doc<"projects">, slugs: Array<string | undefined>, now: number): Promise<void> {
  const trial = project.line_trial;
  if (!trial) return;
  let password = trial.page_password;
  for (const slug of new Set(slugs.filter((s): s is string => !!s))) {
    const artifact = await ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
    if (!artifact || artifact.password_hash) continue;
    if (!password) {
      password = newSecret().slice(0, 12);
      await ctx.db.patch(project._id, { line_trial: { ...trial, page_password: password } });
    }
    await ctx.db.patch(artifact._id, { password_hash: await passwordHash(password, slug), updated_at: now });
  }
}

/** A trial decision resolved: its card row stops waiting (answered, or closed when withdrawn or dismissed). */
export async function settleTrialCard(ctx: Ctx, decisionId: Id<"session_decisions">, status: string, now: number): Promise<void> {
  const rows: Doc<"trial_cards">[] = await ctx.db.query("trial_cards").withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId)).collect();
  for (const row of rows) {
    if (row.status === "waiting") await ctx.db.patch(row._id, { status: status === "answered" ? "answered" : "closed", updated_at: now });
  }
}

/**
 * The node a station ran in its run, else the node the run stands at. The
 * runner names a station's session by its session id, its short id, or the
 * conversation id's first characters (the short form `cast` prints).
 */
export function stationNodeOf(run: Pick<Doc<"workflow_runs">, "node_statuses" | "current_node_id">, station: Pick<Doc<"conversations">, "session_id" | "short_id"> & { _id?: unknown }): string {
  const ids = new Set([station.session_id, station.short_id].filter(Boolean));
  const conversationId = station._id ? String(station._id) : "";
  const named = (id: string) => ids.has(id) || (id.length >= 7 && conversationId.startsWith(id));
  const ran = [...(run.node_statuses ?? [])].reverse().find((n) => !!n.session_id && named(n.session_id));
  return ran?.node_id ?? run.current_node_id ?? "";
}

/**
 * File a trial decision for the trial feed: the trial_cards row that indexes
 * it by run, node and task, which the review page and For you list. Its
 * question, options, page and answer are the decision's; the row keeps the
 * structured facts a gate checked (the change, proposal or judge-fix card).
 */
export async function fileTrialCard(
  ctx: Ctx,
  f: { project: Doc<"projects">; task: Doc<"tasks">; run: Pick<Doc<"workflow_runs">, "_id">; node_id: string; decision_id: Id<"session_decisions">; kind: "card" | "gate"; card?: unknown; proposal?: unknown; judge_fix?: unknown },
  now: number,
): Promise<string> {
  const short_id = await nextShortId(ctx.db, "tc");
  await ctx.db.insert("trial_cards", {
    workspace: f.project.workspace ?? f.task.workspace,
    ...(f.project.team_id ? { team_id: f.project.team_id } : {}),
    project_id: f.project._id,
    task_id: f.task._id,
    run_id: f.run._id,
    short_id,
    node_id: f.node_id,
    kind: f.kind,
    decision_id: f.decision_id,
    ...(f.card ? { card: f.card } : {}),
    ...(f.proposal ? { proposal: f.proposal } : {}),
    ...(f.judge_fix ? { judge_fix: f.judge_fix } : {}),
    status: "waiting",
    created_at: now,
    updated_at: now,
  });
  return short_id;
}
