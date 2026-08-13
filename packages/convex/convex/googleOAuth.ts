// The Google (Gmail) connector: connect / confirm / store / refresh /
// disconnect, shaped on the Slack OAuth pair (slack.ts
// getInstallUrl/completeSlackInstall). Two deliberate differences from Slack:
//
//   Personal, not team. Mail belongs to a person, so a connection binds to
//   scope_user_id only (google_installations, googleOAuthSchema.ts) — there is
//   no team branch.
//
//   The callback lands on the CONVEX host, not the web app. Google redirects to
//   the httpAction below (routed via http.ts under /api/webhooks/*, the one
//   prefix the convex proxy already forwards — infra/convex-proxy/Caddyfile
//   routes only enumerated prefixes to the HTTP-actions port). Because that
//   request is unauthenticated, the signed state (HMAC'd with the client
//   secret, 5-min TTL) is the only binding to the initiating user — which
//   closes forgery but NOT the relay: an attacker could mint an authorize URL
//   whose state names the attacker, hand it to a victim, and the victim's
//   consent would bind the victim's Gmail to the attacker's row. Slack closes
//   the relay by completing in the victim's authenticated web session
//   (slack.ts:27-33), which this flow cannot do. So a NEW connection lands
//   PENDING and unusable until `confirmConnection` — called from the /apps
//   page the callback redirects to — proves the browser that finished consent
//   is signed in as the SAME user the state names. Under a relay that check
//   fails: the victim's confirm deletes the row and revokes the grant at
//   Google, and the attacker never learns the confirm token (it travels only
//   inside the victim's redirect).
//
// Scopes are requested INCREMENTALLY: gmail.readonly at connect; the later
// send ask (grant: "gmail.send") requests readonly AND send — never send
// alone, because the callback must read the Gmail profile (readonly) to key
// the row, and a user whose earlier grant was revoked would otherwise consent
// to a send-only token the callback can only discard. include_granted_scopes
// makes the overlap free when readonly is already granted. The refresh token
// is stored encrypted (AES-256-GCM, key HKDF-derived from the client secret)
// using the cipher/KDF parameters already standardized in
// @codecast/shared/contracts/providerKeyCrypto.ts — plaintext never reaches
// the database. Agent-facing verbs (read/send mail) ship separately through
// the audited credential path; this module is only connect/store/refresh.
//
// Env: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (documented next to
// the Slack env vars). Absent config fails with a clear "not configured".

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { query, action, internalAction, internalMutation, internalQuery } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { convexSiteUrl, webBaseUrl } from "./slack";
import {
  PROVIDER_KEY_AES_ALGO,
  PROVIDER_KEY_AES_KEY_BITS,
  PROVIDER_KEY_GCM_IV_BYTES,
  PROVIDER_KEY_HKDF_HASH,
} from "@codecast/shared/contracts";

// googleOAuth enters the generated api/dataModel typings only after the
// schema.ts splice + codegen land (both handoffs); the casts keep this module
// and its callers compiling on either side of that. Precedent: taskMining.ts:431.
const internalApi = internal as any;

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
// users.getProfile — readable with gmail.readonly; gives the connected
// account's email address, which keys the stored row.
export const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

// Under /api/webhooks/ because that prefix already reaches the HTTP-actions
// port through the convex proxy (Caddyfile); a new top-level path would need an
// infra change on every deployment.
export const GOOGLE_CALLBACK_PATH = "/api/webhooks/google-oauth/callback";

// How long a freshly-stored connection may sit unconfirmed before the confirm
// token dies. Generous enough for a slow /apps load, short enough that a
// relayed-but-never-confirmed grant doesn't linger.
const CONFIRM_TTL_MS = 15 * 60 * 1000;

function googleEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

const NOT_CONFIGURED = "Google OAuth not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)";

// convexSiteUrl (slack.ts:19) is the public convex host; both connectors'
// callbacks live on it.
export function googleRedirectUri(): string {
  return `${convexSiteUrl()}${GOOGLE_CALLBACK_PATH}`;
}

