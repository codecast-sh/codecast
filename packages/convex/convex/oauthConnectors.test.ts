import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import {
  PROVIDERS, storeConnection, finishConfirm, deleteConnection, getConnectUrl, accessExpiresAt, needsRefresh, REFRESH_MARGIN_MS,
  getConnectionForTeam, updateStoredTokens, getFreshAccessTokenForTeam, claimRefresh, REFRESH_LEASE_MS,
} from "./oauthConnectors";
import { signStateWith, verifyStateWith, encryptRefreshToken, decryptRefreshToken } from "./googleOAuth";

// The generic connector shares Google's security design; these tests pin the
// PROVIDER TABLE (a new connector must be a config, not a fork) and the
// two-phase confirm on the shared table.

const OWNER = "u_owner";
const TEAM = "team_1";
const ctx = (t: Record<string, any[]>) => ({ db: makeFakeDb(t) }) as any;

describe("PROVIDERS", () => {
  test("every provider is fully specified", () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.authorizeUrl.startsWith("https://")).toBe(true);
      expect(p.tokenUrl.startsWith("https://")).toBe(true);
      expect(p.env.clientId).toMatch(/_OAUTH_CLIENT_ID$/);
      expect(p.env.clientSecret).toMatch(/_OAUTH_CLIENT_SECRET$/);
      expect(["body", "basic"]).toContain(p.tokenAuth);
    }
  });

  test("scopes stay minimal — no admin, no delete", () => {
    // Linear: read + write + comment. `write` is what issue sync's outbound
    // needs to change a title or move a state (issue-sync.md S5); it is not
    // admin, and there is no delete scope in the set.
    expect(PROVIDERS.linear.scopes).toEqual(["read", "write", "comments:create"]);
    expect(PROVIDERS.linear.scopes).not.toContain("admin");
    // Notion: access is per-page the user shares; the OAuth has no scope string.
    expect(PROVIDERS.notion.scopes).toEqual([]);
  });

  test("Linear writes are attributed to the app, not the connector", () => {
    expect(PROVIDERS.linear.authorizeExtra?.actor).toBe("app");
  });
});

describe("connect state", () => {
  const SECRET = "linear-client-secret";
  const connectCtx = () => ({
    runQuery: async () => ({ user_id: OWNER, team_id: TEAM }),
  }) as any;

  test("the state getConnectUrl signs is one verifyStateWith accepts", async () => {
    process.env.LINEAR_OAUTH_CLIENT_ID = "linear-client-id";
    process.env.LINEAR_OAUTH_CLIENT_SECRET = SECRET;

    const res = await (getConnectUrl as any)._handler(connectCtx(), { provider: "linear" });
    expect(res.ok).toBe(true);

    const url = new URL(res.url);
    const payload = await verifyStateWith(SECRET, url.searchParams.get("state")!);
    // THE regression: the connector used to sign `iat`, and verifyStateWith
    // requires `ts` — so it returned null and every Linear/Notion callback
    // died at bad_state before the code was ever exchanged.
    expect(payload).not.toBeNull();
    expect(payload!.provider).toBe("linear");
    expect(payload!.user_id).toBe(OWNER);
    expect(payload!.team_id).toBe(TEAM);

    expect(url.searchParams.get("scope")).toBe("read,write,comments:create");
    expect(url.searchParams.get("actor")).toBe("app");
  });

  test("a state carrying iat instead of ts never verifies", async () => {
    const stale = await signStateWith(SECRET, {
      provider: "linear", user_id: OWNER, team_id: TEAM, iat: Date.now(),
    });
    expect(await verifyStateWith(SECRET, stale)).toBeNull();
  });
});

