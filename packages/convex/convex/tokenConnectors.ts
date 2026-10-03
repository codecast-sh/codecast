// Token connectors: Sentry, PostHog and a product's own app connector.
//
// These services hand out a token rather than run an OAuth round trip, so the
// flow is shorter than oauthConnectors.ts: the person pastes the token and a
// few non-secret settings, one live call proves the token reaches what the
// settings name, and the row is stored CONFIRMED. There is no two-phase
// confirm because there is no redirect to relay: the authenticated caller
// typed the credential themself, in the request that stores it.
//
// Everything else is the OAuth connectors' machinery, reused rather than
// copied: the `app_installations` table (provider-keyed, team XOR person),
// googleOAuth's AES-GCM helpers under this family's own HKDF info string and
// deployment key, `stillAuthorized` for the membership rule, `connectionForWork`
// for resolution and `deleteConnection` for revoke. A new token provider is
// one TOKEN_PROVIDERS entry plus its descriptor in appDescriptors.ts.
//
// docs/architecture/external-data.md X1. The token never leaves the backend:
// `getTokenCredential` is internal and answers only the adapters.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { internal } from "./_generated/api";
import {
  APP_DESCRIPTORS,
  isAppConnectionScope,
  type AppConnectionScope,
  type AppId,
} from "@codecast/shared/contracts";
import { encryptRefreshToken, decryptRefreshToken } from "./googleOAuth";
import { connectionForWork, connectionRowFor, stillAuthorized } from "./oauthConnectors";
import { parseWorkspaceKey, workspaceKey } from "./lib/accessKeys";
import { resumeSourcesOnConnect } from "./lib/sourceHealth";
import { POSTHOG_PROJECT_ID, SENTRY_SLUG } from "@codecast/shared/contracts/ingest";
import { internalHostRefusal, jsonOf, tokenHttp, type FetchLike } from "./lib/tokenHttp";

export type { FetchLike };

/* ==========================================================================
 * Encryption
 * ========================================================================== */

/** Domain separation from the OAuth connectors' ciphertexts. */
export const TOKEN_CONNECTION_HKDF_INFO = "codecast-token-connection-v1";

/** The deployment env var the token key derives from. Rotating it orphans
 *  every stored token connection; people reconnect. */
export const CONNECTION_SECRETS_KEY_ENV = "CONNECTION_SECRETS_KEY";

export const TOKEN_CONNECTIONS_NOT_CONFIGURED = `Token connections not configured (${CONNECTION_SECRETS_KEY_ENV})`;

export function connectionSecretsKey(): string | null {
  return process.env[CONNECTION_SECRETS_KEY_ENV] || null;
}

export function encryptConnectionSecret(plaintext: string, key: string): Promise<string> {
  return encryptRefreshToken(plaintext, key, TOKEN_CONNECTION_HKDF_INFO);
}

export function decryptConnectionSecret(enc: string, key: string): Promise<string | null> {
  return decryptRefreshToken(enc, key, TOKEN_CONNECTION_HKDF_INFO);
}

/**
 * The stored ciphertext of an app connection with no secret: codecast signs
 * every request to it instead (lib/codecastSigning.ts, external-data.md X8),
 * so there is nothing to encrypt and no deployment key is needed.
 */
export const SIGNED_CONNECTION = "";

/** A connection's display label and account id for a signed app connection: its base url's host. */
export function signedAppAccount(baseUrl: string): { label: string; account_id: string } {
  return { label: new URL(baseUrl).host, account_id: baseUrl };
}

/* ==========================================================================
 * The provider table
 * ========================================================================== */

export type TokenConnectorId = "sentry" | "posthog" | "app";

export type TokenConfig = Record<string, string>;

