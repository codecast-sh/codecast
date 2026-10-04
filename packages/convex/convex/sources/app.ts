// The app connector (docs/architecture/external-data.md X8): a product
// declares at <base_url>/codecast/manifest what codecast may read and do, and
// this module calls exactly that and nothing else.
//
// - Every request carries codecast's signature (lib/codecastSigning.ts,
//   @codecast/shared/contracts/codecastSignature), naming the source and its
//   workspace, so an app verifies codecast with no shared secret. A
//   connection may also hold a bearer secret, for apps that prefer one.
// - The manifest is fetched with the connection's credential, checked by
//   parseAppManifest, and cached on the source. It is refetched daily by a
//   cron, on `cast connector refresh`, and whenever a call finds it older than a day.
// - `read` and `doAction` resolve the secret through the token connectors
//   (tokenConnectors.tokenFor), validate the args against the declared schema, and
//   call method + path under the base url the secret was validated against.
//   Responses go back to the caller and are never stored.
// - An action runs only while a person's grant on the source covers it; a
//   high-risk action also needs `yes` on the call, and a non-idempotent one an
//   idempotency key (writeRefusal, the check every outside write passes,
//   Sentry's resolve and ignore included).
// - Grants are a person's: `grant` and `revoke` take a signed-in web session
//   and refuse an api token, so an agent can never approve its own action.
//   They cover an app's declared actions and a vendor source's fixed writes
//   (VENDOR_ACTIONS) alike.
// - Every call writes an app_calls row (who, what, args hash, status, ms,
//   bytes), never a body.
// - Watches poll a declared reader and fold its rows into check or job groups
//   through ingest.applyBatch, so transitions fire like any other source.
//
// The pure rules live in @codecast/shared/contracts/appConnector, where the
// CLI and web read them too.
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { patchSourceStats, scopeArgs, scopeOf, sourceByRef, type ScopeArgs } from "../ingest";
import { connectionIdForSource, tokenFor, TOKEN_PROVIDERS, type FetchLike } from "../tokenConnectors";
import { tokenHttp } from "../lib/tokenHttp";
import { signatureHeaders } from "../lib/codecastSigning";
import { isTokenRefusal, markConnectionLost } from "../lib/sourceHealth";
import { resolveSessionConversation } from "../lib/access";
import { forbidden, invalidScope, requireUser } from "../lib/auth";
import { siteUrl } from "../lib/siteUrl";
import { sha256Hex } from "../lib/hash";
import { INGEST_LIMITS, validateIngestBatch } from "@codecast/shared/contracts/ingest";
import { parseDuration } from "@codecast/shared/time";
import {
  APP_LIMITS,
  activeGrant,
  buildAppRequest,
  canonicalJson,
  formatActorHeader,
  grantPagePath,
  grantableActions,
  sourceHasGrants,
  mapWatchRows,
  parseAppManifest,
  validateJson,
  watchKey,
  withGrant,
  writeRefusal,
  type AppAction,
  type AppManifest,
  type AppReader,
  type AppWatch,
} from "@codecast/shared/contracts/appConnector";

type RunCtx = { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> };

