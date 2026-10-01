// "Anyone with the link" for every shared object kind but conversations
// (whose link also carries a profile pin and an owner-only rule, see
// conversations.writeShareLink). One write rule and one token claim, so the
// kinds cannot drift apart; the public views of every kind born here live
// beside it (docs and plans keep theirs in their own modules). The URL grammar is
// @codecast/shared/entities sharePath.
//
// The web mints the token (a v4 UUID) so its optimistic draft and the stored
// value are the same string (dispatch setObjectShareLink). Turning the link
// off clears the token, killing every copy; turning it back on takes a new
// one, so an old link never comes back to life.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { canAccessDoc, canAccessInitiative, canAccessPlan, canAccessProject, canAccessTask, isSameWorkspace, workspaceForResource } from "./lib/access";
import { canReadCall } from "./transcripts";
import { assigneeNamesFor } from "./tasks";
import { userMayRead } from "./sessionDecisions";
import { canReadStack } from "./decisionStacks";
import { canViewTask } from "./agentTasks";
import { canReadRun } from "./workflow_runs";
import { isRecRoomKey } from "@codecast/shared/contracts";

export const SHARE_TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ShareTable =
  | "conversations" | "docs" | "plans" | "tasks" | "transcripts" | "projects" | "initiatives"
  | "session_decisions" | "decision_stacks" | "agent_tasks" | "workflow_runs";

/** Point `row`'s share token at `token` (null clears it). A token already
 *  serving another row of the table is refused, so one link can never be
 *  re-aimed at a different object. */
export async function claimShareToken(
  ctx: Pick<MutationCtx, "db">,
  table: ShareTable,
  row: { _id: Id<ShareTable>; share_token?: string | null },
  token: string | null,
): Promise<void> {
  if (token === null) {
    if (row.share_token) await ctx.db.patch(row._id, { share_token: undefined } as any);
    return;
  }
  if (row.share_token === token) return;
  if (!SHARE_TOKEN_SHAPE.test(token)) throw new Error("Invalid share token");
  const taken = await (ctx.db.query(table) as any)
    .withIndex("by_share_token", (q: any) => q.eq("share_token", token))
    .first();
  if (taken) throw new Error("Invalid share token");
  await ctx.db.patch(row._id, { share_token: token } as any);
}

// Who may turn a kind's link on or off: whoever may read the object. Docs,
// plans and tasks are team-editable, and a call's record belongs to everyone
// who sat through it. Wrapped, not referenced: this module sits in an import
// cycle with conversations.ts, and a bare binding read at load is a TDZ.
const SHARE_KINDS = {
  doc: { table: "docs", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessDoc(ctx, u, row) },
  plan: { table: "plans", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessPlan(ctx, u, row) },
  task: { table: "tasks", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessTask(ctx, u, row) },
  call: { table: "transcripts", canManage: (ctx: any, u: Id<"users">, row: any) => canReadCall(ctx, u, row) },
  project: { table: "projects", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessProject(ctx, u, row) },
  initiative: { table: "initiatives", canManage: (ctx: any, u: Id<"users">, row: any) => canAccessInitiative(ctx, u, row) },
  decision: { table: "session_decisions", canManage: (ctx: any, u: Id<"users">, row: any) => userMayRead(ctx, u, row) },
  stack: { table: "decision_stacks", canManage: (ctx: any, u: Id<"users">, row: any) => canReadStack(ctx, u, row) },
  trigger: { table: "agent_tasks", canManage: (ctx: any, u: Id<"users">, row: any) => canViewTask(ctx, u, row) },
  run: { table: "workflow_runs", canManage: (ctx: any, u: Id<"users">, row: any) => canReadRun(ctx, u, row) },
} as const satisfies Record<string, { table: TableNames; canManage: (ctx: any, userId: Id<"users">, row: any) => Promise<boolean> }>;

export type ObjectShareKind = keyof typeof SHARE_KINDS;

export function isObjectShareKind(kind: string): kind is ObjectShareKind {
  return Object.prototype.hasOwnProperty.call(SHARE_KINDS, kind);
}

export async function writeObjectShareLink(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  kind: string,
  id: string,
  token: string | null,
): Promise<void> {
  if (!isObjectShareKind(kind)) throw new Error("Unknown share kind");
  const { table, canManage } = SHARE_KINDS[kind];
  const rowId = ctx.db.normalizeId(table, id);
  const row = rowId ? await ctx.db.get(rowId) : null;
  // One error for "no row" and "not yours", so a probe learns nothing.
  if (!row || !(await canManage(ctx, userId, row))) throw new Error("Not found");
  await claimShareToken(ctx, table, row as any, token);
}