export interface TokenProvider {
  id: TokenConnectorId;
  /** Config keys holding a base URL: normalized to https origin + path. */
  urlKeys: readonly string[];
  /** Shape checks a required/default pass cannot express. Null when fine. */
  check: (config: TokenConfig) => string | null;
  /** The one GET that proves the token reaches what the config names. */
  validateUrl: (config: TokenConfig) => string;
  /** What the provider calls the thing at that URL, for a 404. */
  what: string;
  /** The connected account from the validate response, or null when the
   *  answer is not the shape this provider gives (a login page, a proxy). */
  account: (body: any, config: TokenConfig) => { label: string; account_id: string } | null;
}

// A Sentry slug and a PostHog project id, spelled once for connections and
// sources alike. Checked so a pasted value cannot steer the validate URL.
export { SENTRY_SLUG };

const sentry: TokenProvider = {
  id: "sentry",
  urlKeys: ["host"],
  check: (c) => (SENTRY_SLUG.test(c.org) ? null : `"${c.org}" is not a Sentry organization slug`),
  validateUrl: (c) => `${c.host}/api/0/organizations/${c.org}/`,
  what: "organization",
  account: (j, c) =>
    j && typeof j === "object" && (j.slug || j.id)
      ? { label: String(j.name ?? j.slug ?? c.org), account_id: String(j.id ?? j.slug) }
      : null,
};

const posthog: TokenProvider = {
  id: "posthog",
  urlKeys: ["host"],
  check: (c) => (POSTHOG_PROJECT_ID.test(c.project_id) ? null : `PostHog project id must be a number, got "${c.project_id}"`),
  validateUrl: (c) => `${c.host}/api/projects/${c.project_id}/`,
  what: "project",
  account: (j, c) =>
    j && typeof j === "object" && j.id !== undefined
      ? { label: String(j.name ?? `project ${c.project_id}`), account_id: String(j.id) }
      : null,
};

const app: TokenProvider = {
  id: "app",
  urlKeys: ["base_url"],
  check: () => null,
  validateUrl: (c) => `${c.base_url}/codecast/manifest`,
  what: "manifest",
  // A manifest names itself (external-data.md X8). Anything else answering
  // 200 there is not an app connector.
  account: (j, c) =>
    j && typeof j === "object" && typeof j.name === "string" && j.name.trim()
      ? { label: j.name.trim(), account_id: c.base_url }
      : null,
};

export const TOKEN_PROVIDERS: Record<TokenConnectorId, TokenProvider> = { sentry, posthog, app };

export function isTokenConnectorId(value: unknown): value is TokenConnectorId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TOKEN_PROVIDERS, value);
}

/* ==========================================================================
 * Parsing (pure)
 * ========================================================================== */

const MAX_TOKEN_CHARS = 4096;
const MAX_CONFIG_VALUE_CHARS = 512;

/** A pasted token: trimmed, printable ASCII with no spaces. Anything else is a
 *  paste accident (a newline, a quoted value) or a header injection. */
export function parseToken(raw: string): { ok: true; token: string } | { ok: false; error: string } {
  const token = raw.trim();
  if (!token) return { ok: false, error: "Paste the token" };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, error: "That token is too long" };
  if (!/^[\x21-\x7e]+$/.test(token)) return { ok: false, error: "A token has no spaces or line breaks" };
  return { ok: true, token };
}

/** An https base URL with no credentials, query or fragment, without its
 *  trailing slash. The token is sent there, so plain http is refused, and so
 *  is a host inside codecast's own network (lib/tokenHttp, checked again on
 *  every call). */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (internalHostRefusal(url.href)) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * The stored config for a provider: only the keys its descriptor lists, each
 * trimmed, defaults applied, required ones present, URLs normalized, then the
 * provider's own shape check. An unknown key is refused rather than dropped,
 * because config is stored in the clear and a misplaced secret must not land
 * there quietly.
 */