// access_type=offline + prompt=consent force Google to (re)issue a refresh
// token on every authorization — without them a re-connect returns only a
// short-lived access token and the stored row could never refresh.
// include_granted_scopes makes any later grant (gmail.send) fold into the
// existing one instead of replacing it, so the token response always reports
// the FULL accumulated scope set.
export function googleAuthorizeUrl(state: string, scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

// ── OAuth state signing (CSRF + user binding) ───────────────────────────────
// Same construction as slack.ts:50-89, parameterized on the secret. Two live
// copies of CSRF verification is one too many, but slack.ts cannot import from
// here (this module already imports convexSiteUrl/webBaseUrl FROM slack.ts —
// that would be a cycle). The consolidation handoff is a neutral module (e.g.
// convex/oauthState.ts) holding these parameterized helpers, with both
// connectors importing it; slack's migration goes with it.

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signStateWith(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = btoa(JSON.stringify(payload));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyStateWith(secret: string, state: string): Promise<Record<string, any> | null> {
  // An empty secret would HMAC-verify attacker-forgeable states; refuse.
  if (!secret) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = await hmacHex(secret, body);
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const payload = JSON.parse(atob(body));
    // Freshness is mandatory — a ts-less state would never expire (slack.ts:81-84).
    if (typeof payload.ts !== "number" || Date.now() - payload.ts > 5 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Refresh-token encryption at rest ────────────────────────────────────────
// AES-256-GCM under a key HKDF-derived from the OAuth client secret, reusing
// the exact cipher/KDF parameters of the provider-key contract
// (@codecast/shared/contracts/providerKeyCrypto.ts) with a domain-separating
// info string. Consequence to know: rotating GOOGLE_OAUTH_CLIENT_SECRET
// orphans stored ciphertexts — users reconnect (Google would also invalidate
// the tokens' client binding on rotation, so nothing extra is lost).

const REFRESH_TOKEN_HKDF_INFO = "codecast-google-refresh-token-v1";
const REFRESH_TOKEN_ENC_VERSION = "v1";

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  // Explicit ArrayBuffer backing: TS 5.7's generic Uint8Array<ArrayBufferLike>
  // no longer satisfies SubtleCrypto's BufferSource.
  const raw = atob(s);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function refreshTokenAesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: PROVIDER_KEY_HKDF_HASH,
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(REFRESH_TOKEN_HKDF_INFO),
    },
    raw,
    { name: PROVIDER_KEY_AES_ALGO, length: PROVIDER_KEY_AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptRefreshToken(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(PROVIDER_KEY_GCM_IV_BYTES));
  const key = await refreshTokenAesKey(secret);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: PROVIDER_KEY_AES_ALGO, iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `${REFRESH_TOKEN_ENC_VERSION}.${b64(iv)}.${b64(ct)}`;
}

export async function decryptRefreshToken(enc: string, secret: string): Promise<string | null> {
  const [version, ivB64, ctB64] = enc.split(".");
  if (version !== REFRESH_TOKEN_ENC_VERSION || !ivB64 || !ctB64) return null;
  try {
    const key = await refreshTokenAesKey(secret);
    const pt = await crypto.subtle.decrypt(
      { name: PROVIDER_KEY_AES_ALGO, iv: unb64(ivB64) },
      key,
      unb64(ctB64),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // wrong key (rotated secret) or corrupt ciphertext
  }
}

// ── Confirm-token plumbing ──────────────────────────────────────────────────
// The confirm token is a random secret that exists only in the redirect the
// consenting browser receives; the db stores its hash, so a db read alone
// cannot mint a confirmation.

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Revoking the refresh token revokes the whole Google-side grant (all scopes).
// Best effort by design: the caller's row/decision must not depend on Google —
// the token may already be dead upstream, and losing the race changes nothing
// the user can act on.
async function revokeAtGoogle(refreshToken: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
  } catch {
    /* best effort */
  }
}

// ── Connect ─────────────────────────────────────────────────────────────────

// resolveConnectUser — auth the caller (internal; the action can't touch the db).
export const resolveConnectUser = internalQuery({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ user_id: string } | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    return { user_id: userId.toString() };
  },
});

// getConnectUrl — the Apps tab's "Connect Gmail" button calls this and sends
// the browser to the returned URL. First connect asks ONLY for gmail.readonly;
// grant: "gmail.send" is the later incremental ask (triggered the first time
// the user wants an agent to send).
export const getConnectUrl = action({
  args: {
    api_token: v.optional(v.string()),
    grant: v.optional(v.literal("gmail.send")),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const env = googleEnv();
    if (!env) return { ok: false, error: NOT_CONFIGURED };
    const who = await ctx.runQuery(internalApi.googleOAuth.resolveConnectUser, {
      api_token: args.api_token,
    });
    if (!who) return { ok: false, error: "Authentication failed — sign in and retry from the Apps tab" };
    // The send ask carries readonly TOO (module header explains why send-alone
    // dead-ends at the profile read when the earlier grant was revoked).
    const scopes =
      args.grant === "gmail.send" ? [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] : [GMAIL_READONLY_SCOPE];
    const state = await signStateWith(env.clientSecret, { user_id: who.user_id, ts: Date.now() });
    return { ok: true, url: googleAuthorizeUrl(state, scopes) };
  },
});

// ── Callback (Google → convex host) ─────────────────────────────────────────

// Exported for the test (bad-state rejection, encrypted storage); http.ts
// registers `callback` on GOOGLE_CALLBACK_PATH.
export const callbackHandler = async (ctx: any, request: Request): Promise<Response> => {
  const env = googleEnv();
  if (!env) return new Response(NOT_CONFIGURED, { status: 503 });

  const url = new URL(request.url);
  const errorRedirect = (reason: string) =>
    Response.redirect(`${webBaseUrl()}/apps?google=error&reason=${encodeURIComponent(reason)}`, 302);

  // User declined on Google's consent screen — a normal outcome, back to Apps.
  if (url.searchParams.get("error")) return errorRedirect(url.searchParams.get("error")!);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // A missing/forged/stale state is hostile or dead, not a user we can route
  // anywhere useful — hard 400, nothing stored.
  const st = state ? await verifyStateWith(env.clientSecret, state) : null;
  if (!st || typeof st.user_id !== "string" || !code) return new Response("bad_state", { status: 400 });

  // Exchange the code. The response's `scope` is the FULL accumulated grant
  // (include_granted_scopes), which is what we store.
  let tok: any;
  try {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.clientId,
        client_secret: env.clientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }).toString(),
    });
    tok = await resp.json();
  } catch {
    return errorRedirect("exchange_failed");
  }
  if (!tok?.access_token) return errorRedirect(tok?.error || "exchange_failed");

  // The connected account's email keys the row (a user may connect several
  // accounts). Readable with gmail.readonly, which every grant includes.
  let email: string | undefined;
  try {
    const resp = await fetch(GMAIL_PROFILE_URL, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    email = (await resp.json())?.emailAddress;
  } catch {
    /* handled below */
  }
  if (!email) return errorRedirect("profile_failed");

  // Encrypt BEFORE anything is handed to the mutation — the plaintext refresh
  // token never crosses into db-writing code.
  const refreshTokenEnc = tok.refresh_token
    ? await encryptRefreshToken(String(tok.refresh_token), env.clientSecret)
    : undefined;

  // Minted per callback; only its hash is stored, and only this redirect ever
  // carries the token itself (module header: the relay defense).
  const confirmToken = b64url(crypto.getRandomValues(new Uint8Array(32)));

  const stored = await ctx.runMutation(internalApi.googleOAuth.storeConnection, {
    user_id: st.user_id,
    email,
    refresh_token_enc: refreshTokenEnc,
    granted_scopes: typeof tok.scope === "string" ? tok.scope.split(" ").filter(Boolean) : [],
    pending_confirm_hash: await sha256Hex(confirmToken),
  });
  if (!stored?.ok) return errorRedirect(stored?.error || "store_failed");
  if (stored.pending) {
    // A NEW connection is stored pending; /apps completes it by calling
    // confirmConnection with these params from the signed-in session. They
    // ride in the FRAGMENT, not the query: a fragment never leaves the
    // browser, so the confirm token cannot land in the web server's access
    // logs.
    return Response.redirect(
      `${webBaseUrl()}/apps?google=pending#installation=${encodeURIComponent(stored.id)}&confirm=${confirmToken}`,
      302,
    );
  }
  return Response.redirect(`${webBaseUrl()}/apps?google=connected`, 302);
};

