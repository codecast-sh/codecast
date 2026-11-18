// The shared log's entry kinds (`cast plan comment --type fact|fail|interface`)
// are plan entries like any other: a fact is stored as the existing
// "discovery", and fail and interface are accepted by the schema.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(30_000);
const api = anyApi as any;
const TOKEN = "l".repeat(64);
const T0 = 1_790_000_000_000;

test("fact, fail and interface comments land on the plan, a fact as a discovery", async () => {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const me = await ctx.db.insert("users", { name: "Me" } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
  });
  const plan = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Shared log" });
  const comment = (type: string, content: string) =>
    t.mutation(api.plans.addComment, { api_token: TOKEN, short_id: plan.short_id, type, content });
  await comment("fact", "the cache keys on host");
  await comment("fail", "a global lock deadlocks the pusher");
  await comment("interface", "plans.messaging_policy: lead | shared-log");

  const entries = await t.run(async (ctx) => (await ctx.db.get(plan.id as any) as any).entries);
  expect(entries.map((e: any) => [e.type, e.content])).toEqual([
    ["discovery", "the cache keys on host"],
    ["fail", "a global lock deadlocks the pusher"],
    ["interface", "plans.messaging_policy: lead | shared-log"],
  ]);
});
