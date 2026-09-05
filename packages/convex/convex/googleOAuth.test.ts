// The Google connector's load-bearing claims, tested against behavior:
//
//   The refresh token lands ENCRYPTED. The plaintext from Google's token
//   response must never appear in anything written to the db — asserted by
//   scanning every inserted doc for the sentinel, then proving the ciphertext
//   is the real token by decrypting it back (encryption, not truncation/hash).
//
//   First connect asks for the MINIMUM. The authorize URL carries
//   access_type=offline + prompt=consent (or the stored token could never
//   refresh) and ONLY gmail.readonly — send is a later incremental grant
//   (which asks readonly+send, never send alone: the callback needs the
//   profile read).
//
//   A bad state stores nothing. The callback is unauthenticated; the signed
//   state is the only user binding, so a forged/stale one must be a hard
//   reject with an untouched db.
//
//   The relay dies at confirm. A new connection is PENDING until the
//   signed-in /apps session proves it is the user the state named; a relayed
//   flow (attacker's state, victim's consent) must end with the row deleted
//   and the grant revoked at Google, and the pending row must be unusable
//   meanwhile.
//
// The run*/dispatch fakes route by getFunctionName, so a typo'd internal
// function path fails HERE, not first in prod (the `internal as any` cast has
// already disabled the compiler's check).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import {
  GMAIL_PROFILE_URL,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  callbackHandler,
  confirmConnection,
  decryptRefreshToken,
  deleteConnection,
  disconnect,
  encryptRefreshToken,
  finishConfirm,
  getConnectUrl,
  getFreshAccessToken,
  getOwnedConnection,
  listConnections,
  resolveConnectUser,
  signStateWith,
  storeConnection,
  claimRefresh,
  writeRefreshOutcome,
} from "./googleOAuth";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const OWNER = "u_owner";
const PLAINTEXT_RT = "1//refresh-token-PLAINTEXT-sentinel";

function tables(extra: Record<string, any[]> = {}) {
  return { users: [{ _id: OWNER }], google_installations: [], ...extra } as Record<string, any[]>;
}

// Session-authenticated ctx, the capabilities.test.ts shape.
function dbCtx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: { async getUserIdentity() { return userId ? { subject: `${userId}|session` } : null; } },
    db: makeFakeDb(t),
  } as any;
}

// Every internal function the actions/callback reach, keyed by its REAL
// convex path — dispatch resolves the ref's name, so a wrong path throws.
const registry: Record<string, any> = {
  "googleOAuth:resolveConnectUser": resolveConnectUser,
  "googleOAuth:storeConnection": storeConnection,
  "googleOAuth:getOwnedConnection": getOwnedConnection,
  "googleOAuth:finishConfirm": finishConfirm,
  "googleOAuth:deleteConnection": deleteConnection,
  "googleOAuth:claimRefresh": claimRefresh,
  "googleOAuth:writeRefreshOutcome": writeRefreshOutcome,
};