/** The cached manifest, or null when none was fetched or it no longer parses. */
export function cachedManifest(row: Pick<Doc<"event_sources">, "manifest_json">): AppManifest | null {
  if (!row.manifest_json) return null;
  try {
    const parsed = parseAppManifest(JSON.parse(row.manifest_json));
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}

/**
 * The source with its manifest attached as manifest_json: from app_manifests,
 * or the copy a row stored before that table still carries. Code that reads
 * a manifest takes the row through this.
 */
export async function withManifest<T extends Doc<"event_sources">>(ctx: { db: any }, row: T): Promise<T> {
  const stored = await ctx.db.query("app_manifests").withIndex("by_source", (q: any) => q.eq("source_id", row._id)).first();
  return stored ? { ...row, manifest_json: stored.manifest_json } : row;
}

function manifestStale(row: Pick<Doc<"event_sources">, "manifest_fetched_at">, now: number): boolean {
  return !row.manifest_fetched_at || now - row.manifest_fetched_at > APP_LIMITS.manifest_max_age_ms;
}

async function appSource(ctx: any, args: ScopeArgs & { source: string }) {
  const { userId, workspaceKey } = await scopeOf(ctx, args);
  const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
  if (row.provider !== "app") invalidScope(`${row.short_id} is a ${row.provider} source, not an app connector`);
  return { userId, row };
}

/** A source with actions to grant: an app connector, or a vendor source with writes (Sentry). */
async function grantSource(ctx: any, args: ScopeArgs & { source: string }) {
  const { userId, workspaceKey } = await scopeOf(ctx, args);
  const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
  if (!sourceHasGrants(row.provider)) invalidScope(`${row.short_id} is a ${row.provider} source, which has nothing to grant`);
  return { userId, row };
}

/** Where a person grants this source's actions, for refusals to name. */
export const grantUrlFor = (source: Pick<Doc<"event_sources">, "short_id">) => `${siteUrl()}${grantPagePath(source.short_id)}`;

// ── The HTTP call ──

export interface AppHttpResult {
  ok: boolean;
  status?: number;
  text?: string;
  content_type?: string;
  bytes: number;
  ms: number;
  error?: string;
}

/** Which source a request is for: its signature names both, and the app checks them against its codecast.json. */
export interface AppSigner {
  source: string;
  workspace: string;
}

/** The signer of a source row. */
export const signerOf = (source: Pick<Doc<"event_sources">, "short_id" | "workspace">): AppSigner => ({ source: source.short_id, workspace: source.workspace });

/**
 * One request to the product, signed by codecast for `sign`'s source, with
 * the bearer secret too when the connection holds one. Redirects are not
 * followed (nothing goes to a host the connection does not name), the call is
 * aborted after 15 s, and a body over 256 KB is refused while it streams.
 * Error text never contains the secret. With no secret, a request codecast
 * cannot sign is not sent.
 */
export async function appHttp(
  fetchImpl: FetchLike,
  req: { url: string; method: string; body?: string },
  headers: { token?: string; actor: string; idempotency_key?: string; sign?: AppSigner },
): Promise<AppHttpResult> {
  const signed = headers.sign ? await signatureHeaders({ method: req.method, url: req.url, body: req.body, ...headers.sign }) : null;
  if (!headers.token && !signed?.ok) {
    return { ok: false, bytes: 0, ms: 0, error: signed && !signed.ok ? signed.error : "the connection has no secret and the request is unsigned" };
  }
  const res = await tokenHttp(fetchImpl, {
    url: req.url,
    method: req.method,
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(headers.token ? { token: headers.token } : {}),
    headers: {
      ...(signed?.ok ? signed.headers : {}),
      "X-Codecast-Actor": headers.actor,
      ...(headers.idempotency_key ? { "Idempotency-Key": headers.idempotency_key } : {}),
    },
    maxBytes: APP_LIMITS.response_bytes,
    timeoutMs: APP_LIMITS.timeout_ms,
    vendor: "the app",
  });
  // The product's own wording for each failure: these land in app_calls and on watch state.
  const error = (() => {
    switch (res.failure) {
      case "timeout":
        return `no answer in ${APP_LIMITS.timeout_ms / 1000}s`;
      case "redirect":
        return `redirected (${res.status}); the connector does not follow redirects`;
      case "over":
        return `the response is over ${APP_LIMITS.response_bytes / 1024} KB`;
      case undefined:
        return res.ok ? undefined : `answered ${res.status}`;
      default:
        return res.error;
    }
  })();
  return {
    ok: res.ok,
    ...(res.status ? { status: res.status } : {}),
    ...(res.text !== undefined ? { text: res.text } : {}),
    ...(res.content_type ? { content_type: res.content_type } : {}),
    bytes: res.bytes,
    ms: res.ms,
    ...(error ? { error } : {}),
  };
}

// ── The connection ──

const NO_APP_CONNECTION = "no app connection: connect the app in Settings → Integrations";

/**
 * The secret (empty for a signed connection) and base url a call goes out with, or why there is none. Every
 * call to the product (the manifest, a person's read or action, a watch)
 * resolves its connection through this.
 */
async function appCredential(ctx: RunCtx, connectionId: string | null): Promise<{ ok: true; token: string; base_url: string } | { ok: false; error: string }> {
  if (!connectionId) return { ok: false, error: NO_APP_CONNECTION };
  const cred = await tokenFor(ctx, connectionId, "app");
  if (!cred.ok) return cred;
  if (!cred.config.base_url) return { ok: false, error: "the connection has no base url" };
  return { ok: true, token: cred.token, base_url: cred.config.base_url };
}

// ── The manifest ──

/**
 * Fetch, check and cache a source's manifest. A manifest that fails to fetch
 * or parse keeps the cached one (an outage should not unlist every reader)
 * and records why on the source.
 */
export async function refreshManifestFor(
  ctx: RunCtx,
  source: Pick<Doc<"event_sources">, "_id" | "short_id" | "workspace">,
  connectionId: string | null,
  fetchImpl: FetchLike,
): Promise<{ ok: true; manifest: AppManifest } | { ok: false; error: string }> {
  const fail = async (error: string, lost?: boolean) => {
    await ctx.runMutation(internal.sources.app.storeManifest, { source_id: source._id, error, ...(lost ? { lost } : {}) });
    return { ok: false as const, error };
  };
  const cred = await appCredential(ctx, connectionId);
  if (!cred.ok) return fail(cred.error, true);
  const res = await appHttp(fetchImpl, { url: TOKEN_PROVIDERS.app.validateUrl({ base_url: cred.base_url }), method: "GET" }, { token: cred.token, actor: formatActorHeader({ watch: "manifest" }), sign: signerOf(source) });
  if (!res.ok) {
    const refused = isTokenRefusal(res.status);
    // A signed connection the app refuses is almost always an app whose codecast.json does not name this source yet.
    const why = refused && !cred.token ? `; the app must name ${source.short_id} (${source.workspace}) in its codecast.json, then cast connector refresh` : "";
    return fail(`manifest: ${res.error}${why}`, refused);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(res.text ?? "");
  } catch {
    return fail("manifest: the answer is not JSON");
  }
  const parsed = parseAppManifest(raw);
  if (!parsed.ok) return fail(`manifest: ${parsed.errors.slice(0, 5).join("; ")}${parsed.errors.length > 5 ? ` (+${parsed.errors.length - 5} more)` : ""}`);
  await ctx.runMutation(internal.sources.app.storeManifest, { source_id: source._id, manifest_json: JSON.stringify(parsed.manifest) });
  return { ok: true, manifest: parsed.manifest };
}

export const storeManifest = internalMutation({
  args: {
    source_id: v.id("event_sources"),
    manifest_json: v.optional(v.string()),
    error: v.optional(v.string()),
    /** The error is a lost connection (lib/sourceHealth): the source stops polling, cached manifest or not. */
    lost: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.source_id);
    if (!row) return;
    const now = Date.now();
    if (args.lost && args.error) {
      await markConnectionLost(ctx, row, args.error, now);
      return;
    }
    const stored = await ctx.db.query("app_manifests").withIndex("by_source", (q) => q.eq("source_id", row._id)).first();
    if (args.manifest_json) {
      if (stored) await ctx.db.patch(stored._id, { manifest_json: args.manifest_json, fetched_at: now });
      else await ctx.db.insert("app_manifests", { source_id: row._id, manifest_json: args.manifest_json, fetched_at: now });
      await ctx.db.patch(row._id, {
        // The manifest lives in app_manifests; a copy an older row carried goes.
        manifest_json: undefined,
        manifest_fetched_at: now,
        next_watch_at: nextWatchAt(cachedManifest({ manifest_json: args.manifest_json }), row.watch_state, now),
        updated_at: now,
        // A paused source stays paused; one that errored on its manifest recovers.
        ...(row.status === "error" ? { status: "active" as const, last_error: undefined } : {}),
      });
      return;
    }
    const hasManifest = !!stored || !!row.manifest_json;
    await ctx.db.patch(row._id, {
      last_error: args.error,
      updated_at: now,
      // With no manifest there is nothing to poll until the next refresh.
      ...(hasManifest ? {} : { next_watch_at: now + APP_LIMITS.manifest_max_age_ms }),
      ...(row.status === "active" && !hasManifest ? { status: "error" as const } : {}),
    });
  },
});

