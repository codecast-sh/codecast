// Passkeys and presence grants (vault.md "Touch ID"), driven by a software
// authenticator that produces real registration and assertion responses: the
// first passkey enrolls freely, waits out its probation and is removed with
// one press meanwhile, a second spends a grant; an assertion grants one action
// on one target once, spent only with the grant string its beginner holds;
// replays, other targets, expiry, a counter that goes backwards, another
// person's passkey and origins outside the web's are refused; and each Vault
// gate refuses without a grant and passes with one.
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

async function enroll(as: any, auth: SoftAuthenticator, name = "MacBook Touch ID", grant?: string) {
  const begun = await as.action(api.passkeys.registrationBegin, { origin: ORIGIN, grant });
  if (begun.error) return begun;
  return await as.action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: await auth.register(begun.options, ORIGIN), name });
}

/** A day passes: every passkey is past its probation. */
const dayLater = (t: any) => t.run(async (ctx: any) => {
  for (const p of await ctx.db.query("passkeys").collect()) if (p.probation_until) await ctx.db.patch(p._id, { probation_until: Date.now() - 1 });
});

/** Enroll a first passkey and let its probation pass. */
async function enrollTrusted(t: any, as: any, auth: SoftAuthenticator, name?: string) {
  const made = await enroll(as, auth, name);
  await dayLater(t);
  return made;
}

/** Begin a presence challenge as the signed-in person and answer it with `auth`; returns the finish result, the begin's answer (its `grant` string included) and the response used. */
async function confirm(t: any, as: any, auth: SoftAuthenticator, action: PresenceAction, target?: string) {
  const begun = await as.action(api.passkeys.presenceBegin, { action, target, origin: ORIGIN });
  if (begun.error) return { finished: begun, begun, grant: undefined };
  const response = await auth.assert(begun.options, ORIGIN);
  // The finish runs with no session: the /confirm page may have none.
  const finished = await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response });
  return { finished, begun, response, grant: begun.grant as string };
}

async function askFirstSecret(t: any, as: (u: string) => any, ana: string, acme: string, name = "stripe-live") {
  const made = await as(ana).action(api.secrets.create, { name, kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: name, ask_first: true });
  return made.id as string;
}

const scheduledMails = async (t: any) =>
  (await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect())).filter((s: any) => s.name.includes("sendPasskeyAdded"));
const notices = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("notifications").collect()).filter((n: any) => n.type === "passkey_changed"));

test("the first passkey enrolls with no grant into probation; a second spends an add_passkey grant; each is mailed and noticed", async () => {
  const { t, as, ana } = await seed();
  expect(await as(ana).query(api.passkeys.list, {})).toEqual([]);
  const first = await softAuthenticator();
  const made = await enroll(as(ana), first);
  expect(made).toMatchObject({ name: "MacBook Touch ID", first: true });
  expect(made.probation_until).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  const listed = await as(ana).query(api.passkeys.list, {});
  expect(listed.map((p: any) => p.name)).toEqual(["MacBook Touch ID"]);
  expect(listed[0].probation_until).toBe(made.probation_until);
  expect(JSON.stringify(listed)).not.toContain("public_key");
  const mails = await scheduledMails(t);
  expect(mails).toHaveLength(1);
  expect(mails[0].args[0]).toMatchObject({ email: "ana@example.com", passkey_name: "MacBook Touch ID" });
  expect((await notices(t)).map((n: any) => [String(n.recipient_user_id), n.message])).toEqual([[ana, "Touch ID added: MacBook Touch ID"]]);

  // In probation it confirms nothing, so it cannot vouch for a second one yet.
  expect((await as(ana).action(api.passkeys.presenceBegin, { action: "add_passkey", origin: ORIGIN })).error).toMatch(/new and confirms nothing/);
  await dayLater(t);

  // A second passkey is one more way to confirm as Ana, so it takes the first.
  const second = await softAuthenticator();
  expect(isPresenceRequired(await enroll(as(ana), second, "YubiKey"))).toBe(true);
  const { finished, grant } = await confirm(t, as(ana), first, "add_passkey");
  expect(finished).toMatchObject({ granted: true, action: "add_passkey" });
  const added = await enroll(as(ana), second, "YubiKey", grant);
  expect(added).toMatchObject({ name: "YubiKey", first: false });
  // Vouched for, it has no probation.
  expect(added.probation_until).toBeUndefined();
  expect((await as(ana).query(api.passkeys.list, {})).map((p: any) => p.name).sort()).toEqual(["MacBook Touch ID", "YubiKey"]);
  // Every enrollment is mailed and noticed.
  expect(await scheduledMails(t)).toHaveLength(2);
  expect(await notices(t)).toHaveLength(2);
  // The spent grant does not let a third in.
  expect(isPresenceRequired(await enroll(as(ana), await softAuthenticator(), "Third", grant))).toBe(true);
});

