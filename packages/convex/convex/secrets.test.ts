// Vault: metadata reads never carry a value, a secret is readable only inside
// the workspaces the caller holds, a ciphertext is bound to its workspace, an
// agent's read is recorded against its session, and a request filled by a
// person wakes the asking session without the value in the message.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { decryptSecret, encryptSecret } from "./secrets";
import { parseVaultReady } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

const api = anyApi as any;
const KEY_ENV = "CONNECTION_SECRETS_KEY";
const ANA_TOKEN = "a".repeat(64);
const CAT_TOKEN = "c".repeat(64);
const STRIPE = "sk_test_51HsecretVALUEdoNotLeak9876";

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-deployment-key-0123456789abcdef";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "a" } as any);
    const beta = await ctx.db.insert("teams", { name: "Beta", created_at: now, invite_code: "b" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: acme, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: cat, team_id: beta, role: "member", joined_at: now } as any);
    for (const [u, tok] of [[ana, ANA_TOKEN], [cat, CAT_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: ana, team_id: acme, agent_type: "claude_code", session_id: "sess-ana-1", short_id: "jx7ana1", title: "Wire up billing",
      started_at: now, updated_at: now, message_count: 3, is_private: false, status: "active", project_path: "/repo",
    } as any);
    return { acme, beta, ana, ben, cat, conv };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ...ids, as };
}

const allText = async (t: any) => JSON.stringify(await t.run(async (ctx: any) => ({
  pending: await ctx.db.query("pending_messages").collect(),
  notifications: await ctx.db.query("notifications").collect(),
  events: await ctx.db.query("secret_events").collect(),
})));

test("list, show and events carry metadata and never a value or its ciphertext", async () => {
  const { as, ana, ben, acme } = await seed();
  const made = await as(ana).action(api.secrets.create, { name: "stripe-test", kind: "key", payload: { value: STRIPE }, env: ["STRIPE_SECRET_KEY"], team_id: acme });
  // Plain checks: bun's toMatchObject writes its matchers into the object it reads.
  expect(made.short_id).toMatch(/^sec-\d+$/);
  expect(made.name).toBe("stripe-test");

  const rows = await as(ben).query(api.secrets.list, {});
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: "stripe-test", kind: "key", status: "ready", fingerprint: "sk_t…9876", created_by_name: "Ana", env: ["STRIPE_SECRET_KEY"] });
  const shown = await as(ben).query(api.secrets.show, { ref: made.short_id });
  const evs = await as(ben).query(api.secrets.events, { ref: "stripe-test" });
  expect(evs.map((e: any) => e.kind)).toEqual(["created"]);
  for (const out of [rows, shown, evs]) {
    const s = JSON.stringify(out);
    expect(s).not.toContain("value_enc");
    expect(s).not.toContain(STRIPE);
    expect(s).not.toContain("v1.");
  }
});

test("writes name their workspace, and a duplicate name is refused with the rotate command", async () => {
  const { as, ana, acme } = await seed();
  expect(await as(ana).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "x" } })).toMatchObject({ error: expect.stringMatching(/--team .* --personal/) });
  await as(ana).action(api.secrets.create, { name: "dup", kind: "key", payload: { value: "x" }, team_id: acme });
  const again = await as(ana).action(api.secrets.create, { name: "dup", kind: "key", payload: { value: "y" }, team_id: acme });
  expect(again.error).toMatch(/already exists here \(sec-\d+\): replace its value with cast vault rotate dup/);
  expect(await as(ana).action(api.secrets.create, { name: "Bad Name", kind: "key", payload: { value: "x" }, personal: true })).toMatchObject({ error: expect.stringMatching(/lowercase/) });
});

