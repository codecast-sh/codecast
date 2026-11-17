// Who an MCP call reads as, and the OAuth that connects an agent
// (docs/architecture/agent-mcp.md). Two bearers reach /mcp:
//   - a grant's access token (cmcp_…), minted here by the OAuth code exchange;
//   - an existing `cast` token, for headless agents that already hold one,
//     whose reads are recorded so a leaked token reading here is visible.
// A grant lives in mcp_grants, never in api_tokens, so it cannot reach any
// `cast` mutation that accepts a CLI token.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { MCP_READ_SCOPE } from "@codecast/shared/contracts";
import { hashToken, verifyApiToken } from "./apiTokens";
import { bumpWindow } from "./ipRateLimit";
import { newSlug } from "./lib/slug";

export const ACCESS_PREFIX = "cmcp_";
const REFRESH_PREFIX = "cmcr_";
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
const UNAPPROVED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const READ_NOTE_THROTTLE_MS = 60 * 1000;

export const newGrantSecret = (prefix: string) => prefix + newSlug(43);
const secret = newGrantSecret;

// ── Redirect URIs ──

const REFUSED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https anywhere, http only on loopback, or a private-use app scheme (cursor://). */
export function redirectUriAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return !!url.hostname;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  if (REFUSED_SCHEMES.has(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** The place a client returns to, as a person reads it on the consent screen. */
export function redirectHost(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "https:" || url.protocol === "http:") return LOOPBACK.has(url.hostname) ? "this computer" : url.host;
  return `${url.protocol}//${url.host}`;
}

// ── PKCE ──

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── Bearer resolution (every /mcp call) ──

export type McpCaller =
  | { userId: Id<"users">; kind: "grant"; grantId: Id<"mcp_grants"> }
  | { userId: Id<"users">; kind: "cast_token"; tokenId: Id<"api_tokens"> };

export const resolveBearer = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<McpCaller | null> => {
    if (args.token.startsWith(ACCESS_PREFIX)) {
      const hash = await hashToken(args.token);
      const grant = await ctx.db.query("mcp_grants").withIndex("by_access_hash", (q) => q.eq("access_hash", hash)).first();
      if (!grant || grant.access_expires_at < Date.now()) return null;
      return { userId: grant.user_id, kind: "grant", grantId: grant._id };
    }
    if (args.token.startsWith(REFRESH_PREFIX)) return null;
    const auth = await verifyApiToken(ctx, args.token, false);
    return auth ? { userId: auth.userId as Id<"users">, kind: "cast_token", tokenId: auth.tokenId as Id<"api_tokens"> } : null;
  },
});

/** Last read per grant or per cast token, at most once a minute. */
export const noteRead = internalMutation({
  args: {
    user_id: v.id("users"),
    grant_id: v.optional(v.id("mcp_grants")),
    token_id: v.optional(v.id("api_tokens")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.grant_id) {
      const grant = await ctx.db.get(args.grant_id);
      if (grant && now - (grant.last_used_at ?? 0) > READ_NOTE_THROTTLE_MS) await ctx.db.patch(grant._id, { last_used_at: now });
      return;
    }
    if (!args.token_id) return;
    const tokenId = args.token_id;
    const row = await ctx.db.query("mcp_bearer_reads").withIndex("by_token", (q) => q.eq("token_id", tokenId)).first();
    if (!row) await ctx.db.insert("mcp_bearer_reads", { user_id: args.user_id, token_id: tokenId, first_read_at: now, last_read_at: now });
    else if (now - row.last_read_at > READ_NOTE_THROTTLE_MS) await ctx.db.patch(row._id, { last_read_at: now });
  },
});

// ── Dynamic client registration (RFC 7591) ──