test("a grant is spent only with the string its beginner holds: another caller on the same sign-in gets nothing", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  // An agent holding Ana's session polls reveal while she confirms.
  const agent = as(ana);
  const { finished, begun, grant } = await confirm(t, as(ana), auth, "reveal", live);
  expect(finished.granted).toBe(true);
  expect(isPresenceRequired(await agent.action(api.secrets.reveal, { ref: live }))).toBe(true);
  // The challenge it can watch carries no grant string.
  const watched = await agent.query(api.passkeys.challenge, { challenge_id: begun.challenge_id });
  expect(watched.status).toBe("granted");
  expect(JSON.stringify(watched)).not.toContain(grant.split(".")[1]);
  // A guessed secret, or the id alone, is refused, and the grant survives for its holder.
  expect(isPresenceRequired(await agent.action(api.secrets.reveal, { ref: live, grant: `${begun.challenge_id}.guess` }))).toBe(true);
  expect(isPresenceRequired(await agent.action(api.secrets.reveal, { ref: live, grant: begun.challenge_id }))).toBe(true);
  expect(await as(ana).action(api.secrets.reveal, { ref: live, grant })).toEqual({ payload: { value: STRIPE } });
});

test("an add_passkey grant is spent when enrollment begins, so a second register cannot ride the person's confirmation", async () => {
  const { t, as, ana } = await seed();
  const first = await softAuthenticator();
  await enrollTrusted(t, as(ana), first);
  const { grant } = await confirm(t, as(ana), first, "add_passkey");
  // The agent's register begin, without the string, is refused even though Ana just confirmed.
  expect(isPresenceRequired(await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN }))).toBe(true);
  const begun = await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN, grant });
  expect(begun.challenge_id).toBeDefined();
  // The grant is spent: a second begin with it is refused.
  expect(isPresenceRequired(await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN, grant }))).toBe(true);
  const mine = await softAuthenticator();
  const done = await as(ana).action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: await mine.register(begun.options, ORIGIN), name: "Mine" });
  expect(done).toMatchObject({ name: "Mine", first: false });
});

test("a first enrollment that a passkey overtook cannot store a second without a grant", async () => {
  const { t, as, ana } = await seed();
  // The agent begins while Ana has none, then Ana sets hers up first.
  const begun = await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN });
  await enroll(as(ana), await softAuthenticator(), "Ana's Mac");
  const rogue = await softAuthenticator();
  const forged = await as(ana).action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: await rogue.register(begun.options, ORIGIN), name: "Rogue" });
  expect(isPresenceRequired(forged)).toBe(true);
  expect((await as(ana).query(api.passkeys.list, {})).map((p: any) => p.name)).toEqual(["Ana's Mac"]);
});

test("a passkey in probation confirms nothing and is removed with one press; the only grant-less one stays removable after", async () => {
  const { t, as, ana, acme } = await seed();
  const rogue = await softAuthenticator();
  await enroll(as(ana), rogue, "Rogue");
  const live = await askFirstSecret(t, as, ana, acme);
  expect((await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN })).error).toMatch(/new and confirms nothing/);
  // A challenge opened before is still refused at the grant.
  const stamped = await t.run(async (ctx: any) => {
    const p = (await ctx.db.query("passkeys").collect())[0];
    await ctx.db.patch(p._id, { probation_until: undefined });
    return p;
  });
  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN });
  await t.run((ctx: any) => ctx.db.patch(stamped._id, { probation_until: Date.now() + 3_600_000 }));
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response: await rogue.assert(begun.options, ORIGIN) })).error).toMatch(/new and confirms nothing/);
  // Ana removes it with one press.
  const id = String(stamped._id);
  expect(await as(ana).mutation(api.passkeys.remove, { id })).toMatchObject({ removed: true });
  expect((await notices(t)).map((n: any) => n.message)).toContain("Touch ID removed: Rogue");

  // Past probation and used, the account's only grant-less passkey still goes with one press.
  const mine = await softAuthenticator();
  await enrollTrusted(t, as(ana), mine, "Mine");
  expect((await confirm(t, as(ana), mine, "reveal", live)).finished.granted).toBe(true);
  const mineId = (await as(ana).query(api.passkeys.list, {}))[0]._id;
  expect(await as(ana).mutation(api.passkeys.remove, { id: mineId })).toMatchObject({ removed: true });
});