/** The manifest a call should use: the cached one, refreshed first when it is absent or a day old. */
async function freshManifest(ctx: RunCtx, source: Doc<"event_sources">, connectionId: string | null, fetchImpl: FetchLike, now: number) {
  const cached = cachedManifest(source);
  if (cached && !manifestStale(source, now)) return { ok: true as const, manifest: cached };
  const refreshed = await refreshManifestFor(ctx, source, connectionId, fetchImpl);
  if (refreshed.ok) return refreshed;
  return cached ? { ok: true as const, manifest: cached } : refreshed;
}

// ── Calls ──

/**
 * Who is calling, which source, and through which connection. Internal, read
 * by the actions below with the caller's auth (a session's identity rides
 * runQuery; the CLI passes its api_token), so access is the same check every
 * other source function makes. Returns the connection id, never a secret.
 */
export const callContext = internalQuery({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, row } = await appSource(ctx, args);
    const conversation = args.conversation_id ? await resolveSessionConversation(ctx, userId, args.conversation_id) : null;
    const user = await ctx.db.get(userId);
    return {
      source: await withManifest(ctx, row),
      user_id: userId,
      person: user?.email ?? String(userId),
      conversation_id: conversation?._id,
      session: conversation ? conversation.short_id ?? String(conversation._id) : undefined,
      connection_id: await connectionIdForSource(ctx, row),
    };
  },
});