export const registerClient = internalMutation({
  args: { client_name: v.string(), redirect_uris: v.array(v.string()), ip: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; client_id: string; created_at: number } | { ok: false; error: string; status: number }> => {
    const limited = await bumpWindow(ctx.db, `mcp_register:${args.ip}`, 20, 60 * 60 * 1000);
    if (!limited.ok) return { ok: false, error: "Too many registrations; try again later", status: 429 };
    const uris = args.redirect_uris.slice(0, 10);
    if (uris.length === 0 || !uris.every(redirectUriAllowed) || uris.some((u) => u.length > 2000)) {
      return { ok: false, error: "redirect_uris must be https, loopback http, or an app scheme", status: 400 };
    }
    const client_id = "cmcc_" + newSlug(24);
    const created_at = Date.now();
    await ctx.db.insert("mcp_clients", {
      client_id,
      client_name: (args.client_name || "Unnamed agent").slice(0, 80),
      redirect_uris: uris,
      created_at,
    });
    return { ok: true, client_id, created_at };
  },
});

// ── Token endpoint ──

export type TokenReply =
  | { ok: true; access_token: string; refresh_token: string; expires_in: number; scope: string }
  | { ok: false; error: "invalid_grant" | "invalid_request" | "invalid_client"; description: string };

async function mintPair() {
  const access = secret(ACCESS_PREFIX);
  const refresh = secret(REFRESH_PREFIX);
  const now = Date.now();
  return {
    access,
    refresh,
    fields: {
      access_hash: await hashToken(access),
      access_expires_at: now + ACCESS_TTL_MS,
      refresh_hash: await hashToken(refresh),
      refresh_expires_at: now + REFRESH_IDLE_MS,
    },
  };
}

const granted = (access: string, refresh: string): TokenReply => ({
  ok: true,
  access_token: access,
  refresh_token: refresh,
  expires_in: ACCESS_TTL_MS / 1000,
  scope: MCP_READ_SCOPE,
});

export const exchangeCode = internalMutation({
  args: { code: v.string(), code_verifier: v.string(), client_id: v.string(), redirect_uri: v.string() },
  handler: async (ctx, args): Promise<TokenReply> => {
    const hash = await hashToken(args.code);
    const code = await ctx.db.query("mcp_auth_codes").withIndex("by_code_hash", (q) => q.eq("code_hash", hash)).first();
    if (!code) return { ok: false, error: "invalid_grant", description: "Unknown or used code" };
    // Single use, whatever happens next.
    await ctx.db.delete(code._id);
    if (code.expires_at < Date.now()) return { ok: false, error: "invalid_grant", description: "Code expired" };
    if (code.client_id !== args.client_id || code.redirect_uri !== args.redirect_uri) {
      return { ok: false, error: "invalid_grant", description: "Code was issued to another client or return address" };
    }
    if ((await s256(args.code_verifier)) !== code.code_challenge) {
      return { ok: false, error: "invalid_grant", description: "PKCE verifier does not match" };
    }
    const client = await ctx.db.query("mcp_clients").withIndex("by_client_id", (q) => q.eq("client_id", args.client_id)).first();
    if (!client) return { ok: false, error: "invalid_client", description: "Client no longer registered" };
    if (!client.approved_at) await ctx.db.patch(client._id, { approved_at: Date.now() });
    // One connection per agent per person: connecting the same client again
    // (a lost token, a second login) replaces its earlier grant.
    for (const g of await ctx.db.query("mcp_grants").withIndex("by_user", (q) => q.eq("user_id", code.user_id)).collect()) {
      if (g.client_id === client.client_id) await ctx.db.delete(g._id);
    }
    const pair = await mintPair();
    await ctx.db.insert("mcp_grants", {
      user_id: code.user_id,
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_host: redirectHost(code.redirect_uri),
      scope: code.scope,
      created_at: Date.now(),
      ...pair.fields,
    });
    return granted(pair.access, pair.refresh);
  },
});