export function parseTokenConfig(
  provider: TokenConnectorId,
  raw: Record<string, string | undefined>,
): { ok: true; config: TokenConfig } | { ok: false; error: string } {
  const fields = APP_DESCRIPTORS[provider].tokenConfig ?? [];
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { ok: false, error: `Unknown setting "${key}" for ${APP_DESCRIPTORS[provider].name}` };
  }
  const p = TOKEN_PROVIDERS[provider];
  const config: TokenConfig = {};
  for (const field of fields) {
    const value = (raw[field.key] ?? "").trim() || field.default || "";
    if (!value) {
      if (field.optional) continue;
      return { ok: false, error: `${field.label} is required` };
    }
    if (value.length > MAX_CONFIG_VALUE_CHARS) return { ok: false, error: `${field.label} is too long` };
    if (p.urlKeys.includes(field.key)) {
      const url = normalizeBaseUrl(value);
      if (!url) return { ok: false, error: `${field.label} must be an https URL, got "${value}"` };
      config[field.key] = url;
    } else {
      config[field.key] = value;
    }
  }
  const problem = p.check(config);
  return problem ? { ok: false, error: problem } : { ok: true, config };
}

/* ==========================================================================
 * Validation (one live call)
 * ========================================================================== */

/**
 * GET the provider's validate URL with the token. Redirects are not followed:
 * a token is never carried to a host the person did not name. Every message is
 * safe to show; none of them contains the token.
 */
export async function validateToken(
  provider: TokenConnectorId,
  token: string,
  config: TokenConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; label: string; account_id: string } | { ok: false; error: string }> {
  const p = TOKEN_PROVIDERS[provider];
  const name = APP_DESCRIPTORS[provider].name;
  const url = p.validateUrl(config);
  const res = await tokenHttp(fetchImpl, { url, token, vendor: name, timeoutMs: 10_000, maxBytes: 1024 * 1024 });
  if (res.failure) return { ok: false, error: res.error! };
  if (res.status === 401 || res.status === 403) return { ok: false, error: `${name} refused the token (${res.status})` };
  if (res.status === 404) return { ok: false, error: `${name} has no ${p.what} at ${url}` };
  if (!res.ok) return { ok: false, error: `${name} answered ${res.status} at ${url}` };
  const body = jsonOf(res.text) ?? null;
  const account = p.account(body, config);
  if (!account) return { ok: false, error: `${url} did not answer like ${name}` };
  return { ok: true, ...account };
}

/* ==========================================================================
 * Connect
 * ========================================================================== */

/**
 * Validate a pasted token and store it as a confirmed connection. Session
 * auth from the web form, `api_token` from `cast integrations connect`
 * (integrations.cliConnectToken). Returns the row id and the account label,
 * never the token or its ciphertext.
 */
