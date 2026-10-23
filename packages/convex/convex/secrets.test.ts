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
import { SECRET_APPROVAL_TTL_MS, SECRET_PAYLOAD_MAX, validatePayload } from "@codecast/shared/contracts/secrets";
import { formatVaultDeclined, parseVaultReady } from "@codecast/shared/contracts";
import { isHumanOnlyCategory } from "./lib/decisionCategory";

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

test("asking again keeps the open request's kind: left out it stays, a different one is refused", async () => {
  const { t, as, ben, acme } = await seed();
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "github-bot", kind: "login", sites: ["github.com"], conversation: "sess-ana-1", team_id: acme });
  await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "github-bot", env: ["GITHUB_TOKEN"], team_id: acme });
  expect(await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "github-bot", kind: "key", team_id: acme }))
    .toMatchObject({ error: expect.stringMatching(/already requested as a login.*--kind login/) });
  expect(await as(ben).query(api.secrets.show, { ref: asked.short_id })).toMatchObject({ kind: "login", sites: ["github.com"], env: ["GITHUB_TOKEN"] });
  // Left out on a new name, it is a key.
  const fresh = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "npm-token", team_id: acme });
  expect(await as(ben).query(api.secrets.show, { ref: fresh.short_id })).toMatchObject({ kind: "key" });
});

test("declining a request tells the asking session no and wakes it; deleting a ready secret wakes nobody", async () => {
  const { t, as, ben, acme, conv } = await seed();
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "prod-db", kind: "key", why: "migrate", conversation: "sess-ana-1", team_id: acme });
  expect(await as(ben).mutation(api.secrets.remove, { ref: asked.short_id })).toMatchObject({ removed: true });
  const pending = await t.run(async (ctx: any) => ctx.db.query("pending_messages").collect());
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ conversation_id: conv, content: formatVaultDeclined("prod-db") });

  const made = await as(ben).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "value-one-12345" }, team_id: acme });
  await as(ben).mutation(api.secrets.remove, { ref: made.short_id });
  expect(await t.run(async (ctx: any) => ctx.db.query("pending_messages").collect())).toHaveLength(1);
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
  // The rotated-away value stays in the feed while it is restorable.
  expect(red).toEqual({ version: v2, values: [{ name: "k", value: "value-two-12345" }, { name: "k", value: "value-one-12345" }] });

  // A rename moves the version: the markers daemons write carry the name.
  await as(ana).mutation(api.secrets.updateMeta, { ref: "k", name: "k2" });
  const v4 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  expect(v4).not.toBe(v3);
  expect((await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN })).values[0]).toEqual({ name: "k2", value: "value-two-12345" });

  expect(await as(ana).mutation(api.secrets.remove, { ref: made.short_id })).toMatchObject({ removed: true });
  expect((await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version).not.toBe(v4);
  const evs = (await t.run(async (ctx: any) => ctx.db.query("secret_events").collect())).filter((e: any) => e.secret_id);
  expect(evs.map((e: any) => [e.kind, e.secret_name])).toEqual([["created", "k"], ["rotated", "k"], ["updated", "k"], ["updated", "k2"], ["deleted", "k2"]]);
});

const SEED = "JBSWY3DPEHPK3PXP";
const read = (t: any, refs: string[], extra: Record<string, unknown> = {}) =>
  t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs, conversation: "jx7ana1", purpose: "run", ...extra });
/** A person answers on the web, signed in: the only way an Ask first decision settles. */
const answer = async (t: any, as: (u: string) => any, user: string, decision: string, index: number) => {
  const row = await t.run(async (ctx: any) => (await ctx.db.query("session_decisions").collect()).find((d: any) => d.short_id === decision));
  return as(user).mutation(api.sessionDecisions.resolve, { decision_id: row._id, status: "answered", answer_index: index });
};

test("Ask first: an agent's read files one decision for the session, Approve lets that session read, Deny asks again", async () => {
  const { t, as, ana, ben, acme, conv } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  expect(await as(ben).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true })).toMatchObject({ ask_first: true });
  expect((await as(ana).query(api.secrets.show, { ref: "stripe-live" })).ask_first).toBe(true);

  const held = await read(t, ["stripe-live"], { why: "refund order 123" });
  expect(held.secrets).toBeUndefined();
  expect(held.needs_approval.secret).toBe("stripe-live");
  expect(held.needs_approval.decision).toMatch(/^sd-\d+$/);
  expect(held.message).toContain(`dormant naming ${held.needs_approval.decision}`);
  expect(JSON.stringify(held)).not.toContain(STRIPE);
  const decision = await t.run(async (ctx: any) => ctx.db.query("session_decisions").first());
  expect(decision.question).toBe("Wire up billing asks to use stripe-live");
  expect(decision.context_md).toStartWith("Why: refund order 123\n\n");
  expect(decision.options.map((o: any) => o.label)).toEqual(["Approve for this session", "Deny"]);
  expect(decision.conversation_id).toBe(conv);
  // Proposed as access; a keyword may pin another protected category. Either way only a person holds it.
  expect(isHumanOnlyCategory(decision.category)).toBe(true);

  // A repeat while it is open reuses the decision; no read is recorded and no value leaves.
  expect((await read(t, ["stripe-live"])).needs_approval.decision).toBe(held.needs_approval.decision);
  expect(await t.run(async (ctx: any) => (await ctx.db.query("session_decisions").collect()).length)).toBe(1);
  // A repeat without a why keeps the asked one; a newer why rewrites the open decision's context.
  expect((await t.run(async (ctx: any) => ctx.db.query("session_decisions").first())).context_md).toStartWith("Why: refund order 123\n\n");
  expect((await read(t, ["stripe-live"], { why: "refund order 456 too" })).needs_approval.decision).toBe(held.needs_approval.decision);
  const rewritten = await t.run(async (ctx: any) => ctx.db.query("session_decisions").collect());
  expect(rewritten.length).toBe(1);
  expect(rewritten[0].context_md).toStartWith("Why: refund order 456 too\n\n");
  expect(rewritten[0].question).toBe("Wire up billing asks to use stripe-live");
  // No session to approve: refused, never silently read.
  expect(await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["stripe-live"], purpose: "get" })).toMatchObject({ error: expect.stringMatching(/Ask first/) });
  // A person's reveal on the web is not gated.
  expect(await as(ana).action(api.secrets.reveal, { ref: "stripe-live" })).toEqual({ payload: { value: STRIPE } });

  await answer(t, as, ana, held.needs_approval.decision, 0);
  const approval = await t.run(async (ctx: any) => ctx.db.query("secret_approvals").first());
  expect(approval).toMatchObject({ status: "approved", approved_by: ana, conversation_id: conv });
  const ok = await read(t, ["stripe-live"]);
  expect(ok.secrets[0].payload).toEqual({ value: STRIPE });
  const kinds = (await as(ana).query(api.secrets.events, { ref: "stripe-live" })).map((e: any) => e.kind);
  expect(kinds.slice(0, 4)).toEqual(["read", "approved", "revealed", "approval_requested"]);
  expect(kinds).toContain("ask_first_on");
  expect((await as(ana).query(api.secrets.events, { ref: "stripe-live" })).find((e: any) => e.kind === "approved").decision_short_id).toBe(held.needs_approval.decision);

  // Deny on another secret records it, and the next read asks again.
  await as(ana).action(api.secrets.create, { name: "prod-db", kind: "key", payload: { value: "postgres://prod-secret-value" }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "prod-db", ask_first: true });
  const first = await read(t, ["stripe-live", "prod-db"]);
  expect(first.approvals).toEqual([{ decision: expect.stringMatching(/^sd-/), secret: "prod-db" }]);
  await answer(t, as, ana, first.needs_approval.decision, 1);
  const again = await read(t, ["prod-db"]);
  expect(again.needs_approval.decision).not.toBe(first.needs_approval.decision);
  expect((await as(ana).query(api.secrets.events, { ref: "prod-db" })).map((e: any) => e.kind).slice(0, 3)).toEqual(["approval_requested", "denied", "approval_requested"]);
  expect(await allText(t)).not.toContain("postgres://prod-secret-value");
});