export const callback = httpAction(callbackHandler);

// storeConnection — upsert by (user, email). refresh_token_enc is optional
// defensively: prompt=consent should always re-issue one, but if Google ever
// omits it on an incremental grant we keep the working ciphertext we have
// rather than destroying it.
//
// New rows land PENDING (unusable until confirmConnection). An existing
// CONFIRMED row stays confirmed: the patch path is only reachable when the
// state's user already has this exact Gmail account connected — a relayed URL
// always lands on a different (user, email) pair and therefore inserts.
export const storeConnection = internalMutation({
  args: {
    user_id: v.string(),
    email: v.string(),
    refresh_token_enc: v.optional(v.string()),
    granted_scopes: v.array(v.string()),
    pending_confirm_hash: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; id?: string; pending?: boolean }> => {
    const userId = (ctx.db as any).normalizeId("users", args.user_id);
    if (!userId) return { ok: false, error: "bad_user" };
    const now = Date.now();
    const existing = await (ctx.db as any)
      .query("google_installations")
      .withIndex("by_user_email", (q: any) => q.eq("scope_user_id", userId).eq("email", args.email))
      .first();
    if (existing) {
      const stillPending = !!existing.pending_confirm_hash;
      await (ctx.db as any).patch(existing._id, {
        refresh_token_enc: args.refresh_token_enc ?? existing.refresh_token_enc,
        granted_scopes: args.granted_scopes,
        updated_at: now,
        // A still-pending row gets THIS callback's confirm token (the older
        // redirect may be long gone); a confirmed row is never re-locked.
        ...(stillPending
          ? { pending_confirm_hash: args.pending_confirm_hash, pending_expires_at: now + CONFIRM_TTL_MS }
          : {}),
      });
      return { ok: true, id: existing._id.toString(), pending: stillPending };
    }
    if (!args.refresh_token_enc) return { ok: false, error: "no_refresh_token" };
    const id = await (ctx.db as any).insert("google_installations", {
      scope_user_id: userId,
      email: args.email,
      refresh_token_enc: args.refresh_token_enc,
      granted_scopes: args.granted_scopes,
      pending_confirm_hash: args.pending_confirm_hash,
      pending_expires_at: now + CONFIRM_TTL_MS,
      created_at: now,
      updated_at: now,
    });
    return { ok: true, id: id.toString(), pending: true };
  },
});