export const connectWithToken = action({
  args: {
    provider: v.string(),
    token: v.string(),
    config: v.optional(v.record(v.string(), v.string())),
    /** "team" (default) or "personal", as for the OAuth connectors. */
    scope: v.optional(v.string()),
    /**
     * The team a team-scoped connection binds to, by id or name among the
     * caller's own teams. Required for team scope: a write never lands in a
     * team the caller did not name (the web passes the workspace being
     * looked at, the CLI `--team <name>`).
     */
    team: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; id?: string; label?: string; error?: string }> => {
    if (!isTokenConnectorId(args.provider)) return { ok: false, error: "unknown provider" };
    const descriptor = APP_DESCRIPTORS[args.provider as AppId];
    const scope: AppConnectionScope = isAppConnectionScope(args.scope) ? args.scope : "team";
    if (!descriptor.scopes.includes(scope)) {
      return { ok: false, error: `${descriptor.name} connects at ${descriptor.scopes.join(" or ")} scope only` };
    }
    const me: ConnectTarget | null = await ctx.runQuery(internal.tokenConnectors.connectTarget, {
      api_token: args.api_token,
      ...(scope === "team" ? { team: args.team ?? "" } : {}),
    });
    if (!me) return { ok: false, error: "not signed in" };
    if (scope === "team" && !me.team_id) return { ok: false, error: me.error ?? `Name the team to connect ${descriptor.name} for` };
    // An app connector with no secret: codecast signs every request, so there
    // is no token to validate or encrypt. Nothing is called now either, since
    // the app accepts the signature only once its codecast.json names the
    // source; the manifest is fetched when the source exists (and retried).
    if (descriptor.tokenOptional && !args.token.trim()) {
      const parsed = parseTokenConfig(args.provider, args.config ?? {});
      if (!parsed.ok) return parsed;
      const account = signedAppAccount(parsed.config.base_url);
      const stored = await ctx.runMutation(internal.tokenConnectors.storeTokenConnection, {
        provider: args.provider,
        user_id: String(me.user_id),
        team_id: scope === "team" ? String(me.team_id) : undefined,
        access_token_enc: SIGNED_CONNECTION,
        config: parsed.config,
        account_label: account.label,
        account_id: account.account_id,
      });
      return stored.ok ? { ok: true, id: stored.id, label: account.label } : stored;
    }
    const key = connectionSecretsKey();
    if (!key) return { ok: false, error: TOKEN_CONNECTIONS_NOT_CONFIGURED };

    const token = parseToken(args.token);
    if (!token.ok) return token;
    const parsed = parseTokenConfig(args.provider, args.config ?? {});
    if (!parsed.ok) return parsed;
    const account = await validateToken(args.provider, token.token, parsed.config);
    if (!account.ok) return account;

    const stored = await ctx.runMutation(internal.tokenConnectors.storeTokenConnection, {
      provider: args.provider,
      user_id: String(me.user_id),
      team_id: scope === "team" ? String(me.team_id) : undefined,
      access_token_enc: await encryptConnectionSecret(token.token, key),
      config: parsed.config,
      account_label: account.label,
      account_id: account.account_id,
    });
    return stored.ok ? { ok: true, id: stored.id, label: account.label } : stored;
  },
});

export type ConnectTarget = { user_id: Id<"users">; team_id?: Id<"teams">; error?: string };

/**
 * The team a ref names among `teams` (the caller's own): an exact id, else a
 * name, case-insensitively. Null when nothing or more than one team matches.
 */
export function teamFromRef<T extends { _id: string; name?: string }>(teams: T[], ref: string): T | null {
  const needle = ref.trim();
  if (!needle) return null;
  const byId = teams.find((t) => String(t._id) === needle);
  if (byId) return byId;
  const byName = teams.filter((t) => (t.name ?? "").trim().toLowerCase() === needle.toLowerCase());
  return byName.length === 1 ? byName[0] : null;
}

/**
 * Who is connecting, and for a team connection the team they named among
 * their memberships. Writes are explicit (CLAUDE.md, workspace access vs
 * routing): an absent or unknown team is refused with the caller's teams
 * listed, never filled in from a pointer.
 */
export const connectTarget = internalQuery({
  args: { api_token: v.optional(v.string()), team: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ConnectTarget | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    if (args.team === undefined) return { user_id: userId };
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q) => q.eq("user_id", userId)).take(200);
    const teams = (await Promise.all(memberships.map((m) => ctx.db.get(m.team_id)))).filter((t): t is NonNullable<typeof t> => !!t);
    const team = teamFromRef(teams.map((t) => ({ ...t, _id: String(t._id) })), args.team);
    if (team) return { user_id: userId, team_id: team._id as Id<"teams"> };
    const yours = teams.length ? `your teams: ${teams.map((t) => t.name).join(", ")}` : "you are in no team";
    return {
      user_id: userId,
      error: args.team.trim()
        ? `No team of yours is named "${args.team.trim()}" (${yours}), or it names more than one: use its id`
        : `Name the team this connection is for (${yours}), or connect it personally`,
    };
  },
});

/**
 * Store a validated token connection, confirmed. One row per (provider,
 * scope): a reconnect replaces the credential, settings and account whole,
 * which any member could already do by disconnecting and connecting again.
 * The membership check runs HERE, in the transaction that writes, so a
 * caller removed from the team during the validate call stores nothing.
 */
