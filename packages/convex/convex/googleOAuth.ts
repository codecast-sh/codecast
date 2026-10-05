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
//   PENDING and unusable until `confirmConnection`, called from the in-app
//   page the callback redirects to (GOOGLE_RETURN_PATHS), proves the browser
//   that finished consent
//   is signed in as the SAME user the state names. Under a relay that check
//   fails: the victim's confirm deletes the row and revokes the grant at
//   Google, and the attacker never learns the confirm token (it travels only
//   inside the victim's redirect).
//
// Scopes are requested INCREMENTALLY: gmail.readonly at connect; each later
// ask (a GoogleGrant: gmail.send, gmail.modify, calendar.events) requests
// readonly AND the grant, never the grant alone, because the callback must
// read the Gmail profile (readonly) to key the row, and a user whose earlier
// grant was revoked would otherwise consent to a token the callback can only
// discard. include_granted_scopes makes the overlap free when readonly is
// already granted. The refresh token
// is stored encrypted (AES-256-GCM, key HKDF-derived from the client secret)
// using the cipher/KDF parameters already standardized in
// @codecast/shared/contracts/providerKeyCrypto.ts — plaintext never reaches
// the database. The hosted assistant's tools get a token through
// googleAccessTokenForUser (server only, keyed by user and required scope);
// the verbs themselves live with the tools.
//
// Env: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (documented next to
// the Slack env vars). Absent config fails with a clear "not configured".

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { claimRefreshOn, writeRefreshOutcomeOn, singleFlightRefresh, type RefreshRow } from "./lib/tokenRefresh";
import { query, action, internalAction, internalMutation, internalQuery } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { signStateWith, verifyStateWith } from "./lib/hmac";
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
// Read, archive, label and send; everything except permanent deletion.
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_FULL_SCOPE = "https://mail.google.com/";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const CALENDAR_FULL_SCOPE = "https://www.googleapis.com/auth/calendar";

/** The incremental asks beyond the readonly connect, by the name callers pass. */
export const GOOGLE_GRANT_SCOPES = {
  "gmail.send": GMAIL_SEND_SCOPE,
  "gmail.modify": GMAIL_MODIFY_SCOPE,
  "calendar.events": CALENDAR_EVENTS_SCOPE,
} as const;
export type GoogleGrant = keyof typeof GOOGLE_GRANT_SCOPES;
const grantValidator = v.union(v.literal("gmail.send"), v.literal("gmail.modify"), v.literal("calendar.events"));

/** Every scope a connect asks for: readonly always (the callback keys the row
 *  on the Gmail profile), then each grant once, in the order given. */
export function googleConnectScopes(grants: readonly GoogleGrant[] = []): string[] {
  return [...new Set([GMAIL_READONLY_SCOPE, ...grants.map((g) => GOOGLE_GRANT_SCOPES[g])])];
}

// Broader scopes a person may already hold that cover a narrower one, per
// Google's API reference for the calls each scope gates (messages.send takes
// gmail.modify or gmail.compose; events.* take the full calendar scope).
const SCOPE_COVERED_BY: Record<string, readonly string[]> = {
  [GMAIL_READONLY_SCOPE]: [GMAIL_MODIFY_SCOPE, GMAIL_FULL_SCOPE],
  [GMAIL_SEND_SCOPE]: [GMAIL_MODIFY_SCOPE, GMAIL_COMPOSE_SCOPE, GMAIL_FULL_SCOPE],
  [GMAIL_MODIFY_SCOPE]: [GMAIL_FULL_SCOPE],
  [CALENDAR_EVENTS_SCOPE]: [CALENDAR_FULL_SCOPE],
};

/** Whether a connection's granted scopes let it make calls that need `required`. */
export function googleScopeGranted(granted: readonly string[], required: string): boolean {
  return granted.includes(required) || (SCOPE_COVERED_BY[required] ?? []).some((s) => granted.includes(s));
}

/** What a grant lets the assistant do with someone's Google account, by the
 *  calls each scope gates: read mail, change mail (drafts, archive, labels),
 *  send mail, and read and write the calendar. The one rule both the
 *  Connections screen and the assistant's tool set (assistant/tools) read. */
export type GoogleCapabilities = { read_mail: boolean; modify_mail: boolean; send_mail: boolean; calendar: boolean };