describe("storeConnection + finishConfirm", () => {
  const base = {
    provider: "linear",
    user_id: OWNER,
    team_id: TEAM,
    account_label: "Acme",
    access_token_enc: "enc-token",
    granted_scopes: ["read"],
    pending_confirm_hash: "hash-1",
  };
  const t0 = () => ({
    users: [{ _id: OWNER }],
    teams: [{ _id: TEAM }],
    app_installations: [] as any[],
  });

  test("a stored row is PENDING until confirmed with the right token by the right user", async () => {
    const t = t0();
    const c = ctx(t);
    const stored = await (storeConnection as any)._handler(c, base);
    expect(stored.ok).toBe(true);
    expect(t.app_installations[0].pending_confirm_hash).toBe("hash-1");

    // Wrong token: still pending, not deleted (the real browser may still confirm).
    const wrong = await (finishConfirm as any)._handler(c, { user_id: OWNER, installation_id: stored.id, token_hash: "nope" });
    expect(wrong.ok).toBe(false);
    expect(t.app_installations[0].pending_confirm_hash).toBe("hash-1");

    // Wrong user with the right token: refused — the relay-attack case.
    const relay = await (finishConfirm as any)._handler(c, { user_id: "u_attacker", installation_id: stored.id, token_hash: "hash-1" });
    expect(relay.ok).toBe(false);

    // Right user, right token: confirmed.
    const ok = await (finishConfirm as any)._handler(c, { user_id: OWNER, installation_id: stored.id, token_hash: "hash-1" });
    expect(ok.ok).toBe(true);
    expect(t.app_installations[0].pending_confirm_hash).toBeUndefined();
  });

  test("re-connecting the same team upserts one row, never two", async () => {
    const t = t0();
    const c = ctx(t);
    await (storeConnection as any)._handler(c, base);
    await (storeConnection as any)._handler(c, { ...base, access_token_enc: "enc-token-2", pending_confirm_hash: "hash-2" });
    expect(t.app_installations).toHaveLength(1);
    expect(t.app_installations[0].access_token_enc).toBe("enc-token-2");
  });

  test("an expired pending row is deleted on confirm, not left as a live grant", async () => {
    const t = t0();
    t.app_installations.push({
      _id: "ai_old", provider: "linear", team_id: TEAM, connected_by: OWNER, access_token_enc: "enc",
      granted_scopes: [], pending_confirm_hash: "h", pending_expires_at: 1, created_at: 1, updated_at: 1,
    });
    const res = await (finishConfirm as any)._handler(ctx(t), { user_id: OWNER, installation_id: "ai_old", token_hash: "h" });
    expect(res.ok).toBe(false);
    expect(t.app_installations).toHaveLength(0);
  });

  test("any team member may disconnect; a non-member may not", async () => {
    const t = {
      ...t0(),
      users: [{ _id: OWNER }, { _id: "u_member" }, { _id: "u_stranger" }],
      team_memberships: [{ _id: "tm1", team_id: TEAM, user_id: "u_member" }],
      app_installations: [{ _id: "ai_1", provider: "linear", team_id: TEAM, connected_by: OWNER, access_token_enc: "enc", granted_scopes: [], created_at: 1, updated_at: 1 }],
    };
    const c = ctx(t);
    const outsider = await (deleteConnection as any)._handler(c, { user_id: "u_stranger", installation_id: "ai_1" });
    expect(outsider.ok).toBe(false);
    expect(t.app_installations).toHaveLength(1);
    const member = await (deleteConnection as any)._handler(c, { user_id: "u_member", installation_id: "ai_1" });
    expect(member.ok).toBe(true);
    expect(t.app_installations).toHaveLength(0);
  });
});