test("enrollment from a page that is not the web's origin is refused", async () => {
  const { as, ana } = await seed();
  const auth = await softAuthenticator();
  const begun = await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN });
  const forged = await auth.register(begun.options, "https://evil.example");
  expect((await as(ana).action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: forged })).error).toMatch(/could not be verified/);
  expect(await as(ana).query(api.passkeys.list, {})).toEqual([]);
});

test("the local dev origins take no ceremony on a deployment that has not opted in", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  for (const origin of ["https://local.codecast.sh", "http://localhost:3200"]) {
    expect((await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin })).error).toMatch(/runs on https:\/\/codecast.sh only/);
    expect((await as(ana).action(api.passkeys.registrationBegin, { origin })).error).toMatch(/runs on https:\/\/codecast.sh only/);
  }
  // An assertion made on local.codecast.sh for a challenge begun on the web is refused.
  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN });
  const local = await auth.assert(begun.options, "https://local.codecast.sh");
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response: local })).error).toMatch(/could not be verified/);
  // A localhost passkey from a dev web confirms nothing here.
  await t.run(async (ctx: any) => {
    const p = (await ctx.db.query("passkeys").collect())[0];
    await ctx.db.patch(p._id, { rp_id: "localhost" });
  });
  expect(await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN })).toMatchObject({ needs_passkey: true });
});

test("a dev deployment that opts in takes the local origins", async () => {
  const prior = process.env.PASSKEY_DEV_ORIGINS;
  process.env.PASSKEY_DEV_ORIGINS = "1";
  try {
    const { t, as, ana, acme } = await seed();
    const auth = await softAuthenticator();
    const origin = "http://localhost:3200";
    const begun = await as(ana).action(api.passkeys.registrationBegin, { origin });
    expect(begun.options.rp.id).toBe("localhost");
    await as(ana).action(api.passkeys.registrationFinish, { challenge_id: begun.challenge_id, response: await auth.register(begun.options, origin), name: "Dev" });
    await dayLater(t);
    const live = await askFirstSecret(t, as, ana, acme);
    const asked = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin });
    expect((await t.action(api.passkeys.presenceFinish, { challenge_id: asked.challenge_id, response: await auth.assert(asked.options, origin) })).granted).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.PASSKEY_DEV_ORIGINS;
    else process.env.PASSKEY_DEV_ORIGINS = prior;
  }
});

test("an assertion grants exactly one action on one target, once", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  const other = await askFirstSecret(t, as, ana, acme, "stripe-other");

  const { finished, begun, grant } = await confirm(t, as(ana), auth, "reveal", live);
  expect(finished).toMatchObject({ granted: true, action: "reveal" });
  const state = await as(ana).query(api.passkeys.challenge, { challenge_id: begun.challenge_id });
  expect(state).toMatchObject({ status: "granted", action: "reveal", label: "stripe-live" });
  expect(state.options).toBeUndefined();
  // Settled, nobody but its owner reads what it was for.
  expect((await t.query(api.passkeys.challenge, { challenge_id: begun.challenge_id })).label).toBeUndefined();

  // Not the other secret, not another action.
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: other, grant }))).toBe(true);
  expect(isPresenceRequired(await as(ana).mutation(api.secrets.setAskFirst, { ref: live, ask_first: false, grant }))).toBe(true);
  // The one it was for, once.
  expect(await as(ana).action(api.secrets.reveal, { ref: live, grant })).toEqual({ payload: { value: STRIPE } });
  expect((await t.query(api.passkeys.challenge, { challenge_id: begun.challenge_id })).status).toBe("used");
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live, grant }))).toBe(true);
  // The passkey records its use.
  expect((await as(ana).query(api.passkeys.list, {}))[0].last_used_at).toBeGreaterThan(0);
});