test("another team's member cannot list, read, reveal, change or delete a team secret", async () => {
  const { t, as, ana, cat, acme, beta } = await seed();
  const made = await as(ana).action(api.secrets.create, { name: "stripe-test", kind: "key", payload: { value: STRIPE }, team_id: acme });
  expect(await as(cat).query(api.secrets.list, {})).toEqual([]);
  expect(await as(cat).query(api.secrets.show, { ref: made.short_id })).toMatchObject({ error: expect.stringMatching(/No secret/) });
  expect(await as(cat).action(api.secrets.reveal, { ref: made.short_id })).toMatchObject({ error: expect.any(String) });
  expect(await as(cat).action(api.secrets.reveal, { ref: made.id })).toMatchObject({ error: expect.any(String) });
  expect(await t.action(api.secrets.cliRead, { api_token: CAT_TOKEN, refs: ["stripe-test"], purpose: "get" })).toMatchObject({ error: expect.any(String) });
  expect(await as(cat).mutation(api.secrets.remove, { ref: made.short_id })).toMatchObject({ error: expect.any(String) });
  expect(await as(cat).action(api.secrets.rotate, { ref: made.short_id, payload: { value: "stolen" } })).toMatchObject({ error: expect.any(String) });
  // Writing into a team you are not in is refused outright.
  await expect(as(cat).action(api.secrets.create, { name: "x", kind: "key", payload: { value: "x" }, team_id: acme })).rejects.toThrow(/Forbidden/);
  // The redaction feed holds only what the caller can read.
  await as(cat).action(api.secrets.create, { name: "beta-key", kind: "key", payload: { value: "beta-value-123456" }, team_id: beta });
  const red = await t.action(api.secrets.redactionValues, { api_token: CAT_TOKEN });
  expect(red.values).toEqual([{ name: "beta-key", value: "beta-value-123456" }]);
});

test("a personal secret is its owner's alone", async () => {
  const { as, ana, ben } = await seed();
  const made = await as(ana).action(api.secrets.create, { name: "mine", kind: "login", payload: { username: "ana", password: "pw-ana-secret" }, personal: true });
  expect(await as(ben).query(api.secrets.list, {})).toEqual([]);
  expect(await as(ben).action(api.secrets.reveal, { ref: made.short_id })).toMatchObject({ error: expect.any(String) });
  expect(await as(ana).action(api.secrets.reveal, { ref: "mine" })).toEqual({ payload: { username: "ana", password: "pw-ana-secret" } });
});

test("a ciphertext moved to another workspace does not decrypt", async () => {
  const { t, as, ana, acme, beta } = await seed();
  const made = await as(ana).action(api.secrets.create, { name: "stripe-test", kind: "key", payload: { value: STRIPE }, team_id: acme });
  const enc = await encryptSecret({ value: STRIPE }, `team:${acme}`);
  expect(await decryptSecret(enc, `team:${acme}`)).toEqual({ value: STRIPE });
  expect(await decryptSecret(enc, `team:${beta}`)).toBeNull();
  // Re-keyed in place: the row now claims Ana's personal workspace, which she holds.
  await t.run(async (ctx: any) => ctx.db.patch(ctx.db.normalizeId("secrets", made.id), { workspace: `user:${ana}` }));
  const r = await as(ana).action(api.secrets.reveal, { ref: made.short_id });
  expect(r.error).toMatch(/no longer decrypts .* cast vault rotate stripe-test/);
  expect(JSON.stringify(r)).not.toContain(STRIPE);
});

test("cliRead records one read per secret naming the session, and bumps use", async () => {
  const { t, as, ana, acme, conv } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-test", kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).action(api.secrets.create, { name: "staging", kind: "login", payload: { username: "admin", password: "pw-staging-1" }, team_id: acme });
  const r = await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["stripe-test", "staging"], conversation: "jx7ana1", purpose: "run" });
  expect(r.secrets.map((s: any) => [s.name, s.payload])).toEqual([["stripe-test", { value: STRIPE }], ["staging", { username: "admin", password: "pw-staging-1" }]]);
  const { rows, reads } = await t.run(async (ctx: any) => ({
    rows: await ctx.db.query("secrets").collect(),
    reads: (await ctx.db.query("secret_events").collect()).filter((e: any) => e.kind === "read"),
  }));
  expect(reads).toHaveLength(2);
  for (const e of reads) expect(e).toMatchObject({ conversation_id: conv, purpose: "run", actor_user_id: ana });
  for (const row of rows) expect(row).toMatchObject({ use_count: 1, last_used_by_conversation: conv, last_used_at: expect.any(Number) });
  const evs = await as(ana).query(api.secrets.events, { ref: "stripe-test" });
  expect(evs[0]).toMatchObject({ kind: "read", session_short_id: "jx7ana1", session_title: "Wire up billing", actor_name: "Ana" });
  expect(await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["nope"], purpose: "get" })).toMatchObject({ error: expect.stringMatching(/cast vault request nope/) });
});