describe("token refresh policy", () => {
  const now = 1_800_000_000_000;

  test("expires_in becomes an absolute expiry; a provider without one records none", () => {
    expect(accessExpiresAt({ expires_in: 86399 }, now)).toBe(now + 86_399_000);
    expect(accessExpiresAt({}, now)).toBeUndefined();
    expect(accessExpiresAt({ expires_in: 0 }, now)).toBeUndefined();
  });

  test("a row refreshes when it can and its token is expiring or of unknown age", () => {
    const fresh = { refresh_token_enc: "r", access_expires_at: now + 60 * 60 * 1000 };
    const expiring = { refresh_token_enc: "r", access_expires_at: now + REFRESH_MARGIN_MS - 1 };
    const expired = { refresh_token_enc: "r", access_expires_at: now - 1 };
    const unknownAge = { refresh_token_enc: "r" };
    expect(needsRefresh(fresh, now)).toBe(false);
    expect(needsRefresh(expiring, now)).toBe(true);
    expect(needsRefresh(expired, now)).toBe(true);
    // The rows connected before expiry was recorded: refresh once, then it is known.
    expect(needsRefresh(unknownAge, now)).toBe(true);
  });

  test("a row without a refresh token never refreshes (Notion: the access token is all there is)", () => {
    expect(needsRefresh({ access_expires_at: now - 1 }, now)).toBe(false);
    expect(needsRefresh({}, now)).toBe(false);
  });

  test("storeConnection persists the expiry on insert and on re-store", async () => {
    const t = { users: [{ _id: OWNER }], teams: [{ _id: TEAM }], app_installations: [] as any[] };
    const c = ctx(t);
    const base = {
      provider: "linear", user_id: OWNER, team_id: TEAM, access_token_enc: "a1", refresh_token_enc: "r1",
      granted_scopes: ["read"], pending_confirm_hash: "h", access_expires_at: now + 1000,
    };
    await (storeConnection as any)._handler(c, base);
    expect(t.app_installations[0].access_expires_at).toBe(now + 1000);
    t.app_installations[0].last_error = "stale";
    await (storeConnection as any)._handler(c, { ...base, access_token_enc: "a2", access_expires_at: now + 2000 });
    expect(t.app_installations.length).toBe(1);
    expect(t.app_installations[0].access_expires_at).toBe(now + 2000);
    expect(t.app_installations[0].last_error).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------
 * The refresh action, over the real handlers and a provider we control.
 * The provider answers only when the test says so, which is how two
 * refreshes, a reconnect, or a disconnect are made to overlap the await.
 * ---------------------------------------------------------------------- */
describe("getFreshAccessTokenForTeam (Linear)", () => {
  const CLIENT_ID = "lin-client";
  const SECRET = "lin-secret-for-tests";
  const realFetch = globalThis.fetch;
  const savedEnv = { id: process.env.LINEAR_OAUTH_CLIENT_ID, secret: process.env.LINEAR_OAUTH_CLIENT_SECRET };
  beforeEach(() => {
    process.env.LINEAR_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.LINEAR_OAUTH_CLIENT_SECRET = SECRET;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.LINEAR_OAUTH_CLIENT_ID = savedEnv.id;
    process.env.LINEAR_OAUTH_CLIENT_SECRET = savedEnv.secret;
  });

  const registry: Record<string, any> = {
    "oauthConnectors:getConnectionForTeam": getConnectionForTeam,
    "oauthConnectors:updateStoredTokens": updateStoredTokens,
    "oauthConnectors:storeConnection": storeConnection,
    "oauthConnectors:claimRefresh": claimRefresh,
  };
  /** A gate a test can hold shut: the caller stalls at that mutation until
   *  `open()` — how "provider answered, DB write not yet issued" is staged. */
  function gate() {
    let open!: () => void;
    const held = new Promise<void>((r) => { open = r; });
    let arrived!: () => void;
    const reached = new Promise<void>((r) => { arrived = r; });
    return { held, open, reached, arrived };
  }
  function actionCtx(t: Record<string, any[]>, gates: Record<string, ReturnType<typeof gate>> = {}) {
    const inner = ctx(t);
    const dispatch = async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      const fn = registry[name];
      if (!fn) throw new Error(`no test handler for ${name}`);
      const g = gates[name];
      if (g) { g.arrived(); await g.held; }
      return (fn as any)._handler(inner, args);
    };
    return { runQuery: dispatch, runMutation: dispatch, _inner: inner } as any;
  }

  /** Linear's token endpoint, answering one call at a time on command. */
  function stubLinear() {
    const pending: Array<{ body: string; resolve: (r: Response) => void }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = typeof input === "string" ? input : input.url;
      if (u !== PROVIDERS.linear.tokenUrl) throw new Error(`unexpected fetch ${u}`);
      return new Promise<Response>((resolve) => pending.push({ body: String(init?.body ?? ""), resolve }));
    }) as any;
    const answer = (i: number, body: any, status = 200) =>
      pending[i].resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    const untilCalls = async (n: number) => {
      for (let i = 0; i < 200 && pending.length < n; i++) await new Promise((r) => setTimeout(r, 0));
      if (pending.length < n) throw new Error(`provider saw ${pending.length} calls, wanted ${n}`);
    };
    return { pending, answer, untilCalls };
  }

  const pair = (n: number | string) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 86399, token_type: "Bearer" });
  const NO_CONNECTION = { ok: false, error: "no_connection: Linear is not connected for this team" };

  async function tables(opts: { expiresAt?: number } = {}) {
    return {
      users: [{ _id: OWNER }],
      teams: [{ _id: TEAM }],
      app_installations: [{
        _id: "inst_1", provider: "linear", team_id: TEAM, connected_by: OWNER, granted_scopes: ["read"],
        access_token_enc: await encryptRefreshToken("access-0", SECRET),
        refresh_token_enc: await encryptRefreshToken("refresh-0", SECRET),
        access_expires_at: opts.expiresAt, created_at: 1, updated_at: 1,
      }] as any[],
    };
  }
  const run = (t: any, gates?: Record<string, ReturnType<typeof gate>>) =>
    (getFreshAccessTokenForTeam as any)._handler(actionCtx(t, gates), { provider: "linear", team_id: TEAM });
  const stored = async (t: any) => ({
    access: await decryptRefreshToken(t.app_installations[0].access_token_enc, SECRET),
    refresh: await decryptRefreshToken(t.app_installations[0].refresh_token_enc, SECRET),
    row: t.app_installations[0],
  });
  /** A reconnect landing while a refresh is in flight. */
  const reconnect = (t: any) => (async () => (storeConnection as any)._handler(ctx(t), {
    provider: "linear", user_id: OWNER, team_id: TEAM, granted_scopes: ["read"], pending_confirm_hash: "h",
    access_token_enc: await encryptRefreshToken("access-re", SECRET),
    refresh_token_enc: await encryptRefreshToken("refresh-re", SECRET),
    access_expires_at: Date.now() + 86_399_000,
  }))();
  const expireLease = (t: any) => { t.app_installations[0].refresh_lease_until = Date.now() - 1; };

  test("an unknown-age token refreshes once; the rotated pair and expiry land together, and a fresh row skips the provider", async () => {
    const linear = stubLinear();
    const t = await tables();
    const p = run(t);
    await linear.untilCalls(1);
    expect(linear.pending[0].body).toContain("grant_type=refresh_token");
    expect(linear.pending[0].body).toContain("refresh_token=refresh-0");
    linear.answer(0, pair(1));
    expect(await p).toEqual({ ok: true, token: "access-1" });
    const s = await stored(t);
    expect([s.access, s.refresh]).toEqual(["access-1", "refresh-1"]);
    expect(s.row.access_expires_at).toBeGreaterThan(Date.now() + 86_000_000);
    expect(s.row.last_error).toBeUndefined();
    expect(s.row.refresh_lease_id).toBeUndefined();
    expect(await run(t)).toEqual({ ok: true, token: "access-1" });   // fresh: no provider call
    expect(linear.pending).toHaveLength(1);
  });

  test("two overlapping refreshes make ONE provider call; the waiter returns the claimant's pair", async () => {
    const linear = stubLinear();
    const t = await tables();
    const a = run(t);
    await linear.untilCalls(1);
    expect(typeof t.app_installations[0].refresh_lease_id).toBe("string");
    const b = run(t);
    await new Promise((r) => setTimeout(r, 400));
    expect(linear.pending).toHaveLength(1);
    linear.answer(0, pair(1));
    expect(await a).toEqual({ ok: true, token: "access-1" });
    expect(await b).toEqual({ ok: true, token: "access-1" });
    expect(linear.pending).toHaveLength(1);
    expect((await stored(t)).row.refresh_lease_id).toBeUndefined();
  });

  test("a reconnect during the await wins: the fetched pair is dropped and the caller gets the reconnect's token", async () => {
    const linear = stubLinear();
    const t = await tables();
    const a = run(t);
    await linear.untilCalls(1);
    await reconnect(t);
    linear.answer(0, pair(1));
    expect(await a).toEqual({ ok: true, token: "access-re" });
    const s = await stored(t);
    expect([s.access, s.refresh]).toEqual(["access-re", "refresh-re"]);
    expect(t.app_installations).toHaveLength(1);
  });

  test("a disconnect during the await yields no credentials and resurrects nothing", async () => {
    const linear = stubLinear();
    const t = await tables();
    const a = run(t);
    await linear.untilCalls(1);
    t.app_installations.length = 0;
    linear.answer(0, pair(1));
    expect(await a).toEqual(NO_CONNECTION);
    expect(t.app_installations).toHaveLength(0);
  });

  test("a late refusal after a reconnect stamps nothing and returns the reconnect's token", async () => {
    const linear = stubLinear();
    const t = await tables();
    const a = run(t);
    await linear.untilCalls(1);
    await reconnect(t);
    linear.answer(0, { error: "invalid_grant" }, 400);
    expect(await a).toEqual({ ok: true, token: "access-re" });
    expect(t.app_installations[0].last_error).toBeUndefined();
    expect(t.app_installations[0].refresh_lease_id).toBeUndefined();
  });

  test("a refusal with nobody else involved parks the connection with a reconnect message and loses nothing", async () => {
    const linear = stubLinear();
    const t = await tables();
    const a = run(t);
    await linear.untilCalls(1);
    linear.answer(0, { error: "invalid_grant" }, 400);
    const res = await a;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reconnect Linear");
    expect(t.app_installations[0].last_error).toContain("invalid_grant");
    expect(t.app_installations[0].refresh_lease_id).toBeUndefined();
    const s = await stored(t);
    expect([s.access, s.refresh]).toEqual(["access-0", "refresh-0"]);
  });

  test("A succeeds and stalls before its write; lease expires; B claims and succeeds; A writes first: A is refused, B's pair lands, both return B's pair", async () => {
    const linear = stubLinear();
    const t = await tables();
    const gateA = gate();
    const gateB = gate();
    const a = run(t, { "oauthConnectors:updateStoredTokens": gateA });
    await linear.untilCalls(1);
    linear.answer(0, pair("a"));             // A's provider grant succeeds ...
    await gateA.reached;                     // ... and A stalls before the DB write
    expireLease(t);                          // A's lease lapses
    const b = run(t, { "oauthConnectors:updateStoredTokens": gateB });
    await linear.untilCalls(2);              // B claimed a new lease and asked the provider
    const leaseB = t.app_installations[0].refresh_lease_id;
    linear.answer(1, pair("b"));             // B's grant succeeds too, its write delayed
    await gateB.reached;
    gateA.open();                            // A writes first
    await new Promise((r) => setTimeout(r, 300));
    const mid = await stored(t);
    expect([mid.access, mid.refresh]).toEqual(["access-0", "refresh-0"]);   // A wrote nothing
    expect(mid.row.refresh_lease_id).toBe(leaseB);                          // and cleared no lease
    gateB.open();                            // then B writes
    expect(await b).toEqual({ ok: true, token: "access-b" });
    expect(await a).toEqual({ ok: true, token: "access-b" });                 // A deferred to the owner
    const s = await stored(t);
    expect([s.access, s.refresh]).toEqual(["access-b", "refresh-b"]);
    expect(s.row.last_error).toBeUndefined();
    expect(s.row.refresh_lease_id).toBeUndefined();
  });

  test("expiry, replacement, then the OLD claimant fails late: it cannot clear the new lease or park the row, and waits for the new claimant", async () => {
    const linear = stubLinear();
    const t = await tables();
    const a = run(t);
    await linear.untilCalls(1);
    expireLease(t);
    const b = run(t);
    await linear.untilCalls(2);
    const leaseB = t.app_installations[0].refresh_lease_id;
    linear.answer(0, { error: "invalid_grant" }, 400);   // A's late failure
    await new Promise((r) => setTimeout(r, 300));
    expect(t.app_installations[0].refresh_lease_id).toBe(leaseB);   // B's lease intact
    expect(t.app_installations[0].last_error).toBeUndefined();
    linear.answer(1, pair("b"));
    expect(await b).toEqual({ ok: true, token: "access-b" });
    expect(await a).toEqual({ ok: true, token: "access-b" });
    const s = await stored(t);
    expect([s.access, s.refresh]).toEqual(["access-b", "refresh-b"]);
    expect(s.row.refresh_lease_id).toBeUndefined();
  });

  test("a lease left by a dead claimant expires and the next caller refreshes", async () => {
    const linear = stubLinear();
    const t = await tables();
    t.app_installations[0].refresh_lease_id = "dead";
    expireLease(t);
    const a = run(t);
    await linear.untilCalls(1);
    linear.answer(0, pair(1));
    expect(await a).toEqual({ ok: true, token: "access-1" });
  });

  test("claimRefresh: a stale read cannot claim, a second claim is held, each claim has its own id", async () => {
    const t = await tables();
    const enc = t.app_installations[0].access_token_enc;
    expect(await (claimRefresh as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: "not-the-row's", now: Date.now() })).toEqual({ ok: false, reason: "superseded" });
    const first = await (claimRefresh as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: enc, now: Date.now() });
    expect(first.ok).toBe(true);
    expect(typeof first.lease).toBe("string");
    expect(await (claimRefresh as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: enc, now: Date.now() })).toEqual({ ok: false, reason: "held" });
    expireLease(t);
    const second = await (claimRefresh as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: enc, now: Date.now() });
    expect(second.ok).toBe(true);
    expect(second.lease).not.toBe(first.lease);
    expect(t.app_installations[0].refresh_lease_until).toBeLessThanOrEqual(Date.now() + REFRESH_LEASE_MS);
  });

  test("updateStoredTokens: both outcomes need the exact lease AND the read ciphertext; the passing write releases the lease", async () => {
    const t = await tables();
    const enc = t.app_installations[0].access_token_enc;
    t.app_installations[0].refresh_lease_id = "current";
    const staleFail = await (updateStoredTokens as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: enc, lease: "old", last_error: "late" });
    expect(staleFail).toEqual({ ok: false, reason: "superseded" });
    const staleSuccess = await (updateStoredTokens as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: enc, lease: "old", access_token_enc: "late-enc", access_expires_at: 5 });
    expect(staleSuccess).toEqual({ ok: false, reason: "superseded" });
    const movedOn = await (updateStoredTokens as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: "other-enc", lease: "current", access_token_enc: "x", access_expires_at: 5 });
    expect(movedOn).toEqual({ ok: false, reason: "superseded" });
    expect(t.app_installations[0].last_error).toBeUndefined();
    expect(t.app_installations[0].access_token_enc).toBe(enc);
    expect(t.app_installations[0].refresh_lease_id).toBe("current");
    const ok = await (updateStoredTokens as any)._handler(ctx(t), { installation_id: "inst_1", expected_enc: enc, lease: "current", access_token_enc: "new-enc", access_expires_at: 5 });
    expect(ok).toEqual({ ok: true });
    expect(t.app_installations[0].access_token_enc).toBe("new-enc");
    expect(t.app_installations[0].refresh_lease_id).toBeUndefined();
    expect(await (updateStoredTokens as any)._handler(ctx(t), { installation_id: "nope", expected_enc: enc, lease: "x", last_error: "e" })).toEqual({ ok: false, reason: "gone" });
  });
});