// ── Confirm (the relay defense's second half) ───────────────────────────────

// finishConfirm — the db half of confirmConnection: compare hashes, compare
// users, and either activate the row or destroy it. When the row must die and
// Google should forget the grant too, the ciphertext comes back as
// `revoke_enc` so the ACTION can decrypt + revoke (fetch is action-only).
export const finishConfirm = internalMutation({
  args: { user_id: v.string(), installation_id: v.string(), token_hash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; error?: string; revoke_enc?: string }> => {
    const rowId = (ctx.db as any).normalizeId("google_installations", args.installation_id);
    const row = rowId ? await ctx.db.get(rowId) : null;
    if (!row) return { ok: false, error: "not_found" };
    const r = row as any;
    // Already confirmed — a re-clicked link is a no-op, not an error.
    if (!r.pending_confirm_hash) return { ok: true };
    if (typeof r.pending_expires_at === "number" && Date.now() > r.pending_expires_at) {
      // Expired pending rows are dead weight AND a live grant on the user's
      // Google account — delete here, revoke upstream (via the action).
      await ctx.db.delete(rowId);
      return { ok: false, error: "expired", revoke_enc: r.refresh_token_enc };
    }
    if (r.pending_confirm_hash !== args.token_hash) {
      // Wrong token, e.g. guessed. The row stays pending — the browser holding
      // the real token may still confirm.
      return { ok: false, error: "bad_token" };
    }
    if (r.scope_user_id.toString() !== args.user_id) {
      // The relay, caught: the consenting browser's signed-in user is NOT the
      // user the state named. The row binds the confirmer's Gmail to someone
      // else's account — destroy it and revoke the grant.
      await ctx.db.delete(rowId);
      return { ok: false, error: "wrong_account", revoke_enc: r.refresh_token_enc };
    }
    await (ctx.db as any).patch(rowId, {
      pending_confirm_hash: undefined,
      pending_expires_at: undefined,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

// confirmConnection — /apps calls this with the installation + confirm params
// from the callback redirect, in the signed-in session. Success activates the
// row; every failure says what the user should do next.
export const confirmConnection = action({
  args: { api_token: v.optional(v.string()), installation_id: v.string(), confirm_token: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const env = googleEnv();
    if (!env) return { ok: false, error: NOT_CONFIGURED };
    const who = await ctx.runQuery(internalApi.googleOAuth.resolveConnectUser, {
      api_token: args.api_token,
    });
    if (!who) {
      return { ok: false, error: "Authentication failed — sign in, then reopen this confirmation link" };
    }
    const res = await ctx.runMutation(internalApi.googleOAuth.finishConfirm, {
      user_id: who.user_id,
      installation_id: args.installation_id,
      token_hash: await sha256Hex(args.confirm_token),
    });
    if (res.revoke_enc) {
      const refreshToken = await decryptRefreshToken(res.revoke_enc, env.clientSecret);
      if (refreshToken) await revokeAtGoogle(refreshToken);
    }
    if (res.ok) return { ok: true };
    const explain: Record<string, string> = {
      not_found: "No such pending Gmail connection — connect again from the Apps tab",
      expired: "This confirmation link expired; the grant was revoked — connect again from the Apps tab",
      bad_token: "Confirmation token mismatch — use the exact link Google redirected you to, or connect again from the Apps tab",
      wrong_account:
        "This Gmail connect flow was started by a DIFFERENT codecast account; the connection was discarded and the Google grant revoked — connect from your own Apps tab",
    };
    return { ok: false, error: explain[res.error ?? ""] ?? res.error ?? "confirm_failed" };
  },
});

// ── Read / refresh / disconnect ─────────────────────────────────────────────

// listConnections — the Apps tab's list. Never returns the ciphertext: the
// encrypted blob is useless to the client and its shape is nobody's contract.
export const listConnections = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const rows = await (ctx.db as any)
      .query("google_installations")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
      .collect();
    return rows.map((r: any) => ({
      _id: r._id,
      email: r.email,
      granted_scopes: r.granted_scopes,
      // Awaiting confirmConnection — the Apps tab shows these as incomplete.
      pending: !!r.pending_confirm_hash,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  },
});

// getOwnedConnection — auth + ownership in one internal read, for the actions.
// Returns the ciphertext; only server-side action code ever sees it. PENDING
// rows are invisible by default — an unconfirmed grant must not be usable —
// except to disconnect, which may clean one up (include_pending).
export const getOwnedConnection = internalQuery({
  args: {
    api_token: v.optional(v.string()),
    installation_id: v.string(),
    include_pending: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ _id: string; refresh_token_enc: string } | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const rowId = (ctx.db as any).normalizeId("google_installations", args.installation_id);
    const row = rowId ? await ctx.db.get(rowId) : null;
    if (!row || (row as any).scope_user_id.toString() !== userId.toString()) return null;
    if ((row as any).pending_confirm_hash && !args.include_pending) return null;
    return { _id: rowId.toString(), refresh_token_enc: (row as any).refresh_token_enc };
  },
});

export const deleteConnection = internalMutation({
  args: { installation_id: v.string() },
  handler: async (ctx, args) => {
    const rowId = (ctx.db as any).normalizeId("google_installations", args.installation_id);
    if (rowId) await ctx.db.delete(rowId);
    return { ok: true };
  },
});

// updateStoredRefreshToken — Google MAY rotate the refresh token in a refresh
// response; ignoring the new one leaves a permanently stale ciphertext and a
// forced reconnect later. Internal: only getFreshAccessToken calls it, with a
// ciphertext it just produced.
export const updateStoredRefreshToken = internalMutation({
  args: { installation_id: v.string(), refresh_token_enc: v.string() },
  handler: async (ctx, args) => {
    const rowId = (ctx.db as any).normalizeId("google_installations", args.installation_id);
    if (!rowId) return { ok: false };
    await (ctx.db as any).patch(rowId, { refresh_token_enc: args.refresh_token_enc, updated_at: Date.now() });
    return { ok: true };
  },
});

// disconnect — revoke at Google (best effort: the row must die even when the
// token is already dead upstream), then delete the row. Works on pending rows
// too, so an abandoned half-connect can be cleaned from the Apps tab.
export const disconnect = action({
  args: { api_token: v.optional(v.string()), installation_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const env = googleEnv();
    if (!env) return { ok: false, error: NOT_CONFIGURED };
    const conn = await ctx.runQuery(internalApi.googleOAuth.getOwnedConnection, {
      api_token: args.api_token,
      installation_id: args.installation_id,
      include_pending: true,
    });
    if (!conn) return { ok: false, error: "No such Gmail connection for this account — check the Apps tab" };
    const refreshToken = await decryptRefreshToken(conn.refresh_token_enc, env.clientSecret);
    if (refreshToken) await revokeAtGoogle(refreshToken);
    await ctx.runMutation(internalApi.googleOAuth.deleteConnection, {
      installation_id: args.installation_id,
    });
    return { ok: true };
  },
});

// getFreshAccessToken — the refresh half. Internal only: access tokens flow to
// the audited credential path (the coming agent verbs), never to clients.
// invalid_grant means the user revoked us (or the secret rotated) — reported,
// not thrown, so callers can surface "reconnect Gmail".
export const getFreshAccessToken = internalAction({
  args: { api_token: v.optional(v.string()), installation_id: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; access_token?: string; expires_in?: number; error?: string }> => {
    const env = googleEnv();
    if (!env) return { ok: false, error: NOT_CONFIGURED };
    const conn = await ctx.runQuery(internalApi.googleOAuth.getOwnedConnection, {
      api_token: args.api_token,
      installation_id: args.installation_id,
    });
    if (!conn) {
      return { ok: false, error: "No such Gmail connection for this account (or it is unconfirmed) — reconnect from the Apps tab" };
    }
    const refreshToken = await decryptRefreshToken(conn.refresh_token_enc, env.clientSecret);
    if (!refreshToken) {
      return {
        ok: false,
        error: "Stored token undecryptable (GOOGLE_OAUTH_CLIENT_SECRET rotated?) — disconnect and reconnect Gmail from the Apps tab",
      };
    }
    let tok: any;
    try {
      const resp = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: env.clientId,
          client_secret: env.clientSecret,
          grant_type: "refresh_token",
        }).toString(),
      });
      tok = await resp.json();
    } catch {
      return { ok: false, error: "Google token endpoint unreachable — retry; if it persists, reconnect Gmail from the Apps tab" };
    }
    if (!tok?.access_token) {
      if (tok?.error === "invalid_grant") {
        return { ok: false, error: "invalid_grant — access was revoked at Google; reconnect Gmail from the Apps tab" };
      }
      return { ok: false, error: tok?.error || "refresh_failed" };
    }
    // Google rotated the refresh token: persist the new one or the stored
    // ciphertext goes permanently stale after Google retires the old.
    if (tok.refresh_token) {
      await ctx.runMutation(internalApi.googleOAuth.updateStoredRefreshToken, {
        installation_id: conn._id,
        refresh_token_enc: await encryptRefreshToken(String(tok.refresh_token), env.clientSecret),
      });
    }
    return { ok: true, access_token: tok.access_token, expires_in: tok.expires_in };
  },
});