export function googleCapabilities(granted: readonly string[]): GoogleCapabilities {
  return {
    read_mail: googleScopeGranted(granted, GMAIL_READONLY_SCOPE),
    modify_mail: googleScopeGranted(granted, GMAIL_MODIFY_SCOPE),
    send_mail: googleScopeGranted(granted, GMAIL_SEND_SCOPE),
    calendar: googleScopeGranted(granted, CALENDAR_EVENTS_SCOPE),
  };
}

/** The grant to ask for when `required` is missing (undefined for readonly, which every connect carries). */
export function googleGrantFor(required: string): GoogleGrant | undefined {
  return (Object.keys(GOOGLE_GRANT_SCOPES) as GoogleGrant[]).find((g) => GOOGLE_GRANT_SCOPES[g] === required);
}

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

// The in-app pages a connect may come back to. Each one must run the confirm
// step (parseConnectorReturn, then confirmConnection) itself. A fixed list, not
// a prefix or origin check: the confirm token rides the redirect's fragment,
// and a page that let anyone else's script read it would hand a relay attacker
// the one thing the defense keeps from them. The settings page is the default.
export const GOOGLE_RETURN_PATHS = ["/settings/integrations", "/simple/connections", "/welcome"] as const;
export type GoogleReturnPath = (typeof GOOGLE_RETURN_PATHS)[number];

/** `raw` when it is an allowed return page, else undefined. */
export function googleReturnPath(raw: unknown): GoogleReturnPath | undefined {
  return (GOOGLE_RETURN_PATHS as readonly unknown[]).includes(raw) ? (raw as GoogleReturnPath) : undefined;
}

// How long a freshly-stored connection may sit unconfirmed before the confirm
// token dies. Generous enough for a slow page load, short enough that a
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