test("only the asking session's owner approves an Ask first read; a teammate viewing the session is refused and the approval stays pending", async () => {
  const { t, as, ana, ben, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const held = await read(t, ["stripe-live"]);
  const decisionId = await t.run(async (ctx: any) => (await ctx.db.query("session_decisions").first())._id);
  // Ben can view Ana's team-shared session, so he can see the card, but not answer it.
  await expect(answer(t, as, ben, held.needs_approval.decision, 0)).rejects.toThrow(/Only the person whose session asked/);
  // The settle hook holds too, for a path that reaches it without the refusal.
  await t.run(async (ctx: any) => {
    const { settleSecretApproval } = await import("./lib/secretApprovals");
    const row = await ctx.db.get(decisionId);
    await settleSecretApproval(ctx, row, { status: "answered", answer_index: 0 }, { kind: "user", user_id: ben, signed_in: true }, Date.now());
  });
  expect(await t.run(async (ctx: any) => (await ctx.db.query("secret_approvals").first()).status)).toBe("pending");
  expect((await read(t, ["stripe-live"])).secrets).toBeUndefined();

  await answer(t, as, ana, held.needs_approval.decision, 0);
  expect((await read(t, ["stripe-live"])).secrets[0].payload).toEqual({ value: STRIPE });
});

test("two partial login rotates at once keep both edits, and two fills at once fill once", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "db", kind: "login", payload: { username: "admin", password: "first-pass-123" }, team_id: acme });
  // Both read the same stored login; the later write merges again instead of dropping the other's field.
  const [a, b] = await Promise.all([
    as(ana).action(api.secrets.rotate, { ref: "db", payload: { username: "root" } }),
    as(ana).action(api.secrets.rotate, { ref: "db", payload: { password: "second-pass-456" } }),
  ]);
  expect(a.error ?? b.error).toBeUndefined();
  expect((await as(ana).action(api.secrets.reveal, { ref: "db" })).payload).toEqual({ username: "root", password: "second-pass-456" });

  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "late-key", kind: "key", conversation: "jx7ana1", team_id: acme });
  const fills = await Promise.all([
    as(ana).action(api.secrets.fulfill, { ref: asked.short_id, payload: { value: "fill-one-1234567890" } }),
    as(ana).action(api.secrets.fulfill, { ref: asked.short_id, payload: { value: "fill-two-1234567890" } }),
  ]);
  expect(fills.filter((f: any) => f.error)).toHaveLength(1);
  expect(fills.find((f: any) => f.error).error).toMatch(/already has a value/);
  const kinds = (await as(ana).query(api.secrets.events, { ref: "late-key" })).map((e: any) => e.kind);
  expect(kinds.filter((k: string) => k === "fulfilled")).toHaveLength(1);
  expect((await as(ana).query(api.secrets.show, { ref: "late-key" })).version_count ?? 0).toBe(0);
});

