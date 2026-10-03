// The app connector (docs/architecture/external-data.md X8): a product
// declares at <base_url>/codecast/manifest what codecast may read and do, and
// this module calls exactly that and nothing else.
//
// - The manifest is fetched with the connection's bearer secret, checked by
//   parseAppManifest, and cached on the source. It is refetched daily by a
//   cron, on `cast connector refresh`, and whenever a call finds it older than a day.
// - `read` and `doAction` resolve the secret through the token connectors
//   (readTokenCredential), validate the args against the declared schema, and
//   call method + path under the base url the secret was validated against.
//   Responses go back to the caller and are never stored.
// - An action runs only while a person's grant on the source covers it; a
//   high-risk action also needs `yes` on the call, and a non-idempotent one an
//   idempotency key (doRefusal).
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
import { scopeArgs, scopeOf, sourceByRef, type ScopeArgs } from "../ingest";
import { connectionIdForSource, readTokenCredential, TOKEN_PROVIDERS, type FetchLike } from "../tokenConnectors";
import { readBodyCapped } from "../replays";
import { resolveSessionConversation } from "../lib/access";
import { invalidScope } from "../lib/auth";
import { sha256Hex } from "../lib/hash";
import { validateIngestBatch } from "@codecast/shared/contracts/ingest";
import { parseDuration } from "@codecast/shared/time";
import {
  APP_LIMITS,
  activeGrant,
  buildAppRequest,
  canonicalJson,
  doRefusal,
  formatActorHeader,
  mapWatchRows,
  parseAppManifest,
  validateJson,
  watchKey,
  withGrant,
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

function manifestStale(row: Pick<Doc<"event_sources">, "manifest_fetched_at">, now: number): boolean {
  return !row.manifest_fetched_at || now - row.manifest_fetched_at > APP_LIMITS.manifest_max_age_ms;
}

async function appSource(ctx: any, args: ScopeArgs & { source: string }) {
  const { userId, workspaceKey } = await scopeOf(ctx, args);
  const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
  if (row.provider !== "app") invalidScope(`${row.short_id} is a ${row.provider} source, not an app connector`);
  return { userId, row };
}

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

/**
 * One request to the product with the bearer secret. Redirects are not
 * followed (the secret goes only to the host it was validated against), the
 * call is aborted after 15 s, and a body over 256 KB is refused while it
 * streams. Error text never contains the secret.
 */
export async function appHttp(
  fetchImpl: FetchLike,
  req: { url: string; method: string; body?: string },
  headers: { token: string; actor: string; idempotency_key?: string },
): Promise<AppHttpResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${headers.token}`,
        Accept: "application/json",
        "X-Codecast-Actor": headers.actor,
        ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(headers.idempotency_key ? { "Idempotency-Key": headers.idempotency_key } : {}),
      },
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(APP_LIMITS.timeout_ms),
    });
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, bytes: 0, ms: elapsed(), error: timedOut ? `no answer in ${APP_LIMITS.timeout_ms / 1000}s` : `could not reach ${new URL(req.url).origin}: ${e?.message ?? "network error"}` };
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, bytes: 0, ms: elapsed(), error: `redirected (${res.status}); the connector does not follow redirects` };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(res, APP_LIMITS.response_bytes);
  } catch (e: any) {
    return { ok: false, status: res.status, bytes: 0, ms: elapsed(), error: `the response broke off: ${e?.message ?? "read error"}` };
  }
  if (!bytes) {
    return { ok: false, status: res.status, bytes: APP_LIMITS.response_bytes, ms: elapsed(), error: `the response is over ${APP_LIMITS.response_bytes / 1024} KB` };
  }
  return {
    ok: res.ok,
    status: res.status,
    text: new TextDecoder().decode(bytes),
    content_type: res.headers.get("content-type") ?? undefined,
    bytes: bytes.length,
    ms: elapsed(),
    ...(res.ok ? {} : { error: `answered ${res.status}` }),
  };
}

// ── The manifest ──

/**
 * Fetch, check and cache a source's manifest. A manifest that fails to fetch
 * or parse keeps the cached one (an outage should not unlist every reader)
 * and records why on the source.
 */
export async function refreshManifestFor(
  ctx: RunCtx,
  source: { _id: Id<"event_sources"> },
  connectionId: string | null,
  fetchImpl: FetchLike,
): Promise<{ ok: true; manifest: AppManifest } | { ok: false; error: string }> {
  const fail = async (error: string) => {
    await ctx.runMutation(internal.sources.app.storeManifest, { source_id: source._id, error });
    return { ok: false as const, error };
  };
  if (!connectionId) return fail("no app connection: connect the app in Settings → Integrations");
  const cred = await readTokenCredential(ctx, connectionId);
  if (!cred.ok) return fail(cred.error);
  if (cred.provider !== "app" || !cred.config.base_url) return fail("the connection is not an app connection");
  const res = await appHttp(fetchImpl, { url: TOKEN_PROVIDERS.app.validateUrl(cred.config), method: "GET" }, { token: cred.token, actor: formatActorHeader({ watch: "manifest" }) });
  if (!res.ok) return fail(`manifest: ${res.error}`);
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
  args: { source_id: v.id("event_sources"), manifest_json: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.source_id);
    if (!row) return;
    const now = Date.now();
    if (args.manifest_json) {
      await ctx.db.patch(row._id, {
        manifest_json: args.manifest_json,
        manifest_fetched_at: now,
        updated_at: now,
        // A paused source stays paused; one that errored on its manifest recovers.
        ...(row.status === "error" ? { status: "active" as const, last_error: undefined } : {}),
      });
      return;
    }
    await ctx.db.patch(row._id, {
      last_error: args.error,
      updated_at: now,
      ...(row.status === "active" && !row.manifest_json ? { status: "error" as const } : {}),
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
      source: row,
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
  const audit = async (status: "ok" | "error" | "denied", extra: { http_status?: number; error?: string; ms?: number; bytes?: number }) =>
    ctx.runMutation(internal.sources.app.recordCall, {
      source_id: source._id,
      user_id: c.user_id,
      ...(c.conversation_id ? { conversation_id: c.conversation_id } : {}),
      kind,
      name,
      args_hash: await sha256Hex(canonicalJson(args)),
      ...(idempotency_key ? { idempotency_key } : {}),
      status,
      ms: extra.ms ?? 0,
      bytes: extra.bytes ?? 0,
      ...(extra.http_status !== undefined ? { http_status: extra.http_status } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    });

  const invalid = argsError ? [argsError] : validateJson(def.input, args);
  if (invalid.length) {
    const error = `invalid args: ${invalid.join("; ")}`;
    await audit("error", { error });
    return { ok: false, error };
  }
  if (kind === "do") {
    const refusal = doRefusal(def as AppAction, source.grants, { yes, idempotency_key }, now);
    if (refusal) {
      await audit("denied", { error: refusal });
      return { ok: false, denied: true, error: refusal };
    }
  }

  if (!c.connection_id) {
    const error = "no app connection: connect the app in Settings → Integrations";
    await audit("error", { error });
    return { ok: false, error };
  }
  const cred = await readTokenCredential(ctx, c.connection_id);
  if (!cred.ok || !cred.config.base_url) {
    const error = cred.ok ? "the connection has no base url" : cred.error;
    await audit("error", { error });
    return { ok: false, error };
  }
  const req = buildAppRequest(cred.config.base_url, def, args);
  if (!req.ok) {
    await audit("error", { error: req.error });
    return { ok: false, error: req.error };
  }
  const res = await appHttp(fetchImpl, req, {
    token: cred.token,
    actor: formatActorHeader({ person: c.person, session: c.session }),
    idempotency_key: kind === "do" ? idempotency_key : undefined,
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
    const { row } = await appSource(ctx, args);
    const manifest = cachedManifest(row);
    const now = Date.now();
    return {
      source: { _id: row._id, short_id: row.short_id, name: row.name, status: row.status, last_error: row.last_error },
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
    const { row } = await appSource(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    return await ctx.db.query("app_calls").withIndex("by_source_created", (q) => q.eq("source_id", row._id)).order("desc").take(limit);
  },
});

// ── Grants ──

/**
 * A person allows an action, optionally for a while (`until`: "30d"). From
 * the web (a session) or from their own CLI token; which one is recorded on
 * the grant. The action must be one the cached manifest declares.
 */
export const grant = mutation({
  args: { ...scopeArgs, source: v.string(), action: v.string(), until: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, row } = await appSource(ctx, args);
    const manifest = cachedManifest(row);
    if (!manifest) invalidScope(`${row.short_id} has no manifest yet: run \`cast connector refresh ${row.name}\` first`);
    if (!manifest!.actions.some((a) => a.name === args.action)) {
      invalidScope(`${row.name} declares no action ${args.action} (it has: ${manifest!.actions.map((a) => a.name).join(", ") || "none"})`);
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
    const entry = {
      action: args.action,
      granted_by: userId,
      granted_at: now,
      ...(until ? { until } : {}),
      via: args.api_token ? ("api_token" as const) : ("session" as const),
    };
    await ctx.db.patch(row._id, { grants: withGrant(row.grants, entry, now), updated_at: now });
    return { grant: entry };
  },
});