async function refreshTokenAesKey(secret: string, info: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: PROVIDER_KEY_HKDF_HASH,
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    raw,
    { name: PROVIDER_KEY_AES_ALGO, length: PROVIDER_KEY_AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `info` domain-separates the derived key: the OAuth connectors keep the
 *  default, token connectors (tokenConnectors.ts) pass their own, so a
 *  ciphertext from one family never decrypts under the other's key even when
 *  the secrets match. */
export async function encryptRefreshToken(
  plaintext: string,
  secret: string,
  info: string = REFRESH_TOKEN_HKDF_INFO,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(PROVIDER_KEY_GCM_IV_BYTES));
  const key = await refreshTokenAesKey(secret, info);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: PROVIDER_KEY_AES_ALGO, iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `${REFRESH_TOKEN_ENC_VERSION}.${b64(iv)}.${b64(ct)}`;
}

export async function decryptRefreshToken(
  enc: string,
  secret: string,
  info: string = REFRESH_TOKEN_HKDF_INFO,
): Promise<string | null> {
  const [version, ivB64, ctB64] = enc.split(".");
  if (version !== REFRESH_TOKEN_ENC_VERSION || !ivB64 || !ctB64) return null;
  try {
    const key = await refreshTokenAesKey(secret, info);
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

// getConnectUrl: a "Connect Google" button calls this and sends the browser
// to the returned URL. First connect asks ONLY for gmail.readonly; `grant` is
// a later incremental ask (one grant or several at once: the simple lane asks
// for mail and calendar together). `return_to` names the in-app page the
// callback lands on (GOOGLE_RETURN_PATHS); it rides the signed state, so the
// callback trusts only what this action accepted.
export const getConnectUrl = action({
  args: {
    api_token: v.optional(v.string()),
    grant: v.optional(v.union(grantValidator, v.array(grantValidator))),
    return_to: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const env = googleEnv();
    if (!env) return { ok: false, error: NOT_CONFIGURED };
    const returnTo = args.return_to === undefined ? undefined : googleReturnPath(args.return_to);
    if (args.return_to !== undefined && !returnTo) {
      return { ok: false, error: `return_to must be one of ${GOOGLE_RETURN_PATHS.join(", ")}` };
    }
    const who = await ctx.runQuery(internalApi.googleOAuth.resolveConnectUser, {
      api_token: args.api_token,
    });
    if (!who) return { ok: false, error: "Authentication failed — sign in and retry from the Apps tab" };
    const grants = args.grant === undefined ? [] : Array.isArray(args.grant) ? args.grant : [args.grant];
    const state = await signStateWith(env.clientSecret, {
      user_id: who.user_id,
      ts: Date.now(),
      ...(returnTo ? { return_to: returnTo } : {}),
    });
    return { ok: true, url: googleAuthorizeUrl(state, googleConnectScopes(grants)) };
  },
});

// ── Callback (Google → convex host) ─────────────────────────────────────────

// Exported for the test (bad-state rejection, encrypted storage); http.ts
// registers `callback` on GOOGLE_CALLBACK_PATH.
export const callbackHandler = async (ctx: any, request: Request): Promise<Response> => {
  const env = googleEnv();
  if (!env) return new Response(NOT_CONFIGURED, { status: 503 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const st = state ? await verifyStateWith(env.clientSecret, state) : null;
  // Only a verified state may pick the landing page; anything else lands on
  // the settings page.
  const landing = `${webBaseUrl()}${googleReturnPath(st?.return_to) ?? GOOGLE_RETURN_PATHS[0]}`;
  const errorRedirect = (reason: string) =>
    Response.redirect(`${landing}?google=error&reason=${encodeURIComponent(reason)}`, 302);

  // User declined on Google's consent screen: a normal outcome, back to the page.
  if (url.searchParams.get("error")) return errorRedirect(url.searchParams.get("error")!);

  // A missing/forged/stale state is hostile or dead, not a user we can route
  // anywhere useful — hard 400, nothing stored.
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
    // A NEW connection is stored pending; the landing page completes it by calling
    // confirmConnection with these params from the signed-in session. They
    // ride in the FRAGMENT, not the query: a fragment never leaves the
    // browser, so the confirm token cannot land in the web server's access
    // logs.
    return Response.redirect(
      `${landing}?google=pending#installation=${encodeURIComponent(stored.id)}&confirm=${confirmToken}`,
      302,
    );
  }
  return Response.redirect(`${landing}?google=connected`, 302);
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
        // A reconnect is a fresh grant: drop the cached access token and any
        // refresh in flight, whose outcome write is then refused.
        access_token_enc: undefined,
        access_expires_at: undefined,
        refresh_lease_id: undefined,
        refresh_lease_until: undefined,
        last_error: undefined,
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

// confirmConnection: the landing page calls this with the installation + confirm params
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
      // What the grant lets the assistant do, through the same coverage rule
      // the tools check (googleScopeGranted), so a screen never re-derives it.
      can: googleCapabilities(r.granted_scopes ?? []),
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
// except to disconnect, which may clean one up (include_pending). `user_id`
// is for server callers with no session (the assistant's tools), which have
// already decided whose connection they act for.
export const getOwnedConnection = internalQuery({
  args: {
    api_token: v.optional(v.string()),
    user_id: v.optional(v.string()),
    installation_id: v.string(),
    include_pending: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<(RefreshRow & { _id: string }) | null> => {
    const userId = args.user_id ?? (await getAuthenticatedUserId(ctx, args.api_token));
    if (!userId) return null;
    const rowId = (ctx.db as any).normalizeId("google_installations", args.installation_id);
    const row: any = rowId ? await ctx.db.get(rowId) : null;
    if (!row || row.scope_user_id.toString() !== userId.toString()) return null;
    if (row.pending_confirm_hash && !args.include_pending) return null;
    return {
      _id: rowId.toString(),
      refresh_token_enc: row.refresh_token_enc,
      access_token_enc: row.access_token_enc,
      access_expires_at: row.access_expires_at,
      refresh_lease_id: row.refresh_lease_id,
      refresh_lease_until: row.refresh_lease_until,
    };
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

// The previous getFreshAccessToken stored a rotated refresh token through an
// unfenced updateStoredRefreshToken. It is gone, not bridged: a legacy call
// carries no credential or lease identity, so no write it asks for can be
// proven safe. The drain is structural and checked at cut time: nothing in
// the codebase invokes googleOAuth.getFreshAccessToken yet (the Gmail agent
// verbs are still to come) and google_installations holds no rows, so no
// pre-deploy action can be in flight when this ships.

/** Claim the refresh for one connection (lib/tokenRefresh.claimRefreshOn). */
export const claimRefresh = internalMutation({
  args: { installation_id: v.string(), expected_enc: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const rowId = (ctx.db as any).normalizeId("google_installations", args.installation_id);
    if (!rowId) return { ok: false, reason: "gone" as const };
    return await claimRefreshOn(ctx.db, rowId, args.expected_enc, args.now);
  },
});

/** Persist one refresh outcome, fenced (lib/tokenRefresh.writeRefreshOutcomeOn).
 *  Google MAY rotate the refresh token in a refresh response; ignoring the new
 *  one leaves a permanently stale ciphertext, so the pair lands in one write. */
export const writeRefreshOutcome = internalMutation({
  args: {
    installation_id: v.string(),
    expected_enc: v.string(),
    lease: v.string(),
    access_token_enc: v.optional(v.string()),
    refresh_token_enc: v.optional(v.string()),
    access_expires_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { installation_id, ...outcome } = args;
    const rowId = (ctx.db as any).normalizeId("google_installations", installation_id);
    if (!rowId) return { ok: false, reason: "gone" as const };
    return await writeRefreshOutcomeOn(ctx.db, rowId, outcome);
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

/** Refresh-or-reuse one connection's access token through the single flight
 *  protocol. `read` names whose row it is; both entry points below share it. */
async function refreshConnection(
  ctx: any,
  env: { clientId: string; clientSecret: string },
  read: { api_token?: string; user_id?: string; installation_id: string },
  force: boolean | undefined,
  errors: { noConnection: string; undecryptable: string; reconnect: string },
) {
  return await singleFlightRefresh({
    provider: "Google",
    read: () => ctx.runQuery(internalApi.googleOAuth.getOwnedConnection, read),
    claim: (installation_id, expected_enc, now) =>
      ctx.runMutation(internalApi.googleOAuth.claimRefresh, { installation_id, expected_enc, now }),
    write: (installation_id, outcome) =>
      ctx.runMutation(internalApi.googleOAuth.writeRefreshOutcome, { installation_id, ...outcome }),
    decrypt: (enc) => decryptRefreshToken(enc, env.clientSecret),
    encrypt: (plain) => encryptRefreshToken(plain, env.clientSecret),
    request: async (refreshToken) => {
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
      let tok: any = null;
      try { tok = await resp.json(); } catch { tok = null; }
      return { ok: resp.ok, status: resp.status, tok };
    },
    force,
    errors,
  });
}

const secondsUntil = (at: number | undefined) =>
  at ? Math.max(0, Math.floor((at - Date.now()) / 1000)) : undefined;

// getFreshAccessToken: the refresh half, for one installation the caller
// owns. Internal only: access tokens never reach clients. The access token is
// cached with its expiry and refreshed single flight (lib/tokenRefresh), so a
// Gmail call no longer pays a token round trip and two concurrent callers
// cannot both spend a rotating refresh token. invalid_grant means the user
// revoked us (or the secret rotated): reported, not thrown, so callers can
// surface "reconnect Gmail".
export const getFreshAccessToken = internalAction({
  args: { api_token: v.optional(v.string()), installation_id: v.string(), force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; access_token?: string; expires_in?: number; error?: string }> => {
    const env = googleEnv();
    if (!env) return { ok: false, error: NOT_CONFIGURED };
    const res = await refreshConnection(
      ctx,
      env,
      { api_token: args.api_token, installation_id: args.installation_id },
      args.force,
      {
        noConnection: "No such Gmail connection for this account (or it is unconfirmed) — reconnect from the Apps tab",
        undecryptable: "Stored token undecryptable (GOOGLE_OAUTH_CLIENT_SECRET rotated?) — disconnect and reconnect Gmail from the Apps tab",
        reconnect: "reconnect Gmail from the Apps tab",
      },
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, access_token: res.token, expires_in: secondsUntil(res.expires_at) };
  },
});

// ── The assistant's token getter ────────────────────────────────────────────
// The hosted assistant's tools run inside a turn (an action with no session),
// for a user the turn engine already resolved. They ask for a scope, not an
// installation: the getter picks the person's connection that can make the
// call, refreshes its token, and says plainly why when it cannot.

export type GoogleTokenFailure = "not_configured" | "not_connected" | "missing_scope" | "reconnect" | "unavailable";
export type GoogleTokenResult =
  | { ok: true; access_token: string; email: string; installation_id: string; expires_in?: number }
  | { ok: false; code: GoogleTokenFailure; error: string; grant?: GoogleGrant };

/** The user's confirmed connections, newest first. A pending row (awaiting
 *  confirmConnection) is never usable, so it is never listed. */
async function confirmedConnections(ctx: { db: any }, userIdRaw: string, email?: string): Promise<any[]> {
  const userId = ctx.db.normalizeId("users", userIdRaw);
  if (!userId) return [];
  const rows: any[] = await ctx.db
    .query("google_installations")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  return rows
    .filter((r) => !r.pending_confirm_hash && (email === undefined || r.email === email))
    .sort((a, b) => b.updated_at - a.updated_at);
}

/** What each of the user's confirmed connections allows, for server code that
 *  decides which Google tools to offer. Never the tokens. */
export const connectionScopesForUser = internalQuery({
  args: { user_id: v.string() },
  handler: async (ctx, args): Promise<{ email: string; granted_scopes: string[] }[]> =>
    (await confirmedConnections(ctx, args.user_id)).map((r) => ({ email: r.email, granted_scopes: r.granted_scopes ?? [] })),
});

/** Which of the user's confirmed connections serves `scope`: the one named by
 *  `email` when given, else the most recently updated one that holds the scope. */
export const pickConnectionForUser = internalQuery({
  args: { user_id: v.string(), scope: v.string(), email: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; installation_id: string; email: string } | { ok: false; code: "not_connected" | "missing_scope" }> => {
    const confirmed = await confirmedConnections(ctx, args.user_id, args.email);
    if (confirmed.length === 0) return { ok: false, code: "not_connected" };
    const row = confirmed.find((r) => googleScopeGranted(r.granted_scopes ?? [], args.scope));
    if (!row) return { ok: false, code: "missing_scope" };
    return { ok: true, installation_id: row._id.toString(), email: row.email };
  },
});

/**
 * A fresh access token for `user_id` that can make calls needing `scope`.
 * Call it from server code only (the assistant's tools, inside an action);
 * the token must never be returned to a client. Refusals are values, with a
 * code the tool can turn into "connect Google" or "allow calendar access".
 */
export async function googleAccessTokenForUser(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  args: { user_id: string; scope: string; email?: string; force?: boolean },
): Promise<GoogleTokenResult> {
  const env = googleEnv();
  if (!env) return { ok: false, code: "not_configured", error: NOT_CONFIGURED };
  const picked = await ctx.runQuery(internalApi.googleOAuth.pickConnectionForUser, {
    user_id: args.user_id,
    scope: args.scope,
    ...(args.email !== undefined ? { email: args.email } : {}),
  });
  const account = args.email ? `the Google account ${args.email}` : "a Google account";
  if (!picked.ok && picked.code === "not_connected") {
    return { ok: false, code: "not_connected", error: `Not connected: ${account} is not connected. Connect Google first.` };
  }
  if (!picked.ok) {
    const grant = googleGrantFor(args.scope);
    return {
      ok: false,
      code: "missing_scope",
      error: `Missing scope: ${account} is connected without ${args.scope}. Ask the person to allow ${grant ?? "it"} from Connections.`,
      ...(grant ? { grant } : {}),
    };
  }
  const reconnect = "reconnect Google from Connections";
  const errors = {
    noConnection: `Not connected: the Google connection went away. ${reconnect}`,
    undecryptable: `The stored Google token cannot be read; ${reconnect}`,
    reconnect,
  };
  const res = await refreshConnection(
    ctx,
    env,
    { user_id: args.user_id, installation_id: picked.installation_id },
    args.force,
    errors,
  );
  if (!res.ok || !res.token) {
    const error = res.error ?? "Google token refresh failed";
    const code: GoogleTokenFailure =
      error === errors.noConnection ? "not_connected" : error.includes(reconnect) ? "reconnect" : "unavailable";
    return { ok: false, code, error };
  }
  return {
    ok: true,
    access_token: res.token,
    email: picked.email,
    installation_id: picked.installation_id,
    expires_in: secondsUntil(res.expires_at),
  };
}

/** googleAccessTokenForUser as an internal action, for callers that are not
 *  already inside an action. Never exposed publicly. */
export const getAccessTokenForUser = internalAction({
  args: { user_id: v.string(), scope: v.string(), email: v.optional(v.string()), force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<GoogleTokenResult> => await googleAccessTokenForUser(ctx, args),
});