export const recordCall = internalMutation({
  args: {
    source_id: v.id("event_sources"),
    user_id: v.id("users"),
    conversation_id: v.optional(v.id("conversations")),
    kind: v.union(v.literal("read"), v.literal("do")),
    name: v.string(),
    args_hash: v.string(),
    idempotency_key: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("error"), v.literal("denied")),
    http_status: v.optional(v.number()),
    error: v.optional(v.string()),
    ms: v.number(),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return;
    await ctx.db.insert("app_calls", {
      ...args,
      error: args.error?.slice(0, 500),
      workspace: source.workspace,
      team_id: source.team_id,
      created_at: Date.now(),
    });
  },
});

/** One call codecast made to an outside service on a person's behalf, as app_calls records it. */
export interface OutsideCall {
  source_id: Id<"event_sources">;
  user_id: Id<"users">;
  /** The agent session that made it, when one did. */
  conversation_id?: Id<"conversations">;
  kind: "read" | "do";
  name: string;
  /** Hashed, never stored: the row proves which args without keeping them. */
  args: unknown;
  idempotency_key?: string;
}
export type OutsideCallStatus = "ok" | "error" | "denied";
export interface OutsideCallOutcome {
  http_status?: number;
  error?: string;
  ms?: number;
  bytes?: number;
}

