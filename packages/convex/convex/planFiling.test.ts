// A plan's tasks live in the plan's project (lib/planFiling): a task created
// under a plan takes its project, refiling the plan carries its open tasks
// along, and the backfill fills in tasks created before either rule.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(30_000);
const api = anyApi as any;
const internal = anyApi as any;
const TOKEN = "f".repeat(64);
const T0 = 1_790_000_000_000;

async function setup() {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
  });
  const p1 = (await t.mutation(api.projects.create, { api_token: TOKEN, title: "Deals" })).id;
  const p2 = (await t.mutation(api.projects.create, { api_token: TOKEN, title: "Funnel" })).id;
  const p3 = (await t.mutation(api.projects.create, { api_token: TOKEN, title: "Elsewhere" })).id;
  const plan = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Close deals", project_id: p1 });
  const create = (title: string, extra: Record<string, any> = {}) =>
    t.mutation(api.tasks.create, { api_token: TOKEN, title, ...extra });
  const projectOf = (id: string) => t.run(async (ctx) => (await ctx.db.get(id as any) as any)?.project_id ?? null);
  return { t, p1, p2, p3, plan, create, projectOf };
}

test("a task created under a plan takes the plan's project; its own project wins", async () => {
  const { plan, p1, p3, create, projectOf } = await setup();
  const inherited = await create("Call Ana", { plan_id: plan.short_id });
  expect(await projectOf(inherited.id)).toBe(p1);
  const explicit = await create("Draft memo", { plan_id: plan.short_id, project_id: p3 });
  expect(await projectOf(explicit.id)).toBe(p3);
  const loose = await create("No plan");
  expect(await projectOf(loose.id)).toBeNull();
});

test("a task moved into a plan takes its project unless it has one", async () => {
  const { t, plan, p1, p3, create, projectOf } = await setup();
  const bare = await create("Bare");
  const filed = await create("Filed", { project_id: p3 });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: bare.short_id, plan_id: plan.short_id });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: filed.short_id, plan_id: plan.short_id });
  expect(await projectOf(bare.id)).toBe(p1);
  expect(await projectOf(filed.id)).toBe(p3);
});

test("a task moved to another plan follows it when it followed the old plan", async () => {
  const { t, plan, p1, p2, p3, create, projectOf } = await setup();
  const other = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Funnel work", project_id: p2 });
  const following = await create("Follows", { plan_id: plan.short_id });
  const own = await create("Own", { plan_id: plan.short_id, project_id: p3 });
  expect(await projectOf(following.id)).toBe(p1);
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: following.short_id, plan_id: other.short_id });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: own.short_id, plan_id: other.short_id });
  expect(await projectOf(following.id)).toBe(p2);
  expect(await projectOf(own.id)).toBe(p3);
});

test("refiling a plan moves its open tasks that followed it, and leaves the rest", async () => {
  const { t, plan, p2, p3, create, projectOf } = await setup();
  const following = await create("Follows", { plan_id: plan.short_id });
  const own = await create("Own project", { plan_id: plan.short_id, project_id: p3 });
  const closed = await create("Done", { plan_id: plan.short_id });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: closed.short_id, status: "done" });
  // A task from before inheritance: under the plan with no project.
  const legacy = await create("Legacy", { plan_id: plan.short_id });
  await t.run(async (ctx) => ctx.db.patch(legacy.id, { project_id: undefined } as any));

  const res = await t.mutation(api.plans.update, { api_token: TOKEN, short_id: plan.short_id, project_id: p2 });
  expect(res.filed).toEqual({ project_id: p2, project_title: "Funnel", tasks_moved: 2 });
  expect(await projectOf(plan.id)).toBe(p2);
  expect(await projectOf(following.id)).toBe(p2);
  expect(await projectOf(legacy.id)).toBe(p2);
  expect(await projectOf(own.id)).toBe(p3);
  expect(await projectOf(closed.id)).not.toBe(p2);
});

test("the backfill counts per workspace when dry and fills open plan tasks when real", async () => {
  const { t, plan, p1, p3, create, projectOf } = await setup();
  const a = await create("A", { plan_id: plan.short_id });
  const b = await create("B", { plan_id: plan.short_id });
  const own = await create("Own", { plan_id: plan.short_id, project_id: p3 });
  const closed = await create("Closed", { plan_id: plan.short_id });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: closed.short_id, status: "done" });
  await t.run(async (ctx) => {
    for (const id of [a.id, b.id, closed.id]) await ctx.db.patch(id, { project_id: undefined } as any);
  });

  const dry = await t.mutation(internal.planTaskProjectBackfill.run, {});
  expect(dry.dryRun).toBe(true);
  expect(dry.tasks).toBe(2);
  expect(Object.values(dry.by_workspace)).toEqual([{ plans: 1, tasks: 2 }]);
  expect(Object.keys(dry.by_workspace)[0]).toMatch(/^user:/);
  expect(await projectOf(a.id)).toBeNull();

  const real = await t.mutation(internal.planTaskProjectBackfill.run, { dryRun: false });
  expect(real.tasks).toBe(2);
  expect(await projectOf(a.id)).toBe(p1);
  expect(await projectOf(b.id)).toBe(p1);
  expect(await projectOf(own.id)).toBe(p3);
  expect(await projectOf(closed.id)).toBeNull();
  expect((await t.mutation(internal.planTaskProjectBackfill.run, {})).tasks).toBe(0);
});
