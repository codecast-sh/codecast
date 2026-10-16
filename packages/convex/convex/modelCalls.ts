// The one place codecast makes a model call for a product's loop
// (docs/architecture/learning-loop.md LL1, LL8, LL10): a judge on a moment,
// grouping a finding, a graph's call node. One prompt, one answer, no tools,
// sent through lib/anthropic on the deployment's key. Each call reserves its
// worst case from the team's budget first and settles what it cost after, so
// thousands of judgments a day stay inside the cap a person set and never
// start a session.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext } from "./data";
import { requireTeamAdmin, requireTeamMembership } from "./lib/access";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { callModelMetered, estimatedUsage, modelCost } from "./lib/anthropic";
import { readBudget, setBudgetCap, settleBudget, takeBudget, worstCaseCost } from "./lib/teamBudget";
import { recordModelSpend } from "./lib/modelSpend";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { modelCallProblem, parseJsonBlock, type BudgetPurpose, type BudgetSummary, type ModelCallResult, type ModelCallSpec } from "@codecast/shared/contracts/modelCall";

const purposeValidator = v.union(v.literal("judge"), v.literal("grouping"), v.literal("call"));

export const reserve = internalMutation({
  args: { workspace: v.string(), team_id: v.optional(v.id("teams")), amount: v.number() },
  handler: async (ctx, args): Promise<boolean> => takeBudget(ctx, args.workspace, args.team_id, args.amount, Date.now()),
});

export const settle = internalMutation({
  args: { workspace: v.string(), purpose: purposeValidator, held: v.number(), cost: v.number(), project_ids: v.optional(v.array(v.id("projects"))) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await settleBudget(ctx, args.workspace, args.purpose, args.held, args.cost, now);
    await recordModelSpend(ctx, args.workspace, args.project_ids ?? [], args.purpose, args.cost, now);
  },
});

/** Where a call is charged: the workspace's budget, and the project (or projects) it served, which model_spend_hours splits it among. */
export type CallScope = { workspace: string; team_id?: Id<"teams">; project_id?: Id<"projects">; project_ids?: Id<"projects">[] };

const projectsOf = (scope: CallScope): Id<"projects">[] => scope.project_ids ?? (scope.project_id ? [scope.project_id] : []);

/**
 * Spends from the team's budget around one paid step (LL10): reserves `held`
 * first and answers `{ room: false }` without running `run` when the cap has
 * no room; otherwise runs it and settles whatever `run` charged, failed or
 * not. Every model call and embedding codecast pays for goes through here.
 * A settle that fails (every call contends for the one budget row, and a
 * burst of judging exhausts the conflict retries) goes to the scheduler,
 * which retries it until it lands: a hold left behind keeps the cap full
 * for the rest of the month (364 holds, $65 of a $400 cap, 2026-10-14).
 */
export async function withinBudget<T>(
  ctx: { runMutation: any; scheduler: any },
  scope: CallScope,
  purpose: BudgetPurpose,
  held: number,
  run: (charge: (usd: number) => void) => Promise<T>,
): Promise<{ room: false } | { room: true; value: T }> {
  const room: boolean = await ctx.runMutation(internal.modelCalls.reserve, { workspace: scope.workspace, team_id: scope.team_id, amount: held });
  if (!room) return { room: false };
  let cost = 0;
  try {
    return { room: true, value: await run((usd) => (cost = usd)) };
  } finally {
    const settle = { workspace: scope.workspace, purpose, held, cost, project_ids: projectsOf(scope) };
    try {
      await ctx.runMutation(internal.modelCalls.settle, settle);
    } catch {
      await ctx.scheduler.runAfter(0, internal.modelCalls.settle, settle);
    }
  }
}

/**
 * Runs one call inside the team's budget. Answers `budget` without sending
 * anything when the cap has no room; otherwise charges what the call cost,
 * failed or not (a call that reported no usage is charged its prompt).
 */
