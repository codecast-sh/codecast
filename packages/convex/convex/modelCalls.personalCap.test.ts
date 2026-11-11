// A personal workspace's model budget spends codecast's key with no payment
// behind it, so its owner may set it only up to PERSONAL_BUDGET_CEILING_USD.
// A cap already stored above that keeps working, staff are not held to it,
// and teams stay under their admin's rule.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { PERSONAL_BUDGET_CEILING_USD } from "./modelCalls";

const TOKEN = "p".repeat(64);

async function setup(user: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Ana", ...user } as any);
    await ctx.db.insert("api_tokens", { user_id: userId, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    const team = await ctx.db.insert("teams", { name: "Product", created_at: 1, invite_code: "x" } as any);
    await ctx.db.insert("team_memberships", { user_id: userId, team_id: team, role: "admin", joined_at: 1 } as any);
    return { userId, team };
  });
  const personal = (set_usd?: number) => t.mutation(api.modelCalls.budgetForCli, { api_token: TOKEN, workspace: "personal" as const, ...(set_usd !== undefined ? { set_usd } : {}) });
  return { t, ids, personal };
}

test("a personal workspace sets its budget up to the ceiling and no higher", async () => {
  const { personal } = await setup();
  expect(await personal(5)).toMatchObject({ cap_usd: 5 });
  expect(await personal(PERSONAL_BUDGET_CEILING_USD)).toMatchObject({ cap_usd: PERSONAL_BUDGET_CEILING_USD });
  await expect(personal(100_000)).rejects.toThrow("A personal monthly budget is at most $250");
  expect(await personal()).toMatchObject({ cap_usd: PERSONAL_BUDGET_CEILING_USD });
});

test("a personal cap stored above the ceiling keeps working and can be set again or lowered", async () => {
  const { t, ids, personal } = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insert("team_budgets", { workspace: `user:${ids.userId}`, cap_usd: 2_000, month: "2026-11", spent_usd: 0, held_usd: 0, by_purpose: { judge: 0, grouping: 0, call: 0 }, refused: 0, history: [], updated_at: 1 } as any);
  });
  expect(await personal()).toMatchObject({ cap_usd: 2_000 });
  expect(await personal(2_000)).toMatchObject({ cap_usd: 2_000 });
  await expect(personal(2_001)).rejects.toThrow("at most $2,000");
  expect(await personal(1_500)).toMatchObject({ cap_usd: 1_500 });
});

test("staff are not held to the personal ceiling", async () => {
  const { personal } = await setup({ staff: true });
  expect(await personal(5_000)).toMatchObject({ cap_usd: 5_000 });
});

test("a team admin still sets the team's budget past the personal ceiling", async () => {
  const { t, ids } = await setup();
  const r = await t.mutation(api.modelCalls.budgetForCli, { api_token: TOKEN, workspace: "team" as const, team_id: ids.team, set_usd: 5_000 });
  expect(r).toMatchObject({ cap_usd: 5_000 });
});