// Action/httpAction ctx: no db — run* dispatches to the real registered
// handlers over the fake db, like production's runQuery/runMutation would.
/** A gate a test can hold shut: the caller stalls at that function until
 *  `open()` — how "provider answered, DB write not yet issued" is staged. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((r) => { open = r; });
  let arrived!: () => void;
  const reached = new Promise<void>((r) => { arrived = r; });
  return { held, open, reached, arrived };
}
function actionCtx(userId: string | null, t: Record<string, any[]>, gates: Record<string, ReturnType<typeof gate>> = {}) {
  const inner = dbCtx(userId, t);
  const dispatch = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    const fn = registry[name];
    if (!fn) throw new Error(`no test handler registered for "${name}" — typo'd function path?`);
    const g = gates[name];
    if (g) { g.arrived(); await g.held; }
    return (fn as any)._handler(inner, args);
  };
  return { runQuery: dispatch, runMutation: dispatch, _inner: inner } as any;
}

const realFetch = globalThis.fetch;
const savedEnv = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.GOOGLE_OAUTH_CLIENT_ID = savedEnv.id;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedEnv.secret;
});

function jsonResponse(body: any) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** Stub Google: code exchange + Gmail profile + revoke. Records url AND body. */
function stubGoogle(overrides: { token?: any } = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = typeof input === "string" ? input : input.url;
    calls.push({ url: u, body: String(init?.body ?? "") });
    if (u === GOOGLE_TOKEN_URL) {
      return jsonResponse(
        overrides.token ?? {
          access_token: "ya29.test-access",
          refresh_token: PLAINTEXT_RT,
          scope: GMAIL_READONLY_SCOPE,
          expires_in: 3599,
          token_type: "Bearer",
        },
      );
    }
    if (u === GMAIL_PROFILE_URL) return jsonResponse({ emailAddress: "person@gmail.com" });
    if (u === GOOGLE_REVOKE_URL) return jsonResponse({});
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as any;
  return calls;
}

function revokeCalls(calls: Array<{ url: string; body: string }>) {
  return calls.filter((c) => c.url === GOOGLE_REVOKE_URL);
}

async function freshState(userId = OWNER) {
  return await signStateWith(CLIENT_SECRET, { user_id: userId, ts: Date.now() });
}

function callbackRequest(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return new Request(`https://convex.codecast.sh/api/webhooks/google-oauth/callback?${qs}`);
}

/** Run the callback and hand back the /apps redirect's confirm params. */
async function connectPending(ctx: any, code = "auth-code", stateUser = OWNER) {
  const resp = await callbackHandler(ctx, callbackRequest({ code, state: await freshState(stateUser) }));
  expect(resp.status).toBe(302);
  const loc = new URL(resp.headers.get("Location")!);
  expect(loc.searchParams.get("google")).toBe("pending");
  // The confirm params travel in the FRAGMENT — never in the query, where a
  // web server's access log would record the token.
  expect(loc.search).not.toContain("confirm=");
  const frag = new URLSearchParams(loc.hash.slice(1));
  return {
    installation_id: frag.get("installation")!,
    confirm_token: frag.get("confirm")!,
  };
}

/** Full happy path: callback + confirm in the same user's session. */
async function connectAndConfirm(ctx: any, code = "auth-code") {
  const p = await connectPending(ctx, code);
  const res = await (confirmConnection as any)._handler(ctx, p);
  expect(res.ok).toBe(true);
  return p;
}