test("an enrollment's options name the account by id, never its email", async () => {
  const { t, as, ana } = await seed();
  const begun = await as(ana).action(api.passkeys.registrationBegin, { origin: ORIGIN });
  const state = await t.query(api.passkeys.challenge, { challenge_id: begun.challenge_id });
  expect(JSON.stringify(state)).not.toContain("ana@example.com");
  expect(JSON.stringify(begun.options)).not.toContain("ana@example.com");
});

test("a replayed assertion is refused, on its own challenge and on a new one", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
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
  await enrollTrusted(t, as(ana), auth);
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
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live, grant: granted.grant }))).toBe(true);
  // The purge takes both.
  expect(await t.mutation(api.passkeys.purgeExpiredChallenges, {})).toEqual({ deleted: 2 });
  // Left: the enrollment's own challenge, used and not yet past its deadline.
  expect((await t.run((ctx: any) => ctx.db.query("passkey_challenges").collect())).map((r: any) => r.purpose)).toEqual(["register"]);
});

test("a signature count that goes backwards is refused", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
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
  await dayLater(t);
  const live = await askFirstSecret(t, as, ana, acme);
  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "reveal", target: live, origin: ORIGIN });
  const response = await bens.assert(begun.options, ORIGIN);
  expect((await t.action(api.passkeys.presenceFinish, { challenge_id: begun.challenge_id, response })).error).toMatch(/not set up for the account that asked/);
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live, grant: begun.grant }))).toBe(true);
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
  await enrollTrusted(t, as(ana), auth);
  await as(ana).action(api.secrets.create, { name: "plain", kind: "key", payload: { value: "plain-value-123456" }, team_id: acme });
  expect(await as(ana).action(api.secrets.reveal, { ref: "plain" })).toEqual({ payload: { value: "plain-value-123456" } });
  const live = await askFirstSecret(t, as, ana, acme);
  expect(isPresenceRequired(await as(ana).action(api.secrets.reveal, { ref: live }))).toBe(true);
  // A refused reveal records nothing.
  expect((await as(ana).query(api.secrets.events, { ref: live })).map((e: any) => e.kind)).not.toContain("revealed");
  const { grant } = await confirm(t, as(ana), auth, "reveal", live);
  expect(await as(ana).action(api.secrets.reveal, { ref: live, grant })).toEqual({ payload: { value: STRIPE } });
});

test("Ask first off takes a grant on the web and through the dispatch rail; on takes none", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
  const live = await askFirstSecret(t, as, ana, acme);
  expect(isPresenceRequired(await as(ana).mutation(api.secrets.setAskFirst, { ref: live, ask_first: false }))).toBe(true);
  await expect(as(ana).mutation(api.dispatch.dispatch, { action: "setSecretAskFirst", args: [live, false] })).rejects.toThrow(/presence_required/);
  expect((await as(ana).query(api.secrets.show, { ref: live })).ask_first).toBe(true);
  const { grant } = await confirm(t, as(ana), auth, "ask_first_off", live);
  // The dispatch without the string is still refused; with it, it lands.
  await expect(as(ana).mutation(api.dispatch.dispatch, { action: "setSecretAskFirst", args: [live, false] })).rejects.toThrow(/presence_required/);
  await as(ana).mutation(api.dispatch.dispatch, { action: "setSecretAskFirst", args: [live, false, grant] });
  expect((await as(ana).query(api.secrets.show, { ref: live })).ask_first).toBe(false);
  expect(await as(ana).mutation(api.secrets.setAskFirst, { ref: live, ask_first: true })).toMatchObject({ ask_first: true });
});