export const revoke = mutation({
  args: { ...scopeArgs, source: v.string(), action: v.string() },
  handler: async (ctx, args) => {
    const { row } = await appSource(ctx, args);
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

const POLL_PAGE = 200;

/** Active app sources with a watch due now. */
export const sourcesWithDueWatches = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("event_sources").withIndex("by_provider_status", (q) => q.eq("provider", "app").eq("status", "active")).take(POLL_PAGE);
    return rows.filter((row) => dueWatches(cachedManifest(row), row.watch_state, args.now).length > 0).map((row) => row._id);
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
    return { source: row, connection_id: await connectionIdForSource(ctx, row) };
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
    await ctx.db.patch(row._id, { watch_state: [...byKey.values()], last_poll_at: now, updated_at: now });
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
  const m = await freshManifest(ctx, source, found.connection_id, fetchImpl, now);
  if (!m.ok) return { polled: 0, error: m.error };
  const due = dueWatches(m.manifest, source.watch_state, now);
  if (!due.length) return { polled: 0 };
  const cred = found.connection_id ? await readTokenCredential(ctx, found.connection_id) : null;

  const states: Array<{ key: string; polled_at: number; cursor?: number; last_error?: string }> = [];
  let accepted = 0;
  for (const watch of due) {
    const key = watchKey(watch);
    const prior = source.watch_state?.find((s) => s.key === key);
    const failed = async (error: string, http?: { status?: number; ms: number; bytes: number }) => {
      states.push({ key, polled_at: now, last_error: error });
      await ctx.runMutation(internal.sources.app.recordCall, {
        source_id: source._id,
        user_id: source.owner_user_id,
        kind: "read",
        name: watch.reader,
        args_hash: await sha256Hex(canonicalJson({})),
        status: "error",
        error: `watch ${key}: ${error}`,
        ms: http?.ms ?? 0,
        bytes: http?.bytes ?? 0,
        ...(http?.status !== undefined ? { http_status: http.status } : {}),
      });
    };
    const reader = m.manifest.readers.find((r) => r.name === watch.reader)!;
    if (!cred?.ok || !cred.config.base_url) {
      await failed(cred && !cred.ok ? cred.error : "no app connection");
      continue;
    }
    const req = buildAppRequest(cred.config.base_url, reader, {});
    if (!req.ok) {
      await failed(req.error);
      continue;
    }
    const res = await appHttp(fetchImpl, req, { token: cred.token, actor: formatActorHeader({ watch: key }) });
    if (!res.ok) {
      await failed(res.error ?? "failed", { status: res.status, ms: res.ms, bytes: res.bytes });
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
    const batch = validateIngestBatch({ items: mapped.items }, now);
    if (batch.ok && batch.items.length) {
      const out = await ctx.runMutation(internal.ingest.applyBatch, { source_id: source._id, items_json: JSON.stringify(batch.items) });
      accepted += out.accepted;
    }
    states.push({ key, polled_at: now, ...(mapped.cursor !== undefined ? { cursor: mapped.cursor } : {}) });
  }
  await ctx.runMutation(internal.sources.app.recordWatchPolls, { source_id: source._id, states });
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
    for (const status of ["active", "error"] as const) {
      const rows = await ctx.db.query("event_sources").withIndex("by_provider_status", (q) => q.eq("provider", "app").eq("status", status)).take(POLL_PAGE);
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
