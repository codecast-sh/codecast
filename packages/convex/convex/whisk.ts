// Mail and calendar through Whisk (docs/architecture/hosted-assistant.md,
// "Mail and calendar go through Whisk"): the person's connection to Whisk,
// from Connect to Disconnect, and the token the assistant's tools call Whisk
// with. Codecast holds no Gmail or Calendar token; Whisk's own Google
// verification covers both products.
//
//   1. getConnectUrl signs a state naming the person and the lane page to
//      come back to, and sends the browser to whisk.email/connect.
//   2. The person approves in Whisk, which returns the browser to
//      codecast.sh/connect/whisk with ?whisk_code&state.
//   3. That page calls finishConnect from the person's signed-in session.
//      The state must verify AND name the caller, so a link minted for
//      someone else cannot bind another person's mailbox here. The code is
//      traded server to server for an app token (Whisk's POST /apps/token,
//      with WHISK_APP_SECRET_CODECAST, and the state, which Whisk bound the
//      code to), and the token is stored encrypted.
//   4. disconnect ends the token at Whisk and deletes the row.
//
// The connection is an `app_installations` row (provider "whisk", personal),
// the table every other app connection lives in, keyed by the same
// connectionRowFor rule. The token is sealed with googleOAuth's AES-GCM
// helpers under a key derived from the app secret with its own HKDF info, so
// rotating the secret means reconnecting, as with Google's client secret.
//
// Env: WHISK_APP_SECRET_CODECAST and WHISK_CONVEX_URL (both required), with
// WHISK_SITE_URL and WHISK_WEB_URL optional (lib/whisk.ts).

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query } from "./functions";
import { getAuthenticatedUserId } from "./pendingMessages";
import { signStateWith, verifyStateWith } from "./lib/hmac";
import { webBaseUrl } from "./slack";
import { decryptRefreshToken, encryptRefreshToken } from "./googleOAuth";
import { connectionRowFor } from "./oauthConnectors";
import {
  WHISK_APP_ID,
  WHISK_PROVIDER,
  WHISK_RETURN_PATH,
  whiskAbilities,
  whiskConfigured,
  whiskEnv,
  whiskHttpCall,
  whiskWebUrl,
  type MailAbilities,
  type WhiskCall,
} from "./lib/whisk";

// whisk enters the generated api only after the next push's codegen; the cast
// keeps this module compiling on either side of it (googleOAuth's precedent).
const internalApi = internal as any;

const TOKEN_HKDF_INFO = "codecast-whisk-app-token-v1";

/** The lane pages a connect may come back to. A fixed list: the return path
 *  rides the signed state, and finishConnect sends the browser only here. */
export const WHISK_RETURN_PATHS = ["/simple/connections", "/welcome"] as const;
export type WhiskReturnPath = (typeof WHISK_RETURN_PATHS)[number];

export function whiskReturnPath(raw: unknown): WhiskReturnPath | undefined {
  return (WHISK_RETURN_PATHS as readonly unknown[]).includes(raw) ? (raw as WhiskReturnPath) : undefined;
}

/** How long a connect may take, from the click to the return: long enough
 *  to sign in to Whisk with Google on the way. */
const STATE_MAX_AGE_MS = 30 * 60_000;

/** The URL that starts a connect on Whisk's side. */
export function whiskConnectUrl(webUrl: string, returnUrl: string, state: string): string {
  const params = new URLSearchParams({ app: WHISK_APP_ID, return: returnUrl, state });
  return `${webUrl}/connect?${params.toString()}`;
}

/** What Whisk's code exchange answers (its connect.ts `exchange`). */
type WhiskGrant = { token: string; user_id: string; email: string | null; scopes: string[]; connection_id: string };

/** Trade a one-time code for an app token, server to server. The state the
 *  code came back with goes along: Whisk issued the code bound to it, so a
 *  code that leaked cannot be traded here under another person's state.
 *  Returns a refusal code the reason table describes, never Whisk's raw text. */
export async function exchangeWhiskCode(
  env: { secret: string; siteUrl: string },
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; grant: WhiskGrant } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${env.siteUrl}/apps/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: WHISK_APP_ID, app_secret: env.secret, code, state }),
    });
  } catch {
    return { ok: false, error: "whisk_unreachable" };
  }
  const body: any = await resp.json().catch(() => null);
  if (resp.ok && typeof body?.token === "string" && body.token) {
    return {
      ok: true,
      grant: {
        token: body.token,
        user_id: String(body.user_id ?? ""),
        email: typeof body.email === "string" ? body.email : null,
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((s: unknown): s is string => typeof s === "string") : [],
        connection_id: String(body.connection_id ?? ""),
      },
    };
  }
  // invalid_grant (a spent, expired or unknown code) and invalid_client (this
  // server's secret is not Whisk's) are the two Whisk names.
  const error = typeof body?.error === "string" && /^[a-z_]+$/.test(body.error) ? body.error : "exchange_failed";
  return { ok: false, error: error === "invalid_grant" || error === "invalid_client" ? `whisk_${error}` : "exchange_failed" };
}

