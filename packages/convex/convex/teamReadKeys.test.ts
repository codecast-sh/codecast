// Team read keys under convex-test: only a team admin mints, lists and
// revokes a key, only its hash is stored, and a team holds a capped number of
// live keys.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { MAX_LIVE_TEAM_READ_KEYS } from "./lib/teamReadKey";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = (name: string) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@acme.dev` } as any);
    const [ada, mo] = [await user("Ada"), await user("Mo")];
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: ada, team_id: team, role: "admin", visibility: "full", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: mo, team_id: team, role: "member", visibility: "summary", joined_at: 1 } as any);
    return { ada, mo, team };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

const mint = (as: any, team: Id<"teams">, name = "eng site") =>
  as.mutation(api.teamReadKeys.create, { team_id: team, name, expires_in_days: 90 });

describe("team read keys", () => {
  test("only a team admin mints, lists and revokes; the key is stored as a hash", async () => {
    const { t, ada, mo, team, as } = await setup();
    await expect(mint(as(mo), team)).rejects.toThrow();
    expect(await as(mo).query(api.teamReadKeys.list, { team_id: team })).toBeNull();
    const minted = await mint(as(ada), team);
    expect(minted.key).toMatch(/^cc_trk_[0-9a-f]{48}$/);
    const row = (await t.run((ctx) => ctx.db.get(minted.key_id)))!;
    expect(JSON.stringify(row)).not.toContain(minted.key);
    expect((await as(ada).query(api.teamReadKeys.list, { team_id: team }))!.map((k) => k.name)).toEqual(["eng site"]);
    await expect(as(mo).mutation(api.teamReadKeys.revoke, { key_id: minted.key_id })).rejects.toThrow();
  });

  test(`a team holds at most ${MAX_LIVE_TEAM_READ_KEYS} live keys; a revoked one frees a place`, async () => {
    const { ada, team, as } = await setup();
    const first = await mint(as(ada), team, "key 0");
    for (let i = 1; i < MAX_LIVE_TEAM_READ_KEYS; i++) await mint(as(ada), team, `key ${i}`);
    await expect(mint(as(ada), team, "one too many")).rejects.toThrow(/active read keys/);
    await as(ada).mutation(api.teamReadKeys.revoke, { key_id: first.key_id });
    await mint(as(ada), team, "replacement");
  });
});
