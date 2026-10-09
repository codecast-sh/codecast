// The one place codecast makes a model call for a product's loop
// (docs/architecture/learning-loop.md LL1, LL8, LL10): a judge on a moment,
// grouping a finding, a graph's call node. One prompt, one answer, no tools,
// sent through lib/anthropic on the deployment's key. Each call reserves its
// worst case from the team's budget first and settles what it cost after, so
// thousands of judgments a day stay inside the cap a person set and never
// start a session.

import { v } from "convex/values";
import { action, internalMutation, internalQuery, query, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext } from "./data";
import { requireTeamAdmin, requireTeamMembership } from "./lib/access";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { callModelMetered, estimatedUsage, modelCost } from "./lib/anthropic";
import { readBudget, setBudgetCap, settleBudget, takeBudget, worstCaseCost } from "./lib/teamBudget";
import { modelCallProblem, parseJsonBlock, type BudgetPurpose, type BudgetSummary, type ModelCallResult, type ModelCallSpec } from "@codecast/shared/contracts/modelCall";

const purposeValidator = v.union(v.literal("judge"), v.literal("grouping"), v.literal("call"));

export const reserve = internalMutation({
  args: { workspace: v.string(), team_id: v.optional(v.id("teams")), amount: v.number() },
  handler: async (ctx, args): Promise<boolean> => takeBudget(ctx, args.workspace, args.team_id, args.amount, Date.now()),
});

export const settle = internalMutation({
  args: { workspace: v.string(), purpose: purposeValidator, held: v.number(), cost: v.number() },
  handler: async (ctx, args) => settleBudget(ctx, args.workspace, args.purpose, args.held, args.cost, Date.now()),
});

export type CallScope = { workspace: string; team_id?: Id<"teams"> };

/**
 * Runs one call inside the team's budget. Answers `budget` without sending
 * anything when the cap has no room; otherwise charges what the call cost,
 * failed or not (a call that reported no usage is charged its prompt).
 */
export async function runModelCall(ctx: { runMutation: any }, scope: CallScope, purpose: BudgetPurpose, spec: ModelCallSpec, label: string, timeoutMs = 60_000): Promise<ModelCallResult> {
  const problem = modelCallProblem(spec);
  if (problem) return { ok: false, reason: "failed", error: problem, cost_usd: 0, model: spec.model };
  const held = worstCaseCost(spec.model, (spec.system?.length ?? 0) + spec.prompt.length, spec.max_tokens);
  const room: boolean = await ctx.runMutation(internal.modelCalls.reserve, { workspace: scope.workspace, team_id: scope.team_id, amount: held });
  if (!room) return { ok: false, reason: "budget", error: "the team's model budget for this month has no room", cost_usd: 0, model: spec.model };
  let cost = 0;
  try {
    const { reply, usage } = await callModelMetered({ model: spec.model, system: spec.system, prompt: spec.prompt, max_tokens: spec.max_tokens, label, timeout_ms: timeoutMs });
    cost = modelCost(spec.model, usage ?? estimatedUsage(spec.system, spec.prompt));
    if (!reply) return { ok: false, reason: "failed", error: "the model gave no answer", cost_usd: cost, model: spec.model };
    if (spec.output === "json") {
      const json = parseJsonBlock(reply.text);
      if (json === null) return { ok: false, reason: "failed", error: reply.stop_reason === "max_tokens" ? "the answer ran past max_tokens before its JSON closed" : "the answer held no JSON", cost_usd: cost, model: spec.model };
      return { ok: true, text: reply.text, json, usage: reply.usage, cost_usd: cost, model: spec.model, stop_reason: reply.stop_reason };
    }
    return { ok: true, text: reply.text, usage: reply.usage, cost_usd: cost, model: spec.model, stop_reason: reply.stop_reason };
  } finally {
    await ctx.runMutation(internal.modelCalls.settle, { workspace: scope.workspace, purpose, held, cost });
  }
}

const scopeArgs = {
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
  project_path: v.optional(v.string()),
  conversation_id: v.optional(v.string()),
};

export const scopeFor = internalQuery({
  args: { api_token: v.string(), ...scopeArgs },
  handler: async (ctx, args): Promise<CallScope> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path, conversation_id: args.conversation_id });
    return { workspace: db.workspaceKey, ...(db.axes.team_id ? { team_id: db.axes.team_id } : {}) };
  },
});

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
  },
  handler: async (ctx, args): Promise<ModelCallResult> => {
    const { api_token, workspace, team_id, project_path, conversation_id, label, ...spec } = args;
    const scope: CallScope = await ctx.runQuery(internal.modelCalls.scopeFor, { api_token, workspace, team_id, project_path, conversation_id });
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