test("Save sign-in from my Chrome queues one command for an online laptop of the person's, carrying only site, name and workspace", async () => {
  const { t, as, ana, cat, acme, beta } = await seed();
  const now = Date.now();
  await t.run(async (ctx: any) => {
    await ctx.db.insert("devices", { user_id: ana, device_id: "ana-laptop", label: "Ana's Mac", platform: "darwin", last_seen: now } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "ana-old", label: "Old Mac", platform: "darwin", last_seen: now - 3_600_000 } as any);
    await ctx.db.insert("devices", { user_id: cat, device_id: "cat-laptop", label: "Cat's Mac", platform: "darwin", last_seen: now } as any);
  });
  const capture = (over: Record<string, unknown>) =>
    as(ana).mutation(api.secrets.requestSigninCapture, { site: "github.com", device_id: "ana-laptop", ...(over.personal ? {} : { team_id: acme }), ...over });

  await expect(capture({ team_id: beta })).rejects.toThrow();
  expect(await capture({ site: "not a site" })).toMatchObject({ error: expect.any(String) });
  expect(await capture({ site: "co.uk" })).toMatchObject({ error: expect.any(String) });
  expect(await capture({ name: "Bad Name!" })).toMatchObject({ error: expect.any(String) });
  for (const device_id of ["ana-old", "cat-laptop", "nowhere"]) {
    expect(await capture({ device_id })).toMatchObject({ error: expect.stringMatching(/not online/) });
  }
  expect(await t.run(async (ctx: any) => (await ctx.db.query("daemon_commands").collect()).length)).toBe(0);

  expect(await capture({ name: "gh-ana" })).toMatchObject({ device_id: "ana-laptop", label: "Ana's Mac" });
  expect(await capture({ personal: true, check: true })).toMatchObject({ device_id: "ana-laptop" });
  const commands = await t.run(async (ctx: any) => ctx.db.query("daemon_commands").collect());
  expect(commands.map((c: any) => [c.command, c.target_device_id, c.user_id, JSON.parse(c.args)])).toEqual([
    ["vault_capture_signin", "ana-laptop", ana, { site: "github.com", name: "gh-ana", team_id: acme }],
    ["vault_check_signin", "ana-laptop", ana, { site: "github.com", personal: true }],
  ]);
});

test("rotate keeps the previous value as a version, restore swaps it back, refresh keeps none, and the cron purges expired ones", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "value-one-1234567890" }, team_id: acme });
  await as(ana).action(api.secrets.rotate, { ref: "k", payload: { value: "value-two-1234567890" } });
  await as(ana).action(api.secrets.rotate, { ref: "k", payload: { value: "value-three-12345678" } });
  const vers = await as(ana).query(api.secrets.versions, { ref: "k" });
  expect(vers).toHaveLength(2);
  expect(vers[0]).toMatchObject({ rotated_by_name: "Ana", fingerprint: "valu…7890" });
  expect(vers[0].expires_at - vers[0].rotated_at).toBe(7 * 24 * 60 * 60 * 1000);
  expect(JSON.stringify(vers)).not.toMatch(/value-|v1\./);
  expect((await as(ana).query(api.secrets.show, { ref: "k" })).version_count).toBe(2);

  const v0 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  expect(await as(ana).action(api.secrets.restore, { ref: "k" })).toMatchObject({ name: "k", restored_from: vers[0].rotated_at });
  expect(await as(ana).action(api.secrets.reveal, { ref: "k" })).toEqual({ payload: { value: "value-two-1234567890" } });
  expect((await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version).not.toBe(v0);
  // The value it replaced is now the newest version, so a wrong restore is undone the same way.
  const after = await as(ana).query(api.secrets.versions, { ref: "k" });
  expect(after).toHaveLength(2);
  expect(after[0].fingerprint).toBe("valu…5678");
  expect((await as(ana).query(api.secrets.events, { ref: "k" })).map((e: any) => e.kind).slice(0, 2)).toEqual(["revealed", "restored"]);
  expect(await as(ana).action(api.secrets.restore, { ref: "k", version: "nope" })).toMatchObject({ error: expect.stringMatching(/gone/) });

  const cookie = { name: "sid", value: "cookie-1", domain: "app.example.com", path: "/", secure: true, httpOnly: true };
  const signin = await as(ana).action(api.secrets.create, { name: "app-signin", kind: "signin", payload: { cookies: [cookie], captured_from: "chrome" }, sites: ["app.example.com"], team_id: acme });
  await as(ana).action(api.secrets.refresh, { ref: "app-signin", payload: { cookies: [{ ...cookie, value: "cookie-2" }], captured_from: "agent-browser" }, expected_updated_at: signin.value_updated_at });
  expect((await as(ana).action(api.secrets.reveal, { ref: "app-signin" })).payload.cookies[0].value).toBe("cookie-2");
  expect(await as(ana).query(api.secrets.versions, { ref: "app-signin" })).toEqual([]);

  await t.run(async (ctx: any) => {
    for (const r of await ctx.db.query("secret_versions").collect()) await ctx.db.patch(r._id, { expires_at: Date.now() - 1 });
  });
  expect(await t.mutation((anyApi as any).secrets.purgeExpiredVersions, {})).toEqual({ purged: 2 });
  expect(await as(ana).query(api.secrets.versions, { ref: "k" })).toEqual([]);
  expect((await as(ana).query(api.secrets.show, { ref: "k" })).version_count).toBe(0);
  expect(await as(ana).action(api.secrets.restore, { ref: "k" })).toMatchObject({ error: expect.stringMatching(/no earlier value/) });
});

test("a login's has_otp is stored at write time, and a rotate keeps the fields it leaves out and clears an empty one", async () => {
  const { as, ana, ben, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "staging", kind: "login", payload: { username: "admin", password: "pw-1", totp_seed: SEED }, team_id: acme });
  expect(await as(ana).query(api.secrets.show, { ref: "staging" })).toMatchObject({ has_otp: true, updated_by_name: "Ana" });
  await as(ben).action(api.secrets.rotate, { ref: "staging", payload: { password: "pw-2" } });
  expect(await as(ana).action(api.secrets.reveal, { ref: "staging" })).toEqual({ payload: { username: "admin", password: "pw-2", totp_seed: SEED } });
  expect(await as(ana).query(api.secrets.show, { ref: "staging" })).toMatchObject({ has_otp: true, updated_by_name: "Ben", version_count: 1 });
  await as(ana).action(api.secrets.rotate, { ref: "staging", payload: { totp_seed: "" } });
  expect(await as(ana).action(api.secrets.reveal, { ref: "staging" })).toEqual({ payload: { username: "admin", password: "pw-2" } });
  expect((await as(ana).query(api.secrets.show, { ref: "staging" })).has_otp).toBe(false);
});