async function byShareToken<T extends ShareTable>(ctx: any, table: T, token: string): Promise<Doc<T> | null> {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(token)) return null;
  return await ctx.db
    .query(table)
    .withIndex("by_share_token", (q: any) => q.eq("share_token", token))
    .first();
}

// ── Public views ─────────────────────────────────────────────────────────
// What a stranger holding the link reads: the object's own words, names for
// the people in it, never ids, routing facts or links into private surfaces.

export const getSharedTask = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const task = await byShareToken(ctx, "tasks", args.share_token);
    if (!task) return null;
    const [author, names, comments] = await Promise.all([
      ctx.db.get(task.user_id),
      assigneeNamesFor(ctx, [task.assignee]),
      ctx.db
        .query("task_comments")
        .withIndex("by_task_created", (q) => q.eq("task_id", task._id))
        .collect(),
    ]);
    return {
      short_id: task.short_id,
      title: task.title,
      description: task.description ?? null,
      status: task.status,
      priority: task.priority,
      task_type: task.task_type,
      labels: task.labels ?? [],
      acceptance_criteria: task.acceptance_criteria ?? [],
      assignee: task.assignee ? (names[task.assignee] ?? null) : null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      closed_at: task.closed_at ?? null,
      user: author ? { name: author.name ?? null, image: author.image ?? null } : null,
      comments: comments.map((c) => ({
        author: c.author,
        text: c.text,
        comment_type: c.comment_type,
        created_at: c.created_at,
      })),
    };
  },
});

export const getSharedCall = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const t = await byShareToken(ctx, "transcripts", args.share_token);
    if (!t) return null;
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q) => q.eq("transcript_id", t._id))
      .collect();
    // Speakers are told apart by position, never by their user ids.
    const speakerKey = new Map<string, string>();
    const keyOf = (id: string) => {
      if (!speakerKey.has(id)) speakerKey.set(id, `s${speakerKey.size}`);
      return speakerKey.get(id)!;
    };
    return {
      title: t.title ?? null,
      recording: isRecRoomKey(t.room_key),
      status: t.status,
      started_at: t.started_at,
      ended_at: t.ended_at ?? null,
      participants: (t.participants ?? []).map((p) => ({ id: keyOf(p.id), name: p.name })),
      summary: t.summary ?? null,
      action_items: t.action_items ?? [],
      recording_url: t.recording_storage_id ? await ctx.storage.getUrl(t.recording_storage_id) : null,
      segments: segs.map((s) => ({
        seq: s.seq,
        speaker_id: keyOf(s.speaker_id),
        speaker_name: s.speaker_name,
        text: s.text,
        t0: s.t0,
        t1: s.t1,
      })),
    };
  },
});

// A person's display name, never their id or address.
async function personName(ctx: any, userId: Id<"users"> | undefined | null): Promise<string | null> {
  const u = userId ? await ctx.db.get(userId) : null;
  return u ? (u.name ?? u.github_username ?? null) : null;
}

async function author(ctx: any, userId: Id<"users">) {
  const u = await ctx.db.get(userId);
  return u ? { name: u.name ?? u.github_username ?? null, image: u.image ?? null } : null;
}

async function ownerName(ctx: any, owner: { kind: "user"; user_id: Id<"users"> } | { kind: "role"; role_id: Id<"org_roles"> } | undefined) {
  if (!owner) return null;
  if (owner.kind === "user") return personName(ctx, owner.user_id);
  const role = await ctx.db.get(owner.role_id);
  return role?.name ?? null;
}

/** A decision as a stranger reads it: the question, the options, the answer. */
function shapeDecision(d: Doc<"session_decisions">) {
  return {
    short_id: d.short_id ?? null,
    question: d.question,
    context_md: d.context_md ?? null,
    category: d.category ?? null,
    status: d.status,
    options: d.options.map((o) => ({
      label: o.label,
      description: o.description ?? null,
      body_md: o.body_md ?? null,
      cost: o.cost ?? null,
      risk: o.risk ?? null,
      evidence: o.evidence ?? [],
    })),
    default_option: d.default_option ?? null,
    answer_index: d.answer_index ?? null,
    answer_text: d.answer_text ?? null,
    created_at: d.created_at,
    resolved_at: d.resolved_at ?? null,
  };
}

