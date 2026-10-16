// A team's shared mod with a local half: the half runs on the author's machines
// and serves every member of the team. A member's call lands in the author's
// queue and its answer reaches the member alone; a member reads what the half
// published; someone outside the team does neither.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

setDefaultTimeout(60_000);

const api = anyApi as any;
const TOKEN = "d".repeat(64);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./modLocal.ts": () => import("./modLocal"),
  "./modCalls.ts": () => import("./modCalls"),
};

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed(shared: boolean) {
  const t = convexTest(schema, modules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Union", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const mod = await ctx.db.insert("mods", {
      user_id: ana, team_id: team, shared, name: "union", manifest: {}, code: "", local_code: "x", local_hash: "h",
      rev: 1, version: 0, enabled: true, created_at: now, updated_at: now,
    } as any);
    return { team, ana, ben, cat, mod };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ...ids, as };
}

test("a member's call runs on the author's machine and only the member reads the answer", async () => {
  const { t, mod, ben, ana, as } = await seed(true);
  const id = await as(ben).mutation(api.modCalls.webCall, { mod_id: mod, method: "refs", args: { refs: [] } });
  const row = await t.run(async (ctx: any) => ctx.db.get(id));
  expect(String(row.user_id)).toBe(String(ana));
  expect(String(row.caller_id)).toBe(String(ben));

  // The author's daemon is woken by the waiting call, and the wake clears once it is claimed.
  expect(await t.query(api.modLocal.cliPendingCall, { api_token: TOKEN })).toBe(String(id));
  const { calls } = await t.mutation(api.modLocal.cliClaimCalls, { api_token: TOKEN, names: ["union"], device_name: "host" });
  expect(await t.query(api.modLocal.cliPendingCall, { api_token: TOKEN })).toBeNull();
  expect(calls.map((c: any) => c.method)).toEqual(["refs"]);
  await t.mutation(api.modLocal.cliFinishCall, { api_token: TOKEN, id, result: { ok: 1 } });

  expect(await as(ben).query(api.modCalls.webGetCall, { id })).toMatchObject({ status: "done", result: { ok: 1 } });
  expect(await as(ana).query(api.modCalls.webGetCall, { id })).toBeNull();
});

test("a member reads what the shared half published; an outsider and an unshared mod give nothing", async () => {
  const { t, team, ben, cat, as } = await seed(true);
  await t.mutation(api.modLocal.cliPublish, { api_token: TOKEN, name: "union", key: "contact:1", value: { title: "Javier" } });
  const seen = await as(ben).query(api.modLocal.webState, { team_id: team });
  expect(seen.map((r: any) => r.key)).toEqual(["contact:1"]);
  expect(await as(cat).query(api.modLocal.webState, { team_id: team })).toEqual([]);

  const solo = await seed(false);
  await solo.t.mutation(api.modLocal.cliPublish, { api_token: TOKEN, name: "union", key: "contact:1", value: {} });
  expect(await solo.as(solo.ben).query(api.modLocal.webState, { team_id: solo.team })).toEqual([]);
  await expect(solo.as(solo.ben).mutation(api.modCalls.webCall, { mod_id: solo.mod, method: "refs" })).rejects.toThrow(/your own mods/);
});

test("someone outside the team cannot call into a shared mod", async () => {
  const { mod, cat, as } = await seed(true);
  await expect(as(cat).mutation(api.modCalls.webCall, { mod_id: mod, method: "refs" })).rejects.toThrow(/your own mods/);
});