test("events are found by short id after delete, inside the viewer's workspaces only", async () => {
  const { as, ana, cat, acme } = await seed();
  const made = await as(ana).action(api.secrets.create, { name: "gone", kind: "key", payload: { value: "x-value-123" }, team_id: acme });
  await as(ana).mutation(api.secrets.remove, { ref: "gone" });
  const evs = await as(ana).query(api.secrets.events, { ref: made.short_id });
  expect(evs.map((e: any) => e.kind)).toEqual(["deleted", "created"]);
  expect(await as(cat).query(api.secrets.events, { ref: made.short_id })).toMatchObject({ error: expect.any(String) });
  expect(await as(ana).query(api.secrets.events, { ref: "gone" })).toMatchObject({ error: expect.any(String) });
});

test("a redaction fetch records one redaction_sync per workspace and nothing per secret", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "a", kind: "key", payload: { value: "value-a-123456" }, team_id: acme });
  await as(ana).action(api.secrets.create, { name: "b", kind: "login", payload: { username: "u", password: "value-b-123456" }, team_id: acme });
  await as(ana).action(api.secrets.create, { name: "c", kind: "key", payload: { value: "value-c-123456" }, personal: true });
  await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN });
  const evs = await t.run(async (ctx: any) => ctx.db.query("secret_events").collect());
  const syncs = evs.filter((e: any) => e.kind === "redaction_sync");
  expect(syncs.map((e: any) => [e.workspace, e.count, e.secret_id]).sort()).toEqual([[`team:${acme}`, 2, undefined], [`user:${ana}`, 1, undefined]].sort());
  expect(evs.filter((e: any) => e.kind !== "created" && e.kind !== "redaction_sync")).toEqual([]);
});

test("refresh refuses a stale write-back with a distinct answer", async () => {
  const { t, as, ana, acme } = await seed();
  const cookie = { name: "sid", value: "cookie-1", domain: "app.example.com", path: "/", secure: true, httpOnly: true };
  await as(ana).action(api.secrets.create, { name: "app", kind: "signin", payload: { cookies: [cookie], captured_from: "chrome" }, sites: ["app.example.com"], team_id: acme });
  const got = await read(t, ["app"], { purpose: "signin" });
  const seen = got.secrets[0].value_updated_at;
  expect(seen).toEqual(expect.any(Number));
  const ok = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-2" }], captured_from: "agent-browser" }, expected_updated_at: seen });
  expect(ok.error).toBeUndefined();
  expect(ok.stale).toBeUndefined();
  // A second machine still holding the first read is refused, and nothing is written.
  const stale = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-3" }], captured_from: "agent-browser" }, expected_updated_at: seen });
  expect(stale).toMatchObject({ stale: true, value_updated_at: ok.value_updated_at, message: expect.stringMatching(/read it again/) });
  expect((await as(ana).action(api.secrets.reveal, { ref: "app" })).payload.cookies[0].value).toBe("cookie-2");
});

test("Ask first is a person's control: a token cannot turn it off or answer its decision, from a session or a plain shell", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  // Turning it on is safe from anywhere, a token included.
  expect(await t.mutation(api.secrets.setAskFirst, { api_token: ANA_TOKEN, ref: "stripe-live", ask_first: true })).toMatchObject({ ask_first: true });
  const off = await t.mutation(api.secrets.setAskFirst, { api_token: ANA_TOKEN, ref: "stripe-live", ask_first: false });
  expect(off.error).toMatch(/Only a person turns Ask first off/);
  expect((await as(ana).query(api.secrets.show, { ref: "stripe-live" })).ask_first).toBe(true);

  const held = await read(t, ["stripe-live"]);
  const decision = held.needs_approval.decision;
  // The agent answering its own question: no session named, as a plain shell; or as its human with --for-human.
  const plain = await t.mutation(api.sessionDecisions.answer, { api_token: ANA_TOKEN, decision_id: decision, answer_index: 0 });
  expect(plain.error).toMatch(/Ask first decision is a person's/);
  const forHuman = await t.mutation(api.sessionDecisions.answer, { api_token: ANA_TOKEN, decision_id: decision, session_id: "sess-ana-2", for_human: true, answer_index: 0 });
  expect(forHuman.error).toBeDefined();
  expect(await t.run(async (ctx: any) => (await ctx.db.query("secret_approvals").first()).status)).toBe("pending");
  expect((await read(t, ["stripe-live"])).secrets).toBeUndefined();

  // The person, signed in, approves and turns it off.
  await answer(t, as, ana, decision, 0);
  expect((await read(t, ["stripe-live"])).secrets[0].payload).toEqual({ value: STRIPE });
  expect(await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false })).toMatchObject({ ask_first: false });
});

test("the redaction feed holds an Ask first value only once a person approved one of the user's sessions, and names each copy", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "plain", kind: "key", payload: { value: "plain-value-123456" }, team_id: acme });
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const before = await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN });
  expect(before.values).toEqual([{ name: "plain", value: "plain-value-123456" }]);
  expect(JSON.stringify(before)).not.toContain(STRIPE);

  const held = await read(t, ["stripe-live"]);
  const v0 = (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
  await answer(t, as, ana, held.needs_approval.decision, 0);
  // The approval moves the version, so the daemon refetches and now holds it.
  expect((await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version).not.toBe(v0);
  const after = await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN });
  expect(after.values).toContainEqual({ name: "stripe-live", value: STRIPE });
  const syncs = (await t.run(async (ctx: any) => ctx.db.query("secret_events").collect())).filter((e: any) => e.kind === "redaction_sync" && e.secret_id);
  expect(syncs.map((e: any) => e.secret_name)).toEqual(["stripe-live"]);
});

