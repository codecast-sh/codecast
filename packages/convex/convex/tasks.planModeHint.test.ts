// A plan-mode TaskCreate carries the plan the daemon cached for its session.
// That cache outlives the plan, so a missing plan files the task without one
// rather than failing the transcript; a person's explicit plan stays strict.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

const api = anyApi as any;
const TOKEN = "h".repeat(64);
const T0 = 1_790_000_000_000;

async function setup() {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
  });
  const task = (title: string) => t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((r: any) => r.title === title) as any);
  return { t, task };
}

test("a plan-mode task whose cached plan is gone files without a plan", async () => {
  const { t, task } = await setup();
  await t.mutation(api.tasks.create, { api_token: TOKEN, title: "From TaskCreate", workspace: "personal", source: "plan_mode", plan_id: "pl-gone" });
  const row = await task("From TaskCreate");
  expect(row).toBeDefined();
  expect(row.plan_id).toBeUndefined();
});

test("an explicit plan that does not exist is still refused", async () => {
  const { t } = await setup();
  await expect(
    t.mutation(api.tasks.create, { api_token: TOKEN, title: "By hand", workspace: "personal", plan_id: "pl-gone" }),
  ).rejects.toThrow("Plan not found");
});
