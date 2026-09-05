// Generic OAuth connectors — Linear, Notion, and whatever comes next.
//
// Google's connector (googleOAuth.ts) worked out the hard parts: HMAC-signed
// state, AES-GCM refresh-token storage keyed off the client secret, and the
// two-phase confirm that stops a relay attack (the redirect lands in SOME
// browser; only the authenticated session that started the flow may finish
// it). This module reuses those exports and adds nothing to the security
// design — it only parameterizes the URLs, scopes and profile fetch, so a new
// provider is one entry in PROVIDERS and one env var pair.
//
// Every provider here is TEAM-scoped: Linear and Notion are workspace tools,
// and one connection serves every member (matching Slack). Personal-scoped
// providers (mail) stay on their own path.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getAuthenticatedUserId } from "./pendingMessages";
import { convexSiteUrl, webBaseUrl } from "./slack";
import {
  encryptRefreshToken,
  decryptRefreshToken,
  signStateWith,
  verifyStateWith,
} from "./googleOAuth";

/* ==========================================================================
 * The provider table
 * ========================================================================== */

export type ConnectorId = "linear" | "notion";

export interface ProviderConfig {
  id: ConnectorId;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Scopes requested at connect. Kept minimal on purpose — the same
   *  incremental-grant instinct as Gmail's readonly-first. */
  scopes: string[];
  /** Env var names carrying the client id / secret. */
  env: { clientId: string; clientSecret: string };
  /** How the token endpoint wants credentials. */
  tokenAuth: "body" | "basic";
  /** Fetch the connected account's label after exchange. Total: a failed
   *  profile read stores the connection unlabeled rather than failing it. */
  profile: (accessToken: string) => Promise<{ label?: string; id?: string }>;
  /** Extra authorize params some providers require. */
  authorizeExtra?: Record<string, string>;
}

const linear: ProviderConfig = {
  id: "linear",
  name: "Linear",
  authorizeUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  // write is what lets outbound push a title/state/label back onto an issue
  // (S5); read + issues:create alone can only ever create, never update.
  scopes: ["read", "write", "comments:create"],
  env: { clientId: "LINEAR_OAUTH_CLIENT_ID", clientSecret: "LINEAR_OAUTH_CLIENT_SECRET" },
  tokenAuth: "body",
  // actor: "app" attributes our writes to the Codecast app rather than to
  // whoever happened to connect the workspace — the person who clicked
  // Connect should not appear as the author of every synced comment.
  authorizeExtra: { prompt: "consent", actor: "app" },
  profile: async (accessToken) => {
    try {
      const r = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ query: "{ organization { id name urlKey } }" }),
        signal: AbortSignal.timeout(10_000),
      });
      const j: any = await r.json();
      const org = j?.data?.organization;
      return org ? { label: org.name ?? org.urlKey, id: org.id } : {};
    } catch {
      return {};
    }
  },
};

const notion: ProviderConfig = {
  id: "notion",
  name: "Notion",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  scopes: [], // Notion grants access per page the user shares; no scope string.
  env: { clientId: "NOTION_OAUTH_CLIENT_ID", clientSecret: "NOTION_OAUTH_CLIENT_SECRET" },
  tokenAuth: "basic",
  authorizeExtra: { owner: "user" },
  profile: async () => ({}), // Notion returns workspace_name IN the token response.
};

export const PROVIDERS: Record<ConnectorId, ProviderConfig> = { linear, notion };

export const CONNECTOR_CALLBACK_PATH = "/api/webhooks/oauth-connector/callback";
const CONFIRM_TTL_MS = 15 * 60 * 1000;

function providerEnv(p: ProviderConfig): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[p.env.clientId];
  const clientSecret = process.env[p.env.clientSecret];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function notConfigured(p: ProviderConfig): string {
  return `${p.name} OAuth not configured (${p.env.clientId} / ${p.env.clientSecret})`;
}

function redirectUri(): string {
  return `${convexSiteUrl()}${CONNECTOR_CALLBACK_PATH}`;
}