test("a metadata edit does not make a sign-in's write-back stale; a new value does", async () => {
  const { t, as, ana, ben, acme } = await seed();
  const cookie = { name: "sid", value: "cookie-1", domain: "app.example.com", path: "/", secure: true, httpOnly: true };
  const made = await as(ana).action(api.secrets.create, { name: "app", kind: "signin", payload: { cookies: [cookie], captured_from: "chrome" }, sites: ["app.example.com"], team_id: acme });
  const seen = (await read(t, ["app"], { purpose: "signin" })).secrets[0].value_updated_at;
  expect(seen).toBe(made.value_updated_at);
  await as(ben).mutation(api.secrets.updateMeta, { ref: "app", note: "the staging dashboard" });
  await as(ben).mutation(api.secrets.setAskFirst, { ref: "app", ask_first: true });
  await as(ben).mutation(api.secrets.setAskFirst, { ref: "app", ask_first: false });
  const ok = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-2" }], captured_from: "agent-browser" }, expected_updated_at: seen });
  expect(ok.stale).toBeUndefined();
  expect(ok.value_updated_at).toBeGreaterThanOrEqual(seen);
  await as(ben).action(api.secrets.rotate, { ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-3" }], captured_from: "chrome" } });
  const stale = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-4" }], captured_from: "agent-browser" }, expected_updated_at: ok.value_updated_at });
  expect(stale).toMatchObject({ stale: true, message: expect.stringMatching(/read it again/) });
  // A row from before value_updated_at: a note edit pins its version first.
  await t.run(async (ctx: any) => ctx.db.patch(ctx.db.normalizeId("secrets", made.id), { value_updated_at: undefined, updated_at: 42 }));
  await as(ben).mutation(api.secrets.updateMeta, { ref: "app", note: "again" });
  expect(await t.run(async (ctx: any) => (await ctx.db.get(ctx.db.normalizeId("secrets", made.id))).value_updated_at)).toBe(42);
});

test("every session that asked for a secret is woken when it is filled; a later ask without a session keeps them", async () => {
  const { t, as, ana, ben, acme, conv } = await seed();
  const conv2 = await t.run(async (ctx: any) => ctx.db.insert("conversations", {
    user_id: ana, team_id: acme, agent_type: "claude_code", session_id: "sess-ana-2", short_id: "jx7ana2", title: "Refunds",
    started_at: Date.now(), updated_at: Date.now(), message_count: 1, is_private: false, status: "active", project_path: "/repo",
  } as any));
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "stripe-test", kind: "key", why: "billing", env: ["STRIPE_SECRET_KEY"], conversation: "sess-ana-1", team_id: acme });
  await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "stripe-test", kind: "key", conversation: "sess-ana-2", team_id: acme });
  await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "stripe-test", kind: "key", team_id: acme });
  const row = await as(ben).query(api.secrets.show, { ref: asked.short_id });
  expect(row).toMatchObject({ requested_from_conversation: String(conv), request_why: "billing", env: ["STRIPE_SECRET_KEY"] });
  expect(await as(ben).action(api.secrets.fulfill, { ref: "stripe-test", payload: { value: STRIPE } })).toMatchObject({ delivered: true });
  const pending = await t.run(async (ctx: any) => ctx.db.query("pending_messages").collect());
  expect(pending.map((p: any) => p.conversation_id).sort()).toEqual([conv, conv2].sort());
  for (const p of pending) expect(p.content).not.toContain(STRIPE);
});

test("a name in a team and in personal is never silently the personal one: writes refuse it, reads take the repo's workspace, a fill takes the request", async () => {
  const { t, as, ana, acme } = await seed();
  const mine = await as(ana).action(api.secrets.create, { name: "dup", kind: "key", payload: { value: "personal-value-1234" }, personal: true });
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "dup", kind: "key", team_id: acme });
  // The fill means the request, even with a ready personal row of that name; `cast vault fill` shows it first the same way.
  expect(await as(ana).query(api.secrets.show, { ref: "dup", status: "requested" })).toMatchObject({ short_id: asked.short_id });
  expect(await as(ana).action(api.secrets.fulfill, { ref: "dup", payload: { value: "team-value-123456" } })).toMatchObject({ short_id: asked.short_id });
  for (const write of [
    as(ana).action(api.secrets.rotate, { ref: "dup", payload: { value: "x-value-123456" } }),
    as(ana).mutation(api.secrets.remove, { ref: "dup" }),
    as(ana).mutation(api.secrets.setAskFirst, { ref: "dup", ask_first: true }),
    as(ana).mutation(api.secrets.updateMeta, { ref: "dup", note: "n" }),
  ]) expect((await write).error).toMatch(new RegExp(`dup is in 2 workspaces \\(.*${mine.short_id} personal.*${asked.short_id} team`));
  expect((await read(t, ["dup"])).error).toMatch(/2 workspaces/);
  expect((await read(t, ["dup"], { prefer: `team:${acme}` })).secrets[0].payload).toEqual({ value: "team-value-123456" });
  expect((await read(t, [mine.short_id])).secrets[0].payload).toEqual({ value: "personal-value-1234" });
});

test("names shaped like ids, and env vars that load code, are refused; a legacy id-shaped name is still found by name", async () => {
  const { t, as, ana, acme } = await seed();
  expect((await as(ana).action(api.secrets.create, { name: "sec-5", kind: "key", payload: { value: "x-value-123" }, personal: true })).error).toMatch(/reads as a secret's id/);
  expect((await as(ana).action(api.secrets.create, { name: "team-file", kind: "file", payload: { content: "echo hi" }, env: ["BASH_ENV"], team_id: acme })).error).toMatch(/BASH_ENV/);
  expect((await as(ana).action(api.secrets.create, { name: "path", kind: "key", payload: { value: "/tmp/evil" }, team_id: acme })).error).toMatch(/PATH/);
  expect((await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "ld", kind: "key", env: ["LD_PRELOAD"], team_id: acme })).error).toMatch(/LD_PRELOAD/);
  await as(ana).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "k-value-123456" }, team_id: acme });
  expect((await as(ana).mutation(api.secrets.updateMeta, { ref: "k", env: ["NODE_OPTIONS"] })).error).toMatch(/NODE_OPTIONS/);
  expect((await as(ana).mutation(api.secrets.updateMeta, { ref: "k", name: "path" })).error).toMatch(/PATH/);

  // A row named sec-77 stored before the rule (no secret has that short id): found by its name.
  await t.run(async (ctx: any) => {
    const now = Date.now();
    await ctx.db.insert("secrets", { workspace: `team:${acme}`, team_id: acme, short_id: "sec-900", name: "sec-77", kind: "key", status: "requested", created_by: ana, created_at: now, updated_at: now });
  });
  expect(await as(ana).query(api.secrets.show, { ref: "sec-77" })).toMatchObject({ short_id: "sec-900", name: "sec-77" });
});

