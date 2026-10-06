// One Ship control (docs/architecture/ship.md): the one server action every
// Ship press reaches, from a task, a session, a pull request, a change card or
// `cast ship run`. It gathers the facts for the target, resolves the plan with
// the shared resolver (shared/contracts/shipPlan.ts), and either answers the
// line's change card (a line run parked at its card ships through its own
// ship station) or starts a ship session nested under the work it lands.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { canAccessConversation, canAccessPullRequest, canAccessTask } from "./lib/access";
import { findTaskByRef } from "./taskEvidence";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { pullRequestsLinkedToConversation } from "./lib/prSessions";
import { isViableInboxParent } from "./inboxFilters";
import { spawnSessionCore } from "./spawn";
import { addConversationToWorkItem } from "./conversationLinks";
import { resolveTaskGitContext } from "./tasks";
import { answerCore } from "./sessionDecisions";
import { repositoryFromRemote, normalizeSubagentCaps } from "@codecast/shared/contracts";
import { cardVerdictIndexes } from "@codecast/shared/contracts/changeCard";
import {
  SHIP_DEFAULT_MERGE,
  resolveShipPlan,
  shipBrief,
  type ShipFacts,
  type ShipPlan,
  type ShipProfileFacts,
  type ShipTarget,
  type ShipTargetKind,
} from "@codecast/shared/contracts/shipPlan";

type Ctx = { db: any; scheduler?: any };

export const shipTargetValidator = v.object({
  kind: v.union(v.literal("task"), v.literal("conversation"), v.literal("pull_request")),
  id: v.string(),
});

/** The store key and ship_runs.target_key of a target: one row per thing Ship was pressed on. */
export const shipTargetKey = (t: { kind: ShipTargetKind; id: string }) => `${t.kind}:${t.id}`;

type Gathered = {
  facts: ShipFacts;
  task: any | null;
  /** The session doing the work: the ship session nests under it when it is still in the inbox. */
  work: any | null;
  pr: any | null;
  gate: any | null;
};

function profileFacts(project: any): ShipProfileFacts | null {
  const p = project?.line_profile;
  if (!p?.commands) return null;
  return { check: p.commands.check ?? null, ship: p.commands.ship ?? null, merge: p.merge ?? SHIP_DEFAULT_MERGE };
}

/** The project whose published profile covers a checkout: a task's own, else the one whose profile root holds the path. */
async function projectForPath(ctx: Ctx, conversation: any): Promise<any | null> {
  const root = conversation?.git_root ?? conversation?.project_path;
  if (!root || !conversation.team_id) return null;
  const projects = await ctx.db.query("projects").withIndex("by_team_id", (q: any) => q.eq("team_id", conversation.team_id)).take(200);
  return projects.find((p: any) => p.line_profile?.default && p.line_profile.root && (root === p.line_profile.root || root.startsWith(`${p.line_profile.root}/`))) ?? null;
}

const branchOf = (c: any): string | null => c?.worktree_branch ?? c?.git_branch ?? null;
const checkoutOf = (c: any): string | null => c?.worktree_path ?? c?.git_root ?? c?.project_path ?? null;
const openFirst = (prs: any[]) => [...prs].sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.updated_at - a.updated_at)[0] ?? null;

async function readable(ctx: Ctx, userId: Id<"users">, id: any): Promise<any | null> {
  const c = id ? await ctx.db.get(id).catch(() => null) : null;
  return c && (await canAccessConversation(ctx as any, userId, c)) ? c : null;
}

/** The session a task's change lives in: the newest linked session on a branch, else the newest linked one. */
async function workSessionOfTask(ctx: Ctx, userId: Id<"users">, task: any): Promise<any | null> {
  const ids = [...(task.conversation_ids ?? [])].reverse().slice(0, 12);
  let fallback: any = null;
  for (const id of ids) {
    const c = await readable(ctx, userId, id);
    if (!c || c.ship_target_key) continue;
    if (branchOf(c)) return c;
    fallback ??= c;
  }
  return fallback;
}

/**
 * `decisionId` names the change card a web press already answered on the
 * decision rail (the store's answerDecision patch lands before this runs), so
 * the gate is found even though it is no longer pending.
 */
