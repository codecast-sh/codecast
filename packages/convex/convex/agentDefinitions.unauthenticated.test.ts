import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

// The web's DashboardLayout feeds agentDefinitions.list and listChains with {}
// before auth settles (or after it lapses). A list feed with no caller answers
// an empty list, like the other workspace feeds, instead of throwing a server
// error (ct-74851). A token still has to resolve, and writes and name lookups
// still reject.

setDefaultTimeout(120_000);

const STEPS = [{ agent: "reviewer", prompt: "review it" }];

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const me = await ctx.db.insert("users", { name: "Me", email: "me@a.dev" } as any);
    const stranger = await ctx.db.insert("users", { name: "Them", email: "them@b.dev" } as any);
    const mine = await ctx.db.insert("teams", { name: "Mine", created_at: now, invite_code: "m" });
    const theirs = await ctx.db.insert("teams", { name: "Theirs", created_at: now, invite_code: "t" });
    await ctx.db.insert("team_memberships", { user_id: me, team_id: mine, role: "member", joined_at: now });
    await ctx.db.insert("team_memberships", { user_id: stranger, team_id: theirs, role: "member", joined_at: now });
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken("me_clisecret"), name: "mac", created_at: 1, last_used_at: 1, device_id: "dev-1" });
    return { me, stranger, mine, theirs };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  const chain = (user: Id<"users">, name: string, team_id?: Id<"teams">) =>
    as(user).mutation(api.agentDefinitions.upsertChain, { name, description: name, steps: STEPS, team_id });
  await chain(ids.me, "my-personal");
  await chain(ids.me, "my-team", ids.mine);
  await chain(ids.stranger, "their-personal");
  await chain(ids.stranger, "their-team", ids.theirs);
  return { t, ...ids };
}

describe("agentDefinitions list feeds without a caller", () => {
  test("listChains and list return [] instead of throwing", async () => {
    const { t } = await setup();
    expect(await t.query(api.agentDefinitions.listChains, {})).toEqual([]);
    expect(await t.query(api.agentDefinitions.list, {})).toEqual([]);
  });
});

describe("agentDefinitions list feeds with a token", () => {
  test("a token that does not resolve still fails authentication", async () => {
    const { t } = await setup();
    await expect(t.query(api.agentDefinitions.listChains, { api_token: "bogus" })).rejects.toThrow(/Authentication failed/);
    await expect(t.query(api.agentDefinitions.list, { api_token: "bogus" })).rejects.toThrow(/Authentication failed/);
  });

  test("a valid token gets exactly the chains in its own workspaces", async () => {
    const { t } = await setup();
    const rows = await t.query(api.agentDefinitions.listChains, { api_token: presentToken("me_clisecret", "dev-1") });
    expect(rows.map((r: any) => r.name)).toEqual(["my-personal", "my-team"]);
  });
});

describe("writes and name lookups without a caller", () => {
  const calls: Array<[string, (t: any) => Promise<unknown>]> = [
    ["upsertChain", (t) => t.mutation(api.agentDefinitions.upsertChain, { name: "x", description: "x", steps: STEPS })],
    ["removeChain", (t) => t.mutation(api.agentDefinitions.removeChain, { name: "my-personal" })],
    ["upsert", (t) => t.mutation(api.agentDefinitions.upsert, { name: "x", description: "x" })],
    ["remove", (t) => t.mutation(api.agentDefinitions.remove, { name: "x" })],
    ["resolveChain", (t) => t.query(api.agentDefinitions.resolveChain, { name: "my-personal" })],
    // resolveDefinition is exposed as the `resolve` query.
    ["resolve", (t) => t.query(api.agentDefinitions.resolve, { name: "reviewer" })],
    ["getChain", (t) => t.query(api.agentDefinitions.getChain, { name: "my-personal" })],
  ];
  for (const [name, call] of calls) {
    test(`${name} rejects an unauthenticated caller`, async () => {
      const { t } = await setup();
      await expect(call(t)).rejects.toThrow(/Authentication failed/);
    });
  }
});