function isConnectorId(v: unknown): v is ConnectorId {
  return typeof v === "string" && v in PROVIDERS;
}

/* ==========================================================================
 * Connect
 * ========================================================================== */

// api_token is what lets `cast integrations connect linear` reach the same
// flow as the web button (googleOAuth.getConnectUrl and slack.getInstallUrl
// take it for the same reason). The signed state is identical either way, so
// the CLI and the browser cannot drift apart on what a callback carries.
export const getConnectUrl = action({
  args: { provider: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    if (!isConnectorId(args.provider)) return { ok: false, error: "unknown provider" };
    const p = PROVIDERS[args.provider];
    const env = providerEnv(p);
    if (!env) return { ok: false, error: notConfigured(p) };
    const me: any = await ctx.runQuery(internal.oauthConnectors.resolveTeam, {
      api_token: args.api_token,
    });
    if (!me?.user_id) return { ok: false, error: "not signed in" };
    if (!me?.team_id) return { ok: false, error: `Join or create a team first — ${p.name} binds to a team` };

    const state = await signStateWith(env.clientSecret, {
      provider: p.id,
      user_id: String(me.user_id),
      team_id: String(me.team_id),
      nonce: crypto.randomUUID(),
      // `ts`, not `iat`: verifyStateWith REQUIRES this exact field and rejects
      // any state without it, so an `iat` state failed every callback with
      // bad_state. Freshness (5 minutes) is enforced there, which is why no
      // second expiry check exists below.
      ts: Date.now(),
    });
    const url = new URL(p.authorizeUrl);
    url.searchParams.set("client_id", env.clientId);
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    // Linear wants its scopes comma-joined; everyone else space-joined.
    if (p.scopes.length > 0) url.searchParams.set("scope", p.scopes.join(p.id === "linear" ? "," : " "));
    for (const [k, val] of Object.entries(p.authorizeExtra ?? {})) url.searchParams.set(k, val);
    return { ok: true, url: url.toString() };
  },
});

/** The caller and the team a connector binds to. Routing fallback
 *  (active_team_id ?? team_id), the same one appConnections.listConnections
 *  uses — resolving differently here would connect one team while the card
 *  reports another. */
export const resolveTeam = internalQuery({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return {
      user_id: userId,
      team_id: (user as any)?.active_team_id ?? (user as any)?.team_id ?? null,
    };
  },
});

/* ==========================================================================
 * Token endpoint + refresh
 * ========================================================================== */

/** One POST to the provider's token endpoint, in the shape it wants: Notion
 *  takes JSON with HTTP basic auth, Linear takes a form with the client pair
 *  in the body. Shared by the code exchange and the refresh. */
async function tokenRequest(
  p: ProviderConfig,
  env: { clientId: string; clientSecret: string },
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; tok: any }> {
  const signal = AbortSignal.timeout(15_000);
  const resp =
    p.tokenAuth === "basic"
      ? await fetch(p.tokenUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
          },
          body: JSON.stringify(params),
          signal,
        })
      : await fetch(p.tokenUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...params, client_id: env.clientId, client_secret: env.clientSecret }).toString(),
          signal,
        });
  let tok: any = null;
  try {
    tok = await resp.json();
  } catch {
    tok = null;
  }
  return { ok: resp.ok, status: resp.status, tok };
}

/** Absolute expiry from a token response, or undefined when the provider
 *  gave no expires_in (Notion: tokens do not expire). */
export function accessExpiresAt(tok: any, now: number): number | undefined {
  return typeof tok?.expires_in === "number" && tok.expires_in > 0 ? now + tok.expires_in * 1000 : undefined;
}

/** Refresh this far ahead of expiry so an in-flight sync never straddles it. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A row refreshes when it CAN (has a refresh token) and its access token is
 *  expiring, expired, or of unknown age. Rows without a refresh token never
 *  refresh: their access token is the only credential there is. */
