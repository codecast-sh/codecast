// The task page's cost: a task's linked sessions, their children and its
// workflow runs, each session counted once, priced by the same helper the line
// prices runs with (lib/sessionCost). Runs the real query under convex-test.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { turnCost } from "./lib/usageDaily";

setDefaultTimeout(120_000);

const MODEL = "claude-opus-4-8";
const usage = (n: number) => ({ input: n, output: n, cache_read: n, cache_write: n, updated_at: 1 });
const listPrice = (n: number) => turnCost(MODEL, { input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n });

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@x.dev" } as any);
    const mate = await ctx.db.insert("users", { name: "Mo", email: "mo@x.dev" } as any);
    const outsider = await ctx.db.insert("users", { name: "Oz", email: "oz@y.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 } as any);
    const conv = (fields: Record<string, unknown>) =>
      ctx.db.insert("conversations", { user_id: owner, team_id: team, session_id: crypto.randomUUID(), started_at: 1, updated_at: 1, message_count: 1, status: "active", agent_type: "claude_code", model: MODEL, ...fields } as any);
    const lead = await conv({ usage_totals: usage(1000) });
    const keyed = await conv({ agent_type: "opencode", usage_totals: usage(200) });
    const codex = await conv({ agent_type: "codex", model: "gpt-5" });
    const unpriced = await conv({ agent_type: "grok", model: "grok-unknown-9", usage_totals: usage(50) });
    const subagent = await conv({ parent_conversation_id: lead, usage_totals: usage(100) });
    // A daemon fork syncs the lead's history as its own: only the 300 beyond the lead are its.
    const fork = await conv({ parent_conversation_id: lead, forked_from: lead, usage_totals: usage(1300) });
    const primary = await conv({ is_workflow_primary: true });
    const station = await conv({ parent_conversation_id: primary, usage_totals: usage(400) });
    const project = await ctx.db.insert("projects", { title: "Main", user_id: owner, team_id: team, workspace: `team:${team}`, status: "active", created_at: 1, updated_at: 1 } as any);
    const secret = await ctx.db.insert("projects", { title: "Private", user_id: owner, team_id: team, workspace: `user:${owner}`, status: "active", created_at: 1, updated_at: 1 } as any);
    const task = (short_id: string, project_id: Id<"projects">, conversation_ids: Id<"conversations">[]) =>
      ctx.db.insert("tasks", { short_id, user_id: owner, team_id: team, workspace: `team:${team}`, project_id, title: short_id, status: "in_progress", task_type: "task", priority: "medium", created_at: 1, updated_at: 1, conversation_ids } as any);
    // The lead is linked twice and is also a run's station: it counts once.
    const t1 = await task("ct-1", project, [lead, lead, keyed, codex, unpriced]);
    await task("ct-2", secret, [lead]);
    await task("ct-3", project, [codex]);
    const leadRow = await ctx.db.get(lead);
    await ctx.db.insert("workflow_runs", {
      user_id: owner, task_id: t1, status: "completed", primary_conversation_id: primary, created_at: 1,
      node_statuses: [{ node_id: "build", status: "completed", session_id: leadRow!.session_id }, { node_id: "judge", status: "completed", cost_usd: 0.5 }],
    } as any);
    return { owner, mate, outsider, team };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

describe("taskCost.cost", () => {
  test("counts linked sessions, their children and the runs' stations once each; a fork counts only its own turns", async () => {
    const { as, owner, team } = await setup();
    const c = await as(owner).query(api.taskCost.cost, { workspace: "team", team_id: team, task: "ct-1" });
    // lead, keyed, unpriced, subagent, fork, station. Codex reports no tokens.
    expect(c!.sessions).toBe(6);
    expect(c!.uncounted).toBe(1);
    expect(c!.runs).toBe(1);
    expect(c!.tokens).toBe(4 * (1000 + 200 + 50 + 100 + 300 + 400));
    expect(c!.unpriced_tokens).toBe(4 * 50);
    expect(c!.providers.sort()).toEqual(["claude", "codex"]);
    const round = (n: number) => Math.round(n * 100) / 100;
    expect(c!.list_usd).toBe(round(listPrice(1000) + listPrice(200) + listPrice(100) + listPrice(300) + listPrice(400)));
    // Billed: the opencode session's key and the run's call node.
    expect(c!.billed_usd).toBe(round(listPrice(200) + 0.5));
    expect(c!.subscription_usd).toBe(round(listPrice(1000) + listPrice(100) + listPrice(300) + listPrice(400)));
  });

  test("a task whose sessions report no tokens has zero counted sessions", async () => {
    const { as, owner, team } = await setup();
    const c = await as(owner).query(api.taskCost.cost, { workspace: "team", team_id: team, task: "ct-3" });
    expect(c).toMatchObject({ sessions: 0, uncounted: 1, tokens: 0, list_usd: 0 });
  });

  test("denies a reader outside the task's workspace, or one who cannot see its project", async () => {
    const { as, owner, mate, outsider, team } = await setup();
    expect(await as(outsider).query(api.taskCost.cost, { workspace: "personal", task: "ct-1" })).toBeNull();
    // The owner asking from their personal workspace does not match the task's team key.
    expect(await as(owner).query(api.taskCost.cost, { workspace: "personal", task: "ct-1" })).toBeNull();
    expect(await as(mate).query(api.taskCost.cost, { workspace: "team", team_id: team, task: "ct-1" })).not.toBeNull();
    expect(await as(mate).query(api.taskCost.cost, { workspace: "team", team_id: team, task: "ct-2" })).toBeNull();
    expect(await as(owner).query(api.taskCost.cost, { workspace: "team", team_id: team, task: "ct-2" })).not.toBeNull();
  });
});