test("approving an Ask first read takes a grant for that decision; Deny takes none", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
  await askFirstSecret(t, as, ana, acme);
  const read = () => t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["stripe-live"], conversation: "jx7ana1", purpose: "get" });
  const decisionId = async () => String((await t.run((ctx: any) => ctx.db.query("session_decisions").order("desc").first()))._id);
  const approval = () => t.run((ctx: any) => ctx.db.query("secret_approvals").first());

  expect((await read()).needs_approval).toBeDefined();
  const first = await decisionId();
  // The confirmation names the secret and the session in the Vault's words.
  const firstGrant = await confirm(t, as(ana), auth, "approve", first);
  expect(firstGrant.finished.granted).toBe(true);
  expect((await as(ana).query(api.passkeys.challenge, { challenge_id: firstGrant.begun.challenge_id })).label).toBe("stripe-live for jx7ana1");
  // Deny is one press.
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: first, status: "answered", answer_index: 1 });
  expect((await approval()).status).toBe("denied");

  expect((await read()).needs_approval).toBeDefined();
  const second = await decisionId();
  // Approve without a grant: refused on the resolve mutation and the dispatch rail alike, and nothing settles.
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: second, status: "answered", answer_index: 0 })).rejects.toThrow(/presence_required/);
  const patch = { session_decisions: { [second]: { status: "answered", answer_index: 0, resolved_at: Date.now() } } };
  await expect(as(ana).mutation(api.dispatch.dispatch, { action: "answerDecision", args: [second, { index: 0 }], patches: patch })).rejects.toThrow(/presence_required/);
  expect((await approval()).status).toBe("pending");
  // A grant for another decision does not stand in.
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: second, status: "answered", answer_index: 0, grant: firstGrant.grant })).rejects.toThrow(/presence_required/);

  const { grant } = await confirm(t, as(ana), auth, "approve", second);
  // The answer carries the grant string beside it on the dispatch rail; it never lands on the row.
  await as(ana).mutation(api.dispatch.dispatch, { action: "answerDecision", args: [second, { index: 0, presence: grant }], patches: patch });
  expect((await approval()).status).toBe("approved");
  expect(JSON.stringify(await t.run((ctx: any) => ctx.db.get(second)))).not.toContain(grant);
  expect((await read()).secrets[0].payload).toEqual({ value: STRIPE });
});

test("an Ask first decision cannot be edited by its asker, and only such a decision opens an approve challenge", async () => {
  const { t, as, ana, acme } = await seed();
  const auth = await softAuthenticator();
  await enrollTrusted(t, as(ana), auth);
  await askFirstSecret(t, as, ana, acme);
  await t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs: ["stripe-live"], conversation: "jx7ana1", purpose: "get" });
  const row = await t.run((ctx: any) => ctx.db.query("session_decisions").order("desc").first());
  const edited = await t.mutation(api.sessionDecisions.edit, { api_token: ANA_TOKEN, decision_id: String(row._id), question: "Approve the staging deploy?" });
  expect(edited.error).toMatch(/filed by the Vault/);
  expect((await t.run((ctx: any) => ctx.db.get(row._id))).question).toBe(row.question);
  // An ordinary decision of Ana's mints no approve grant.
  const plain = await t.mutation(api.sessionDecisions.ask, { api_token: ANA_TOKEN, session_id: "sess-ana-1", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] });
  expect((await as(ana).action(api.passkeys.presenceBegin, { action: "approve", target: String(plain.id), origin: ORIGIN })).error).toMatch(/Only approving an Ask first read/);
});

test("removing a passkey takes a grant for it unless it went in with none; renaming does not", async () => {
  const { t, as, ana, ben } = await seed();
  const first = await softAuthenticator();
  await enrollTrusted(t, as(ana), first);
  const { grant: add } = await confirm(t, as(ana), first, "add_passkey");
  const second = await softAuthenticator();
  await enroll(as(ana), second, "YubiKey", add);
  const id = (await as(ana).query(api.passkeys.list, {})).find((p: any) => p.name === "YubiKey")._id;
  expect(await as(ana).mutation(api.passkeys.rename, { id, name: "Work key" })).toMatchObject({ name: "Work key" });
  expect((await as(ben).mutation(api.passkeys.rename, { id, name: "mine" })).error).toMatch(/No such passkey/);
  // A vouched-for passkey needs Touch ID to go.
  expect(isPresenceRequired(await as(ana).mutation(api.passkeys.remove, { id }))).toBe(true);
  const { begun, grant } = await confirm(t, as(ana), first, "remove_passkey", id);
  expect(begun.options.allowCredentials.map((c: any) => c.id).sort()).toEqual([first.credentialId, second.credentialId].sort());
  expect(await as(ana).mutation(api.passkeys.remove, { id, grant })).toMatchObject({ removed: true });
  expect((await as(ana).query(api.passkeys.list, {})).map((p: any) => p.name)).toEqual(["MacBook Touch ID"]);
});
