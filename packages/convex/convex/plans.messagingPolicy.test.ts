// A plan names its messaging policy (lib/messagingPolicyValidator): absent is
// `lead`, create and update set it, and the plan read hands it to the CLI.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(30_000);
const api = anyApi as any;
const TOKEN = "e".repeat(64);
const T0 = 1_790_000_000_000;

async function setup() {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
  });
  const get = (short_id: string) => t.query(api.plans.get, { api_token: TOKEN, short_id });
  return { t, get };
}

test("a plan that never chose has no policy, which reads as lead", async () => {
  const { t, get } = await setup();
  const plan = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Plain" });
  expect((await get(plan.short_id)).messaging_policy).toBeUndefined();
});

test("create sets the policy and the plan read returns it", async () => {
  const { t, get } = await setup();
  const plan = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Logged", messaging_policy: "shared-log" });
  expect((await get(plan.short_id)).messaging_policy).toBe("shared-log");
});

test("update switches the policy and leaves it when not named", async () => {
  const { t, get } = await setup();
  const plan = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Switch" });
  await t.mutation(api.plans.update, { api_token: TOKEN, short_id: plan.short_id, messaging_policy: "shared-log" });
  expect((await get(plan.short_id)).messaging_policy).toBe("shared-log");
  await t.mutation(api.plans.update, { api_token: TOKEN, short_id: plan.short_id, title: "Renamed" });
  expect((await get(plan.short_id)).messaging_policy).toBe("shared-log");
  await t.mutation(api.plans.update, { api_token: TOKEN, short_id: plan.short_id, messaging_policy: "lead" });
  expect((await get(plan.short_id)).messaging_policy).toBe("lead");
});

test("an unknown policy is refused", async () => {
  const { t } = await setup();
  await expect(t.mutation(api.plans.create, { api_token: TOKEN, title: "Bad", messaging_policy: "gossip" })).rejects.toThrow();
});
