// priorityRanks.mine: the viewer's own active priorities, ranked in every
// workspace they hold where the feature is on, and nobody else's.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";

setDefaultTimeout(60_000);

const NOW = Date.now();

test("ranks the viewer's active priorities in each held workspace with the feature on", async () => {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } } as any);
    const off = await ctx.db.insert("teams", { name: "Off", created_at: NOW } as any);
    const stranger = await ctx.db.insert("teams", { name: "Stranger", created_at: NOW, features: { priorities: true } } as any);
    for (const [u, team] of [[ada, acme], [bea, acme], [ada, off]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    }
    const insert = (user_id: any, workspace: string, short_id: string, fields: Record<string, unknown> = {}) => ctx.db.insert("priorities", {
      user_id, workspace, short_id, title: short_id, summary: "", status: "active", steps: [],
      first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, ...fields,
    } as any);
    return {
      ada,
      acme1: await insert(ada, `team:${acme}`, "a1", { ai_rank: 1 }),
      acme2: await insert(ada, `team:${acme}`, "a2", { ai_rank: 2 }),
      acmeDone: await insert(ada, `team:${acme}`, "a3", { status: "done" }),
      beas: await insert(bea, `team:${acme}`, "b1", { ai_rank: 1 }),
      personal1: await insert(ada, `user:${ada}`, "p1", { ai_rank: 2 }),
      personal2: await insert(ada, `user:${ada}`, "p2", { ai_rank: 1 }),
      dark: await insert(ada, `team:${off}`, "d1", { ai_rank: 1 }),
      notHeld: await insert(ada, `team:${stranger}`, "s1", { ai_rank: 1 }),
      acme: `team:${acme}`,
      personal: `user:${ada}`,
    };
  });

  const ranks = await t.withIdentity({ subject: `${ids.ada}|session` }).query((api as any).priorityRanks.mine, {});
  const byId = Object.fromEntries(ranks.map((r: any) => [r._id, r]));
  expect(byId[String(ids.acme1)]).toEqual({ _id: String(ids.acme1), workspace: ids.acme, rank: 1 });
  expect(byId[String(ids.acme2)]?.rank).toBe(2);
  expect(byId[String(ids.personal2)]).toEqual({ _id: String(ids.personal2), workspace: ids.personal, rank: 1 });
  expect(byId[String(ids.personal1)]?.rank).toBe(2);
  // Not active, not the viewer's, the feature off, a workspace not held.
  for (const id of [ids.acmeDone, ids.beas, ids.dark, ids.notHeld]) expect(byId[String(id)]).toBeUndefined();
  expect(ranks).toHaveLength(4);

  expect(await t.query((api as any).priorityRanks.mine, {})).toBeNull();
});