test("request then fulfill: the asking session gets a ready line with no value, and wakes", async () => {
  const { t, as, ana, ben, acme, conv } = await seed();
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "vercel-token", kind: "key", why: "deploy preview", env: ["VERCEL_TOKEN"], conversation: "sess-ana-1", team_id: acme });
  expect(asked.requested).toBe(true);
  expect(asked.short_id).toMatch(/^sec-\d+$/);
  // Asking again reuses the open request.
  const again = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "vercel-token", kind: "key", conversation: "sess-ana-1", team_id: acme });
  expect(again.short_id).toBe(asked.short_id);

  const rows = await as(ben).query(api.secrets.list, {});
  expect(rows[0]).toMatchObject({ status: "requested", requested_by_name: "Ana", requested_from_conversation: String(conv) });
  expect(await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["vercel-token"], purpose: "get" })).toMatchObject({ error: expect.stringMatching(/no value yet/) });
  const notes = await t.run(async (ctx: any) => ctx.db.query("notifications").collect());
  expect(notes.length).toBeGreaterThan(0);
  expect(notes[0]).toMatchObject({ recipient_user_id: ana, link: `/vault?s=${asked.short_id}` });

  const VALUE = "vercel_tok_ABCDEFGHIJKLMNOPQRST";
  const done = await as(ben).action(api.secrets.fulfill, { ref: asked.short_id, payload: { value: VALUE } });
  expect(done).toMatchObject({ delivered: true, name: "vercel-token" });
  expect(await as(ben).action(api.secrets.fulfill, { ref: asked.short_id, payload: { value: VALUE } })).toMatchObject({ error: expect.stringMatching(/rotate/) });

  const pending = await t.run(async (ctx: any) => ctx.db.query("pending_messages").collect());
  expect(pending).toHaveLength(1);
  expect(pending[0].conversation_id).toBe(conv);
  expect(parseVaultReady(pending[0].content)).toMatchObject({ id: asked.short_id, name: "vercel-token" });
  expect(pending[0].content).toContain("VERCEL_TOKEN");
  expect(await allText(t)).not.toContain(VALUE);
  const kinds = (await as(ana).query(api.secrets.events, { ref: "vercel-token" })).map((e: any) => e.kind);
  expect(kinds).toEqual(["fulfilled", "requested", "requested"]);
});

test("the redaction version moves on every value write and delete, and the events outlive the secret", async () => {
  const { t, as, ana, acme } = await seed();
  const v0 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  const made = await as(ana).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "value-one-12345" }, team_id: acme });
  const v1 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  await as(ana).action(api.secrets.rotate, { ref: "k", payload: { value: "value-two-12345" } });
  const v2 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  await as(ana).mutation(api.secrets.updateMeta, { ref: "k", note: "the staging key" });
  const v3 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  expect(new Set([v0, v1, v2]).size).toBe(3);
  expect(v3).toBe(v2);
  const red = await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN });
  expect(red).toEqual({ version: v2, values: [{ name: "k", value: "value-two-12345" }] });

  expect(await as(ana).mutation(api.secrets.remove, { ref: made.short_id })).toMatchObject({ removed: true });
  expect((await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version).not.toBe(v3);
  const evs = await t.run(async (ctx: any) => ctx.db.query("secret_events").collect());
  expect(evs.map((e: any) => [e.kind, e.secret_name])).toEqual([["created", "k"], ["rotated", "k"], ["updated", "k"], ["deleted", "k"]]);
});
