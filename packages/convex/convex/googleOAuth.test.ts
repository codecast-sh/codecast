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
  updateStoredRefreshToken,
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
  "googleOAuth:updateStoredRefreshToken": updateStoredRefreshToken,
};

// Action/httpAction ctx: no db — run* dispatches to the real registered
// handlers over the fake db, like production's runQuery/runMutation would.
function actionCtx(userId: string | null, t: Record<string, any[]>) {
  const inner = dbCtx(userId, t);
  const dispatch = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    const fn = registry[name];
    if (!fn) throw new Error(`no test handler registered for "${name}" — typo'd function path?`);
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