export function sealWhiskToken(token: string, secret: string): Promise<string> {
  return encryptRefreshToken(token, secret, TOKEN_HKDF_INFO);
}

export function openWhiskToken(enc: string, secret: string): Promise<string | null> {
  return decryptRefreshToken(enc, secret, TOKEN_HKDF_INFO);
}

/** The mailboxes a token reaches, for the Connections screen. Best effort:
 *  a token without mail.read, or a Whisk that does not answer, lists none. */
async function mailboxesOf(call: WhiskCall): Promise<string[]> {
  try {
    const envelope = await call<{ accounts?: { email?: string }[] }>("query", "sync:getAccount", {});
    return (envelope?.accounts ?? []).map((a) => a.email).filter((e): e is string => typeof e === "string" && !!e);
  } catch {
    return [];
  }
}

/** End a token at Whisk. Best effort: a token Whisk already dropped is fine. */
async function endAtWhisk(call: WhiskCall): Promise<void> {
  try {
    await call("mutation", "connect:disconnect", {});
  } catch {
    /* best effort */
  }
}

// ── What the screens read ───────────────────────────────────────────────────

/** Whether this deployment can connect mail and calendar through Whisk. */
export const connectAvailable = query({
  args: {},
  handler: async (): Promise<boolean> => whiskConfigured(),
});

export type WhiskConnectionView =
  | { connected: false; whisk_url: string }
  | {
      connected: true;
      whisk_url: string;
      /** The person's Whisk address, the mailbox Whisk calls primary. */
      email?: string;
      /** Every mailbox the connection reaches, as of the connect. */
      mailboxes: string[];
      can: MailAbilities;
      connected_at: number;
    };

/** The person's Whisk connection as the lane shows it. Null when signed out. */
export const connection = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<WhiskConnectionView | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const whisk_url = whiskWebUrl();
    const row = await connectionRowFor(ctx, WHISK_PROVIDER, { user_id: userId });
    if (!row) return { connected: false, whisk_url };
    const mailboxes = (row.config?.mailboxes ?? "").split(",").filter(Boolean);
    return {
      connected: true,
      whisk_url,
      ...(row.account_label ? { email: row.account_label as string } : {}),
      mailboxes,
      can: whiskAbilities(row.granted_scopes ?? []),
      connected_at: row.created_at,
    };
  },
});

// ── Connect ─────────────────────────────────────────────────────────────────

/** Send the browser here to connect. `return_to` is the lane page to come back to. */
export const getConnectUrl = action({
  args: { api_token: v.optional(v.string()), return_to: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const env = whiskEnv();
    if (!env) return { ok: false, error: "whisk_not_configured" };
    const returnTo = whiskReturnPath(args.return_to ?? WHISK_RETURN_PATHS[0]);
    if (!returnTo) return { ok: false, error: `return_to must be one of ${WHISK_RETURN_PATHS.join(", ")}` };
    const who = await ctx.runQuery(internalApi.googleOAuth.resolveConnectUser, { api_token: args.api_token });
    if (!who) return { ok: false, error: "signed_out" };
    const state = await signStateWith(env.secret, { user_id: who.user_id, ts: Date.now(), return_to: returnTo });
    return { ok: true, url: whiskConnectUrl(env.webUrl, `${webBaseUrl()}${WHISK_RETURN_PATH}`, state) };
  },
});

/**
 * The return page's one call, from the person's signed-in session: verify
 * the state names this caller, trade the code, store the token. Answers the
 * lane page to land on and, on failure, a reason code for the reason table.
 */
export const finishConnect = action({
  args: {
    api_token: v.optional(v.string()),
    state: v.optional(v.string()),
    code: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ return_to: WhiskReturnPath; ok: boolean; reason?: string }> => {
    const env = whiskEnv();
    const fallback = WHISK_RETURN_PATHS[0];
    if (!env) return { return_to: fallback, ok: false, reason: "whisk_not_configured" };
    const st = args.state ? await verifyStateWith(env.secret, args.state, STATE_MAX_AGE_MS) : null;
    // Only a verified state picks the landing page.
    const return_to = whiskReturnPath(st?.return_to) ?? fallback;
    if (!st) return { return_to, ok: false, reason: "bad_state" };
    if (args.error) {
      return { return_to, ok: false, reason: args.error === "access_denied" ? "access_denied" : "exchange_failed" };
    }
    const who = await ctx.runQuery(internalApi.googleOAuth.resolveConnectUser, { api_token: args.api_token });
    if (!who) return { return_to, ok: false, reason: "signed_out" };
    if (who.user_id !== st.user_id) return { return_to, ok: false, reason: "wrong_user" };
    if (!args.code || !args.state) return { return_to, ok: false, reason: "bad_state" };

    const exchanged = await exchangeWhiskCode(env, args.code, args.state);
    if (!exchanged.ok) return { return_to, ok: false, reason: exchanged.error };
    const { grant } = exchanged;
    const call = whiskHttpCall(env.convexUrl, grant.token);
    const stored: { ok: boolean; previous_enc?: string } = await ctx.runMutation(internalApi.whisk.storeConnection, {
      user_id: who.user_id,
      token_enc: await sealWhiskToken(grant.token, env.secret),
      email: grant.email ?? undefined,
      whisk_user_id: grant.user_id,
      scopes: grant.scopes,
      mailboxes: (await mailboxesOf(call)).join(","),
    });
    if (!stored.ok) {
      await endAtWhisk(call);
      return { return_to, ok: false, reason: "store_failed" };
    }
    // A reconnect replaced an earlier token: end it at Whisk too, unless it
    // is the same one (Whisk already drops a person's earlier token for this
    // app when it mints a new one; this covers a different Whisk account).
    if (stored.previous_enc) {
      const previous = await openWhiskToken(stored.previous_enc, env.secret);
      if (previous && previous !== grant.token) await endAtWhisk(whiskHttpCall(env.convexUrl, previous));
    }
    return { return_to, ok: true };
  },
});