/** The app_calls row for an outside call: every writer (app connector, Sentry) audits through this. */
export async function auditOutsideCall(ctx: Pick<RunCtx, "runMutation">, call: OutsideCall, status: OutsideCallStatus, extra: OutsideCallOutcome = {}) {
  await ctx.runMutation(internal.sources.app.recordCall, {
    source_id: call.source_id,
    user_id: call.user_id,
    ...(call.conversation_id ? { conversation_id: call.conversation_id } : {}),
    kind: call.kind,
    name: call.name,
    args_hash: await sha256Hex(canonicalJson(call.args)),
    ...(call.idempotency_key ? { idempotency_key: call.idempotency_key } : {}),
    status,
    ms: extra.ms ?? 0,
    bytes: extra.bytes ?? 0,
    ...(extra.http_status !== undefined ? { http_status: extra.http_status } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });
}

export interface AppCallResult {
  ok: boolean;
  status?: number;
  /** The response as text (JSON as sent). Never parsed here: product keys need not be valid Convex field names. */
  text?: string;
  content_type?: string;
  bytes?: number;
  ms?: number;
  error?: string;
  denied?: boolean;
}

export interface AppCallInput extends ScopeArgs {
  source: string;
  name: string;
  args_json?: string;
  idempotency_key?: string;
  yes?: boolean;
}

/** `read` and `do` share every step but the grant gate. */
export async function appCall(ctx: RunCtx, kind: "read" | "do", input: AppCallInput, fetchImpl: FetchLike): Promise<AppCallResult> {
  const { source: ref, name, args_json, idempotency_key, yes, ...scope } = input;
  const c = await ctx.runQuery(internal.sources.app.callContext, { ...scope, source: ref });
  const source: Doc<"event_sources"> = c.source;
  if (source.status === "paused") return { ok: false, error: `${source.short_id} is paused` };
  const now = Date.now();
  const m = await freshManifest(ctx, source, c.connection_id, fetchImpl, now);
  if (!m.ok) return { ok: false, error: m.error };

  const defs: Array<AppReader | AppAction> = kind === "read" ? m.manifest.readers : m.manifest.actions;
  const def = defs.find((d) => d.name === name);
  if (!def) {
    const known = defs.map((d) => d.name).join(", ") || "none";
    return { ok: false, error: `${source.name} declares no ${kind === "read" ? "reader" : "action"} ${name} (it has: ${known})` };
  }

  let args: Record<string, unknown> = {};
  let argsError: string | undefined;
  if (args_json && args_json.length > APP_LIMITS.args_bytes) argsError = `args are over ${APP_LIMITS.args_bytes / 1024} KB`;
  else if (args_json) {
    try {
      const parsed = JSON.parse(args_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) argsError = "args must be a JSON object";
      else args = parsed;
    } catch {
      argsError = "args are not JSON";
    }
  }
  const call: OutsideCall = { source_id: source._id, user_id: c.user_id, conversation_id: c.conversation_id, kind, name, args, idempotency_key };
  const audit = (status: OutsideCallStatus, extra: OutsideCallOutcome) => auditOutsideCall(ctx, call, status, extra);

  const invalid = argsError ? [argsError] : validateJson(def.input, args);
  if (invalid.length) {
    const error = `invalid args: ${invalid.join("; ")}`;
    await audit("error", { error });
    return { ok: false, error };
  }
  if (kind === "do") {
    const refusal = writeRefusal(m.manifest.actions, source.grants, name, { yes, idempotency_key, grantUrl: grantUrlFor(source) }, now);
    if (refusal) {
      await audit("denied", { error: refusal });
      return { ok: false, denied: true, error: refusal };
    }
  }

  const cred = await appCredential(ctx, c.connection_id);
  if (!cred.ok) {
    await audit("error", { error: cred.error });
    return { ok: false, error: cred.error };
  }
  const req = buildAppRequest(cred.base_url, def, args);
  if (!req.ok) {
    await audit("error", { error: req.error });
    return { ok: false, error: req.error };
  }
  const res = await appHttp(fetchImpl, req, {
    token: cred.token,
    actor: formatActorHeader({ person: c.person, session: c.session }),
    idempotency_key: kind === "do" ? idempotency_key : undefined,
    sign: signerOf(source),
  });
  await audit(res.ok ? "ok" : "error", { http_status: res.status, error: res.error, ms: res.ms, bytes: res.bytes });
  return {
    ok: res.ok,
    ...(res.status !== undefined ? { status: res.status } : {}),
    ...(res.text !== undefined ? { text: res.text } : {}),
    ...(res.content_type ? { content_type: res.content_type } : {}),
    bytes: res.bytes,
    ms: res.ms,
    ...(res.error ? { error: res.error } : {}),
  };
}

const callArgs = {
  ...scopeArgs,
  source: v.string(),
  /** The args as a JSON object string: product argument names need not be valid Convex field names. */
  args_json: v.optional(v.string()),
};

/** `cast connector read <source> <reader>`: call a declared reader and hand back its answer. */
export const read = action({
  args: { ...callArgs, reader: v.string() },
  handler: async (ctx, { reader, ...args }): Promise<AppCallResult> => appCall(ctx, "read", { ...args, name: reader }, fetch),
});

/** `cast connector do <source> <action>`: run a granted action. */
export const doAction = action({
  args: { ...callArgs, action: v.string(), idempotency_key: v.optional(v.string()), yes: v.optional(v.boolean()) },
  handler: async (ctx, { action: name, ...args }): Promise<AppCallResult> => appCall(ctx, "do", { ...args, name }, fetch),
});

/** `cast connector refresh <source>`: refetch the manifest now. */
export const refresh = action({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; readers?: number; actions?: number; watches?: number }> => {
    const c = await ctx.runQuery(internal.sources.app.callContext, args);
    const out = await refreshManifestFor(ctx, c.source, c.connection_id, fetch);
    if (!out.ok) return out;
    return { ok: true, readers: out.manifest.readers.length, actions: out.manifest.actions.length, watches: out.manifest.watches.length };
  },
});

// ── Listing ──

/**
 * The cached manifest with the grants in force and each watch's poll state.
 * The manifest crosses as JSON text: a declared input schema may carry keys
 * ($schema, $ref) Convex refuses as field names. Clients read it with
 * parseAppManifest and activeGrant from the shared contract.
 */
