// `cast task create|update --predict` through the real mutations (ct-96177):
// a prediction lands on the task, one on a shipped task is refused unless the
// same call reopens it, and a repeat "done" keeps the close the reading
// counts its ship from.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
const TOKEN = "p".repeat(64);
const T0 = 1_790_000_000_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
  "./tasks.ts": () => import("./tasks"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
  "./sessionDecisions.ts": () => import("./sessionDecisions"),
  "./issueSync.ts": () => import("./issueSync"),
};

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const workspace = `user:${owner}`;
    await ctx.db.insert("initiatives", { user_id: owner, workspace, short_id: "in-9", title: "Cost per match", status: "active", project_ids: [], health: "none", created_at: T0, updated_at: T0, metrics: [{ key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14" }] } as any);
    const base = { user_id: owner, workspace, task_type: "task", priority: "medium", source: "human", created_at: T0, updated_at: T0 };
    await ctx.db.insert("tasks", { ...base, short_id: "ct-1", title: "Open work", status: "open" } as any);
    await ctx.db.insert("tasks", { ...base, short_id: "ct-2", title: "Shipped work", status: "done", closed_at: T0 } as any);
  });
  const task = (short_id: string) => t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((r: any) => r.short_id === short_id) as any);
  return { t, task };
}

const LINE = "in-9:intros_a_week +5% in 21d :: replay env +6 on L2";

test("update sets a prediction on open work, and an empty one clears it", async () => {
  const { t, task } = await setup();
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", predict: LINE });
  expect((await task("ct-1")).predicted).toMatchObject({ goal_ref: "in-9:intros_a_week", direction: "up", size: 5, relative: true, read_days: 21, series: "mw-14", basis: "replay env +6 on L2" });
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", predict: "" });
  expect((await task("ct-1")).predicted).toBeUndefined();
});

test("a prediction on shipped work is refused, unless the same call reopens it", async () => {
  const { t, task } = await setup();
  await expect(t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-2", predict: LINE })).rejects.toThrow("a prediction is stated before ship");
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-2", status: "open", predict: LINE });
  expect(await task("ct-2")).toMatchObject({ status: "open", predicted: { goal_ref: "in-9:intros_a_week" } });
});

test("a repeat done keeps the close it had, so a reading's ship does not move", async () => {
  const { t, task } = await setup();
  await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-2", status: "done" });
  expect((await task("ct-2")).closed_at).toBe(T0);
});

test("create takes a goal ref and a prediction", async () => {
  const { t } = await setup();
  await t.mutation(api.tasks.create, { api_token: TOKEN, title: "New work", workspace: "personal", goal_ref: "in-9:intros_a_week", predict: LINE });
  const row = (await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((r: any) => r.title === "New work"))) as any;
  expect(row).toMatchObject({ goal_ref: "in-9:intros_a_week", predicted: { goal_ref: "in-9:intros_a_week", read_days: 21 } });
});