/** Store a fresh connection, replacing the person's earlier one whole.
 *  Answers the earlier token's ciphertext so the caller can end it at Whisk. */
export const storeConnection = internalMutation({
  args: {
    user_id: v.string(),
    token_enc: v.string(),
    email: v.optional(v.string()),
    whisk_user_id: v.string(),
    scopes: v.array(v.string()),
    mailboxes: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; previous_enc?: string }> => {
    const userId = ctx.db.normalizeId("users", args.user_id);
    if (!userId || !(await ctx.db.get(userId))) return { ok: false };
    const now = Date.now();
    const fields = {
      connected_by: userId,
      access_token_enc: args.token_enc,
      account_label: args.email,
      account_id: args.whisk_user_id,
      granted_scopes: args.scopes,
      config: { mailboxes: args.mailboxes },
      last_error: undefined,
      last_error_kind: undefined,
      updated_at: now,
    };
    const existing = await connectionRowFor(ctx, WHISK_PROVIDER, { user_id: userId });
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, created_at: now });
      return { ok: true, previous_enc: existing.access_token_enc };
    }
    await ctx.db.insert("app_installations", {
      provider: WHISK_PROVIDER,
      scope_user_id: userId,
      ...fields,
      created_at: now,
    });
    return { ok: true };
  },
});

// ── Disconnect ──────────────────────────────────────────────────────────────

export const removeConnection = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args): Promise<{ token_enc?: string }> => {
    const row = await connectionRowFor(ctx, WHISK_PROVIDER, { user_id: args.user_id });
    if (!row) return {};
    await ctx.db.delete(row._id);
    return { token_enc: row.access_token_enc };
  },
});

/** The person disconnects. The row goes at once; the token is ended at Whisk
 *  too, so it stops working there and leaves Whisk's Settings list. */
export const disconnect = action({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const who = await ctx.runQuery(internalApi.googleOAuth.resolveConnectUser, { api_token: args.api_token });
    if (!who) return { ok: false, error: "signed_out" };
    const removed: { token_enc?: string } = await ctx.runMutation(internalApi.whisk.removeConnection, { user_id: who.user_id });
    const env = whiskEnv();
    if (removed.token_enc && env) {
      const token = await openWhiskToken(removed.token_enc, env.secret);
      if (token) await endAtWhisk(whiskHttpCall(env.convexUrl, token));
    }
    return { ok: true };
  },
});

// ── For the assistant's tools ───────────────────────────────────────────────

/** The sealed token and grant of a person's connection, for server code only. */
export const sealedConnectionFor = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args): Promise<{ token_enc: string; scopes: string[]; email?: string } | null> => {
    const row = await connectionRowFor(ctx, WHISK_PROVIDER, { user_id: args.user_id });
    if (!row) return null;
    return {
      token_enc: row.access_token_enc,
      scopes: row.granted_scopes ?? [],
      ...(row.account_label ? { email: row.account_label as string } : {}),
    };
  },
});

export type WhiskAccess =
  | { state: "not_configured" }
  | { state: "not_connected" }
  /** Connected, but the token cannot be opened (the app secret changed). */
  | { state: "reconnect"; email?: string }
  | { state: "connected"; call: WhiskCall; can: MailAbilities; email?: string };

/** How a person's turn reaches Whisk: a caller bound to their token, and
 *  what its grant allows. The token never leaves this closure. */
export async function whiskAccessFor(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  userId: Id<"users">,
  fetchImpl?: typeof fetch,
): Promise<WhiskAccess> {
  const env = whiskEnv();
  if (!env) return { state: "not_configured" };
  const row = await ctx.runQuery(internalApi.whisk.sealedConnectionFor, { user_id: userId });
  if (!row) return { state: "not_connected" };
  const token = await openWhiskToken(row.token_enc, env.secret);
  if (!token) return { state: "reconnect", ...(row.email ? { email: row.email } : {}) };
  return {
    state: "connected",
    call: whiskHttpCall(env.convexUrl, token, fetchImpl),
    can: whiskAbilities(row.scopes),
    ...(row.email ? { email: row.email } : {}),
  };
}
