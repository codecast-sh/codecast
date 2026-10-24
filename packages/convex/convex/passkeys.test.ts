// Passkeys and presence grants (vault.md "Ask first"), driven by a software
// authenticator that produces real registration and assertion responses: the
// first passkey enrolls freely and is emailed, a second needs a grant; an
// assertion grants one action on one target once; replays, other targets,
// expiry, a counter that goes backwards and another person's passkey are
// refused; and each Vault gate refuses without a grant and passes with one.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { softAuthenticator, type SoftAuthenticator } from "./passkeys.testkit";
import { isPresenceRequired, type PresenceAction } from "@codecast/shared/contracts/secrets";

setDefaultTimeout(60_000);

const api = anyApi as any;
const KEY_ENV = "CONNECTION_SECRETS_KEY";
const ANA_TOKEN = "a".repeat(64);
const ORIGIN = "https://codecast.sh";
const STRIPE = "sk_" + "live_51HsecretVALUEdoNotLeak9876";

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "test-deployment-key-0123456789abcdef";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

async function seed() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "a" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", email: "ben@example.com" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: acme, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(ANA_TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("conversations", {
      user_id: ana, team_id: acme, agent_type: "claude_code", session_id: "sess-ana-1", short_id: "jx7ana1", title: "Wire up billing",
      started_at: now, updated_at: now, message_count: 3, is_private: false, status: "active", project_path: "/repo",
    } as any);
    return { acme, ana: String(ana), ben: String(ben) };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ...ids, as };
}

async function enroll(as: any, auth: SoftAuthenticator, name = "MacBook Touch ID") {
  const begun = await as.action(api.passkeys.registrationBegin, { origin: ORIGIN });
  if (begun.error) return begun;
  return await as.action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: await auth.register(begun.options, ORIGIN), name });
}

/** Begin a presence challenge as the signed-in person and answer it with `auth`; returns the finish result and the response used. */
async function confirm(t: any, as: any, auth: SoftAuthenticator, action: PresenceAction, target?: string) {
  const begun = await as.action(api.passkeys.presenceBegin, { action, target, origin: ORIGIN });
  if (begun.error) return { finished: begun, begun };
  const response = await auth.assert(begun.options, ORIGIN);
  // The finish runs with no session: the /confirm page may have none.
  const finished = await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response });
  return { finished, begun, response };
}

async function askFirstSecret(t: any, as: (u: string) => any, ana: string, acme: string, name = "stripe-live") {
  const made = await as(ana).action(api.secrets.create, { name, kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: name, ask_first: true });
  return made.id as string;
}

test("the first passkey enrolls with no grant and is emailed; a second needs an add_passkey grant", async () => {
  const { t, as, ana } = await seed();
  expect(await as(ana).query(api.passkeys.list, {})).toEqual([]);
  const first = await softAuthenticator();
  const made = await enroll(as(ana), first);
  expect(made).toMatchObject({ name: "MacBook Touch ID", first: true });
  const listed = await as(ana).query(api.passkeys.list, {});
  expect(listed.map((p: any) => p.name)).toEqual(["MacBook Touch ID"]);
  expect(JSON.stringify(listed)).not.toContain("public_key");
  const scheduled = await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect());
  const mails = scheduled.filter((s: any) => s.name.includes("sendPasskeyAdded"));
  expect(mails).toHaveLength(1);
  expect(mails[0].args[0]).toMatchObject({ email: "ana@example.com", passkey_name: "MacBook Touch ID" });

  // A second passkey is one more way to confirm as Ana, so it takes the first.
  const second = await softAuthenticator();
  expect(isPresenceRequired(await enroll(as(ana), second, "YubiKey"))).toBe(true);
  expect((await confirm(t, as(ana), first, "add_passkey")).finished).toMatchObject({ granted: true, action: "add_passkey" });
  expect(await enroll(as(ana), second, "YubiKey")).toMatchObject({ name: "YubiKey", first: false });
  expect((await as(ana).query(api.passkeys.list, {})).map((p: any) => p.name).sort()).toEqual(["MacBook Touch ID", "YubiKey"]);
  // Only the first enrollment, which needed no grant, is mailed.
  const after = await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect());
  expect(after.filter((s: any) => s.name.includes("sendPasskeyAdded"))).toHaveLength(1);
  // The same authenticator again is refused, and the used grant does not let a third in.
  expect(isPresenceRequired(await enroll(as(ana), await softAuthenticator(), "Third"))).toBe(true);
});

