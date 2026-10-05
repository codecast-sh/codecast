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
  storeConnection,
  claimRefresh,
  writeRefreshOutcome,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FULL_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GOOGLE_RETURN_PATHS,
  getAccessTokenForUser,
  googleAccessTokenForUser,
  googleScopeGranted,
  pickConnectionForUser,
  connectionScopesForUser,
  googleAccount,
  rankGoogleConnections,
} from "./googleOAuth";
import { signStateWith } from "./lib/hmac";

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
  "googleOAuth:pickConnectionForUser": pickConnectionForUser,
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
    expect(res.error).toBe("signed_out");
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
    expect(res.error).toBe("wrong_account");
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
    expect(res.error).toBe("bad_token");
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
    expect(res.error).toBe("expired");
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
    expect(missing.error).toBe("no_such_installation");
    const anon = await (confirmConnection as any)._handler(actionCtx(null, t), {
      installation_id: "gi_nope",
      confirm_token: "x",
    });
    expect(anon.ok).toBe(false);
    expect(anon.error).toBe("signed_out");
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
    expect(res.error).toBe("no_such_installation");
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
    expect(mine[0].can).toEqual({ read_mail: true, modify_mail: false, send_mail: false, calendar: false });
    expect(mine[0].pending).toBe(true);
    expect(mine[0].assistant).toBe(false);
    // Neither the ciphertext nor the confirm-token hash leaks to the client.
    expect(JSON.stringify(mine)).not.toContain("refresh_token_enc");
    expect(JSON.stringify(mine)).not.toContain("pending_confirm_hash");

    await (confirmConnection as any)._handler(ctx, p);
    mine = await (listConnections as any)._handler(dbCtx(OWNER, t), {});
    expect(mine[0].pending).toBe(false);
    expect(mine[0].assistant).toBe(true);

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

  test("the generic path refuses the released Linear action's access-only stamp: Gmail never accepts a legacy form", async () => {
    const t = await seeded();
    t.google_installations[0].access_token_enc = "cached-enc";
    const claim = await (claimRefresh as any)._handler(dbCtx(OWNER, t), { installation_id: "gi_1", expected_enc: "cached-enc", now: Date.now() });
    expect(claim).toEqual({ ok: false, reason: "superseded" });
    const write = await (writeRefreshOutcome as any)._handler(dbCtx(OWNER, t), { installation_id: "gi_1", expected_enc: "cached-enc", lease: "any", refresh_token_enc: "late" });
    expect(write).toEqual({ ok: false, reason: "superseded" });
    expect(t.google_installations[0].refresh_token_enc).not.toBe("late");
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

describe("incremental grants: Gmail modify and Calendar", () => {
  const scopeOf = async (args: any) => {
    const res = await (getConnectUrl as any)._handler(actionCtx(OWNER, tables()), args);
    expect(res.ok).toBe(true);
    return new URL(res.url).searchParams.get("scope");
  };

  test("each grant asks readonly AND the grant, never the grant alone", async () => {
    expect(await scopeOf({ grant: "gmail.modify" })).toBe(`${GMAIL_READONLY_SCOPE} ${GMAIL_MODIFY_SCOPE}`);
    expect(await scopeOf({ grant: "calendar.events" })).toBe(`${GMAIL_READONLY_SCOPE} ${CALENDAR_EVENTS_SCOPE}`);
  });

  test("several grants in one ask: mail and calendar together, each scope once", async () => {
    expect(await scopeOf({ grant: ["gmail.modify", "calendar.events", "gmail.modify"] })).toBe(
      `${GMAIL_READONLY_SCOPE} ${GMAIL_MODIFY_SCOPE} ${CALENDAR_EVENTS_SCOPE}`,
    );
  });

  test("a broader grant covers the narrower call; nothing covers a scope never granted", () => {
    expect(googleScopeGranted([GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE], GMAIL_SEND_SCOPE)).toBe(true);
    expect(googleScopeGranted([GMAIL_MODIFY_SCOPE], GMAIL_READONLY_SCOPE)).toBe(true);
    expect(googleScopeGranted([CALENDAR_FULL_SCOPE], CALENDAR_EVENTS_SCOPE)).toBe(true);
    expect(googleScopeGranted([GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE], GMAIL_MODIFY_SCOPE)).toBe(false);
    expect(googleScopeGranted([GMAIL_READONLY_SCOPE], CALENDAR_EVENTS_SCOPE)).toBe(false);
  });
});

describe("return_to: where the connect lands", () => {
  async function landing(args: any, reqParams: (state: string) => Record<string, string>) {
    stubGoogle();
    const ctx = actionCtx(OWNER, tables());
    const minted = await (getConnectUrl as any)._handler(ctx, args);
    expect(minted.ok).toBe(true);
    const state = new URL(minted.url).searchParams.get("state")!;
    const resp = await callbackHandler(ctx, callbackRequest(reqParams(state)));
    return new URL(resp.headers.get("Location")!);
  }

  test("no return_to lands on the settings page, which runs the confirm step", async () => {
    const loc = await landing({}, (state) => ({ code: "c", state }));
    expect(loc.pathname).toBe("/settings/integrations");
    expect(loc.searchParams.get("google")).toBe("pending");
    expect(new URLSearchParams(loc.hash.slice(1)).get("confirm")).toBeTruthy();
  });

  test("an allowed page rides the signed state: the simple lane gets its own confirm, and its own errors", async () => {
    const loc = await landing({ return_to: "/simple/connections" }, (state) => ({ code: "c", state }));
    expect(loc.pathname).toBe("/simple/connections");
    expect(loc.searchParams.get("google")).toBe("pending");
    const declined = await landing({ return_to: "/welcome" }, (state) => ({ error: "access_denied", state }));
    expect(declined.pathname).toBe("/welcome");
    expect(declined.searchParams.get("google")).toBe("error");
  });

  test("any other path is refused at mint: an off-list page could read the confirm token", async () => {
    for (const bad of ["/a/attacker-page", "https://evil.example/simple/connections", "//evil.example", "/settings/integrations/../../a/x"]) {
      const res = await (getConnectUrl as any)._handler(actionCtx(OWNER, tables()), { return_to: bad });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("return_to must be one of");
    }
    expect([...GOOGLE_RETURN_PATHS]).toEqual(["/settings/integrations", "/simple/connections", "/welcome"]);
  });

  test("the callback re-checks the list: even a validly signed off-list path lands on the default", async () => {
    stubGoogle();
    const state = await signStateWith(CLIENT_SECRET, { user_id: OWNER, ts: Date.now(), return_to: "/a/attacker-page" });
    const resp = await callbackHandler(actionCtx(OWNER, tables()), callbackRequest({ code: "c", state }));
    expect(new URL(resp.headers.get("Location")!).pathname).toBe("/settings/integrations");
  });

  test("an unverified state cannot pick the landing page of a decline", async () => {
    const forged = btoa(JSON.stringify({ user_id: OWNER, ts: Date.now(), return_to: "/welcome" })) + ".bad";
    const resp = await callbackHandler(actionCtx(OWNER, tables()), callbackRequest({ error: "access_denied", state: forged }));
    expect(new URL(resp.headers.get("Location")!).pathname).toBe("/settings/integrations");
  });
});

describe("googleAccessTokenForUser: the assistant's token getter", () => {
  const OTHER = "u_other";
  const tokenResponse = () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = typeof input === "string" ? input : input.url;
      if (u !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch: ${u}`);
      calls.push(String(init?.body ?? ""));
      return jsonResponse({ access_token: "ya29.for-the-tool", expires_in: 3599 });
    }) as any;
    return calls;
  };
  // A server ctx with NO session: the turn engine's action. Only the user id
  // the engine resolved says whose connection this is.
  const serverCtx = (t: Record<string, any[]>) => actionCtx(null, t);
  const rows = async (...overrides: Record<string, any>[]) =>
    tables({
      users: [{ _id: OWNER }, { _id: OTHER }],
      google_installations: await Promise.all(
        overrides.map(async (o, i) => confirmedRow(await encryptRefreshToken(`1//rt-${i}`, CLIENT_SECRET), { _id: `gi_${i + 1}`, ...o })),
      ),
    });

  test("no Google client configured: not_configured, nothing read", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const res = await googleAccessTokenForUser(serverCtx(await rows({})), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE });
    expect(res).toMatchObject({ ok: false, code: "not_configured" });
  });

  test("no confirmed connection: not_connected (a pending row does not count)", async () => {
    tokenResponse();
    const none = await googleAccessTokenForUser(serverCtx(tables()), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE });
    expect(none).toMatchObject({ ok: false, code: "not_connected" });
    expect((none as any).error).toContain("Not connected");
    const pending = await rows({ pending_confirm_hash: "h", pending_expires_at: Date.now() + 60_000 });
    expect(await googleAccessTokenForUser(serverCtx(pending), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE })).toMatchObject({
      ok: false,
      code: "not_connected",
    });
  });

  test("connected without the scope: missing_scope, naming the grant to ask for", async () => {
    tokenResponse();
    const res = await googleAccessTokenForUser(serverCtx(await rows({})), { user_id: OWNER, scope: CALENDAR_EVENTS_SCOPE });
    expect(res).toMatchObject({ ok: false, code: "missing_scope", grant: "calendar.events" });
    expect((res as any).error).toContain("Missing scope");
  });

  test("picks the connection that holds the scope and returns a fresh token, with no session or api token", async () => {
    const calls = tokenResponse();
    const t = await rows(
      { email: "home@gmail.com", updated_at: 5 },
      { email: "work@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE], updated_at: 1 },
    );
    const res = await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: CALENDAR_EVENTS_SCOPE });
    expect(res).toMatchObject({ ok: true, access_token: "ya29.for-the-tool", email: "work@gmail.com", installation_id: "gi_2" });
    expect(new URLSearchParams(calls[0]).get("refresh_token")).toBe("1//rt-1");
    // Cached: the next ask for the same connection skips Google.
    await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: CALENDAR_EVENTS_SCOPE });
    expect(calls).toHaveLength(1);
  });

  test("a broader grant serves a narrower scope, and `email` pins the account", async () => {
    tokenResponse();
    const t = await rows(
      { email: "a@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE], updated_at: 1 },
      { email: "b@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE], updated_at: 9 },
    );
    expect(await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_SEND_SCOPE })).toMatchObject({
      ok: true,
      email: "a@gmail.com",
    });
    expect(
      await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_MODIFY_SCOPE, email: "b@gmail.com" }),
    ).toMatchObject({ ok: false, code: "missing_scope", grant: "gmail.modify" });
  });

  test("never another user's connection", async () => {
    tokenResponse();
    const t = await rows({ scope_user_id: OTHER });
    expect(await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE })).toMatchObject({
      ok: false,
      code: "not_connected",
    });
  });

  test("a revoked grant is reconnect, not a throw", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })) as any;
    const res = await googleAccessTokenForUser(serverCtx(await rows({})), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE });
    expect(res).toMatchObject({ ok: false, code: "reconnect" });
  });

  /** Google refuses one refresh token (revoked) and grants the rest. */
  const revokeOne = (revoked: string) => {
    const calls: string[] = [];
    globalThis.fetch = (async (_input: any, init?: any) => {
      const refresh = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
      calls.push(refresh ?? "");
      return refresh === revoked
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })
        : jsonResponse({ access_token: `ya29.${refresh}`, expires_in: 3599 });
    }) as any;
    return calls;
  };

  test("a revoked newest connection hands over to an older one that works, and is tried last from then on", async () => {
    const calls = revokeOne("1//rt-0");
    const t = await rows({ email: "new@gmail.com", updated_at: 9 }, { email: "old@gmail.com", updated_at: 1 });
    const first = await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE });
    expect(first).toMatchObject({ ok: true, email: "old@gmail.com", installation_id: "gi_2", access_token: "ya29.1//rt-1" });
    expect(calls).toEqual(["1//rt-0", "1//rt-1"]);
    // The dead row now carries last_error, so the next ask goes straight to
    // the working one (cached, so Google is not called again either).
    expect(t.google_installations[0].last_error).toContain("invalid_grant");
    expect(t.google_installations[0].last_error_kind).toBe("revoked");
    const again = await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE });
    expect(again).toMatchObject({ ok: true, email: "old@gmail.com" });
    expect(calls).toHaveLength(2);
  });

  test("a pinned account never falls back to another, and every dead connection reads as reconnect", async () => {
    revokeOne("1//rt-0");
    const t = await rows({ email: "new@gmail.com", updated_at: 9 }, { email: "old@gmail.com", updated_at: 1 });
    expect(
      await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE, email: "new@gmail.com" }),
    ).toMatchObject({ ok: false, code: "reconnect" });
    // Every candidate dead: the answer is the first one's failure.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })) as any;
    const all = await rows({ email: "new@gmail.com", updated_at: 9 }, { email: "old@gmail.com", updated_at: 1 });
    expect(await googleAccessTokenForUser(serverCtx(all), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE })).toMatchObject({
      ok: false,
      code: "reconnect",
    });
  });

  test("one account rule: healthy first, then the one that allows the most, then the newest", () => {
    const readOnly = { email: "r@gmail.com", granted_scopes: [GMAIL_READONLY_SCOPE], updated_at: 9 };
    const full = { email: "f@gmail.com", granted_scopes: [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE], updated_at: 1 };
    const deadFull = { ...full, email: "d@gmail.com", updated_at: 5, last_error_kind: "revoked" as const };
    const unreadable = { ...full, email: "u@gmail.com", updated_at: 6, last_error_kind: "undecryptable" as const };
    const olderReadOnly = { ...readOnly, email: "o@gmail.com", updated_at: 2 };
    expect(rankGoogleConnections([readOnly, deadFull, olderReadOnly, unreadable, full]).map((c) => c.email)).toEqual([
      "f@gmail.com",
      "r@gmail.com",
      "o@gmail.com",
      "u@gmail.com",
      "d@gmail.com",
    ]);
    expect(googleAccount([deadFull, readOnly])?.email).toBe("r@gmail.com");
    // A failure the next call may clear moves nothing.
    expect(googleAccount([readOnly, { ...full, last_error_kind: "transient" as const }])?.email).toBe("f@gmail.com");
    expect(googleAccount([])).toBeUndefined();
  });

  test("a pinned account that died fails its turn, and every reader then moves to the healthy one", async () => {
    revokeOne("1//rt-0");
    const t = await rows({ email: "new@gmail.com", updated_at: 9 }, { email: "old@gmail.com", updated_at: 1 });
    // Equal grants, both healthy: the newest is the turn's account.
    const before = await (connectionScopesForUser as any)._handler(dbCtx(null, t), { user_id: OWNER });
    expect(googleAccount(before)?.email).toBe("new@gmail.com");
    expect(
      await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE, email: "new@gmail.com" }),
    ).toMatchObject({ ok: false, code: "reconnect" });
    // The failure ranks it last: the next turn's account, the getter's first
    // candidate and the Connections screen's mark all name the live one.
    const after = await (connectionScopesForUser as any)._handler(dbCtx(null, t), { user_id: OWNER });
    expect(after.map((c: any) => [c.email, c.last_error_kind ?? null])).toEqual([["old@gmail.com", null], ["new@gmail.com", "revoked"]]);
    expect(googleAccount(after)?.email).toBe("old@gmail.com");
    const picked = await (pickConnectionForUser as any)._handler(dbCtx(null, t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE });
    expect(picked.candidates.map((c: any) => c.email)).toEqual(["old@gmail.com", "new@gmail.com"]);
    const listed = await (listConnections as any)._handler(dbCtx(OWNER, t), {});
    expect(listed.filter((r: any) => r.assistant).map((r: any) => r.email)).toEqual(["old@gmail.com"]);
    expect(
      await googleAccessTokenForUser(serverCtx(t), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE, email: "old@gmail.com" }),
    ).toMatchObject({ ok: true, email: "old@gmail.com" });
  });

  test("the failure code comes from the refresh's kind, not its wording: an unreadable token is reconnect, a 5xx is unavailable", async () => {
    tokenResponse();
    const unreadable = await rows({ refresh_token_enc: "not-a-ciphertext" });
    expect(await googleAccessTokenForUser(serverCtx(unreadable), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE })).toMatchObject({
      ok: false,
      code: "reconnect",
    });
    // The release records it, so the account ranks like a revoked one, and
    // the lease is free for the next caller.
    expect(unreadable.google_installations[0]).toMatchObject({ last_error_kind: "undecryptable", refresh_lease_id: undefined });
    expect(unreadable.google_installations[0].last_error).toContain("cannot be read");
    let asked = 0;
    globalThis.fetch = (async () => {
      asked++;
      return new Response(JSON.stringify({ error: "backend_error" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }) as any;
    const down = await rows({ email: "a@gmail.com", updated_at: 9 }, { email: "b@gmail.com", updated_at: 1 });
    expect(await googleAccessTokenForUser(serverCtx(down), { user_id: OWNER, scope: GMAIL_READONLY_SCOPE })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    // A passing outage is no reason to answer from the other account.
    expect(asked).toBe(1);
  });

  test("a transient failure on the turn's account keeps it the turn's account, and the next good refresh clears the stamp", async () => {
    // A full grant (the turn's account) and a readonly one, both healthy.
    const t = await rows(
      { email: "full@gmail.com", granted_scopes: [GMAIL_MODIFY_SCOPE, CALENDAR_EVENTS_SCOPE], updated_at: 1 },
      { email: "ro@gmail.com", updated_at: 9 },
    );
    const account = async () => googleAccount(await (connectionScopesForUser as any)._handler(dbCtx(null, t), { user_id: OWNER }))?.email;
    expect(await account()).toBe("full@gmail.com");
    const pinned = { user_id: OWNER, scope: GMAIL_READONLY_SCOPE, email: "full@gmail.com" };
    // Google answers 503 once, then is unreachable once.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "backend_error" }), { status: 503, headers: { "Content-Type": "application/json" } })) as any;
    expect(await googleAccessTokenForUser(serverCtx(t), pinned)).toMatchObject({ ok: false, code: "unavailable" });
    expect(t.google_installations[0]).toMatchObject({ last_error_kind: "transient" });
    expect(await account()).toBe("full@gmail.com");
    globalThis.fetch = (async () => { throw new Error("network down"); }) as any;
    expect(await googleAccessTokenForUser(serverCtx(t), pinned)).toMatchObject({ ok: false, code: "unavailable" });
    expect(await account()).toBe("full@gmail.com");
    const listed = await (listConnections as any)._handler(dbCtx(OWNER, t), {});
    expect(listed.filter((r: any) => r.assistant).map((r: any) => r.email)).toEqual(["full@gmail.com"]);
    // Google is back: the same pinned account refreshes and the stamp goes.
    tokenResponse();
    expect(await googleAccessTokenForUser(serverCtx(t), pinned)).toMatchObject({ ok: true, email: "full@gmail.com" });
    expect(t.google_installations[0].last_error).toBeUndefined();
    expect(t.google_installations[0].last_error_kind).toBeUndefined();
  });

  test("the internal action answers the same as the helper", async () => {
    tokenResponse();
    const res = await (getAccessTokenForUser as any)._handler(serverCtx(await rows({})), {
      user_id: OWNER,
      scope: GMAIL_READONLY_SCOPE,
    });
    expect(res).toMatchObject({ ok: true, access_token: "ya29.for-the-tool", email: "person@gmail.com" });
  });
});