export function needsRefresh(
  row: { refresh_token_enc?: string; access_expires_at?: number },
  now: number,
): boolean {
  if (!row.refresh_token_enc) return false;
  if (row.access_expires_at === undefined) return true;
  return row.access_expires_at - now < REFRESH_MARGIN_MS;
}

/* ==========================================================================
 * Callback — code exchange, encrypted store, PENDING until confirmed
 * ========================================================================== */

export const callbackHandler = async (ctx: any, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const errorRedirect = (provider: string, reason: string) =>
    Response.redirect(`${webBaseUrl()}/settings/integrations?${provider}=error&reason=${encodeURIComponent(reason)}`, 302);

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    if (url.searchParams.get("error")) return errorRedirect("connector", url.searchParams.get("error")!);
    return new Response("bad_state", { status: 400 });
  }

  // The provider is inside the signed state, so try each secret until one
  // verifies — a state signed by Linear's secret cannot verify under Notion's.
  let st: Record<string, any> | null = null;
  let p: ProviderConfig | undefined;
  let env: { clientId: string; clientSecret: string } | null = null;
  for (const candidate of Object.values(PROVIDERS)) {
    const e = providerEnv(candidate);
    if (!e) continue;
    const verified = await verifyStateWith(e.clientSecret, state);
    if (verified && verified.provider === candidate.id) {
      st = verified;
      p = candidate;
      env = e;
      break;
    }
  }
  if (!st || !p || !env || typeof st.user_id !== "string" || typeof st.team_id !== "string") {
    return new Response("bad_state", { status: 400 });
  }

  // Exchange the code.
  let tok: any;
  try {
    const res = await tokenRequest(p, env, { code, redirect_uri: redirectUri(), grant_type: "authorization_code" });
    tok = res.tok;
    if (!res.ok) return errorRedirect(p.id, tok?.error ?? `token_${res.status}`);
  } catch (err) {
    return errorRedirect(p.id, "token_exchange_failed");
  }
  if (typeof tok?.access_token !== "string") return errorRedirect(p.id, "no_access_token");

  const profile = await p.profile(tok.access_token);
  const label = profile.label ?? tok.workspace_name ?? undefined; // Notion puts it in the token response
  const accountId = profile.id ?? tok.workspace_id ?? undefined;
  const scopes: string[] =
    typeof tok.scope === "string" ? tok.scope.split(/[ ,]+/).filter(Boolean) : Array.isArray(tok.scope) ? tok.scope : p.scopes;

  const confirmToken = crypto.randomUUID();
  const confirmHash = await sha256Hex(confirmToken);
  const stored: any = await ctx.runMutation(internal.oauthConnectors.storeConnection, {
    provider: p.id,
    user_id: st.user_id,
    team_id: st.team_id,
    account_label: label,
    account_id: accountId,
    access_token_enc: await encryptRefreshToken(tok.access_token, env.clientSecret),
    refresh_token_enc: typeof tok.refresh_token === "string" ? await encryptRefreshToken(tok.refresh_token, env.clientSecret) : undefined,
    access_expires_at: accessExpiresAt(tok, Date.now()),
    granted_scopes: scopes,
    pending_confirm_hash: confirmHash,
  });
  if (!stored?.ok) return errorRedirect(p.id, stored?.error ?? "store_failed");

  // Two-phase: hand the confirm token to the browser in the fragment (never
  // sent to any server by the redirect), and let the authenticated session
  // finish it. See googleOAuth.ts for the relay-attack reasoning.
  return Response.redirect(
    `${webBaseUrl()}/settings/integrations?${p.id}=pending#installation=${encodeURIComponent(stored.id)}&confirm=${confirmToken}&provider=${p.id}`,
    302,
  );
};