test("enrollment from a page that is not the web's origin is refused", async () => {
  const { as, ana } = await seed();
  const auth = await softAuthenticator();
  const begun = await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN });
  const forged = await auth.register(begun.options, "https://evil.example");
  expect((await as(ana).action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: forged })).error).toMatch(/could not be verified/);
  expect(await as(ana).query(api.passkeys.list, {})).toEqual([]);
});

test("an assertion grants exactly one action on one target, once", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  const other = await askFirstSecret(t, as, ana, acme, "stripe-other");

  const { finished, begun } = await confirm(t, as(ana), auth, "reveal", live);
  expect(finished).toMatchObject({ granted: true, action: "reveal" });
  const state = await t.query(api.passkeys.challenge, { challenge_id: begun.challenge_id });
  expect(state).toMatchObject({ status: "granted", action: "reveal", label: "stripe-live" });
  expect(state.options).toBeUndefined();

  // Not the other secret, not another action.
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: other }))).toBe(true);
  expect(isPresenceRequired(await as(ana).mutation(api.secrets.setAskFirst, { ref: live, ask_first: false }))).toBe(true);
  // The one it was for, once.
  expect(await as(ana).action(api.secrets.reveal, { ref: live })).toEqual({ payload: { value: STRIPE } });
  expect((await t.query(api.passkeys.challenge, { challenge_id: begun.challenge_id })).status).toBe("used");
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live }))).toBe(true);
  // The passkey records its use.
  expect((await as(ana).query(api.passkeys.list, {}))[0].last_used_at).toBeGreaterThan(0);
});

test("a replayed assertion is refused, on its own challenge and on a new one", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  const { begun, response } = await confirm(t, as(ana), auth, "reveal", live);
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response })).error).toMatch(/already used/);
  const fresh = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN });
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: fresh.challenge_id, response })).error).toMatch(/could not be verified/);
  expect((await t.query(api.passkeys.challenge, { challenge_id: fresh.challenge_id })).status).toBe("pending");
});

test("an expired challenge and an expired grant are refused", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  const past = (id: string) => t.run((ctx: any) => ctx.db.patch(id, { expires_at: Date.now() - 1 }));

  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN });
  await past(begun.challenge_id);
  expect((await t.query(api.passkeys.challenge, { challenge_id: begun.challenge_id })).status).toBe("expired");
  const response = await auth.assert(begun.options, ORIGIN);
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response })).error).toMatch(/expired/);

  const granted = await confirm(t, as(ana), auth, "reveal", live);
  expect(granted.finished.granted).toBe(true);
  await past(granted.begun.challenge_id);
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live }))).toBe(true);
  // The purge takes both.
  expect(await t.mutation(api.passkeys.purgeExpiredChallenges, {})).toEqual({ deleted: 2 });
  // Left: the enrollment's own challenge, used and not yet past its deadline.
  expect((await t.run((ctx: any) => ctx.db.query("passkey_challenges").collect())).map((r: any) => r.purpose)).toEqual(["register"]);
});

test("a signature count that goes backwards is refused", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  expect((await confirm(t, as(ana), auth, "reveal", live)).finished.granted).toBe(true);
  // A copy of the key still at its first count signs the same count again.
  auth.counter = 0;
  const { finished } = await confirm(t, as(ana), auth, "reveal", live);
  expect(finished.granted).toBeUndefined();
  expect(finished.error).toMatch(/counter|count/i);
});

test("another person's passkey does not answer the asker's challenge", async () => {
  const { t, as, ana, ben, acme } = await seed();
  const anas = await softAuthenticator();
  const bens = await softAuthenticator();
  await enroll(as(ana), anas);
  await enroll(as(ben), bens);
  const live = await askFirstSecret(t, as, ana, acme);
  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN });
  const response = await bens.assert(begun.options, ORIGIN);
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response })).error).toMatch(/not set up for the account that asked/);
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live }))).toBe(true);
  // Ben cannot open a challenge on a passkey of Ana's, or on her secret's label from another team.
  const aKey = (await as(ana).query(api.passkeys.list, {}))[0]._id;
  expect((await as(ben).action(api.passkeys.presenceBegin, { action: "remove_passkey", target: aKey, origin: ORIGIN })).error).toMatch(/not yours/);
});

test("with no passkey, a presence challenge asks for enrollment", async () => {
  const { t, as, ana, acme } = await seed();
  const live = await askFirstSecret(t, as, ana, acme);
  expect(await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN })).toMatchObject({ needs_passkey: true });
  // A signed-out caller cannot begin one at all.
  expect((await t.action(api.passkeys.presenceBegin, { action: "reveal", target: live })).error).toMatch(/Sign in/);
});