const version = async (t: any) => (await t.query(api.secrets.redactionVersion, { api_token: ANA_TOKEN })).version;
const decisionStatus = (t: any, shortId: string) =>
  t.run(async (ctx: any) => (await ctx.db.query("session_decisions").collect()).find((d: any) => d.short_id === shortId).status);

test("an Ask first approval ends with a new value, after its TTL, and with its session", async () => {
  const { t, as, ana, acme, conv } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const approve = async () => {
    const held = await read(t, ["stripe-live"]);
    expect(held.needs_approval).toBeDefined();
    await answer(t, as, ana, held.needs_approval.decision, 0);
    expect((await read(t, ["stripe-live"])).secrets).toHaveLength(1);
  };
  const decision = async () => t.run(async (ctx: any) => (await ctx.db.query("session_decisions").collect()).at(-1));
  await approve();
  expect((await decision()).context_md).toMatch(/12 hours at most/);

  // A rotate is a value the person never approved: the session asks again.
  await as(ana).action(api.secrets.rotate, { ref: "stripe-live", payload: { value: "sk_live_rotatedVALUE1234567890" } });
  expect((await read(t, ["stripe-live"])).needs_approval).toBeDefined();
  await answer(t, as, ana, (await decision()).short_id, 0);
  // A restore likewise.
  await as(ana).action(api.secrets.restore, { ref: "stripe-live" });
  expect((await read(t, ["stripe-live"])).needs_approval).toBeDefined();
  await answer(t, as, ana, (await decision()).short_id, 0);
  expect((await read(t, ["stripe-live"])).secrets[0].payload).toEqual({ value: STRIPE });

  // Past its TTL the approval lends nothing, to the read or to the redaction feed.
  await t.run(async (ctx: any) => {
    for (const a of await ctx.db.query("secret_approvals").collect()) await ctx.db.patch(a._id, { at: Date.now() - SECRET_APPROVAL_TTL_MS - 1 });
  });
  expect(JSON.stringify(await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN }))).not.toContain(STRIPE);
  expect((await read(t, ["stripe-live"])).needs_approval).toBeDefined();
  await answer(t, as, ana, (await decision()).short_id, 0);

  // An ended session's id is visible to the user's other sessions: it reads nothing.
  await t.run(async (ctx: any) => ctx.db.patch(conv, { status: "completed" }));
  expect((await read(t, ["stripe-live"])).error).toMatch(/your own live agent session/);
  expect(JSON.stringify(await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN }))).not.toContain(STRIPE);
});

test("switching Ask first clears its approvals, withdraws an open decision and moves the redaction version; remove withdraws too", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const open = (await read(t, ["stripe-live"])).needs_approval.decision;

  const v0 = await version(t);
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false });
  // The daemon refetches at once, and the value is redacted from now on.
  expect(await version(t)).not.toBe(v0);
  expect((await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN })).values).toContainEqual({ name: "stripe-live", value: STRIPE });
  expect(await decisionStatus(t, open)).toBe("withdrawn");
  expect(await t.run(async (ctx: any) => (await ctx.db.query("secret_approvals").collect()).length)).toBe(0);
  expect((await read(t, ["stripe-live"])).secrets[0].payload).toEqual({ value: STRIPE });

  // Approved, then switched off and on again: the old approval does not carry over.
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const v1 = await version(t);
  expect(v1).not.toBe(v0);
  await answer(t, as, ana, (await read(t, ["stripe-live"])).needs_approval.decision, 0);
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const again = await read(t, ["stripe-live"]);
  expect(again.needs_approval).toBeDefined();

  // The asking session takes its decision back: recorded as withdrawn, never as a person's denial, and the next read asks again.
  await t.mutation(api.sessionDecisions.withdraw, { api_token: ANA_TOKEN, decision_id: again.needs_approval.decision });
  expect(await decisionStatus(t, again.needs_approval.decision)).toBe("withdrawn");
  expect((await as(ana).query(api.secrets.events, { ref: "stripe-live" }))[0]).toMatchObject({ kind: "withdrawn", decision_short_id: again.needs_approval.decision });
  const reasked = await read(t, ["stripe-live"]);
  expect(reasked.needs_approval.decision).not.toBe(again.needs_approval.decision);

  // Removing the secret leaves no decision in the queue that can no longer do anything.
  await as(ana).mutation(api.secrets.remove, { ref: "stripe-live" });
  expect(await decisionStatus(t, reasked.needs_approval.decision)).toBe("withdrawn");
  const kinds = (await t.run(async (ctx: any) => ctx.db.query("secret_events").collect())).map((e: any) => e.kind);
  expect(kinds.filter((k: string) => k === "denied")).toEqual([]);
});

test("refresh takes only a ready sign-in, and only with the version it read", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "value-one-1234567890" }, team_id: acme });
  const seen = (await read(t, ["k"])).secrets[0].value_updated_at;
  const onKey = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "k", payload: { value: "agent-chosen-value-123" }, expected_updated_at: seen });
  expect(onKey.error).toMatch(/refresh only writes a saved sign-in's cookies back: replace its value with cast vault rotate k/);
  expect(await as(ana).action(api.secrets.reveal, { ref: "k" })).toEqual({ payload: { value: "value-one-1234567890" } });

  const cookie = { name: "sid", value: "cookie-1", domain: "app.example.com", path: "/", secure: true, httpOnly: true };
  await as(ana).action(api.secrets.create, { name: "app", kind: "signin", payload: { cookies: [cookie], captured_from: "chrome" }, sites: ["app.example.com"], team_id: acme });
  const blind = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-2" }], captured_from: "agent-browser" } });
  expect(blind).toMatchObject({ stale: true, value_updated_at: expect.any(Number) });
  expect((await as(ana).action(api.secrets.reveal, { ref: "app" })).payload.cookies[0].value).toBe("cookie-1");
});