export const callback = httpAction(callbackHandler);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const storeConnection = internalMutation({
  args: {
    provider: v.string(),
    user_id: v.string(),
    team_id: v.string(),
    account_label: v.optional(v.string()),
    account_id: v.optional(v.string()),
    access_token_enc: v.string(),
    refresh_token_enc: v.optional(v.string()),
    access_expires_at: v.optional(v.number()),
    granted_scopes: v.array(v.string()),
    pending_confirm_hash: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; id?: string; error?: string }> => {
    const userId = (ctx.db as any).normalizeId("users", args.user_id);
    const teamId = (ctx.db as any).normalizeId("teams", args.team_id);
    if (!userId || !teamId) return { ok: false, error: "bad_ids" };
    const now = Date.now();
    const existing = await (ctx.db as any)
      .query("app_installations")
      .withIndex("by_provider_team", (q: any) => q.eq("provider", args.provider).eq("team_id", teamId))
      .first();
    if (existing) {
      const stillPending = !!existing.pending_confirm_hash;
      await (ctx.db as any).patch(existing._id, {
        access_token_enc: args.access_token_enc,
        refresh_token_enc: args.refresh_token_enc ?? existing.refresh_token_enc,
        access_expires_at: args.access_expires_at,
        last_error: undefined,
        refresh_lease_id: undefined,
        refresh_lease_until: undefined,
        granted_scopes: args.granted_scopes,
        account_label: args.account_label ?? existing.account_label,
        account_id: args.account_id ?? existing.account_id,
        updated_at: now,
        ...(stillPending
          ? { pending_confirm_hash: args.pending_confirm_hash, pending_expires_at: now + CONFIRM_TTL_MS }
          : {}),
      });
      return { ok: true, id: existing._id.toString() };
    }
    const id = await (ctx.db as any).insert("app_installations", {
      provider: args.provider,
      team_id: teamId,
      connected_by: userId,
      account_label: args.account_label,
      account_id: args.account_id,
      access_token_enc: args.access_token_enc,
      refresh_token_enc: args.refresh_token_enc,
      access_expires_at: args.access_expires_at,
      granted_scopes: args.granted_scopes,
      pending_confirm_hash: args.pending_confirm_hash,
      pending_expires_at: now + CONFIRM_TTL_MS,
      created_at: now,
      updated_at: now,
    });
    return { ok: true, id: id.toString() };
  },
});

/* ==========================================================================
 * Confirm — the authenticated half of the two-phase flow
 * ========================================================================== */

export const confirmConnection = action({
  args: { installation_id: v.string(), confirm_token: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, error: "not signed in" };
    const hash = await sha256Hex(args.confirm_token);
    return await ctx.runMutation(internal.oauthConnectors.finishConfirm, {
      user_id: String(userId),
      installation_id: args.installation_id,
      token_hash: hash,
    });
  },
});