export async function gatherShipFacts(ctx: Ctx, userId: Id<"users">, target: ShipTarget, decisionId?: string): Promise<Gathered | { error: string }> {
  let task: any = null;
  let work: any = null;
  let pr: any = null;
  let gate: any = null;

  if (target.kind === "task") {
    task = await findTaskByRef(ctx, target.id);
    if (!task || !(await canAccessTask(ctx as any, userId, task))) return { error: "Task not found" };
    const pending = await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", task._id).eq("status", "pending")).collect();
    const isCard = (d: any) => d && d.card && d.workflow_run_id && String(d.task_id) === String(task._id) && cardVerdictIndexes(d.options ?? []);
    const named = decisionId && ctx.db.normalizeId("session_decisions", decisionId) ? await ctx.db.get(decisionId as Id<"session_decisions">) : null;
    gate = (isCard(named) ? named : pending.find(isCard)) ?? null;
    work = await workSessionOfTask(ctx, userId, task);
  } else if (target.kind === "conversation") {
    const id = ctx.db.normalizeId("conversations", target.id);
    work = id ? await readable(ctx, userId, id) : await findConversationByAnyRef(ctx as any, target.id, userId);
    if (!work || !(await canAccessConversation(ctx as any, userId, work))) return { error: "Session not found" };
    task = work.active_task_id ? await ctx.db.get(work.active_task_id).catch(() => null) : null;
  } else {
    const id = ctx.db.normalizeId("pull_requests", target.id);
    pr = id ? await ctx.db.get(id) : null;
    if (!pr || !(await canAccessPullRequest(ctx as any, userId, pr))) return { error: "Pull request not found" };
    work = await readable(ctx, userId, pr.shepherd_conversation_id) ?? await readable(ctx, userId, [...(pr.linked_session_ids ?? [])].pop());
    task = pr.task_ids?.length ? await ctx.db.get(pr.task_ids[0]).catch(() => null) : (work?.active_task_id ? await ctx.db.get(work.active_task_id).catch(() => null) : null);
  }
  if (!pr && work) pr = openFirst(await pullRequestsLinkedToConversation(ctx, work._id));

  const project = task?.project_id ? await ctx.db.get(task.project_id).catch(() => null) : await projectForPath(ctx, work);
  let projectPath = checkoutOf(work);
  if (!projectPath && task) {
    const mappings = await ctx.db.query("directory_team_mappings").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
    const g = await resolveTaskGitContext(ctx, userId, task, mappings);
    projectPath = g.git_root ?? g.project_path ?? null;
  }
  const repository = pr?.repository ?? repositoryFromRemote(work?.git_remote_url) ?? null;
  const label = target.kind === "pull_request"
    ? `${pr.repository}#${pr.number} ${pr.title}`
    : target.kind === "task"
      ? `${task.short_id} ${task.title}`
      : `session ${work.short_id ?? String(work._id).slice(0, 7)}${work.title ? ` ${work.title}` : ""}`;

  const facts: ShipFacts = {
    target: { kind: target.kind, id: String(target.kind === "task" ? task._id : target.kind === "conversation" ? work._id : pr._id) },
    label,
    repository,
    branch: branchOf(work),
    base: "main",
    projectPath,
    taskShortId: task?.short_id ?? null,
    profile: profileFacts(project),
    pr: pr ? { repository: pr.repository, number: pr.number, state: pr.state, head_ref: pr.head_ref ?? null, base_ref: pr.base_ref ?? null } : null,
    lineGate: gate ? { decisionId: String(gate._id) } : null,
    sessionShortId: work ? (work.short_id ?? String(work._id).slice(0, 7)) : null,
  };
  return { facts, task, work, pr, gate };
}

/** The latest ship run for a target, as the control renders it. */
async function latestRun(ctx: Ctx, key: string) {
  const run = await ctx.db.query("ship_runs").withIndex("by_target", (q: any) => q.eq("target_key", key)).order("desc").first();
  if (!run) return null;
  return {
    id: String(run._id),
    client_key: run.client_key ?? null,
    procedure: run.plan?.procedure ?? null,
    conversation_id: run.conversation_id ? String(run.conversation_id) : null,
    short_id: run.conversation_id ? String(run.conversation_id).slice(0, 7) : null,
    decision_id: run.decision_id ? String(run.decision_id) : null,
    workflow_run_id: run.workflow_run_id ? String(run.workflow_run_id) : null,
    created_at: run.created_at,
  };
}

/** The line run's ship and merge stations, for a Ship that answered a change card. */
async function lineStations(ctx: Ctx, runId: string | null) {
  if (!runId) return null;
  const run = await ctx.db.get(runId as Id<"workflow_runs">).catch(() => null);
  if (!run) return null;
  const node = (id: string) => run.node_statuses?.find((n: any) => n.node_id === id) ?? null;
  return {
    status: run.status,
    ship: node("ship") ? { status: node("ship").status, outcome: node("ship").outcome ?? null, preview: node("ship").result_preview ?? null } : null,
    merge: run.merge ? { branch: run.merge.branch, into: run.merge.into, pr_url: run.merge.pr_url ?? null } : null,
    fail_reason: run.fail_reason ?? null,
  };
}

export type StartShipResult = { run_id: string; plan: ShipPlan; conversation_id: string | null; short_id: string | null; answered_card: boolean };