export async function runModelCall(ctx: { runMutation: any; scheduler: any }, scope: CallScope, purpose: BudgetPurpose, spec: ModelCallSpec, label: string, timeoutMs = 60_000): Promise<ModelCallResult> {
  const problem = modelCallProblem(spec);
  if (problem) return { ok: false, reason: "failed", error: problem, cost_usd: 0, model: spec.model };
  const held = worstCaseCost(spec.model, (spec.system?.length ?? 0) + spec.prompt.length, spec.max_tokens);
  const spent = await withinBudget(ctx, scope, purpose, held, async (charge): Promise<ModelCallResult> => {
    const { reply, usage, error } = await callModelMetered({ model: spec.model, system: spec.system, prompt: spec.prompt, max_tokens: spec.max_tokens, label, timeout_ms: timeoutMs });
    const cost = modelCost(spec.model, usage ?? estimatedUsage(spec.system, spec.prompt));
    charge(cost);
    if (!reply) return { ok: false, reason: "failed", error: error ?? "the model gave no answer", cost_usd: cost, model: spec.model };
    if (spec.output === "json") {
      const json = parseJsonBlock(reply.text);
      if (json === null) return { ok: false, reason: "failed", error: reply.stop_reason === "max_tokens" ? "the answer ran past max_tokens before its JSON closed" : "the answer held no JSON", cost_usd: cost, model: spec.model };
      return { ok: true, text: reply.text, json, usage: reply.usage, cost_usd: cost, model: spec.model, stop_reason: reply.stop_reason };
    }
    return { ok: true, text: reply.text, usage: reply.usage, cost_usd: cost, model: spec.model, stop_reason: reply.stop_reason };
  });
  if (!spent.room) return { ok: false, reason: "budget", error: "the team's model budget for this month has no room", cost_usd: 0, model: spec.model, worst_case_usd: held };
  return spent.value;
}

const scopeArgs = {
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
  project_path: v.optional(v.string()),
  conversation_id: v.optional(v.string()),
  project: v.optional(v.string()),
};

export const scopeFor = internalQuery({
  args: { api_token: v.string(), ...scopeArgs, run_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<CallScope> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path, conversation_id: args.conversation_id });
    const workspace = db.workspaceKey as string;
    return { workspace, ...(db.axes.team_id ? { team_id: db.axes.team_id } : {}), ...(await callProject(ctx, workspace, args.run_id, args.project)) };
  },
});

/** The project a CLI call served: its workflow run's problem's (a graph's call node), else the project it names (`--project`); none when neither is in the workspace. */
async function callProject(ctx: any, workspace: string, runId: string | undefined, ref: string | undefined): Promise<{ project_id?: Id<"projects"> }> {
  const id = runId ? ctx.db.normalizeId("workflow_runs", runId) : null;
  const run = id ? await ctx.db.get(id) : null;
  const task = run?.task_id ? await ctx.db.get(run.task_id) : null;
  const fromRun = task?.project_id ? await ctx.db.get(task.project_id) : null;
  if (fromRun?.workspace === workspace) return { project_id: fromRun._id };
  if (!ref?.trim()) return {};
  try {
    const project = await resolveWorkspaceProject(ctx, workspace, ref);
    return project ? { project_id: project._id } : {};
  } catch {
    return {};
  }
}

/**
 * A graph's call node (`cast workflow run`, LL1): one call on the caller's
 * workspace budget. `/cli/model/call`.
 */
export const callForCli = action({
  args: {
    api_token: v.string(),
    ...scopeArgs,
    model: v.string(),
    max_tokens: v.number(),
    system: v.optional(v.string()),
    prompt: v.string(),
    output: v.union(v.literal("json"), v.literal("text")),
    label: v.optional(v.string()),
    /** The workflow run a call node belongs to: its cost is charged to that run's project. */
    run_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ModelCallResult> => {
    const { api_token, workspace, team_id, project_path, conversation_id, project, run_id, label, ...spec } = args;
    const scope: CallScope = await ctx.runQuery(internal.modelCalls.scopeFor, { api_token, workspace, team_id, project_path, conversation_id, project, run_id });
    return await runModelCall(ctx, scope, "call", spec, label ? `Call node ${label.slice(0, 60)}` : "Call node");
  },
});

// ── Reading and setting the budget ──

async function teamScope(ctx: any, userId: Id<"users">, teamId: Id<"teams">, admin: boolean): Promise<string> {
  if (admin) await requireTeamAdmin(ctx, userId, teamId);
  else await requireTeamMembership(ctx, userId, teamId);
  return `team:${teamId}`;
}

/** A team's budget for its settings: any member reads it. Feeds the web store key `teamBudgets`. */
export const budgetForTeam = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<(BudgetSummary & { team_id: Id<"teams"> }) | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const membership = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", args.team_id)).first();
    if (!membership) return null;
    return { team_id: args.team_id, ...(await readBudget(ctx, `team:${args.team_id}`, Date.now())) };
  },
});

/** A team admin sets the monthly cap; 0 turns judging and grouping off. */
export const setTeamBudget = mutation({
  args: { team_id: v.id("teams"), cap_usd: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (!Number.isFinite(args.cap_usd) || args.cap_usd < 0 || args.cap_usd > 100_000) throw new Error("A monthly budget is from $0 to $100,000");
    const workspace = await teamScope(ctx, userId, args.team_id, true);
    await setBudgetCap(ctx, workspace, args.team_id, Math.round(args.cap_usd * 100) / 100, userId, Date.now());
    return await readBudget(ctx, workspace, Date.now());
  },
});

