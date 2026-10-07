// tasks.update carries the ground node's fields (the-line-end-to-end.md LE5):
// `cast task update --goal-ref --category --risk --readiness --readiness-note`
// write through the one update path, and an empty string clears a field.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { update } from "./tasks";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "ground-token";

async function makeCtx(task: any) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner", github_username: "owner" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks: [task],
    task_history: [],
    entity_subscriptions: [],
  };
  const ctx = {
    auth: { async getUserIdentity() { return null; } },
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    async runMutation() { return null; },
  } as any;
  return { ctx, tables };
}

const run = (ctx: any, args: Record<string, unknown>) => (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", ...args });

describe("tasks.update ground fields", () => {
  test("writes all five", async () => {
    const { ctx, tables } = await makeCtx({ _id: "tasks_1", short_id: "ct-1", title: "t", user_id: OWNER, status: "open", source: "agent" });
    await run(ctx, { goal_ref: "in-3:week4_retention", category: "prompt", risk: "plan", readiness: "needs_context", readiness_note: "no repro yet" });
    expect(tables.tasks[0]).toMatchObject({ goal_ref: "in-3:week4_retention", category: "prompt", risk: "plan", readiness: "needs_context", readiness_note: "no repro yet" });
  });

  test("an empty string clears a field; an absent one is left alone", async () => {
    const { ctx, tables } = await makeCtx({ _id: "tasks_1", short_id: "ct-1", title: "t", user_id: OWNER, status: "open", source: "agent", goal_ref: "none", category: "code", risk: "low" });
    await run(ctx, { category: "", goal_ref: "pj-a" });
    expect(tables.tasks[0].category).toBeUndefined();
    expect(tables.tasks[0].goal_ref).toBe("pj-a");
    expect(tables.tasks[0].risk).toBe("low");
  });

  test("a cause's goal must be one its own goals brief offers: its project, not another's", async () => {
    const cause = { _id: "tasks_1", short_id: "ct-1", title: "t", user_id: OWNER, status: "open", source: "signal", workspace: "team:teams_u", team_id: "teams_u", project_id: "projects_me" };
    const { ctx, tables } = await makeCtx(cause);
    tables.projects = [
      { _id: "projects_me", short_id: "pj-me", title: "Matching Engine", workspace: "team:teams_u", team_id: "teams_u", status: "active", goal: "More intros" },
      { _id: "projects_aq", short_id: "pj-aq", title: "Agent Quality", workspace: "team:teams_u", team_id: "teams_u", status: "active", goal: "Zero clusters" },
    ];
    tables.initiatives = [];
    tables.initiative_projects = [];
    await expect(run(ctx, { goal_ref: "pj-aq" })).rejects.toThrow(/not one of ct-1's goals/);
    expect(tables.tasks[0].goal_ref).toBeUndefined();
    await run(ctx, { goal_ref: "pj-me" });
    expect(tables.tasks[0].goal_ref).toBe("pj-me");
    await run(ctx, { goal_ref: "none" });
    expect(tables.tasks[0].goal_ref).toBe("none");
  });
});