export async function startShipCore(
  ctx: Ctx,
  userId: Id<"users">,
  target: ShipTarget,
  opts: { clientKey?: string; requester?: any; decisionId?: string } = {},
): Promise<StartShipResult> {
  const got = await gatherShipFacts(ctx, userId, target, opts.decisionId);
  if ("error" in got) throw new Error(got.error);
  const plan = resolveShipPlan(got.facts);
  if (plan.blocked) throw new Error(plan.blocked);
  const key = shipTargetKey(got.facts.target);
  const now = Date.now();

  if (plan.procedure === "line_gate") {
    const index = cardVerdictIndexes(got.gate.options)!.ship;
    // The web already answered the card on its own rail (the store's
    // answerDecision, same settle); answer here only when it is still open.
    if (got.gate.status === "pending") {
      const out = await answerCore(ctx as any, { userId }, { decision_id: String(got.gate._id), answer_index: index });
      if (out?.error && !/already/.test(out.error)) throw new Error(out.error);
    }
    const runId = await ctx.db.insert("ship_runs", {
      target_key: key, target_kind: target.kind, user_id: userId, plan,
      decision_id: got.gate._id, workflow_run_id: got.gate.workflow_run_id,
      ...(opts.clientKey ? { client_key: opts.clientKey } : {}), created_at: now,
    });
    return { run_id: String(runId), plan, conversation_id: null, short_id: null, answered_card: true };
  }

  // Nest under the work's session while it is still in the requester's
  // inbox, else under the session that asked (a CLI caller), else top level.
  const parent = [got.work, opts.requester].find((c) => c && isViableInboxParent(c, String(userId)));
  const { conversationId, shortId } = await spawnSessionCore(ctx, userId, {
    projectPath: got.facts.projectPath ?? undefined,
    gitRoot: got.work?.git_root ?? got.facts.projectPath ?? undefined,
    title: `Ship · ${plan.label}`.slice(0, 80),
    prompt: shipBrief(plan, got.facts),
    subagentFields: parent ? { parent_conversation_id: parent._id, is_subagent: true } : null,
    spawnerConversationId: opts.requester?._id,
    fleet: parent ? { device: null, caps: normalizeSubagentCaps(undefined) } : undefined,
  });
  await ctx.db.patch(conversationId, { ship_target_key: key });
  if (got.task) await addConversationToWorkItem(ctx, userId, "task", got.task, conversationId);
  const runId = await ctx.db.insert("ship_runs", {
    target_key: key, target_kind: target.kind, user_id: userId, plan, conversation_id: conversationId,
    ...(opts.clientKey ? { client_key: opts.clientKey } : {}), created_at: now,
  });
  return { run_id: String(runId), plan, conversation_id: String(conversationId), short_id: shortId, answered_card: false };
}

/**
 * The feeder of the store's shipTargets row for one target: the plan a press
 * would run now, and the latest run with what it has done. The id is the
 * target key, so the row the control reads never changes identity.
 */
export const forTarget = query({
  args: { target: shipTargetValidator },
  handler: async (ctx, { target }) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) return null;
    const got = await gatherShipFacts(ctx, userId, target);
    if ("error" in got) return null;
    const key = shipTargetKey(got.facts.target);
    const run = await latestRun(ctx, key);
    return {
      _id: key,
      target: got.facts.target,
      plan: resolveShipPlan(got.facts),
      pr_id: got.pr ? String(got.pr._id) : null,
      run,
      line: run?.workflow_run_id ? await lineStations(ctx, run.workflow_run_id) : null,
    };
  },
});

const cliTargetArgs = {
  api_token: v.string(),
  task: v.optional(v.string()),
  session: v.optional(v.string()),
  pull_request_id: v.optional(v.string()),
  requester_session: v.optional(v.string()),
};

async function cliTarget(ctx: Ctx, userId: Id<"users">, args: { task?: string; session?: string; pull_request_id?: string }): Promise<ShipTarget> {
  if (args.task) return { kind: "task", id: args.task };
  if (args.pull_request_id) return { kind: "pull_request", id: args.pull_request_id };
  if (args.session) {
    const c = await findConversationByAnyRef(ctx as any, args.session, userId);
    if (!c) throw new Error(`Session "${args.session}" not found among your sessions`);
    return { kind: "conversation", id: String(c._id) };
  }
  throw new Error("Name what to ship: --task, --pr or --session");
}

/** `cast ship run --dry-run`: the plan, without starting it. */
export const previewFromCli = mutation({
  args: cliTargetArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    const got = await gatherShipFacts(ctx, userId, await cliTarget(ctx, userId, args));
    if ("error" in got) throw new Error(got.error);
    return { plan: resolveShipPlan(got.facts) };
  },
});

/** `cast ship run`: the same action the web's Ship buttons dispatch. */
export const startFromCli = mutation({
  args: cliTargetArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    const requester = args.requester_session ? await findConversationByAnyRef(ctx as any, args.requester_session, userId) : null;
    return await startShipCore(ctx, userId, await cliTarget(ctx, userId, args), { requester });
  },
});