export const storeTokenConnection = internalMutation({
  args: {
    provider: v.string(),
    user_id: v.string(),
    team_id: v.optional(v.string()),
    access_token_enc: v.string(),
    config: v.record(v.string(), v.string()),
    account_label: v.optional(v.string()),
    account_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; id?: string; error?: string }> => storeConnection(ctx, args),
});

export interface StoreConnectionArgs {
  provider: string;
  user_id: string;
  team_id?: string;
  access_token_enc: string;
  config: Record<string, string>;
  account_label?: string;
  account_id?: string;
}

/** storeTokenConnection's body, for a mutation that stores a connection in its own transaction (ingest.createSource). */
export async function storeConnection(ctx: { db: any }, args: StoreConnectionArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  {
    if (!isTokenConnectorId(args.provider)) return { ok: false, error: "unknown provider" };
    const userId = (ctx.db as any).normalizeId("users", args.user_id);
    const teamId = args.team_id ? (ctx.db as any).normalizeId("teams", args.team_id) : undefined;
    if (!userId || (args.team_id && !teamId)) return { ok: false, error: "bad_ids" };
    const scopeRow = teamId ? { team_id: teamId } : { scope_user_id: userId };
    if (!(await stillAuthorized(ctx, scopeRow, userId))) return { ok: false, error: "not_a_member" };

    const now = Date.now();
    const credential = {
      connected_by: userId,
      access_token_enc: args.access_token_enc,
      config: args.config,
      account_label: args.account_label,
      account_id: args.account_id,
      granted_scopes: [] as string[],
      updated_at: now,
    };
    // The workspace's sources of this provider read through this connection:
    // one stopped on a lost connection polls again, and an app source fetches
    // its manifest (scheduled, so after commit).
    await resumeSourcesOnConnect(ctx, args.provider, workspaceKey(teamId ? { type: "team", teamId } : { type: "personal", userId }), now);
    const existing = await connectionRowFor(ctx, args.provider, teamId ? { team_id: teamId } : { user_id: userId });
    if (existing) {
      await (ctx.db as any).patch(existing._id, {
        ...credential,
        // Nothing of an earlier credential survives: no refresh state, no
        // pending confirm, no stale error from the token this one replaces.
        refresh_token_enc: undefined,
        access_expires_at: undefined,
        refresh_lease_id: undefined,
        refresh_lease_until: undefined,
        pending_confirm_hash: undefined,
        pending_expires_at: undefined,
        pending_replacement: undefined,
        last_error: undefined,
      });
      return { ok: true, id: String(existing._id) };
    }
    const id = await (ctx.db as any).insert("app_installations", {
      provider: args.provider,
      team_id: teamId,
      scope_user_id: teamId ? undefined : userId,
      ...credential,
      created_at: now,
    });
    return { ok: true, id: String(id) };
  }
}

/* ==========================================================================
 * Resolve + read (internal: adapters only)
 * ========================================================================== */

/**
 * The token connection a piece of work acts through: the work's team's, else
 * the acting user's personal one (oauthConnectors.connectionForWork). The id
 * and the non-secret settings only, for a source to record which connection
 * it reads through.
 */
export const tokenConnectionFor = internalQuery({
  args: { provider: v.string(), team_id: v.optional(v.id("teams")), user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!isTokenConnectorId(args.provider)) return null;
    const row = await connectionForWork(ctx, args.provider, args);
    if (!row) return null;
    return {
      connection_id: row._id,
      scope: (row.team_id ? "team" : "personal") as AppConnectionScope,
      config: (row.config ?? {}) as TokenConfig,
      account_label: row.account_label as string | undefined,
    };
  },
});

export const tokenConnectionRow = internalQuery({
  args: { connection_id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("app_installations", args.connection_id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) return null;
    return {
      provider: row.provider,
      access_token_enc: row.access_token_enc,
      config: (row.config ?? {}) as TokenConfig,
      pending: !!row.pending_confirm_hash,
    };
  },
});