/** A row as it looks after connect + confirm (no pending fields). */
function confirmedRow(enc: string, overrides: Record<string, any> = {}) {
  return {
    _id: "gi_1",
    scope_user_id: OWNER,
    email: "person@gmail.com",
    refresh_token_enc: enc,
    granted_scopes: [GMAIL_READONLY_SCOPE],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("getConnectUrl", () => {
  test("first connect: offline + consent + ONLY the readonly scope", async () => {
    const ctx = actionCtx(OWNER, tables());
    const res = await (getConnectUrl as any)._handler(ctx, {});
    expect(res.ok).toBe(true);
    const url = new URL(res.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // ONLY gmail.readonly — exact equality, so a second scope sneaking into the
    // first connect fails here.
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  test("the send grant asks readonly AND send — send alone would dead-end at the profile read", async () => {
    const ctx = actionCtx(OWNER, tables());
    const res = await (getConnectUrl as any)._handler(ctx, { grant: "gmail.send" });
    expect(res.ok).toBe(true);
    const url = new URL(res.url);
    // A send-ONLY token can't read the Gmail profile that keys the row: if the
    // earlier readonly grant was revoked (disconnect kills the whole grant),
    // the callback would discard a live send-only grant. Exact equality again.
    expect(url.searchParams.get("scope")).toBe(`${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}`);
    // Incremental: Google folds it into the existing grant.
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  test("missing env fails with a clear 'not configured', no crash", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const res = await (getConnectUrl as any)._handler(actionCtx(OWNER, tables()), {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not configured");
  });

  test("unauthenticated caller is rejected", async () => {
    const res = await (getConnectUrl as any)._handler(actionCtx(null, tables()), {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Authentication failed");
  });
});

describe("callback", () => {
  test("stores the refresh token ENCRYPTED and PENDING — plaintext appears in no inserted doc", async () => {
    stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    const pending = await connectPending(ctx);
    expect(pending.confirm_token).toBeTruthy();

    const db = ctx._inner.db;
    expect(t.google_installations).toHaveLength(1);
    // The whole write surface, scanned: nothing inserted anywhere carries the
    // plaintext refresh token — and nothing carries the confirm token either
    // (only its hash may land).
    for (const ins of db._inserted) {
      expect(JSON.stringify(ins.doc)).not.toContain(PLAINTEXT_RT);
      expect(JSON.stringify(ins.doc)).not.toContain(pending.confirm_token);
    }
    const row = t.google_installations[0];
    expect(row.refresh_token_enc).not.toContain(PLAINTEXT_RT);
    expect(row.refresh_token_enc.startsWith("v1.")).toBe(true);
    // ...and the ciphertext IS the token (real encryption, not a hash/redaction).
    expect(await decryptRefreshToken(row.refresh_token_enc, CLIENT_SECRET)).toBe(PLAINTEXT_RT);
    // The wrong key decrypts to nothing (GCM authenticates).
    expect(await decryptRefreshToken(row.refresh_token_enc, "other-secret")).toBeNull();

    expect(row.scope_user_id).toBe(OWNER);
    expect(row.email).toBe("person@gmail.com");
    expect(row.granted_scopes).toEqual([GMAIL_READONLY_SCOPE]);
    // Unconfirmed = locked: the credential path refuses the row.
    expect(row.pending_confirm_hash).toBeTruthy();
    expect(
      await (getOwnedConnection as any)._handler(dbCtx(OWNER, t), { installation_id: row._id }),
    ).toBeNull();
  });

  test("a bad state is rejected and nothing is stored", async () => {
    const calls = stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    // Tampered payload, valid-looking shape.
    const forged = `${btoa(JSON.stringify({ user_id: OWNER, ts: Date.now() }))}.deadbeef`;
    const resp = await callbackHandler(ctx, callbackRequest({ code: "auth-code", state: forged }));
    expect(resp.status).toBe(400);
    expect(t.google_installations).toHaveLength(0);
    // Rejected before any Google round-trip: the code is never exchanged.
    expect(calls).toHaveLength(0);
  });

  test("a state signed with a DIFFERENT secret is rejected", async () => {
    const calls = stubGoogle();
    const t = tables();
    const state = await signStateWith("not-the-client-secret", { user_id: OWNER, ts: Date.now() });
    const resp = await callbackHandler(actionCtx(OWNER, t), callbackRequest({ code: "c", state }));
    expect(resp.status).toBe(400);
    expect(t.google_installations).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("a stale state (past the 5-min window) is rejected", async () => {
    stubGoogle();
    const t = tables();
    const stale = await signStateWith(CLIENT_SECRET, { user_id: OWNER, ts: Date.now() - 6 * 60 * 1000 });
    const resp = await callbackHandler(actionCtx(OWNER, t), callbackRequest({ code: "c", state: stale }));
    expect(resp.status).toBe(400);
    expect(t.google_installations).toHaveLength(0);
  });

  test("user declining on the consent screen goes back to Apps, stores nothing, calls Google never", async () => {
    const calls = stubGoogle();
    const t = tables();
    const resp = await callbackHandler(actionCtx(OWNER, t), callbackRequest({ error: "access_denied" }));
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toContain("google=error");
    expect(resp.headers.get("Location")).toContain("access_denied");
    expect(t.google_installations).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("missing env answers 'not configured' instead of crashing", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const resp = await callbackHandler(actionCtx(OWNER, tables()), callbackRequest({ code: "c", state: "x.y" }));
    expect(resp.status).toBe(503);
    expect(await resp.text()).toContain("not configured");
  });

  test("re-connect while pending upserts the row; only the NEWEST confirm token works", async () => {
    stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    const first = await connectPending(ctx, "c1");
    const second = await connectPending(ctx, "c2");
    expect(t.google_installations).toHaveLength(1);
    // The first redirect's token was superseded — it must not confirm.
    const staleRes = await (confirmConnection as any)._handler(ctx, first);
    expect(staleRes.ok).toBe(false);
    const res = await (confirmConnection as any)._handler(ctx, second);
    expect(res.ok).toBe(true);
  });

  test("incremental grant on a CONFIRMED row stays confirmed, merges scopes, keeps one row", async () => {
    stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    await connectAndConfirm(ctx, "c1");
    // The send grant comes back with the FULL accumulated scope set.
    stubGoogle({
      token: {
        access_token: "ya29.test-2",
        refresh_token: "1//rotated-refresh",
        scope: `${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}`,
        expires_in: 3599,
      },
    });
    const resp = await callbackHandler(ctx, callbackRequest({ code: "c2", state: await freshState() }));
    expect(resp.status).toBe(302);
    // No re-confirmation for a row this user already proved: straight to connected.
    expect(resp.headers.get("Location")).toContain("google=connected");
    expect(t.google_installations).toHaveLength(1);
    const row = t.google_installations[0];
    expect(row.pending_confirm_hash).toBeFalsy();
    expect(row.granted_scopes).toEqual([GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]);
    expect(await decryptRefreshToken(row.refresh_token_enc, CLIENT_SECRET)).toBe("1//rotated-refresh");
  });
});

describe("confirmConnection (the relay defense)", () => {
  test("the initiating user confirms: row activates and becomes usable; re-click is a no-op success", async () => {
    stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    const p = await connectAndConfirm(ctx);
    const row = t.google_installations[0];
    expect(row.pending_confirm_hash).toBeFalsy();
    expect(
      await (getOwnedConnection as any)._handler(dbCtx(OWNER, t), { installation_id: row._id }),
    ).not.toBeNull();
    // A re-clicked confirmation link must not error a healthy connection.
    const again = await (confirmConnection as any)._handler(ctx, p);
    expect(again.ok).toBe(true);
  });

  test("RELAYED flow: attacker's state + victim's consent → victim's confirm deletes the row and revokes the grant", async () => {
    const calls = stubGoogle();
    const t = tables({ users: [{ _id: "u_attacker" }, { _id: "u_victim" }] });
    // Attacker mints the URL (state names the attacker), victim consents:
    // the callback binds the VICTIM's Gmail to the ATTACKER's user id.
    const victimBrowser = actionCtx("u_victim", t);
    const p = await connectPending(victimBrowser, "auth-code", "u_attacker");
    expect(t.google_installations).toHaveLength(1);
    // The confirm params landed in the VICTIM's redirect; the victim is
    // signed in as themselves, not as the state's user.
    const res = await (confirmConnection as any)._handler(victimBrowser, p);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("DIFFERENT codecast account");
    // The poisoned row is gone AND the grant was revoked at Google with the
    // victim's real refresh token.
    expect(t.google_installations).toHaveLength(0);
    const revokes = revokeCalls(calls);
    expect(revokes).toHaveLength(1);
    expect(new URLSearchParams(revokes[0].body).get("token")).toBe(PLAINTEXT_RT);
  });

  test("the attacker cannot confirm without the token: guessed token rejected, row stays pending and unusable", async () => {
    const calls = stubGoogle();
    const t = tables({ users: [{ _id: "u_attacker" }, { _id: "u_victim" }] });
    const p = await connectPending(actionCtx("u_victim", t), "auth-code", "u_attacker");
    // The attacker knows the row exists (it's theirs by state) but never saw
    // the redirect that carries the token.
    const res = await (confirmConnection as any)._handler(actionCtx("u_attacker", t), {
      installation_id: p.installation_id,
      confirm_token: "guessed-token",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Confirmation token mismatch");
    expect(t.google_installations).toHaveLength(1);
    expect(revokeCalls(calls)).toHaveLength(0);
    // Still pending → still unusable through the credential path.
    const fresh = await (getFreshAccessToken as any)._handler(actionCtx("u_attacker", t), {
      installation_id: p.installation_id,
    });
    expect(fresh.ok).toBe(false);
  });

  test("an expired confirmation deletes the row and revokes the orphaned grant", async () => {
    const calls = stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    const p = await connectPending(ctx);
    t.google_installations[0].pending_expires_at = Date.now() - 1;
    const res = await (confirmConnection as any)._handler(ctx, p);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("expired");
    expect(res.error).toContain("Apps tab"); // says what to do next
    expect(t.google_installations).toHaveLength(0);
    const revokes = revokeCalls(calls);
    expect(revokes).toHaveLength(1);
    expect(new URLSearchParams(revokes[0].body).get("token")).toBe(PLAINTEXT_RT);
  });

  test("unknown installation and unauthenticated caller are actionable rejections", async () => {
    stubGoogle();
    const t = tables();
    const missing = await (confirmConnection as any)._handler(actionCtx(OWNER, t), {
      installation_id: "gi_nope",
      confirm_token: "x",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("Apps tab");
    const anon = await (confirmConnection as any)._handler(actionCtx(null, t), {
      installation_id: "gi_nope",
      confirm_token: "x",
    });
    expect(anon.ok).toBe(false);
    expect(anon.error).toContain("sign in");
  });
});

describe("getFreshAccessToken", () => {
  test("decrypts the stored token, exchanges it, and returns a fresh access token", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET);
    const t = tables({ google_installations: [confirmedRow(enc)] });
    let sentBody = "";
    globalThis.fetch = (async (input: any, init: any) => {
      const u = typeof input === "string" ? input : input.url;
      if (u !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch: ${u}`);
      sentBody = String(init?.body ?? "");
      return jsonResponse({ access_token: "ya29.fresh", expires_in: 3599 });
    }) as any;
    const res = await (getFreshAccessToken as any)._handler(actionCtx(OWNER, t), { installation_id: "gi_1" });
    expect(res.ok).toBe(true);
    expect(res.access_token).toBe("ya29.fresh");
    const sent = new URLSearchParams(sentBody);
    // The DECRYPTED token went to Google, with the refresh grant.
    expect(sent.get("refresh_token")).toBe(PLAINTEXT_RT);
    expect(sent.get("grant_type")).toBe("refresh_token");
  });

  test("a ROTATED refresh token in the response is re-encrypted and persisted", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET);
    const t = tables({ google_installations: [confirmedRow(enc)] });
    globalThis.fetch = (async () =>
      jsonResponse({ access_token: "ya29.fresh", refresh_token: "1//rotated", expires_in: 3599 })) as any;
    const res = await (getFreshAccessToken as any)._handler(actionCtx(OWNER, t), { installation_id: "gi_1" });
    expect(res.ok).toBe(true);
    const row = t.google_installations[0];
    // Stored ciphertext now holds the NEW token (still encrypted, never plaintext).
    expect(row.refresh_token_enc).not.toContain("1//rotated");
    expect(await decryptRefreshToken(row.refresh_token_enc, CLIENT_SECRET)).toBe("1//rotated");
  });

  test("invalid_grant reports 'reconnect', not a throw", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET);
    const t = tables({ google_installations: [confirmedRow(enc)] });
    globalThis.fetch = (async () => jsonResponse({ error: "invalid_grant" })) as any;
    const res = await (getFreshAccessToken as any)._handler(actionCtx(OWNER, t), { installation_id: "gi_1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid_grant");
    expect(res.error).toContain("reconnect Gmail");
  });

  test("an undecryptable ciphertext (rotated OAuth secret) says what to do next", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, "the-old-secret");
    const t = tables({ google_installations: [confirmedRow(enc)] });
    const res = await (getFreshAccessToken as any)._handler(actionCtx(OWNER, t), { installation_id: "gi_1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reconnect Gmail");
  });

  test("another user cannot refresh a connection they don't own", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET);
    const t = tables({
      users: [{ _id: OWNER }, { _id: "u_other" }],
      google_installations: [confirmedRow(enc)],
    });
    const res = await (getFreshAccessToken as any)._handler(actionCtx("u_other", t), { installation_id: "gi_1" });
    expect(res.ok).toBe(false);
  });
});

describe("disconnect", () => {
  test("owner: revokes the DECRYPTED token at Google, then deletes the row", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET);
    const t = tables({ google_installations: [confirmedRow(enc)] });
    const calls = stubGoogle();
    const res = await (disconnect as any)._handler(actionCtx(OWNER, t), { installation_id: "gi_1" });
    expect(res.ok).toBe(true);
    expect(t.google_installations).toHaveLength(0);
    const revokes = revokeCalls(calls);
    expect(revokes).toHaveLength(1);
    expect(new URLSearchParams(revokes[0].body).get("token")).toBe(PLAINTEXT_RT);
  });

  test("non-owner: rejected, row intact, Google never called", async () => {
    const enc = await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET);
    const t = tables({
      users: [{ _id: OWNER }, { _id: "u_other" }],
      google_installations: [confirmedRow(enc)],
    });
    const calls = stubGoogle();
    const res = await (disconnect as any)._handler(actionCtx("u_other", t), { installation_id: "gi_1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Apps tab"); // says where to look next
    expect(t.google_installations).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("a PENDING row can be disconnected (abandoned half-connect cleanup)", async () => {
    stubGoogle();
    const t = tables();
    const ctx = actionCtx(OWNER, t);
    const p = await connectPending(ctx);
    const res = await (disconnect as any)._handler(ctx, { installation_id: p.installation_id });
    expect(res.ok).toBe(true);
    expect(t.google_installations).toHaveLength(0);
  });
});

describe("listConnections", () => {
  test("returns the caller's rows WITHOUT the ciphertext, with an honest pending flag", async () => {
    stubGoogle();
    const t = tables({ users: [{ _id: OWNER }, { _id: "u_other" }] });
    const ctx = actionCtx(OWNER, t);
    const p = await connectPending(ctx);

    let mine = await (listConnections as any)._handler(dbCtx(OWNER, t), {});
    expect(mine).toHaveLength(1);
    expect(mine[0].email).toBe("person@gmail.com");
    expect(mine[0].granted_scopes).toEqual([GMAIL_READONLY_SCOPE]);
    expect(mine[0].pending).toBe(true);
    // Neither the ciphertext nor the confirm-token hash leaks to the client.
    expect(JSON.stringify(mine)).not.toContain("refresh_token_enc");
    expect(JSON.stringify(mine)).not.toContain("pending_confirm_hash");

    await (confirmConnection as any)._handler(ctx, p);
    mine = await (listConnections as any)._handler(dbCtx(OWNER, t), {});
    expect(mine[0].pending).toBe(false);

    // Another user sees nothing; an unauthenticated caller sees nothing.
    expect(await (listConnections as any)._handler(dbCtx("u_other", t), {})).toHaveLength(0);
    expect(await (listConnections as any)._handler(dbCtx(null, t), {})).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------
 * Single flight refresh (lib/tokenRefresh) on the Gmail connection: the
 * provider answers only when the test says so, which is how two refreshes,
 * a reconnect, or a disconnect are made to overlap the await.
 * ---------------------------------------------------------------------- */
describe("getFreshAccessToken: cache, single flight and fenced writes", () => {
  function stubGoogleDeferred() {
    const pending: Array<{ body: string; resolve: (r: Response) => void }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = typeof input === "string" ? input : input.url;
      if (u !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch: ${u}`);
      return new Promise<Response>((resolve) => pending.push({ body: String(init?.body ?? ""), resolve }));
    }) as any;
    const answer = (i: number, body: any, status = 200) =>
      pending[i].resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    const untilCalls = async (n: number) => {
      for (let i = 0; i < 200 && pending.length < n; i++) await new Promise((r) => setTimeout(r, 0));
      if (pending.length < n) throw new Error(`Google saw ${pending.length} calls, wanted ${n}`);
    };
    return { pending, answer, untilCalls };
  }
  const grant = (n: string, rotate = false) => ({ access_token: `ya29.${n}`, expires_in: 3599, ...(rotate ? { refresh_token: `1//${n}` } : {}) });
  const run = (t: any, gates?: Record<string, ReturnType<typeof gate>>) =>
    (getFreshAccessToken as any)._handler(actionCtx(OWNER, t, gates), { installation_id: "gi_1" });
  const seeded = async () => tables({ google_installations: [confirmedRow(await encryptRefreshToken(PLAINTEXT_RT, CLIENT_SECRET))] });
  const cached = async (t: any) => (t.google_installations[0]?.access_token_enc ? decryptRefreshToken(t.google_installations[0].access_token_enc, CLIENT_SECRET) : null);
  const reconnect = (t: any) => (async () => (storeConnection as any)._handler(dbCtx(OWNER, t), {
    user_id: OWNER, email: "person@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE], pending_confirm_hash: "h",
    refresh_token_enc: await encryptRefreshToken("1//reconnected", CLIENT_SECRET),
  }))();

  test("a row from before caching refreshes once, caches the token with its expiry, and the next call skips Google", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const a = run(t);
    await google.untilCalls(1);
    google.answer(0, grant("one"));
    const res = await a;
    expect(res.ok).toBe(true);
    expect(res.access_token).toBe("ya29.one");
    expect(res.expires_in).toBeGreaterThan(3500);
    expect(await cached(t)).toBe("ya29.one");
    expect(t.google_installations[0].access_expires_at).toBeGreaterThan(Date.now() + 3_500_000);
    expect(t.google_installations[0].refresh_lease_id).toBeUndefined();
    const again = await run(t);
    expect(again.access_token).toBe("ya29.one");
    expect(google.pending).toHaveLength(1);   // served from the cache
  });

  test("two overlapping refreshes make ONE Google call; the waiter returns the claimant's token", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const a = run(t);
    await google.untilCalls(1);
    const b = run(t);
    await new Promise((r) => setTimeout(r, 400));
    expect(google.pending).toHaveLength(1);
    google.answer(0, grant("one", true));
    expect((await a).access_token).toBe("ya29.one");
    expect((await b).access_token).toBe("ya29.one");
    expect(google.pending).toHaveLength(1);
    expect(await decryptRefreshToken(t.google_installations[0].refresh_token_enc, CLIENT_SECRET)).toBe("1//one");
  });

  test("a reconnect during the await wins: the fetched pair is dropped and the caller refreshes once more on the new grant", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const a = run(t);
    await google.untilCalls(1);
    await reconnect(t);
    google.answer(0, grant("stale", true));   // refused: the row moved on
    await google.untilCalls(2);               // second grant, with the reconnected refresh token
    expect(new URLSearchParams(google.pending[1].body).get("refresh_token")).toBe("1//reconnected");
    google.answer(1, grant("fresh"));
    const res = await a;
    expect(res.access_token).toBe("ya29.fresh");
    expect(await cached(t)).toBe("ya29.fresh");
    expect(await decryptRefreshToken(t.google_installations[0].refresh_token_enc, CLIENT_SECRET)).toBe("1//reconnected");
    expect(t.google_installations).toHaveLength(1);
  });

  test("PRE-CLAIM reconnect: A reads the old grant, the reconnect lands before A claims; A's stale claim is refused and the only Google call carries the reconnected grant", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const g = gate();
    const a = run(t, { "googleOAuth:claimRefresh": g });
    await g.reached;                                       // read done, claim not yet issued
    await reconnect(t);                                    // new refresh grant, still no access ciphertext
    g.open();
    await google.untilCalls(1);
    expect(new URLSearchParams(google.pending[0].body).get("refresh_token")).toBe("1//reconnected");
    google.answer(0, grant("fresh", true));
    const res = await a;
    expect(res.access_token).toBe("ya29.fresh");
    expect(google.pending).toHaveLength(1);                // the old grant was never sent
    expect(await decryptRefreshToken(t.google_installations[0].refresh_token_enc, CLIENT_SECRET)).toBe("1//fresh");
    expect(await cached(t)).toBe("ya29.fresh");
  });

  test("a disconnect during the await yields no credentials and resurrects nothing", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const a = run(t);
    await google.untilCalls(1);
    t.google_installations.length = 0;
    google.answer(0, grant("one"));
    const res = await a;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No such Gmail connection");
    expect(t.google_installations).toHaveLength(0);
  });

  test("A succeeds and stalls before its write; lease expires; B claims and succeeds; A writes first: A is refused, B's pair lands, both return B's token", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const gateA = gate();
    const gateB = gate();
    const a = run(t, { "googleOAuth:writeRefreshOutcome": gateA });
    await google.untilCalls(1);
    google.answer(0, grant("a", true));
    await gateA.reached;
    t.google_installations[0].refresh_lease_until = Date.now() - 1;   // A looks dead
    const b = run(t, { "googleOAuth:writeRefreshOutcome": gateB });
    await google.untilCalls(2);
    const leaseB = t.google_installations[0].refresh_lease_id;
    google.answer(1, grant("b", true));
    await gateB.reached;
    gateA.open();
    await new Promise((r) => setTimeout(r, 300));
    expect(await cached(t)).toBeNull();                                  // A wrote nothing
    expect(t.google_installations[0].refresh_lease_id).toBe(leaseB);    // and cleared no lease
    gateB.open();
    expect((await b).access_token).toBe("ya29.b");
    expect((await a).access_token).toBe("ya29.b");
    expect(await cached(t)).toBe("ya29.b");
    expect(await decryptRefreshToken(t.google_installations[0].refresh_token_enc, CLIENT_SECRET)).toBe("1//b");
    expect(t.google_installations[0].refresh_lease_id).toBeUndefined();
  });

  test("a late invalid_grant after a reconnect stamps nothing on the reconnected row", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const a = run(t);
    await google.untilCalls(1);
    await reconnect(t);
    google.answer(0, { error: "invalid_grant" }, 400);   // refused: not ours to park
    await google.untilCalls(2);                            // refreshes again on the new grant
    google.answer(1, grant("fresh"));
    expect((await a).access_token).toBe("ya29.fresh");
    expect(t.google_installations[0].last_error).toBeUndefined();
    expect(t.google_installations[0].refresh_lease_id).toBeUndefined();
  });

  test("invalid_grant alone parks the row with the reconnect hint and releases the lease", async () => {
    const google = stubGoogleDeferred();
    const t = await seeded();
    const a = run(t);
    await google.untilCalls(1);
    google.answer(0, { error: "invalid_grant" }, 400);
    const res = await a;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reconnect Gmail");
    expect(t.google_installations[0].last_error).toContain("invalid_grant");
    expect(t.google_installations[0].refresh_lease_id).toBeUndefined();
  });
});