export const getSharedProject = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const project = await byShareToken(ctx, "projects", args.share_token);
    if (!project) return null;
    const [tasks, plans] = await Promise.all([
      ctx.db.query("tasks").withIndex("by_project_id", (q) => q.eq("project_id", project._id)).collect(),
      ctx.db.query("plans").withIndex("by_project_id", (q) => q.eq("project_id", project._id)).collect(),
    ]);
    // Only what lives in the project's own workspace rides its link.
    const here = workspaceForResource(project);
    return {
      short_id: project.short_id ?? null,
      title: project.title,
      description: project.description ?? null,
      goal: project.goal ?? null,
      status: project.status,
      priority: project.priority ?? null,
      target_date: project.target_date ?? null,
      labels: project.labels ?? [],
      success_metrics: project.success_metrics ?? [],
      non_goals: project.non_goals ?? [],
      risks: project.risks ?? [],
      created_at: project.created_at,
      updated_at: project.updated_at,
      user: await author(ctx, project.user_id),
      plans: plans
        .filter((p) => isSameWorkspace(p, here))
        .map((p) => ({ short_id: p.short_id, title: p.title, status: p.status })),
      tasks: tasks
        .filter((t) => !t.parent_id && isSameWorkspace(t, here))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 200)
        .map((t) => ({ short_id: t.short_id, title: t.title, status: t.status, priority: t.priority })),
    };
  },
});

export const getSharedInitiative = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const ini = await byShareToken(ctx, "initiatives", args.share_token);
    if (!ini) return null;
    const [projects, updates] = await Promise.all([
      Promise.all(ini.project_ids.map((id) => ctx.db.get(id))),
      ctx.db.query("initiative_updates").withIndex("by_initiative_at", (q) => q.eq("initiative_id", ini._id)).order("desc").take(50),
    ]);
    return {
      short_id: ini.short_id,
      title: ini.title,
      description: ini.description ?? null,
      status: ini.status,
      health: ini.health,
      priority: ini.priority ?? null,
      target_date: ini.target_date ?? null,
      labels: ini.labels ?? [],
      owner: await ownerName(ctx, ini.owner as any),
      created_at: ini.created_at,
      updated_at: ini.updated_at,
      user: await author(ctx, ini.user_id),
      projects: projects
        .filter((p): p is Doc<"projects"> => !!p && isSameWorkspace(p, workspaceForResource(ini)))
        .map((p) => ({ title: p.title, status: p.status, description: p.description ?? null })),
      updates: await Promise.all(updates.map(async (u) => ({
        body: u.body,
        health: u.health,
        at: u.at,
        by: await ownerName(ctx, u.by as any),
      }))),
    };
  },
});

export const getSharedDecision = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const d = await byShareToken(ctx, "session_decisions", args.share_token);
    if (!d) return null;
    return { ...shapeDecision(d), user: await author(ctx, d.user_id) };
  },
});

export const getSharedStack = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const stack = await byShareToken(ctx, "decision_stacks", args.share_token);
    if (!stack) return null;
    const members = await Promise.all(stack.decision_ids.map((id) => ctx.db.get(id)));
    return {
      short_id: stack.short_id,
      title: stack.title,
      status: stack.status,
      created_at: stack.created_at,
      updated_at: stack.updated_at,
      user: await author(ctx, stack.owner_user_id),
      decisions: members.filter(Boolean).map((d) => shapeDecision(d as Doc<"session_decisions">)),
    };
  },
});

export const getSharedTrigger = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const t = await byShareToken(ctx, "agent_tasks", args.share_token);
    if (!t) return null;
    return {
      short_id: t.short_id ?? null,
      title: t.display_title ?? t.title,
      summary: t.display_summary ?? null,
      prompt: t.prompt,
      status: t.status,
      schedule_type: t.schedule_type,
      run_at: t.run_at ?? null,
      interval_ms: t.interval_ms ?? null,
      event: t.event_filter?.event_type ?? null,
      run_count: t.run_count,
      last_run_at: t.last_run_at ?? null,
      last_run_summary: t.last_run_summary ?? null,
      last_run_failed: t.last_run_failed ?? false,
      created_at: t.created_at,
      user: await author(ctx, t.user_id),
    };
  },
});

export const getSharedRun = query({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const run = await byShareToken(ctx, "workflow_runs", args.share_token);
    if (!run) return null;
    const workflow = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
    const labelOf = new Map((workflow?.nodes ?? []).map((n) => [n.id, n.label]));
    return {
      name: workflow?.name ?? run.workflow_name ?? "Workflow run",
      goal: run.goal_override ?? workflow?.goal ?? null,
      status: run.status,
      kind: run.run_kind ?? "workflow",
      fail_reason: run.fail_reason ?? null,
      phases: run.phases ?? [],
      total_tokens: run.total_tokens ?? null,
      agent_count: run.agent_count ?? null,
      created_at: run.created_at,
      updated_at: run.updated_at,
      user: await author(ctx, run.user_id),
      nodes: run.node_statuses.map((n) => ({
        label: n.label ?? labelOf.get(n.node_id) ?? n.node_id,
        phase: n.phase ?? null,
        status: n.status,
        outcome: n.outcome ?? null,
        started_at: n.started_at ?? null,
        completed_at: n.completed_at ?? null,
        tokens: n.tokens ?? null,
      })),
    };
  },
});