/**
 * The plaintext token and settings for one connection, for a provider
 * adapter making a call. Internal on purpose: nothing a client can reach
 * returns a token. Refuses OAuth rows, whose ciphertexts are keyed elsewhere.
 */
export const getTokenCredential = internalAction({
  args: { connection_id: v.string() },
  handler: async (ctx, args): Promise<TokenCredential> => await readTokenCredential(ctx, args.connection_id),
});

export type TokenCredential =
  | { ok: true; provider: TokenConnectorId; token: string; config: TokenConfig }
  | { ok: false; error: string };

/** getTokenCredential's body, for an adapter already running in an action (no action-in-action hop). */
export async function readTokenCredential(ctx: { runQuery: (...a: any[]) => Promise<any> }, connectionId: string): Promise<TokenCredential> {
  const row: any = await ctx.runQuery(internal.tokenConnectors.tokenConnectionRow, { connection_id: connectionId });
  if (!row || row.pending) return { ok: false, error: "no_connection: the connection was removed" };
  if (!isTokenConnectorId(row.provider)) return { ok: false, error: `not a token connection (${row.provider})` };
  if (row.access_token_enc === SIGNED_CONNECTION && APP_DESCRIPTORS[row.provider as AppId].tokenOptional) {
    return { ok: true, provider: row.provider, token: "", config: row.config };
  }
  const key = connectionSecretsKey();
  if (!key) return { ok: false, error: TOKEN_CONNECTIONS_NOT_CONFIGURED };
  const token = await decryptConnectionSecret(row.access_token_enc, key);
  const name = APP_DESCRIPTORS[row.provider as AppId].name;
  if (!token) {
    return { ok: false, error: `${name} token undecryptable (${CONNECTION_SECRETS_KEY_ENV} rotated?): reconnect ${name}` };
  }
  return { ok: true, provider: row.provider, token, config: row.config };
}

/**
 * The token for one connection, refused unless it is the provider the caller
 * reads. The adapters' one way from a connection id to a token.
 */
export async function tokenFor(
  ctx: { runQuery: (...a: any[]) => Promise<any> },
  connectionId: string | null,
  provider: TokenConnectorId,
): Promise<{ ok: true; token: string; config: TokenConfig } | { ok: false; error: string }> {
  const name = APP_DESCRIPTORS[provider].name;
  if (!connectionId) return { ok: false, error: `No ${name} connection in this source's workspace: connect it with \`cast integrations connect ${provider} --team <name>\` (or \`--personal\` for a personal source)` };
  const cred = await readTokenCredential(ctx, connectionId);
  if (!cred.ok) return cred;
  if (cred.provider !== provider) return { ok: false, error: `The source's connection is ${cred.provider}, not ${name}` };
  return { ok: true, token: cred.token, config: cred.config };
}

/**
 * The token connection an event source reads through (X1): the one it names,
 * else its workspace's own, the team's for a team source and the owner's for
 * a personal one. Strictly the workspace's: a team source never borrows a
 * member's personal token, and a named connection that moved out of the
 * workspace (or to another provider) is refused rather than used.
 */
export async function connectionIdForSource(
  ctx: { db: any },
  source: { provider: string; connection_id?: any; workspace: string; owner_user_id: any },
): Promise<string | null> {
  const ws = parseWorkspaceKey(source.workspace);
  if (!ws) return null;
  const scope = ws.type === "team" ? { team_id: ws.teamId } : { user_id: ws.userId };
  const belongs = (row: any) =>
    !!row &&
    row.provider === source.provider &&
    !row.pending_confirm_hash &&
    (ws.type === "team" ? String(row.team_id) === String(ws.teamId) : !row.team_id && String(row.scope_user_id) === String(ws.userId));
  if (source.connection_id) {
    const named = await ctx.db.get(source.connection_id);
    return belongs(named) ? String(named._id) : null;
  }
  const row = await connectionRowFor(ctx, source.provider, scope);
  return belongs(row) ? String(row._id) : null;
}