export const finishConfirm = internalMutation({
  args: { user_id: v.string(), installation_id: v.string(), token_hash: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const rowId = (ctx.db as any).normalizeId("app_installations", args.installation_id);
    if (!rowId) return { ok: false, error: "no_such_installation" };
    const r = await (ctx.db as any).get(rowId);
    if (!r) return { ok: false, error: "no_such_installation" };
    if (!r.pending_confirm_hash) return { ok: true }; // already confirmed
    if (typeof r.pending_expires_at === "number" && Date.now() > r.pending_expires_at) {
      await (ctx.db as any).delete(rowId);
      return { ok: false, error: "expired" };
    }
    if (r.pending_confirm_hash !== args.token_hash) return { ok: false, error: "bad_token" };
    if (String(r.connected_by) !== args.user_id) return { ok: false, error: "wrong_user" };
    await (ctx.db as any).patch(rowId, {
      pending_confirm_hash: undefined,
      pending_expires_at: undefined,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

/* ==========================================================================
 * Read + disconnect
 * ========================================================================== */

/** Confirmed connections for the caller's team, for the Apps tab. */
export const listConnections = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const user = await ctx.db.get(userId);
    const teamId = (user as any)?.active_team_id ?? (user as any)?.team_id;
    if (!teamId) return [];
    const out: Array<{ provider: string; _id: string; account_label?: string; connected_by: string; created_at: number }> = [];
    for (const p of Object.values(PROVIDERS)) {
      const row = await (ctx.db as any)
        .query("app_installations")
        .withIndex("by_provider_team", (q: any) => q.eq("provider", p.id).eq("team_id", teamId))
        .first();
      if (row && !row.pending_confirm_hash) {
        out.push({
          provider: p.id,
          _id: row._id.toString(),
          account_label: row.account_label,
          connected_by: String(row.connected_by),
          created_at: row.created_at,
        });
      }
    }
    return out;
  },
});

export const disconnect = action({
  args: { installation_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, error: "not signed in" };
    return await ctx.runMutation(internal.oauthConnectors.deleteConnection, {
      user_id: String(userId),
      installation_id: args.installation_id,
    });
  },
});

export const deleteConnection = internalMutation({
  args: { user_id: v.string(), installation_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const rowId = (ctx.db as any).normalizeId("app_installations", args.installation_id);
    if (!rowId) return { ok: false, error: "no_such_installation" };
    const r = await (ctx.db as any).get(rowId);
    if (!r) return { ok: true };
    // Any team member may disconnect a team connection: it is the team's, and
    // a departed connector must not leave a live grant nobody can revoke.
    const userId = (ctx.db as any).normalizeId("users", args.user_id);
    const member = userId
      ? await (ctx.db as any)
          .query("team_memberships")
          .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", r.team_id))
          .first()
      : null;
    if (!member) return { ok: false, error: "not_a_member" };
    await (ctx.db as any).delete(rowId);
    return { ok: true };
  },
});

/** The connection row's credential fields, for the refresh action only.
 *  Nothing hands a token to a client. */
export const getConnectionForTeam = internalQuery({
  args: { provider: v.string(), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    if (!isConnectorId(args.provider)) return null;
    const row = await (ctx.db as any)
      .query("app_installations")
      .withIndex("by_provider_team", (q: any) => q.eq("provider", args.provider).eq("team_id", args.team_id))
      .first();
    if (!row || row.pending_confirm_hash) return null;
    return {
      _id: row._id,
      access_token_enc: row.access_token_enc as string,
      refresh_token_enc: row.refresh_token_enc as string | undefined,
      access_expires_at: row.access_expires_at as number | undefined,
      refresh_lease_until: row.refresh_lease_until as number | undefined,
      refresh_lease_id: row.refresh_lease_id as string | undefined,
    };
  },
});

/** How long one caller may hold the refresh; long enough for a slow token
 *  endpoint, short enough that a crashed claimant does not block a team. */
export const REFRESH_LEASE_MS = 30 * 1000;
/** How long a waiter watches for the claimant's write before trying itself. */
const REFRESH_WAIT_MS = 15 * 1000;
const REFRESH_POLL_MS = 250;

/**
 * Claim the refresh for one row. Every concurrent caller that finds the
 * token expiring lands here; exactly one gets `ok`, the rest are told the
 * refresh is `held` and wait for the credentials to change. The claim is
 * also a compare and swap on the ciphertext, so a caller holding a stale
 * read cannot claim over credentials that already moved on.
 */
export const claimRefresh = internalMutation({
  args: { installation_id: v.id("app_installations"), expected_enc: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<{ ok: boolean; lease?: string; reason?: "gone" | "superseded" | "held" }> => {
    const row = await (ctx.db as any).get(args.installation_id);
    if (!row) return { ok: false, reason: "gone" };
    if (row.access_token_enc !== args.expected_enc) return { ok: false, reason: "superseded" };
    if (typeof row.refresh_lease_until === "number" && row.refresh_lease_until > args.now) return { ok: false, reason: "held" };
    const lease = crypto.randomUUID();
    await (ctx.db as any).patch(args.installation_id, { refresh_lease_id: lease, refresh_lease_until: args.now + REFRESH_LEASE_MS });
    return { ok: true, lease };
  },
});

/**
 * Persist the outcome of one refresh. Both outcomes are fenced the same way:
 * the writer must still own the lease it claimed AND the credentials must be
 * the ones it read. Nothing about the order in which provider responses
 * arrive says whose pair is newer, so an expired claimant's late success is
 * refused like its late failure would be; the caller then defers to the
 * current owner's write (see getFreshAccessTokenForTeam). A reconnect
 * clears the lease and rewrites the ciphertext, so anything in flight
 * before it is refused on both counts. A deleted row is reported, never
 * recreated. The one write that passes releases the lease.
 */
export const updateStoredTokens = internalMutation({
  args: {
    installation_id: v.id("app_installations"),
    expected_enc: v.string(),
    lease: v.string(),
    access_token_enc: v.optional(v.string()),
    refresh_token_enc: v.optional(v.string()),
    access_expires_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: "gone" | "superseded" }> => {
    const row = await (ctx.db as any).get(args.installation_id);
    if (!row) return { ok: false, reason: "gone" };
    const release = { refresh_lease_id: undefined, refresh_lease_until: undefined, updated_at: Date.now() };
    if (row.refresh_lease_id !== args.lease || row.access_token_enc !== args.expected_enc) return { ok: false, reason: "superseded" };
    if (args.access_token_enc) {
      await (ctx.db as any).patch(args.installation_id, {
        ...release,
        access_token_enc: args.access_token_enc,
        access_expires_at: args.access_expires_at,
        last_error: undefined,
        ...(args.refresh_token_enc ? { refresh_token_enc: args.refresh_token_enc } : {}),
      });
      return { ok: true };
    }
    await (ctx.db as any).patch(args.installation_id, { ...release, last_error: args.last_error });
    return { ok: true };
  },
});

/**
 * The access token for a team's connection, refreshed when it is expiring
 * or of unknown age (see needsRefresh). Same shape as googleOAuth's
 * getFreshAccessToken: a refusal is returned, not thrown, so callers can
 * say "reconnect Linear" instead of "401". `force` refreshes regardless of
 * the recorded expiry, for a caller that just got a 401 on a token this
 * function considered fresh.
 *
 * Single flight: the provider rotates the refresh token on the first grant,
 * so a second concurrent grant with the same token is refused. One caller
 * claims the lease and talks to the provider; the others wait for the row
 * to change and return the pair that landed. Every outcome write is a
 * fenced by lease ownership and credential compare and swap
 * (updateStoredTokens); when a write is refused the caller waits for the
 * current owner's write and returns what the row holds then, never the pair
 * it fetched: a disconnected connection yields no credentials, a superseded
 * refresh yields the owner's.
 */
export const getFreshAccessTokenForTeam = internalAction({
  args: { provider: v.string(), team_id: v.id("teams"), force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ ok: boolean; token?: string; error?: string }> => {
    if (!isConnectorId(args.provider)) return { ok: false, error: "unknown provider" };
    const p = PROVIDERS[args.provider];
    const env = providerEnv(p);
    if (!env) return { ok: false, error: notConfigured(p) };
    type Row = { _id: any; access_token_enc: string; refresh_token_enc?: string; access_expires_at?: number; refresh_lease_until?: number; refresh_lease_id?: string };
    const noConnection = { ok: false, error: `no_connection: ${p.name} is not connected for this team` };
    const read = (): Promise<Row | null> =>
      ctx.runQuery(internal.oauthConnectors.getConnectionForTeam, { provider: p.id, team_id: args.team_id });
    const tokenOf = async (row: Row) => {
      const token = await decryptRefreshToken(row.access_token_enc, env.clientSecret);
      return token ? { ok: true, token } : { ok: false, error: `${p.name} token undecryptable (${p.env.clientSecret} rotated?): reconnect ${p.name}` };
    };
    /** Current credentials, as the row holds them now. */
    const current = async () => {
      const row = await read();
      return row ? await tokenOf(row) : noConnection;
    };
    /** Wait for another claimant's write. Resolves with the new credentials,
     *  or null once the lease lapsed with nothing written. */
    const waitForOther = async (seenEnc: string) => {
      const deadline = Date.now() + REFRESH_WAIT_MS;
      while (Date.now() < deadline) {
        const row = await read();
        if (!row) return noConnection;
        if (row.access_token_enc !== seenEnc) return await tokenOf(row);
        if (typeof row.refresh_lease_until !== "number" || row.refresh_lease_until <= Date.now()) return null;
        await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
      }
      return null;
    };

    let row = await read();
    if (!row) return noConnection;
    const now = Date.now();
    if (!args.force && !needsRefresh(row, now)) return await tokenOf(row);

    // Claim, or wait for whoever holds the claim.
    let lease: string | undefined;
    for (let attempt = 0; attempt < 3 && !lease; attempt++) {
      const claim = await ctx.runMutation(internal.oauthConnectors.claimRefresh, {
        installation_id: row._id,
        expected_enc: row.access_token_enc,
        now: Date.now(),
      });
      if (claim.ok) { lease = claim.lease; break; }
      if (claim.reason === "gone") return noConnection;
      const landed = await waitForOther(row.access_token_enc);
      if (landed) return landed;
      const again = await read();
      if (!again) return noConnection;
      row = again;
      if (!needsRefresh(row, Date.now())) return await tokenOf(row);
    }
    if (!lease) return { ok: false, error: `${p.name} refresh is held by another caller; retry` };

    const refreshToken = row.refresh_token_enc ? await decryptRefreshToken(row.refresh_token_enc, env.clientSecret) : null;
    /** A refused write means the row is no longer ours: a reconnect landed
     *  or a newer claimant holds the lease. Their write is the answer, so
     *  wait for it; the pair we fetched is never handed out. */
    const deferToOwner = async (reason: "gone" | "superseded" | undefined) => {
      if (reason === "gone") return noConnection;
      const landed = await waitForOther(row!.access_token_enc);
      return landed ?? await current();
    };
    if (!refreshToken) {
      // No refresh token (or undecryptable): the access token is all we
      // have. Releasing the lease is an outcome write like any other, so a
      // reconnect or disconnect that landed meanwhile refuses it, and the
      // captured row's token is then not the answer.
      const released = await ctx.runMutation(internal.oauthConnectors.updateStoredTokens, {
        installation_id: row._id,
        expected_enc: row.access_token_enc,
        lease,
      });
      return released.ok ? await tokenOf(row) : await deferToOwner(released.reason);
    }
    const fail = async (error: string) => {
      const stamped = await ctx.runMutation(internal.oauthConnectors.updateStoredTokens, {
        installation_id: row!._id,
        expected_enc: row!.access_token_enc,
        lease: lease!,
        last_error: error,
      });
      return stamped.ok ? { ok: false, error } : await deferToOwner(stamped.reason);
    };
    let res: { ok: boolean; status: number; tok: any };
    try {
      res = await tokenRequest(p, env, { grant_type: "refresh_token", refresh_token: refreshToken });
    } catch {
      return await fail(`${p.name} token endpoint unreachable; the next sync retries`);
    }
    const tok = res.tok;
    if (!res.ok || typeof tok?.access_token !== "string") {
      const code = tok?.error ?? `token_${res.status}`;
      const revoked = code === "invalid_grant" || res.status === 400 || res.status === 401;
      return await fail(
        revoked
          ? `${p.name} refresh refused (${code}): access was revoked or the refresh token expired; reconnect ${p.name} from Settings > Integrations`
          : `${p.name} refresh failed (${code}); the next sync retries`,
      );
    }
    const written = await ctx.runMutation(internal.oauthConnectors.updateStoredTokens, {
      installation_id: row._id,
      expected_enc: row.access_token_enc,
      lease,
      access_token_enc: await encryptRefreshToken(tok.access_token, env.clientSecret),
      refresh_token_enc: typeof tok.refresh_token === "string" ? await encryptRefreshToken(tok.refresh_token, env.clientSecret) : undefined,
      access_expires_at: accessExpiresAt(tok, now),
    });
    return written.ok ? { ok: true, token: tok.access_token } : await deferToOwner(written.reason);
  },
});