test("reveal of an Ask first secret takes a grant; an ordinary secret's does not", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  await as(ana).action(api.secrets.create, { name: "plain", kind: "key", payload: { value: "plain-value-123456" }, team_id: acme });
  expect(await as(ana).action(api.secrets.reveal, { ref: "plain" })).toEqual({ payload: { value: "plain-value-123456" } });
  const live = await askFirstSecret(t, as, ana, acme);
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live }))).toBe(true);
  // A refused reveal records nothing.
  expect((await as(ana).query(api.secrets.events, { ref: live })).map((e: any) => e.kind)).not.toContain("revealed");
  await confirm(t, as(ana), auth, "reveal", live);
  expect(await as(ana).action(api.secrets.reveal, { ref: live })).toEqual({ payload: { value: STRIPE } });
});

test("Ask first off takes a grant on the web and through the dispatch rail; on takes none", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  expect(isPresenceRequired(await as(ana).mutation(api.secrets.setAskFirst, { ref: live, ask_first: false }))).toBe(true);
  await expect(as(ana).mutation(api.dispatch.dispatch, { action: "setSecretAskFirst", args: [live, false] })).rejects.toThrow(/presence_required/);
  expect((await as(ana).query(api.secrets.show, { ref: live })).ask_first).toBe(true);
  await confirm(t, as(ana), auth, "ask_first_off", live);
  await as(ana).mutation(api.dispatch.dispatch, { action: "setSecretAskFirst", args: [live, false] });
  expect((await as(ana).query(api.secrets.show, { ref: live })).ask_first).toBe(false);
  expect(await as(ana).mutation(api.secrets.setAskFirst, { ref: live, ask_first: true })).toMatchObject({ ask_first: true });
});

test("approving an Ask first read takes a grant for that decision; Deny takes none", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  await askFirstSecret(t, as, ana, acme);
  const read = () => t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["stripe-live"], conversation: "jx7ana1", purpose: "get" });
  const decisionId = async () => String((await t.run((ctx: any) => ctx.db.query("session_decisions").order("desc").first()))._id);
  const approval = () => t.run((ctx: any) => ctx.db.query("secret_approvals").first());

  expect((await read()).needs_approval).toBeDefined();
  const first = await decisionId();
  // Deny is one press.
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: first, status: "answered", answer_index: 1 });
  expect((await approval()).status).toBe("denied");

  expect((await read()).needs_approval).toBeDefined();
  const second = await decisionId();
  // Approve without a grant: refused on the resolve mutation and the dispatch rail alike, and nothing settles.
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: second, status: "answered", answer_index: 0 })).rejects.toThrow(/presence_required/);
  await expect(
    as(ana).mutation(api.dispatch.dispatch, { action: "answerDecision", args: [], patches: { session_decisions: { [second]: { status: "answered", answer_index: 0, resolved_at: Date.now() } } } }),
  ).rejects.toThrow(/presence_required/);
  expect((await approval()).status).toBe("pending");
  // A grant for another decision does not stand in.
  expect((await confirm(t, as(ana), auth, "approve", first)).finished.granted).toBe(true);
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: second, status: "answered", answer_index: 0 })).rejects.toThrow(/presence_required/);

  expect((await confirm(t, as(ana), auth, "approve", second)).finished.granted).toBe(true);
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: second, status: "answered", answer_index: 0 });
  expect((await approval()).status).toBe("approved");
  expect((await read()).secrets[0].payload).toEqual({ value: STRIPE });
});

test("removing a passkey takes a grant for it; renaming does not", async () => {
  const { t, as, ana, ben } = await seed();
  const auth = await softAuthenticator();
  await enroll(as(ana), auth);
  const id = (await as(ana).query(api.passkeys.list, {}))[0]._id;
  expect(await as(ana).mutation(api.passkeys.rename, { id, name: "Work laptop" })).toMatchObject({ name: "Work laptop" });
  expect((await as(ben).mutation(api.passkeys.rename, { id, name: "mine" })).error).toMatch(/No such passkey/);
  expect(isPresenceRequired(await as(ana).mutation(api.passkeys.remove, { id }))).toBe(true);
  const { begun } = await confirm(t, as(ana), auth, "remove_passkey", id);
  expect(begun.options.allowCredentials.map((c: any) => c.id)).toEqual([auth.credentialId]);
  expect(await as(ana).mutation(api.passkeys.remove, { id })).toMatchObject({ removed: true });
  expect(await as(ana).query(api.passkeys.list, {})).toEqual([]);
});