export const capabilities = query({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { row } = await grantSource(ctx, args);
    const manifest = cachedManifest(await withManifest(ctx, row));
    const now = Date.now();
    return {
      source: { _id: row._id, short_id: row.short_id, name: row.name, provider: row.provider, status: row.status, last_error: row.last_error },
      manifest_json: manifest ? JSON.stringify(manifest) : null,
      manifest_fetched_at: row.manifest_fetched_at ?? null,
      grants: (row.grants ?? []).filter((g) => activeGrant([g], g.action, now)),
      watch_state: row.watch_state ?? [],
    };
  },
});

/** `cast connector calls <source>`: the call audit, newest first. */
export const listCalls = query({
  args: { ...scopeArgs, source: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { row } = await grantSource(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    return await ctx.db.query("app_calls").withIndex("by_source_created", (q) => q.eq("source_id", row._id)).order("desc").take(limit);
  },
});

// ── Grants ──

/**
 * Grants are a person's call, made in the browser. An api token is what an
 * agent runs with, so a call carrying one is refused before anything is read:
 * an agent must never approve its own outside writes.
 */
async function personGrantSource(ctx: any, args: ScopeArgs & { source: string }) {
  if (args.api_token) forbidden("Grants are made by a person in the browser, under Ops, Apps; an api token cannot grant or revoke");
  await requireUser(ctx);
  return await grantSource(ctx, args);
}

/**
 * A person allows an action, optionally for a while (`until`: "30d"). The
 * action must be one the source can be granted: the cached manifest's for an
 * app connector, the vendor's writes for a Sentry source.
 */
export const grant = mutation({
  args: { ...scopeArgs, source: v.string(), action: v.string(), until: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, row } = await personGrantSource(ctx, args);
    const manifest = cachedManifest(await withManifest(ctx, row));
    if (row.provider === "app" && !manifest) invalidScope(`${row.short_id} has no manifest yet: run \`cast connector refresh ${row.name}\` first`);
    const actions = grantableActions(row.provider, manifest);
    if (!actions.some((a) => a.name === args.action)) {
      invalidScope(`${row.name} declares no action ${args.action} (it has: ${actions.map((a) => a.name).join(", ") || "none"})`);
    }
    const now = Date.now();
    let until: number | undefined;
    if (args.until) {
      try {
        until = now + parseDuration(args.until);
      } catch (e: any) {
        invalidScope(`until: ${e?.message ?? e}`);
      }
    }
    const entry = { action: args.action, granted_by: userId, granted_at: now, ...(until ? { until } : {}), via: "session" as const };
    await ctx.db.patch(row._id, { grants: withGrant(row.grants, entry, now), updated_at: now });
    return { grant: entry };
  },
});

export const revoke = mutation({
  args: { ...scopeArgs, source: v.string(), action: v.string() },
  handler: async (ctx, args) => {
    const { row } = await personGrantSource(ctx, args);
    const kept = (row.grants ?? []).filter((g) => g.action !== args.action);
    const revoked = kept.length !== (row.grants ?? []).length;
    if (revoked) await ctx.db.patch(row._id, { grants: kept, updated_at: Date.now() });
    return { revoked };
  },
});

// ── Watches (crons.ts) ──

/** Cron jitter allowance: a 5m watch polled by a 5m cron must not skip every other tick. */
const WATCH_SLACK_MS = 60_000;

export function dueWatches(manifest: AppManifest | null, state: Doc<"event_sources">["watch_state"], now: number): AppWatch[] {
  return (manifest?.watches ?? []).filter((w) => {
    const s = state?.find((x) => x.key === watchKey(w));
    return !s || now - s.polled_at >= w.every_ms - WATCH_SLACK_MS;
  });
}

/**
 * When the earliest of a manifest's watches is next due under `state`. A
 * manifest with no watches is looked at again after its next refresh.
 */
export function nextWatchAt(manifest: AppManifest | null, state: Doc<"event_sources">["watch_state"], now: number): number {
  const watches = manifest?.watches ?? [];
  if (!watches.length) return now + APP_LIMITS.manifest_max_age_ms;
  return Math.min(
    ...watches.map((w) => {
      const s = state?.find((x) => x.key === watchKey(w));
      // A watch never polled has been due all along.
      return s ? s.polled_at + w.every_ms - WATCH_SLACK_MS : 0;
    }),
  );
}