export const refreshGrant = internalMutation({
  args: { refresh_token: v.string(), client_id: v.string() },
  handler: async (ctx, args): Promise<TokenReply> => {
    const hash = await hashToken(args.refresh_token);
    const grant = await ctx.db.query("mcp_grants").withIndex("by_refresh_hash", (q) => q.eq("refresh_hash", hash)).first();
    if (!grant) {
      // A refresh token already rotated away: someone else holds a copy. End the grant.
      const reused = await ctx.db.query("mcp_grants").withIndex("by_previous_refresh_hash", (q) => q.eq("previous_refresh_hash", hash)).first();
      if (reused) await ctx.db.delete(reused._id);
      return { ok: false, error: "invalid_grant", description: "Unknown refresh token" };
    }
    if (grant.client_id !== args.client_id) return { ok: false, error: "invalid_grant", description: "Refresh token belongs to another client" };
    if (grant.refresh_expires_at < Date.now()) {
      await ctx.db.delete(grant._id);
      return { ok: false, error: "invalid_grant", description: "Refresh token expired" };
    }
    const pair = await mintPair();
    await ctx.db.patch(grant._id, { ...pair.fields, previous_refresh_hash: grant.refresh_hash });
    return granted(pair.access, pair.refresh);
  },
});

// ── Connected agents (Settings) ──

/** One connected agent as Settings lists it: an OAuth grant, or a `cast` token that has read through /mcp. */
export type McpConnection =
  | { kind: "grant"; _id: string; name: string; host: string; created_at: number; last_used_at: number | null }
  | { kind: "cast_token"; _id: string; name: string; host: null; created_at: number; last_used_at: number };

export const listConnections = query({
  args: {},
  handler: async (ctx): Promise<McpConnection[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const out: McpConnection[] = [];
    for (const g of await ctx.db.query("mcp_grants").withIndex("by_user", (q) => q.eq("user_id", userId)).collect()) {
      if (g.refresh_expires_at < now) continue;
      out.push({ kind: "grant", _id: String(g._id), name: g.client_name, host: g.redirect_host, created_at: g.created_at, last_used_at: g.last_used_at ?? null });
    }
    for (const r of await ctx.db.query("mcp_bearer_reads").withIndex("by_user", (q) => q.eq("user_id", userId)).collect()) {
      const token = await ctx.db.get(r.token_id);
      if (!token) continue;
      out.push({ kind: "cast_token", _id: String(token._id), name: token.name, host: null, created_at: r.first_read_at, last_used_at: r.last_read_at });
    }
    return out.sort((a, b) => (b.last_used_at ?? b.created_at) - (a.last_used_at ?? a.created_at));
  },
});

/**
 * Disconnect, from Settings (dispatch disconnectAgent). A grant is deleted and
 * its next call is a 401. A `cast` token seen reading through /mcp is revoked
 * outright, which also signs out the machine holding it: the review says so.
 */
export async function disconnectCore(ctx: { db: any }, userId: Id<"users">, kind: "grant" | "cast_token", id: string): Promise<void> {
  if (kind === "grant") {
    const grantId = ctx.db.normalizeId("mcp_grants", id);
    const grant = grantId ? await ctx.db.get(grantId) : null;
    if (grant && grant.user_id === userId) await ctx.db.delete(grant._id);
    return;
  }
  const tokenId = ctx.db.normalizeId("api_tokens", id);
  const token = tokenId ? await ctx.db.get(tokenId) : null;
  if (!token || token.user_id !== userId) return;
  for (const r of await ctx.db.query("mcp_bearer_reads").withIndex("by_token", (q: any) => q.eq("token_id", token._id)).collect()) await ctx.db.delete(r._id);
  await ctx.db.delete(token._id);
}

/** Codes, unapproved clients and lapsed grants past their time. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const c of await ctx.db.query("mcp_auth_codes").withIndex("by_expires", (q) => q.lt("expires_at", now)).take(200)) await ctx.db.delete(c._id);
    for (const c of await ctx.db.query("mcp_clients").take(500)) {
      if (!c.approved_at && now - c.created_at > UNAPPROVED_CLIENT_TTL_MS) await ctx.db.delete(c._id);
    }
    for (const g of await ctx.db.query("mcp_grants").take(500)) {
      if (g.refresh_expires_at < now) await ctx.db.delete(g._id);
    }
  },
});