/** `cast line budget [--set <usd>]`: the caller's workspace budget, set by a team admin. */
export const budgetForCli = mutation({
  args: { api_token: v.string(), ...scopeArgs, set_usd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path, conversation_id: args.conversation_id });
    const workspace = db.workspaceKey;
    if (args.set_usd !== undefined) {
      if (!Number.isFinite(args.set_usd) || args.set_usd < 0 || args.set_usd > 100_000) throw new Error("A monthly budget is from $0 to $100,000");
      const parsed = parseWorkspaceKey(workspace);
      if (parsed?.type === "team") await requireTeamAdmin(ctx, auth.userId, parsed.teamId);
      await setBudgetCap(ctx, workspace, db.axes.team_id, Math.round(args.set_usd * 100) / 100, auth.userId, Date.now());
    }
    return await readBudget(ctx, workspace, Date.now());
  },
});

// ── Backfill ──

/**
 * One page of a workspace's judge runs in [from, to): what each cost and the
 * projects it graded, the per-call record model_spend_hours was filled from
 * before it existed.
 */
export const judgeSpendPage = internalQuery({
  args: { workspace: v.string(), from: v.number(), to: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("judge_runs").withIndex("by_workspace_at", (q: any) => q.eq("workspace", args.workspace).gte("at", args.from).lt("at", args.to)).take(args.limit);
    return {
      items: rows.filter((r: any) => (r.cost_usd ?? 0) > 0).map((r: any) => ({ at: r.at, usd: r.cost_usd, project_ids: [...new Set(r.expectations.map((e: any) => e.project_id))] as Id<"projects">[] })),
      next: rows.length === args.limit ? rows[rows.length - 1].at + 1 : null,
    };
  },
});

/** A project's call nodes in [from, to): each node's cost on the project's runs, at the time it finished. */
export const callNodeSpend = internalQuery({
  args: { project: v.id("projects"), from: v.number(), to: v.number() },
  handler: async (ctx, args) => {
    const items: Array<{ at: number; usd: number }> = [];
    for (const task of await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", args.project)).collect()) {
      for (const run of await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect()) {
        for (const n of (run as any).node_statuses ?? []) {
          const at = n.completed_at ?? n.started_at;
          if ((n.cost_usd ?? 0) > 0 && at >= args.from && at < args.to) items.push({ at, usd: n.cost_usd });
        }
      }
    }
    return items;
  },
});

export const recordSpendBatch = internalMutation({
  args: { workspace: v.string(), purpose: purposeValidator, items: v.array(v.object({ at: v.number(), usd: v.number(), project_ids: v.array(v.id("projects")) })) },
  handler: async (ctx, args) => {
    for (const i of args.items) await recordModelSpend(ctx, args.workspace, i.project_ids, args.purpose, i.usd, i.at);
    return args.items.length;
  },
});

/**
 * Fills model_spend_hours for one project over [from, to) from the per-call
 * records that predate it: judge runs and the project's call nodes. Grouping
 * kept no per-call record, so its spend before the ledger stays unknown.
 * Run once per project, with `to` the moment the ledger started.
 */
export const backfillProjectSpend = internalAction({
  args: { project: v.id("projects"), workspace: v.string(), from: v.number(), to: v.number() },
  handler: async (ctx, args): Promise<{ judge: number; call: number }> => {
    let judge = 0;
    for (let from: number | null = args.from; from !== null; ) {
      const page: { items: Array<{ at: number; usd: number; project_ids: Id<"projects">[] }>; next: number | null } = await ctx.runQuery(internal.modelCalls.judgeSpendPage, { workspace: args.workspace, from, to: args.to, limit: 400 });
      const mine = page.items.filter((i) => i.project_ids.includes(args.project));
      if (mine.length) judge += await ctx.runMutation(internal.modelCalls.recordSpendBatch, { workspace: args.workspace, purpose: "judge", items: mine });
      from = page.next;
    }
    const calls: Array<{ at: number; usd: number }> = await ctx.runQuery(internal.modelCalls.callNodeSpend, { project: args.project, from: args.from, to: args.to });
    for (let i = 0; i < calls.length; i += 200) await ctx.runMutation(internal.modelCalls.recordSpendBatch, { workspace: args.workspace, purpose: "call", items: calls.slice(i, i + 200).map((c) => ({ ...c, project_ids: [args.project] })) });
    return { judge, call: calls.length };
  },
});