const POLL_PAGE = 200;

/**
 * Active app sources with a watch due now, read by next_watch_at so the cron
 * touches only those (a source that predates the field counts as due once,
 * and its first poll sets it).
 */
export const sourcesWithDueWatches = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("event_sources")
      .withIndex("by_provider_status_next_watch", (q) => q.eq("provider", "app").eq("status", "active").lte("next_watch_at", args.now))
      .take(POLL_PAGE);
    return rows.map((row) => row._id);
  },
});

export const pollWatches = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids: Id<"event_sources">[] = await ctx.runQuery(internal.sources.app.sourcesWithDueWatches, { now: Date.now() });
    for (const source_id of ids) await ctx.scheduler.runAfter(0, internal.sources.app.pollSource, { source_id });
    return ids.length;
  },
});

export const sourceForPoll = internalQuery({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.source_id);
    if (!row || row.provider !== "app") return null;
    return { source: await withManifest(ctx, row), connection_id: await connectionIdForSource(ctx, row) };
  },
});

export const recordWatchPolls = internalMutation({
  args: {
    source_id: v.id("event_sources"),
    states: v.array(v.object({ key: v.string(), polled_at: v.number(), cursor: v.optional(v.number()), last_error: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.source_id);
    if (!row) return;
    const byKey = new Map((row.watch_state ?? []).map((s) => [s.key, s]));
    for (const s of args.states) {
      // A failed poll keeps the cursor it had, so the failures it missed still count next time.
      const cursor = s.cursor ?? byKey.get(s.key)?.cursor;
      byKey.set(s.key, { key: s.key, polled_at: s.polled_at, ...(cursor !== undefined ? { cursor } : {}), ...(s.last_error ? { last_error: s.last_error.slice(0, 500) } : {}) });
    }
    const now = Date.now();
    const watchState = [...byKey.values()];
    const manifest = cachedManifest(await withManifest(ctx, row));
    await ctx.db.patch(row._id, { watch_state: watchState, next_watch_at: nextWatchAt(manifest, watchState, now) });
    if (args.states.length) await patchSourceStats(ctx, row, () => ({ last_poll_at: now }), now);
  },
});

/**
 * Poll one source's due watches. Each answer's rows become check or job
 * items, pass the door's own validation, and go through applyBatch, so a
 * watched invariant turning red is the same transition an SDK check would
 * be. Successful polls write no app_calls row (one every few minutes per
 * watch would bury the people's calls); a failed one does, as the owner.
 */
export async function pollSourceWatches(ctx: RunCtx, sourceId: Id<"event_sources">, fetchImpl: FetchLike, now = Date.now()) {
  const found = await ctx.runQuery(internal.sources.app.sourceForPoll, { source_id: sourceId });
  if (!found || found.source.status !== "active") return { polled: 0 };
  const source: Doc<"event_sources"> = found.source;
  // No connection to poll with: the source stops here (lib/sourceHealth)
  // rather than failing and auditing every watch on every tick.
  const lost = async (error: string) => {
    await ctx.runMutation(internal.ingest.sourceConnectionLost, { source_id: source._id, error });
    return { polled: 0, error };
  };
  const cred = await appCredential(ctx, found.connection_id);
  if (!cred.ok) return lost(cred.error);
  const m = await freshManifest(ctx, source, found.connection_id, fetchImpl, now);
  if (!m.ok) return { polled: 0, error: m.error };
  const due = dueWatches(m.manifest, source.watch_state, now);
  if (!due.length) {
    // Nothing due after all (the cron read an unset next_watch_at): record
    // when something will be, so the cron stops reading this source.
    await ctx.runMutation(internal.sources.app.recordWatchPolls, { source_id: source._id, states: [] });
    return { polled: 0 };
  }

  const states: Array<{ key: string; polled_at: number; cursor?: number; last_error?: string }> = [];
  let accepted = 0;
  let refusedBy: string | undefined;
  for (const watch of due) {
    const key = watchKey(watch);
    const prior = source.watch_state?.find((s) => s.key === key);
    const failed = async (error: string, http?: { status?: number; ms: number; bytes: number }) => {
      states.push({ key, polled_at: now, last_error: error });
      await auditOutsideCall(
        ctx,
        { source_id: source._id, user_id: source.owner_user_id, kind: "read", name: watch.reader, args: {} },
        "error",
        { error: `watch ${key}: ${error}`, ms: http?.ms, bytes: http?.bytes, http_status: http?.status },
      );
    };
    const reader = m.manifest.readers.find((r) => r.name === watch.reader)!;
    const req = buildAppRequest(cred.base_url, reader, {});
    if (!req.ok) {
      await failed(req.error);
      continue;
    }
    const res = await appHttp(fetchImpl, req, { token: cred.token, actor: formatActorHeader({ watch: key }), sign: signerOf(source) });
    if (!res.ok) {
      await failed(res.error ?? "failed", { status: res.status, ms: res.ms, bytes: res.bytes });
      if (isTokenRefusal(res.status)) {
        refusedBy = cred.token
          ? `the app refused the connection's secret (${res.status}): reconnect the app`
          : `the app refused codecast's signature (${res.status}): its codecast.json must name ${source.short_id} (${source.workspace})`;
        break;
      }
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(res.text ?? "");
    } catch {
      await failed("the answer is not JSON", { status: res.status, ms: res.ms, bytes: res.bytes });
      continue;
    }
    const mapped = mapWatchRows(watch, body, { now, since: prior?.cursor });
    if (!mapped.ok) {
      await failed(mapped.error, { status: res.status, ms: res.ms, bytes: res.bytes });
      continue;
    }
    // The rows go through the door's own limits in door-sized pieces. A piece
    // the door would refuse fails the poll and keeps the cursor, so a job
    // watch counts those failures on the next poll rather than never.
    const pieces = [];
    for (let i = 0; i < mapped.items.length; i += INGEST_LIMITS.max_items) pieces.push(validateIngestBatch({ items: mapped.items.slice(i, i + INGEST_LIMITS.max_items) }, now));
    const refused = pieces.find((b) => !b.ok);
    if (refused && !refused.ok) {
      await failed(`the rows do not fit the ingest limits: ${refused.error}`, { status: res.status, ms: res.ms, bytes: res.bytes });
      continue;
    }
    for (const batch of pieces) {
      if (!batch.ok || !batch.items.length) continue;
      const out = await ctx.runMutation(internal.ingest.applyBatch, { source_id: source._id, items_json: JSON.stringify(batch.items) });
      accepted += out.accepted;
    }
    states.push({ key, polled_at: now, ...(mapped.cursor !== undefined ? { cursor: mapped.cursor } : {}) });
  }
  await ctx.runMutation(internal.sources.app.recordWatchPolls, { source_id: source._id, states });
  if (refusedBy) return { ...(await lost(refusedBy)), polled: states.length, accepted };
  return { polled: due.length, accepted };
}

export const pollSource = internalAction({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => pollSourceWatches(ctx, args.source_id, fetch),
});

/** Daily: every app source whose manifest is a day old refetches it, even with nobody calling. */
export const staleManifestSources = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const out: Id<"event_sources">[] = [];
    // Only the stale ones: an index range on manifest_fetched_at (an unset
    // one sorts first, so a source never fetched is included).
    const cutoff = args.now + WATCH_SLACK_MS - APP_LIMITS.manifest_max_age_ms;
    for (const status of ["active", "error"] as const) {
      const rows = await ctx.db
        .query("event_sources")
        .withIndex("by_provider_status_manifest", (q) => q.eq("provider", "app").eq("status", status).lt("manifest_fetched_at", cutoff))
        .take(POLL_PAGE);
      for (const row of rows) if (manifestStale(row, args.now + WATCH_SLACK_MS)) out.push(row._id);
    }
    return out;
  },
});

export const refreshManifests = internalAction({
  args: {},
  handler: async (ctx) => {
    const ids: Id<"event_sources">[] = await ctx.runQuery(internal.sources.app.staleManifestSources, { now: Date.now() });
    for (const source_id of ids) await ctx.scheduler.runAfter(0, internal.sources.app.refreshSourceManifest, { source_id });
    return ids.length;
  },
});

export const refreshSourceManifest = internalAction({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const found = await ctx.runQuery(internal.sources.app.sourceForPoll, { source_id: args.source_id });
    if (!found) return { ok: false, error: "source gone" };
    return refreshManifestFor(ctx, found.source, found.connection_id, fetch);
  },
});
