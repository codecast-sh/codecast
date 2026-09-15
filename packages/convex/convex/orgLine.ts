import { internalMutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { resolveScope } from "./org";
import { capsFor, countersFor, trustOf } from "./orgEvents";
import { recordHandStart } from "./spawn";
import { insertTaskComment } from "./tasks";
import { computeWorkspaceKey } from "./lib/access";
import { resolveCreationPrivacy } from "./privacy";
import { lineSlugOf } from "./orgRoles";

// The line (docs/architecture/the-line.md L2, L9). A scope owns one workflow,
// named by `org_roles.line_workflow_slug`; the sweep below starts that
// workflow on every open task the role's agent is assigned to. Every function
// takes the db and the role row so the fake db tests drive the same code the
// cron runs.

type Ctx = { db: any };

// How many runs one sweep may start in total, so a large backlog is drained
// two minutes at a time instead of in one long mutation.
export const MAX_STARTS_PER_SWEEP = 10;

export const LINE_STARTED_PREFIX = "the line started: run ";

const agentAssignee = (role: { handle: string }) => `agent:${role.handle}`;

// L9: the tasks a role's line should start. In the role's scope (the same
// resolver the scope feed uses), open, assigned to the role's agent, no run
// yet, and no blocker that is still open.
export async function lineCandidates(ctx: Ctx, role: any): Promise<any[]> {
  const resolved = await resolveScope(ctx, role.host_user_id, { role_id: String(role._id) });
  if (!resolved) return [];
  const assignee = agentAssignee(role);
  const out: any[] = [];
  for (const task of resolved.tasks) {
    if (task.status !== "open" || task.assignee !== assignee || task.workflow_run_id) continue;
    if (await isBlocked(ctx, task)) continue;
    out.push(task);
  }
  // Oldest first: the backlog drains in the order it was filed.
  out.sort((a, b) => (a.created_at ?? a._creationTime ?? 0) - (b.created_at ?? b._creationTime ?? 0));
  return out;
}

// blocked_by holds task short ids (tasks.ts ready): a blocker counts as open
// until it is done or dropped. An unknown id blocks nothing.
async function isBlocked(ctx: Ctx, task: any): Promise<boolean> {
  for (const shortId of task.blocked_by ?? []) {
    const blocker = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
    if (blocker && blocker.status !== "done" && blocker.status !== "dropped") return true;
  }
  return false;
}

export function roleMayStartHands(role: any, now: number): boolean {
  if (role.status !== "active" || trustOf(role) !== "direct") return false;
  return countersFor(role, now).hands < capsFor(role).hands_per_day;
}

// L9: one run for one task. Mirrors workflow_runs.createFromCli, with the
// role as the caller: the run belongs to the host user, its spawner is the
// role's standing session (so hands spawn under the role, L1), its cwd is the
// anchor's project path, and its workflow is the host's row with the line's
// slug. When the host has no such row (the slug names a shipped template that
// was never pushed) the run carries `workflow_name` = the slug and no
// `workflow_id`; the daemon command carries `workflow_slug` too, and `cast
// workflow run-daemon` resolves the template by that name.
export async function startLineRun(ctx: Ctx, role: any, task: any, now = Date.now()): Promise<Id<"workflow_runs">> {
  const hostId: Id<"users"> = role.host_user_id;
  const slug = lineSlugOf(role);
  const workflow = await ctx.db
    .query("workflows")
    .withIndex("by_user_slug", (q: any) => q.eq("user_id", hostId).eq("slug", slug))
    .first();
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const projectPath: string | undefined = anchor?.project_path ?? undefined;
  const teamId: Id<"teams"> | undefined = role.team_id ?? task.team_id ?? undefined;

  // L8: workspace is ACCESS, team_id is ROUTING; both are written at create.
  const workspace = computeWorkspaceKey({ user_id: hostId, team_id: teamId }, null);
  const runId: Id<"workflow_runs"> = await ctx.db.insert("workflow_runs", {
    user_id: hostId,
    ...(workflow ? { workflow_id: workflow._id } : {}),
    workflow_name: workflow?.name ?? slug,
    task_id: task._id,
    ...(anchor?.conversation_id ? { spawner_conversation_id: anchor.conversation_id } : {}),
    status: "pending",
    node_statuses: [],
    goal_override: task.title,
    project_path: projectPath,
    workspace,
    team_id: teamId,
    created_at: now,
    updated_at: now,
  });
  // The task leaves `open` the moment its run exists, as createFromCli does:
  // that is also what keeps the next sweep from starting it twice.
  await ctx.db.patch(task._id, { workflow_run_id: runId, status: "in_progress", updated_at: now });

  const privacy = await resolveCreationPrivacy(ctx as any, hostId, projectPath, teamId);
  const title = workflow?.name ?? slug;
  const primaryConvId: Id<"conversations"> = await ctx.db.insert("conversations", {
    user_id: hostId,
    agent_type: "claude_code",
    session_id: `wf-${runId}`,
    title,
    project_path: projectPath,
    started_at: now,
    updated_at: now,
    message_count: 0,
    ...privacy,
    status: "active",
    workflow_run_id: runId,
    is_workflow_primary: true,
  });
  await ctx.db.patch(runId, { primary_conversation_id: primaryConvId });
  await ctx.db.insert("messages", {
    conversation_id: primaryConvId,
    role: "assistant",
    content: JSON.stringify({ __wf: "started", goal: task.title, workflow_name: title }),
    subtype: "workflow_event",
    timestamp: now,
  });
  await ctx.db.patch(primaryConvId, { message_count: 1, last_message_role: "assistant" });

  await ctx.db.insert("daemon_commands", {
    user_id: hostId,
    command: "run_workflow",
    args: JSON.stringify({ workflow_run_id: runId, workflow_slug: slug }),
    created_at: now,
  });

  // The run's primary session is a hand of the role: it counts against
  // caps.hands_per_day and carries org_role_id, the same as a spawn.
  await recordHandStart(ctx, role, primaryConvId);
  await insertTaskComment(ctx, task._id, {
    author: `@${role.handle}`,
    text: `${LINE_STARTED_PREFIX}${runId}`,
    comment_type: "progress",
    conversation_id: primaryConvId,
  });
  return runId;
}

export type SweepResult = { started: Array<{ role_id: string; task_id: string; run_id: string }>; skipped_capped: string[] };

// L9: every two minutes. Paused roles and roles below `direct` never start
// anything; a capped role is reported and left for tomorrow.
export async function sweepCore(ctx: Ctx, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { started: [], skipped_capped: [] };
  const roles: any[] = await ctx.db.query("org_roles").collect();
  for (const seed of roles) {
    if (seed.status !== "active" || trustOf(seed) !== "direct") continue;
    let role = seed;
    for (const task of await lineCandidates(ctx, role)) {
      if (result.started.length >= MAX_STARTS_PER_SWEEP) return result;
      if (!roleMayStartHands(role, now)) { result.skipped_capped.push(String(role._id)); break; }
      const runId = await startLineRun(ctx, role, task, now);
      result.started.push({ role_id: String(role._id), task_id: String(task._id), run_id: String(runId) });
      // recordHandStart patched the counters; read the row back before the
      // next cap check.
      role = await ctx.db.get(role._id);
    }
  }
  return result;
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => sweepCore(ctx),
});