test("a request and a read name only the caller's own session, never a teammate's they can view", async () => {
  const { t, as, ana, ben, acme } = await seed();
  const benConv = await t.run(async (ctx: any) => ctx.db.insert("conversations", {
    user_id: ben, team_id: acme, agent_type: "claude_code", session_id: "sess-ben-1", short_id: "jx7ben1", title: "Ben's work",
    started_at: Date.now(), updated_at: Date.now(), message_count: 1, is_private: false, status: "active", project_path: "/repo",
  } as any));
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "vercel-token", kind: "key", why: "export FOO=1", conversation: "sess-ben-1", team_id: acme });
  expect((await as(ben).query(api.secrets.show, { ref: asked.short_id })).requested_from_conversation).toBeUndefined();
  expect(await t.run(async (ctx: any) => (await ctx.db.query("notifications").collect()).filter((n: any) => n.recipient_user_id === ben))).toEqual([]);
  expect(await as(ben).action(api.secrets.fulfill, { ref: asked.short_id, payload: { value: "vercel_tok_ABCDEFGHIJ" } })).toMatchObject({ delivered: false });
  expect(await t.run(async (ctx: any) => ctx.db.query("pending_messages").collect())).toEqual([]);

  await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["vercel-token"], conversation: "jx7ben1", purpose: "get" });
  const reads = (await t.run(async (ctx: any) => ctx.db.query("secret_events").collect())).filter((e: any) => e.kind === "read");
  expect(reads).toHaveLength(1);
  expect(reads[0].conversation_id).toBeUndefined();
  expect((await as(ana).query(api.secrets.show, { ref: "vercel-token" })).last_used_by_conversation).not.toBe(String(benConv));
});

test("the redaction feed carries a rotated-away value while it is restorable, and drops it when it expires", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "k", kind: "key", payload: { value: "leaked-value-123456" }, team_id: acme });
  await as(ana).action(api.secrets.rotate, { ref: "k", payload: { value: "fresh-value-1234567" } });
  const red = await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN });
  expect(red.values).toEqual([{ name: "k", value: "fresh-value-1234567" }, { name: "k", value: "leaked-value-123456" }]);
  await t.run(async (ctx: any) => {
    for (const r of await ctx.db.query("secret_versions").collect()) await ctx.db.patch(r._id, { expires_at: Date.now() - 1 });
  });
  await t.mutation((anyApi as any).secrets.purgeExpiredVersions, {});
  expect(await version(t)).not.toBe(red.version);
  expect((await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN })).values).toEqual([{ name: "k", value: "fresh-value-1234567" }]);
  // The value went with its version.
  expect(await t.run(async (ctx: any) => (await ctx.db.query("secret_values").collect()).length)).toBe(1);
});

test("the list reads no ciphertext: 30 secrets at the payload limit keep small rows, and values stay readable", async () => {
  const { t, as, ana, acme } = await seed();
  const big = (i: number) => `${i}-`.padEnd(500_000, "x");
  for (let i = 0; i < 30; i++) {
    const made = await as(ana).action(api.secrets.create, { name: `file-${i}`, kind: "file", payload: { content: big(i) }, team_id: acme });
    expect(made.error).toBeUndefined();
  }
  expect(await as(ana).query(api.secrets.list, {})).toHaveLength(30);
  const rows = await t.run(async (ctx: any) => ctx.db.query("secrets").collect());
  for (const row of rows) expect(JSON.stringify(row).length).toBeLessThan(2_000);
  const got = await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: rows.map((r: any) => r.name), purpose: "get" });
  expect(got.secrets).toHaveLength(30);
  expect(got.secrets[29].payload.content).toBe(big(29));
});

test("a row written before the split reads from its inline ciphertext, and moveValuesOut moves it", async () => {
  const { t, as, ana, acme } = await seed();
  const workspace = `team:${acme}`;
  const now = Date.now();
  const id = await t.run(async (ctx: any) => {
    const row = await ctx.db.insert("secrets", { workspace, team_id: acme, short_id: "sec-901", name: "old", kind: "key", status: "ready", value_enc: await encryptSecret({ value: "old-current-123456" }, workspace), created_by: ana, created_at: now, updated_at: now, version_count: 1 });
    await ctx.db.insert("secret_versions", { secret_id: row, workspace, value_enc: await encryptSecret({ value: "old-previous-12345" }, workspace), rotated_at: now, rotated_by: ana, expires_at: now + 60_000 });
    return row;
  });
  expect(await as(ana).action(api.secrets.reveal, { ref: "old" })).toEqual({ payload: { value: "old-current-123456" } });
  expect((await t.action(api.secrets.redactionValues, { api_token: ANA_TOKEN })).values.map((x: any) => x.value)).toEqual(["old-current-123456", "old-previous-12345"]);

  await t.mutation((anyApi as any).secrets.moveValuesOut, {});
  await t.mutation((anyApi as any).secrets.moveValuesOut, { table: "secret_versions" });
  const { row, vers } = await t.run(async (ctx: any) => ({ row: await ctx.db.get(id), vers: await ctx.db.query("secret_versions").collect() }));
  expect(row.value_enc).toBeUndefined();
  expect(row.value_id).toBeDefined();
  expect(vers.map((ver: any) => [!!ver.value_id, ver.value_enc])).toEqual([[true, undefined]]);
  expect(await as(ana).action(api.secrets.reveal, { ref: "old" })).toEqual({ payload: { value: "old-current-123456" } });
  await as(ana).action(api.secrets.restore, { ref: "old" });
  expect(await as(ana).action(api.secrets.reveal, { ref: "old" })).toEqual({ payload: { value: "old-previous-12345" } });
});

test("a saved sign-in holds only its own sites' cookies: a token cannot add a site, and every write is checked against the sites", async () => {
  const { t, as, ana, ben, acme } = await seed();
  const cookie = { name: "sid", value: "cookie-1", domain: ".app.example.com", path: "/", secure: true, httpOnly: true };
  const bank = { ...cookie, name: "bank-sid", value: "bank-cookie-1", domain: ".bank.com" };
  const signin = (cookies: unknown[], local_storage?: Record<string, Record<string, string>>) => ({ cookies, captured_from: "agent-browser", ...(local_storage ? { local_storage } : {}) });

  expect((await as(ana).action(api.secrets.create, { name: "nosite", kind: "signin", payload: signin([cookie]), team_id: acme })).error).toMatch(/needs the site it is for/);
  expect((await as(ana).action(api.secrets.create, { name: "app", kind: "signin", payload: signin([cookie, bank]), sites: ["app.example.com"], team_id: acme })).error).toMatch(/cookie for \.bank\.com is not part of the sign-in for app\.example\.com/);
  // A parent domain's cookie is sent to the site, so it belongs; another origin's storage does not.
  const parent = { ...cookie, name: "pref", domain: "example.com" };
  const made = await as(ana).action(api.secrets.create, { name: "app", kind: "signin", payload: signin([cookie, parent], { "https://app.example.com": { k: "v" } }), sites: ["app.example.com"], team_id: acme });
  expect(made.error).toBeUndefined();

  // A token widening a ready sign-in is refused and nothing changes; narrowing, a note, and a person adding a site go through.
  const widen = await t.mutation(api.secrets.updateMeta, { api_token: ANA_TOKEN, ref: "app", sites: ["app.example.com", "bank.com"] });
  expect(widen.error).toMatch(/Only a person adds a site to a saved sign-in/);
  expect((await as(ana).query(api.secrets.show, { ref: "app" })).sites).toEqual(["app.example.com"]);
  expect((await t.mutation(api.secrets.updateMeta, { api_token: ANA_TOKEN, ref: "app", note: "staging" })).error).toBeUndefined();
  expect((await as(ben).mutation(api.secrets.updateMeta, { ref: "app", sites: ["app.example.com", "admin.example.com"] })).error).toBeUndefined();
  expect((await t.mutation(api.secrets.updateMeta, { api_token: ANA_TOKEN, ref: "app", sites: ["app.example.com"] })).error).toBeUndefined();
  // A request has no value to widen: save-signin names its site with a token before filling it.
  const asked = await t.mutation(api.secrets.request, { api_token: ANA_TOKEN, name: "later", kind: "signin", conversation: "jx7ana1", team_id: acme });
  expect((await t.mutation(api.secrets.updateMeta, { api_token: ANA_TOKEN, ref: asked.short_id, sites: ["later.example.com"] })).error).toBeUndefined();

  // A write-back carrying another site's cookie or storage stores nothing.
  const seen = (await read(t, ["app"], { purpose: "signin" })).secrets[0].value_updated_at;
  const stolen = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: signin([cookie, bank]), expected_updated_at: seen });
  expect(stolen.error).toMatch(/cookie for \.bank\.com/);
  expect(JSON.stringify(stolen)).not.toContain("bank-cookie-1");
  const storage = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: signin([cookie], { "https://bank.com": { k: "v" } }), expected_updated_at: seen });
  expect(storage.error).toMatch(/storage for https:\/\/bank\.com/);
  expect((await as(ana).action(api.secrets.rotate, { ref: "app", payload: signin([bank]) })).error).toMatch(/cookie for \.bank\.com/);
  expect((await as(ana).action(api.secrets.reveal, { ref: "app" })).payload.cookies.map((c: any) => c.domain)).toEqual([".app.example.com", "example.com"]);
});

test("every value write gets a version past the last one, even inside one millisecond", async () => {
  const { t, as, ana, acme } = await seed();
  const cookie = { name: "sid", value: "cookie-1", domain: "app.example.com", path: "/", secure: true, httpOnly: true };
  const made = await as(ana).action(api.secrets.create, { name: "app", kind: "signin", payload: { cookies: [cookie], captured_from: "chrome" }, sites: ["app.example.com"], team_id: acme });
  // The stored version sits ahead of the clock, as a write earlier in this same millisecond would leave it.
  const ahead = Date.now() + 60_000;
  await t.run(async (ctx: any) => ctx.db.patch(ctx.db.normalizeId("secrets", made.id), { value_updated_at: ahead }));
  const seen = (await read(t, ["app"], { purpose: "signin" })).secrets[0].value_updated_at;
  expect(seen).toBe(ahead);
  const rotated = await as(ana).action(api.secrets.rotate, { ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-2" }], captured_from: "chrome" } });
  expect(rotated.value_updated_at).toBe(ahead + 1);
  const stale = await t.action(api.secrets.refresh, { api_token: ANA_TOKEN, ref: "app", payload: { cookies: [{ ...cookie, value: "cookie-3" }], captured_from: "agent-browser" }, expected_updated_at: seen });
  expect(stale).toMatchObject({ stale: true, value_updated_at: ahead + 1 });
  await as(ana).action(api.secrets.restore, { ref: "app" });
  expect((await as(ana).query(api.secrets.show, { ref: "app" })).value_updated_at).toBe(ahead + 2);
  expect((await as(ana).action(api.secrets.reveal, { ref: "app" })).payload.cookies[0].value).toBe("cookie-1");
});

test("a value at the size limit encrypts and decrypts whole, and the limit counts bytes", async () => {
  const workspace = "team:t1";
  const ascii = { content: "a".repeat(SECRET_PAYLOAD_MAX - 100) };
  expect(validatePayload("file", ascii)).toEqual({ payload: ascii });
  expect(await decryptSecret(await encryptSecret(ascii, workspace), workspace)).toEqual(ascii);
  const cjk = { content: "漢".repeat(Math.floor((SECRET_PAYLOAD_MAX - 100) / 3)) };
  expect(validatePayload("file", cjk)).toEqual({ payload: cjk });
  expect(await decryptSecret(await encryptSecret(cjk, workspace), workspace)).toEqual(cjk);
  // 200,000 characters of CJK text is 600 KB: past the limit, whatever its length in characters.
  expect(validatePayload("file", { content: "漢".repeat(200_000) })).toMatchObject({ error: expect.stringMatching(/at most 512 KB/) });
});
