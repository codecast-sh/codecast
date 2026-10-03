// Sources, the group upsert, promotion and the readers for external data
// (docs/architecture/external-data.md X1 to X4, X6, X11).
//
// A source is one feed into a workspace. A keyed source (sdk, http) receives
// batches through the ingest door (ingestHttp.ts), which hands each one to
// applyBatch: items fold into event_groups by fingerprint under the rules in
// lib/ingestGroups.ts, a few samples per group land in event_samples, and only
// a transition writes the external_events timeline, fires triggers and may
// promote to a signal on the line.
//
// Every public function takes either a session (web) or an api_token (CLI)
// through requireUserOrToken, and reads by the stored `workspace` key. None
// returns the key hash; the ingest key itself is returned once, by create and
// rotate.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createWorkContext } from "./data";
import { requireUserOrToken, notFound, invalidScope } from "./lib/auth";
import { workspaceGrantsAccess } from "./lib/access";
import { workspaceKey as makeWorkspaceKey, parseWorkspaceKey } from "./lib/accessKeys";
import { normalizeBaseUrl, signedAppAccount, storeConnection, SIGNED_CONNECTION } from "./tokenConnectors";
import { connectionRowFor } from "./oauthConnectors";
import { sha256Hex } from "./lib/hash";
import { nextShortId } from "./counters";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { recordExternalEventOnce } from "./externalEvents";
import { appSourceIn, refreshAppManifestSoon } from "./lib/appSource";
import { markConnectionLost } from "./lib/sourceHealth";
import { linkReplayToGroup, upsertReplayManifest } from "./replays";
import { takeFromWindow, windowSpent } from "./ipRateLimit";
import { rowByRef } from "./lib/rowByRef";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { commitBySha } from "./commits";
import { addableSourceProviderValidator, groupStatusValidator, groupKindValidator, sourceConfigValidator, transitionValidator } from "./ingestSchema";
import {
  DEFAULT_PROMOTE,
  GITHUB_CI_SOURCE_NAME,
  GROUP_RULES,
  INGEST_LIMITS,
  INGEST_SHORT_ID_PREFIX,
  KEYED_SOURCE_PROVIDERS,
  generateIngestKey,
  ingestKeyPrefix,
  normalizeSourceName,
  sourceConfigProblem,
  transitionSignalKind,
  transitionTriggerEvent,
  type GroupKind,
  type IngestItem,
  type Transition,
} from "@codecast/shared/contracts/ingest";
import { ciCheckFingerprint, groupFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import {
  SAMPLES_PER_BATCH,
  applyMirror,
  countEventNames,
  foldOccurrences,
  openGroupsDelta,
  planItem,
  pruneBuckets,
  utcDay,
  type GroupState,
  type ItemPlan,
  type MirrorSnapshot,
} from "./lib/ingestGroups";

// ── Scope and access ──

// The scope every external data function takes, and a source by the ref a
// person types, live in a leaf (lib/ingestScope.ts) so replays.ts, which this
// module imports, can share them without a load-order cycle.
export { scopeArgs, type ScopeArgs } from "./lib/ingestScopeArgs";
export { scopeOf, sourceByRef } from "./lib/ingestScope";

/**
 * The canonical name a trigger's `source` filter stores (X4): a name or src-N
 * resolved against the sources of the workspace the trigger fires in, since
 * matchTaskTriggers compares names only and an unresolved value never fires.
 * Refuses an unknown source and lists the known ones. github-ci is known in
 * every team workspace before its first run creates it (recordCiRun), so a
 * trigger can wait for CI on main from the start.
 */
export async function triggerSourceName(ctx: any, userId: Id<"users">, workspaceKey: string, ref: string): Promise<string> {
  const row = await sourceByRef(ctx, userId, workspaceKey, ref).catch(() => null);
  if (row && row.workspace === workspaceKey) return row.name;
  if (!row && normalizeSourceName(ref) === GITHUB_CI_SOURCE_NAME && workspaceKey.startsWith("team:")) return GITHUB_CI_SOURCE_NAME;
  const known = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspaceKey)).take(50);
  const list = known.map((s: Doc<"event_sources">) => `${s.name} (${s.short_id})`).join(", ");
  throw new Error(`No source "${ref.trim()}" in this trigger's workspace. ${list ? `Known: ${list}` : "It has none yet: cast sources add"}`);
}

export async function groupByRef(ctx: any, userId: Id<"users">, ref: string): Promise<Doc<"event_groups">> {
  return await rowByRef(ctx, "event_groups", userId, ref, "Group");
}

// ── A source's counters (event_source_stats) ──

/** The fields that move on every batch and poll, kept off the source row. */
const STAT_KEYS = ["counters_day", "events_today", "dropped_today", "event_names", "groups_open", "last_event_at", "last_poll_at"] as const;
export type SourceStats = Partial<Pick<Doc<"event_source_stats">, (typeof STAT_KEYS)[number]>>;

function pickStats(row: Partial<Record<(typeof STAT_KEYS)[number], unknown>>): SourceStats {
  const out: Record<string, unknown> = {};
  for (const k of STAT_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out as SourceStats;
}

async function statsRow(ctx: any, sourceId: Id<"event_sources">): Promise<Doc<"event_source_stats"> | null> {
  return await ctx.db.query("event_source_stats").withIndex("by_source", (q: any) => q.eq("source_id", sourceId)).first();
}

/** A source's counters: their own row, else the fields a source made before that table still carries. */
export async function sourceStats(ctx: any, source: Doc<"event_sources">): Promise<SourceStats> {
  return pickStats((await statsRow(ctx, source._id)) ?? source);
}

/**
 * The one write of a source's counters. `patch` sees the current counters
 * (already rolled to today when the day changed), so a caller adds to what is
 * there. Never touches the source row.
 */
export async function patchSourceStats(ctx: any, source: Doc<"event_sources">, patch: (prev: SourceStats) => SourceStats, now = Date.now()): Promise<SourceStats> {
  const row = await statsRow(ctx, source._id);
  const prev = rollStats(pickStats(row ?? source), now);
  const next = patch(prev);
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert("event_source_stats", { source_id: source._id, workspace: source.workspace, ...prev, ...next });
  return { ...prev, ...next };
}

/** The *_today counters start at zero on a new UTC day. */
function rollStats(stats: SourceStats, now: number): SourceStats {
  const day = utcDay(now);
  return stats.counters_day === day ? stats : { ...stats, counters_day: day, events_today: 0, dropped_today: 0 };
}

/** A source as any reader sees it, counters included: never the key hash or the manifest. */
export function sourceView(row: Doc<"event_sources">, stats: SourceStats = pickStats(row), now = Date.now()) {
  const { ingest_key_hash: _hash, manifest_json: _manifest, ...rest } = row;
  return { ...rest, events_today: 0, dropped_today: 0, groups_open: 0, ...rollStats(stats, now), keyed: !!row.ingest_key_hash };
}

export async function sourceViewOf(ctx: any, row: Doc<"event_sources">) {
  return sourceView(row, await sourceStats(ctx, row));
}

/** A group as lists show it: buckets cut to the window as of now. */
export function groupView(row: Doc<"event_groups">, now: number) {
  return { ...row, buckets: pruneBuckets(row.buckets, now) };
}

// ── Sources ──

export const createSource = mutation({
  args: {
    ...scopeArgs,
    name: v.string(),
    provider: addableSourceProviderValidator,
    project: v.optional(v.string()),
    fingerprint_prefix: v.optional(v.string()),
    config: v.optional(sourceConfigValidator),
    promote: v.optional(v.array(transitionValidator)),
    /**
     * app only: where the app answers. Makes the workspace's app connection in
     * the same step, with no secret: codecast signs every request (X8). An
     * existing connection to the same base url is kept as it is.
     */
    base_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, db, workspaceKey } = await scopeOf(ctx, args);
    if (args.base_url !== undefined && args.provider !== "app") invalidScope("A base url belongs to an app source");
    const configProblem = sourceConfigProblem(args.provider, args.config);
    if (configProblem) invalidScope(configProblem);
    const name = normalizeSourceName(args.name);
    if (!name || name.length > INGEST_LIMITS.name_chars) invalidScope("A source needs a name");
    const taken = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspaceKey).eq("name", name)).first();
    if (taken) invalidScope(`A source named ${name} already exists here (${taken.short_id})`);
    if (name === GITHUB_CI_SOURCE_NAME) invalidScope(`${GITHUB_CI_SOURCE_NAME} is the name codecast gives CI on a repository's default branch; it creates that source itself`);
    if (args.provider === "app") {
      // The app connection (base url and secret) is the workspace's one row
      // (tokenConnectors.connectionIdForSource), so a second app source would
      // call the same app with the same secret, and connecting another app
      // would replace the first one's credential.
      const appSource = await appSourceIn(ctx, workspaceKey);
      if (appSource) invalidScope(`This workspace already has an app connector (${appSource.name}, ${appSource.short_id}); it reads through the workspace's one app connection, so a second would call the same app`);
      if (args.base_url !== undefined) await connectSignedApp(ctx, userId, workspaceKey, args.base_url);
    }
    const project = await resolveWorkspaceProject(ctx, workspaceKey, args.project);
    const keyed = KEYED_SOURCE_PROVIDERS.includes(args.provider);
    const key = keyed ? generateIngestKey() : undefined;
    const now = Date.now();
    const id = await ctx.db.insert("event_sources", {
      workspace: workspaceKey,
      team_id: db.axes.team_id,
      owner_user_id: userId,
      project_id: project?._id,
      short_id: await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.source),
      provider: args.provider,
      name,
      ingest_key_hash: key ? await sha256Hex(key) : undefined,
      key_prefix: key ? ingestKeyPrefix(key) : undefined,
      fingerprint_prefix: args.fingerprint_prefix?.trim() || undefined,
      config: args.config,
      promote: args.promote ?? [...DEFAULT_PROMOTE],
      status: "active",
      created_at: now,
      updated_at: now,
    });
    if (args.provider === "app") await refreshAppManifestSoon(ctx, workspaceKey);
    const row = (await ctx.db.get(id))!;
    // The only time the key leaves the backend: it is stored as a hash.
    return { source: sourceView(row), ...(key ? { ingest_key: key } : {}) };
  },
});

/**
 * The workspace's app connection to `rawBaseUrl` with no secret (a signed
 * connection, tokenConnectors.SIGNED_CONNECTION). Kept as it is when the
 * workspace already connects to that url, so a bearer secret someone chose is
 * not dropped. Runs before the source exists, so the source's own insert is
 * what schedules the manifest fetch.
 */
async function connectSignedApp(ctx: any, userId: Id<"users">, workspaceKey: string, rawBaseUrl: string): Promise<void> {
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl) invalidScope(`The base url must be a public https URL, got "${rawBaseUrl}"`);
  const ws = parseWorkspaceKey(workspaceKey);
  if (!ws) invalidScope("No workspace to connect the app in");
  const existing = await connectionRowFor(ctx, "app", ws.type === "team" ? { team_id: ws.teamId } : { user_id: ws.userId });
  if (existing && !existing.pending_confirm_hash && existing.config?.base_url === baseUrl) return;
  const account = signedAppAccount(baseUrl);
  const stored = await storeConnection(ctx, {
    provider: "app",
    user_id: String(userId),
    team_id: ws.type === "team" ? String(ws.teamId) : undefined,
    access_token_enc: SIGNED_CONNECTION,
    config: { base_url: baseUrl },
    account_label: account.label,
    account_id: account.account_id,
  });
  if (!stored.ok) invalidScope(`Could not connect the app: ${stored.error}`);
}

/** A new key for a keyed source; the old one stops working at once. */
export const rotateKey = mutation({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    if (!KEYED_SOURCE_PROVIDERS.includes(row.provider)) invalidScope(`${row.short_id} is a ${row.provider} source and has no ingest key`);
    const key = generateIngestKey();
    await ctx.db.patch(row._id, { ingest_key_hash: await sha256Hex(key), key_prefix: ingestKeyPrefix(key), updated_at: Date.now() });
    return { source: await sourceViewOf(ctx, (await ctx.db.get(row._id))!), ingest_key: key };
  },
});

export const updateSource = mutation({
  args: {
    ...scopeArgs,
    source: v.string(),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
    promote: v.optional(v.array(transitionValidator)),
    project: v.optional(v.string()),
    fingerprint_prefix: v.optional(v.string()),
    config: v.optional(sourceConfigValidator),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const patch: Partial<Doc<"event_sources">> = { updated_at: Date.now() };
    if (args.status) {
      patch.status = args.status;
      // Resuming clears the reason it stopped (a filer who left, a poller error).
      if (args.status === "active") patch.last_error = undefined;
    }
    if (args.promote) patch.promote = args.promote;
    if (args.project !== undefined) patch.project_id = (await resolveWorkspaceProject(ctx, row.workspace, args.project))?._id;
    if (args.fingerprint_prefix !== undefined) patch.fingerprint_prefix = args.fingerprint_prefix.trim() || undefined;
    if (args.config) {
      const configProblem = sourceConfigProblem(row.provider, args.config);
      if (configProblem) invalidScope(configProblem);
      patch.config = args.config;
    }
    await ctx.db.patch(row._id, patch);
    return { source: await sourceViewOf(ctx, (await ctx.db.get(row._id))!) };
  },
});

/**
 * Removes the source now; everything filed under it goes in the background
 * (purgeSourceRows), metric watches first after the groups, so the poll
 * cron stops claiming watches whose source is gone. The timeline keeps its rows.
 */
export const removeSource = mutation({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    await ctx.db.delete(row._id);
    await ctx.scheduler.runAfter(0, internal.ingest.purgeSourceRows, { source_id: row._id });
    return { removed: row.short_id };
  },
});

/**
 * Rows one purge transaction deletes. Samples carry stacks and context (tens
 * of KB each at the limits), so the page is counted in rows read, not groups:
 * a whole group's samples in one read could pass the 16 MiB cap.
 */
const PURGE_ROWS = 200;

/**
 * Deletes what a removed source left, a bounded page per transaction, and
 * schedules itself until nothing is left: groups with their samples and
 * tallies, then metric watches, replays with their cached timelines, the app
 * call audit and the source's counters and manifest. Replay chunks in R2 go
 * by the bucket's own lifecycle.
 */
export const purgeSourceRows = internalMutation({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    let budget = PURGE_ROWS;
    const del = async (rows: { _id: any }[]) => {
      for (const r of rows) await ctx.db.delete(r._id);
      budget -= rows.length;
    };
    const bySource = (table: "metric_watches" | "event_source_stats" | "app_manifests", n: number) =>
      (ctx.db.query(table) as any).withIndex("by_source", (q: any) => q.eq("source_id", args.source_id)).take(n);

    for (const group of await ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", args.source_id)).take(PURGE_ROWS)) {
      if (budget <= 0) break;
      const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", group._id)).take(budget);
      await del(samples);
      if (budget <= 0) break;
      await del(await ctx.db.query("event_group_tallies").withIndex("by_group", (q) => q.eq("group_id", group._id)).collect());
      await del([group]);
    }
    if (budget > 0) await del(await bySource("metric_watches", budget));
    if (budget > 0) {
      const replays = await ctx.db.query("replays").withIndex("by_source_started", (q) => q.eq("source_id", args.source_id)).take(Math.ceil(budget / 2));
      for (const r of replays) await del(await ctx.db.query("replay_timelines").withIndex("by_replay", (q) => q.eq("replay_id", r._id)).collect());
      await del(replays);
    }
    if (budget > 0) await del(await ctx.db.query("app_calls").withIndex("by_source_created", (q) => q.eq("source_id", args.source_id)).take(budget));
    if (budget > 0) await del([...(await bySource("event_source_stats", 1)), ...(await bySource("app_manifests", 1))]);
    if (budget <= 0) await ctx.scheduler.runAfter(0, internal.ingest.purgeSourceRows, args);
  },
});

export const listSources = query({
  args: { ...scopeArgs },
  handler: async (ctx, args) => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const rows = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspaceKey)).take(500);
    return await Promise.all(rows.map((row) => sourceViewOf(ctx, row)));
  },
});

export const getSource = query({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    return await sourceViewOf(ctx, await sourceByRef(ctx, userId, workspaceKey, args.source));
  },
});

// ── Groups and the timeline ──

const LIST_CAP = 500;
/** Rows listGroups reads for a filter its index cannot take. */
const GROUP_SCAN_MAX = 2000;

export const listGroups = query({
  args: {
    ...scopeArgs,
    source: v.optional(v.string()),
    status: v.optional(groupStatusValidator),
    kind: v.optional(groupKindValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), LIST_CAP);
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    const groups = ctx.db.query("event_groups");
    // The index that takes the most of the filter; a source and a status, or
    // a kind alone, are exact.
    const base = source
      ? args.status
        ? groups.withIndex("by_source_status_last_seen", (q) => q.eq("source_id", source._id).eq("status", args.status!))
        : groups.withIndex("by_source_last_seen", (q) => q.eq("source_id", source._id))
      : args.status
        ? groups.withIndex("by_workspace_status_last_seen", (q) => q.eq("workspace", workspaceKey).eq("status", args.status!))
        : args.kind
          ? groups.withIndex("by_workspace_kind_last_seen", (q) => q.eq("workspace", workspaceKey).eq("kind", args.kind!))
          : groups.withIndex("by_workspace_last_seen", (q) => q.eq("workspace", workspaceKey));
    const out: Doc<"event_groups">[] = [];
    // A filter the index could not take (a kind beside a source or status) is
    // applied while reading, over at most GROUP_SCAN_MAX rows: groups are
    // never deleted, so an unbounded walk for a rare kind would one day pass
    // the read cap.
    let scanned = 0;
    for await (const row of base.order("desc")) {
      if (++scanned > GROUP_SCAN_MAX) break;
      if (args.status && row.status !== args.status) continue;
      if (args.kind && row.kind !== args.kind) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    const now = Date.now();
    return out.map((row) => groupView(row, now));
  },
});

export const getGroup = query({
  args: { ...scopeArgs, group: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await withTally(ctx, await groupByRef(ctx, userId, args.group));
    const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", row._id)).order("desc").take(GROUP_RULES.samples_per_group);
    const source = await ctx.db.get(row.source_id);
    return {
      group: groupView(row, Date.now()),
      samples,
      source: source ? { _id: source._id, short_id: source.short_id, name: source.name, provider: source.provider } : null,
      commit: await groupCommit(ctx, userId, row),
    };
  },
});

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The commit a group's newest release was built from, and the session that
 * wrote it, when the caller may read it (X3): the deploy's sha stamped on the
 * group, else a release that is itself a sha.
 */
async function groupCommit(ctx: any, userId: Id<"users">, row: Pick<Doc<"event_groups">, "last_sha" | "last_release">) {
  const sha = row.last_sha ?? (row.last_release && HEX_SHA.test(row.last_release) ? row.last_release : undefined);
  const commit = sha ? await commitBySha(ctx, userId, sha) : null;
  if (!commit) return null;
  const conversation = commit.conversation_id ? await ctx.db.get(commit.conversation_id) : null;
  return {
    sha: commit.sha as string,
    message: String(commit.message ?? "").split("\n")[0],
    author_name: commit.author_name as string,
    timestamp: commit.timestamp as number,
    conversation_id: commit.conversation_id ?? null,
    session: conversation ? conversation.short_id ?? String(conversation._id) : null,
  };
}

/** Resolve, ignore, mute or reopen a group. Resolving can name the release that carries the fix. */
export const setGroupStatus = mutation({
  args: { ...scopeArgs, group: v.string(), status: groupStatusValidator, resolved_in: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await groupByRef(ctx, userId, args.group);
    const now = Date.now();
    const patch: Partial<Doc<"event_groups">> = { status: args.status, updated_at: now };
    if (args.status === "resolved") {
      patch.resolved_at = now;
      patch.resolved_in = args.resolved_in?.trim() || undefined;
    }
    await ctx.db.patch(row._id, patch);
    const delta = openGroupsDelta(row.status, args.status);
    const source = delta ? await ctx.db.get(row.source_id) : null;
    if (source) await patchSourceStats(ctx, source, (s) => ({ groups_open: Math.max(0, (s.groups_open ?? 0) + delta) }), now);
    return { group: groupView(await withTally(ctx, (await ctx.db.get(row._id))!), now) };
  },
});

/** The transitions across a workspace's sources, newest first (the Ops timeline, `cast events ls`). */
export const listEvents = query({
  args: { ...scopeArgs, source: v.optional(v.string()), since: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), LIST_CAP);
    const since = args.since ?? 0;
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    // Ingestion rows are the only external_events rows that carry a
    // workspace key, so this index is the ingestion timeline and nothing else.
    const rows = await (source
      ? ctx.db.query("external_events").withIndex("by_source_created", (q) => q.eq("source_id", source._id).gte("created_at", since))
      : ctx.db.query("external_events").withIndex("by_workspace_created", (q) => q.eq("workspace", workspaceKey).gte("created_at", since)))
      .order("desc")
      .take(limit);
    return rows;
  },
});

// ── The door's side: key lookup and the batch ──

/**
 * What the door needs to admit a batch. Internal: the hash is compared here,
 * never returned. With `guess_guard`, a caller whose window of unknown keys is
 * spent is refused before the lookup (`retry_after_ms`), so a right guess past
 * the budget earns nothing either (ingestHttp.UNKNOWN_KEY_RATE).
 */
export const sourceForKey = internalQuery({
  args: {
    key_hash: v.string(),
    guess_guard: v.optional(v.object({ key: v.string(), max: v.number(), window_ms: v.number() })),
  },
  handler: async (ctx, args) => {
    if (args.guess_guard) {
      const wait = await windowSpent(ctx.db, args.guess_guard.key, args.guess_guard.max, args.guess_guard.window_ms);
      if (wait !== null) return { retry_after_ms: wait };
    }
    const row = await ctx.db.query("event_sources").withIndex("by_ingest_key_hash", (q) => q.eq("ingest_key_hash", args.key_hash)).first();
    if (!row) return null;
    return { _id: row._id, status: row.status, allowed_origins: row.config?.allowed_origins ?? null };
  },
});

export type GroupPlan = Extract<ItemPlan, { type: "group" }>;

const HOUR_MS = 3600_000;

/**
 * What one source may cost per hour, whoever holds its key (X2). The browser
 * SDK ships its key in a page, so these bound what a scraped key can do: past
 * the group caps a batch's new fingerprints fold into the source's overflow
 * group of their kind, and past the others the extra promotions and deploy
 * markers are skipped. Each is a fixed window (ipRateLimit.takeFromWindow).
 */
export const SOURCE_CAPS = {
  new_groups_per_hour: 200,
  open_groups_max: 1000,
  promotions_per_hour: 30,
  deploys_per_hour: 30,
} as const;

/** The fingerprint new groups past the caps fold into, one per kind. */
export const OVERFLOW_FP = "(overflow)";

function overflowPlan(plan: GroupPlan): GroupPlan {
  return {
    ...plan,
    fp: OVERFLOW_FP,
    fingerprint: groupFingerprint(undefined, plan.kind, OVERFLOW_FP),
    title: `New ${plan.kind} groups past this source's cap (${SOURCE_CAPS.new_groups_per_hour} an hour, ${SOURCE_CAPS.open_groups_max} open)`,
    culprit: undefined,
  };
}

/**
 * How long a group row goes unwritten while occurrences keep coming without a
 * transition. Inside it they land on the group's tally (event_group_tallies),
 * so the issues list, which subscribes to the group rows, re-runs at most
 * this often per busy group rather than on every batch.
 */
export const GROUP_WRITE_EVERY_MS = 60_000;

/** The group fields a tally may hold ahead of the row: counts and names, never a status a person sets. */
const TALLY_FIELDS = ["count", "last_seen", "buckets", "last_release", "title", "culprit", "level", "meta", "sample_count", "last_sha"] as const;

function stateOf(row: Doc<"event_groups">): GroupState {
  return {
    kind: row.kind,
    status: row.status,
    count: row.count,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    buckets: row.buckets,
    first_release: row.first_release,
    last_release: row.last_release,
    resolved_at: row.resolved_at,
    resolved_in: row.resolved_in,
    regressed_at: row.regressed_at,
    last_transition: row.last_transition,
    last_transition_at: row.last_transition_at,
    meta: row.meta ? { ok: row.meta.ok } : undefined,
  };
}

async function findGroup(ctx: any, sourceId: Id<"event_sources">, fingerprint: string): Promise<Doc<"event_groups"> | null> {
  return await ctx.db.query("event_groups").withIndex("by_source_fingerprint", (q: any) => q.eq("source_id", sourceId).eq("fingerprint", fingerprint)).first();
}

async function tallyOf(ctx: any, groupId: Id<"event_groups">): Promise<Doc<"event_group_tallies"> | null> {
  return await ctx.db.query("event_group_tallies").withIndex("by_group", (q: any) => q.eq("group_id", groupId)).first();
}

/** A tally's held fields as JSON. A cleared field rides as null, since JSON drops undefined. */
function tallyJson(fields: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(TALLY_FIELDS.map((k) => [k, fields[k] ?? null])));
}

function tallyFields(json: string): Partial<Doc<"event_groups">> {
  return Object.fromEntries(Object.entries(JSON.parse(json)).map(([k, value]) => [k, value ?? undefined]));
}

/** A group with what its tally holds ahead of the row: the live numbers, for a reader that shows one group. */
export async function withTally(ctx: any, row: Doc<"event_groups">): Promise<Doc<"event_groups">> {
  const tally = await tallyOf(ctx, row._id);
  return tally ? { ...row, ...tallyFields(tally.fields_json) } : row;
}

/** A tally's fields onto its group row, and the tally gone. */
export const flushGroupTally = internalMutation({
  args: { group_id: v.id("event_groups") },
  handler: async (ctx, args) => {
    const tally = await tallyOf(ctx, args.group_id);
    if (!tally) return;
    if (await ctx.db.get(args.group_id)) await ctx.db.patch(args.group_id, { ...tallyFields(tally.fields_json), updated_at: Date.now() });
    await ctx.db.delete(tally._id);
  },
});

/**
 * One group's occurrences from one source folded into its row, with the
 * samples and every transition announced. The one upsert every feed goes
 * through: the door's batches and the polled adapters (metric watches) alike,
 * so a group behaves the same whichever way its facts arrive. `plans` share a
 * fingerprint. The caller moves the source's groups_open by `open_delta`.
 * `found` is the stored row when the caller already looked it up. A deploy's
 * `sha` for the envelope's release is stamped as the group's last_sha (X3),
 * the join from an error to the commit that shipped it.
 */
export async function upsertGroup(
  ctx: any,
  source: Doc<"event_sources">,
  plans: GroupPlan[],
  envelope: { release?: string; environment?: string; sha?: string },
  now: number,
  found?: Doc<"event_groups"> | null,
  link?: EventLink,
): Promise<{ group_id: Id<"event_groups">; short_id: string; open_delta: number; transitions: number }> {
  const plan = plans[0];
  const stored = found !== undefined ? found : await findGroup(ctx, source._id, plan.fingerprint);
  const tally = stored ? await tallyOf(ctx, stored._id) : null;
  const existing: Doc<"event_groups"> | null = stored && tally ? { ...stored, ...tallyFields(tally.fields_json) } : stored;
  const folded = foldOccurrences(existing ? stateOf(existing) : null, plans.map((p) => p.occurrence), now);
  const next = folded.next!;
  // The newest occurrence names the group: a title that drifts with the
  // message (a clipped stack, a new culprit) follows what is happening now.
  const newest = plans.reduce((a, b) => (b.occurrence.at >= a.occurrence.at ? b : a));
  const meta = next.meta || newest.meta ? { ...existing?.meta, ...newest.meta, ...next.meta } : existing?.meta;
  const keep = samplesToKeep(plans);
  // Samples a group held before sample_count existed are counted once, here.
  const priorSamples = existing ? existing.sample_count ?? (await countSamples(ctx, existing._id)) : 0;
  const fields: Record<string, unknown> = {
    ...next,
    title: newest.title,
    culprit: newest.culprit ?? existing?.culprit,
    level: newest.level ?? existing?.level,
    meta: meta as Doc<"event_groups">["meta"],
    sample_count: Math.min(priorSamples + keep.length, GROUP_RULES.samples_per_group),
    // A release with no known deploy sha clears the last one: it named another build.
    last_sha: envelope.release ? envelope.sha : existing?.last_sha,
  };

  let groupId: Id<"event_groups">;
  let shortId: string;
  const quiet = stored && !folded.transitions.length && next.status === stored.status && now - stored.updated_at < GROUP_WRITE_EVERY_MS;
  if (quiet) {
    groupId = stored._id;
    shortId = stored.short_id;
    const held = tallyJson(fields);
    if (tally) await ctx.db.patch(tally._id, { fields_json: held, updated_at: now });
    else {
      await ctx.db.insert("event_group_tallies", { group_id: groupId, fields_json: held, updated_at: now });
      await ctx.scheduler.runAfter(GROUP_WRITE_EVERY_MS, internal.ingest.flushGroupTally, { group_id: groupId });
    }
  } else {
    ({ group_id: groupId, short_id: shortId } = await writeGroup(ctx, source, stored, plan.fingerprint, { ...fields, updated_at: now }));
    if (tally) await ctx.db.delete(tally._id);
  }
  await appendSamples(ctx, source, groupId, plans, keep, priorSamples);

  for (const t of folded.transitions) {
    await announceTransition(ctx, source, {
      group_id: groupId,
      group_short_id: shortId,
      kind: plan.kind,
      title: newest.title,
      level: fields.level as string | undefined,
      count: next.count,
      transition: t.transition,
      at: t.at,
      reopens: t.reopens,
      release: envelope.release,
      environment: envelope.environment,
      value: newest.meta?.value,
      threshold: newest.meta?.threshold,
      signal_fingerprint: groupFingerprint(source.fingerprint_prefix, plan.kind, plan.fp),
      cause_task_id: stored?.signal_task_id,
      link,
    });
  }
  return { group_id: groupId, short_id: shortId, open_delta: openGroupsDelta(existing?.status, next.status), transitions: folded.transitions.length };
}

/** The row write every upsert shares: patch the group, or insert it with its short id. */
async function writeGroup(
  ctx: any,
  source: Doc<"event_sources">,
  existing: Doc<"event_groups"> | null,
  fingerprint: string,
  fields: Record<string, unknown>,
): Promise<{ group_id: Id<"event_groups">; short_id: string }> {
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return { group_id: existing._id, short_id: existing.short_id };
  }
  const shortId = await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.group);
  const groupId = await ctx.db.insert("event_groups", {
    ...fields,
    workspace: source.workspace,
    team_id: source.team_id,
    source_id: source._id,
    short_id: shortId,
    fingerprint,
  });
  return { group_id: groupId, short_id: shortId };
}

/** A vendor group as an adapter read it (X7): its state, its names, and where it lives there. */
export interface MirroredGroup extends MirrorSnapshot {
  /** The kind's own fingerprint (sentryIssueFingerprint), before segment or prefix. */
  fp: string;
  title: string;
  culprit?: string;
  level?: string;
  users?: number;
  external: { provider: string; id: string; url?: string };
}

/**
 * A vendor group mirrored into its row under applyMirror, the counterpart of
 * upsertGroup for a feed that reports whole groups rather than occurrences.
 * A read that changes nothing writes nothing, so a poll every two minutes
 * over a quiet project costs reads only. `added` is how many occurrences the
 * vendor counted since the last read.
 */
export async function mirrorGroup(
  ctx: any,
  source: Doc<"event_sources">,
  m: MirroredGroup,
  now: number,
): Promise<{ group_id?: Id<"event_groups">; short_id?: string; open_delta: number; transitions: number; added: number }> {
  const fingerprint = groupFingerprint(undefined, m.kind, m.fp);
  const existing = await findGroup(ctx, source._id, fingerprint);
  const { next, transitions } = applyMirror(existing ? stateOf(existing) : null, m, now, source.created_at);
  const fields: Record<string, unknown> = {
    ...next,
    title: m.title,
    culprit: m.culprit ?? existing?.culprit,
    level: m.level ?? existing?.level,
    users: m.users ?? existing?.users,
    external: m.external,
  };
  const added = Math.max(0, next.count - (existing?.count ?? 0));
  if (existing && !transitions.length && Object.keys(fields).every((k) => JSON.stringify((existing as any)[k]) === JSON.stringify(fields[k]))) {
    return { group_id: existing._id, short_id: existing.short_id, open_delta: 0, transitions: 0, added: 0 };
  }
  const { group_id, short_id } = await writeGroup(ctx, source, existing, fingerprint, { ...fields, updated_at: now });
  for (const t of transitions) {
    await announceTransition(ctx, source, {
      group_id,
      group_short_id: short_id,
      kind: m.kind,
      title: m.title,
      level: m.level,
      count: next.count,
      transition: t.transition,
      at: t.at,
      reopens: t.reopens,
      release: m.release,
      signal_fingerprint: groupFingerprint(source.fingerprint_prefix, m.kind, m.fp),
      cause_task_id: existing?.signal_task_id,
    });
  }
  return { group_id, short_id, open_delta: openGroupsDelta(existing?.status, next.status), transitions: transitions.length, added };
}

/**
 * Vendor groups for one source mirrored in one transaction, with the source's
 * counters moved once: what the Sentry poll and webhook both write through.
 */
export async function mirrorGroups(ctx: any, source: Doc<"event_sources">, groups: MirroredGroup[], now: number): Promise<{ mirrored: number; transitions: number }> {
  if (source.status === "paused") return { mirrored: 0, transitions: 0 };
  let openDelta = 0;
  let transitions = 0;
  let added = 0;
  for (const m of groups) {
    const out = await mirrorGroup(ctx, source, m, now);
    openDelta += out.open_delta;
    transitions += out.transitions;
    added += out.added;
  }
  if (openDelta || added) {
    await patchSourceStats(ctx, source, (s) => ({
      events_today: (s.events_today ?? 0) + added,
      groups_open: Math.max(0, (s.groups_open ?? 0) + openDelta),
      ...(added ? { last_event_at: now } : {}),
    }), now);
  }
  return { mirrored: groups.length, transitions };
}

/**
 * A page of vendor groups from an adapter's action. Groups cross as JSON for
 * the same reason batch items do: a vendor's free-form fields are not
 * guaranteed to be valid Convex names.
 */
export const applyMirrorBatch = internalMutation({
  args: { source_id: v.id("event_sources"), groups_json: v.string() },
  handler: async (ctx, args): Promise<{ mirrored: number; transitions: number }> => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return { mirrored: 0, transitions: 0 };
    return mirrorGroups(ctx, source, JSON.parse(args.groups_json) as MirroredGroup[], Date.now());
  },
});

// ── CI on a default branch (X7, the github-ci source) ──

/** A finished workflow run on a repository's default branch, as githubWebhooks reads it. */
export interface CiRun {
  team_id: Id<"teams">;
  repository: string;
  workflow: string;
  ok: boolean;
  /** GitHub's word for it (failure, timed_out), kept on the sample. */
  conclusion: string;
  /** When this attempt started: runs are judged in this order, not in delivery order. */
  at: number;
  url?: string;
  sha?: string;
  branch?: string;
  run_id?: string;
}

/**
 * The team workspace's github-ci source, created the first time CI reports
 * there, so nobody has to add it. Its owner (the filer of any promotion, X6)
 * is the team's earliest admin; it promotes nothing until a person turns that
 * on with `cast sources update`. A person's own source already holding the
 * name keeps it, and CI then files nowhere.
 */
async function githubCiSource(ctx: any, teamId: Id<"teams">, now: number): Promise<Doc<"event_sources"> | null> {
  const workspace = makeWorkspaceKey({ type: "team", teamId });
  const found: Doc<"event_sources"> | null = await ctx.db
    .query("event_sources")
    .withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace).eq("name", GITHUB_CI_SOURCE_NAME))
    .first();
  if (found) return found.provider === "github" ? found : null;
  const members: Doc<"team_memberships">[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const owner = members.sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin") || a.joined_at - b.joined_at)[0];
  if (!owner) return null;
  const id = await ctx.db.insert("event_sources", {
    workspace,
    team_id: teamId,
    owner_user_id: owner.user_id,
    short_id: await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.source),
    provider: "github",
    name: GITHUB_CI_SOURCE_NAME,
    promote: [],
    status: "active",
    created_at: now,
    updated_at: now,
  });
  return await ctx.db.get(id);
}

/**
 * One finished CI run folded into its check group, one group per repository
 * and workflow (ciCheckFingerprint), through the upsert every feed shares: a
 * flip announces check_failed or check_recovered and fires triggers, a red
 * run after red only counts. A paused source takes nothing. A run that
 * started no later than the last one judged (an older run finishing late, a
 * redelivery) no longer speaks for the branch and is skipped.
 */
export async function recordCiRun(ctx: any, run: CiRun): Promise<{ transitions: number; skipped?: string }> {
  const now = Date.now();
  const source = await githubCiSource(ctx, run.team_id, now);
  if (!source) return { transitions: 0, skipped: "no github-ci source" };
  if (source.status === "paused") return { transitions: 0, skipped: "paused" };
  const fp = ciCheckFingerprint(run.repository, run.workflow);
  const fingerprint = groupFingerprint(undefined, "check", fp);
  const stored = await findGroup(ctx, source._id, fingerprint);
  const current = stored ? await withTally(ctx, stored) : null;
  if (current && run.at <= current.last_seen) return { transitions: 0, skipped: "stale" };
  const plan: GroupPlan = {
    type: "group",
    kind: "check",
    fp,
    fingerprint,
    title: `${run.workflow} on ${run.repository}${run.branch ? ` ${run.branch}` : ""}`,
    occurrence: { kind: "check", at: run.at, ok: run.ok },
    sample: {
      at: run.at,
      message: `${run.workflow} ${run.conclusion}${run.sha ? ` at ${run.sha.slice(0, 7)}` : ""}`,
      url: run.url,
      context_json: JSON.stringify({ repository: run.repository, branch: run.branch, sha: run.sha, run_id: run.run_id }),
    },
  };
  const link: EventLink = { repository: run.repository, url: run.url, sha: run.sha, branch: run.branch };
  const out = await upsertGroup(ctx, source, [plan], {}, now, stored, link);
  await patchSourceStats(ctx, source, (s) => ({
    events_today: (s.events_today ?? 0) + 1,
    groups_open: Math.max(0, (s.groups_open ?? 0) + out.open_delta),
    last_event_at: now,
  }), now);
  return { transitions: out.transitions };
}

function deployKey(sourceId: Id<"event_sources">, version: string, environment: string | undefined): string {
  return `ingest:${sourceId}:deploy:${version}:${environment ?? ""}`;
}

async function eventByDedupeKey(ctx: any, key: string): Promise<Doc<"external_events"> | null> {
  return await ctx.db.query("external_events").withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", key)).first();
}

/**
 * The sha the envelope's release was deployed from: a deploy item in this
 * batch, else the deploy marker already recorded for that release.
 */
async function releaseSha(ctx: any, sourceId: Id<"event_sources">, envelope: { release?: string; environment?: string }, deploys: Extract<ItemPlan, { type: "deploy" }>[]): Promise<string | undefined> {
  if (!envelope.release) return undefined;
  const inBatch = deploys.find((d) => d.version === envelope.release && d.sha && (d.environment ?? "") === (envelope.environment ?? ""));
  if (inBatch) return inBatch.sha;
  return (await eventByDedupeKey(ctx, deployKey(sourceId, envelope.release, envelope.environment)))?.sha ?? undefined;
}

/**
 * One batch from the door, in one transaction. `items_json` is the validated
 * items as JSON: product payloads carry object keys Convex refuses as field
 * names ($current_url), so they cross as a string and are stored as strings.
 * `folded` counts the items whose new fingerprints were past the source's
 * group caps (SOURCE_CAPS) and went to its overflow group.
 */
export const applyBatch = internalMutation({
  args: {
    source_id: v.id("event_sources"),
    items_json: v.string(),
    release: v.optional(v.string()),
    environment: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accepted: number; dropped: number; transitions: number; folded: number }> => {
    const items = JSON.parse(args.items_json) as IngestItem[];
    const source = await ctx.db.get(args.source_id);
    if (!source || source.status === "paused") return { accepted: 0, dropped: items.length, transitions: 0, folded: 0 };
    const now = Date.now();
    const envelope = { release: args.release, environment: args.environment };

    const groups = new Map<string, GroupPlan[]>();
    const add = (plan: GroupPlan) => groups.set(plan.fingerprint, [...(groups.get(plan.fingerprint) ?? []), plan]);
    const deploys: Extract<ItemPlan, { type: "deploy" }>[] = [];
    for (const item of items) {
      const plan = planItem(item, envelope);
      if (plan.type === "group") add(plan);
      else if (plan.type === "deploy") deploys.push(plan);
      // A recording's manifest is the replays module's row (X5), not a group.
      if (item.type === "replay") await upsertReplayManifest(ctx, source, item, now);
    }

    // New fingerprints spend the source's group budget; the ones past it fold
    // into the overflow group of their kind, which is never refused.
    const stored = new Map<string, Doc<"event_groups"> | null>();
    for (const fp of groups.keys()) stored.set(fp, await findGroup(ctx, source._id, fp));
    const fresh = [...groups.keys()].filter((fp) => !stored.get(fp) && groups.get(fp)![0].fp !== OVERFLOW_FP);
    let folded = 0;
    if (fresh.length) {
      const room = Math.max(0, SOURCE_CAPS.open_groups_max - ((await sourceStats(ctx, source)).groups_open ?? 0));
      const { granted } = await takeFromWindow(ctx.db, `ingest-new-groups:${source._id}`, SOURCE_CAPS.new_groups_per_hour, HOUR_MS, Math.min(fresh.length, room));
      for (const fp of fresh.slice(granted)) {
        const plans = groups.get(fp)!;
        groups.delete(fp);
        folded += plans.length;
        for (const p of plans) add(overflowPlan(p));
      }
    }

    const sha = await releaseSha(ctx, source._id, envelope, deploys);
    let openDelta = 0;
    let transitions = 0;
    for (const [fp, plans] of groups) {
      const upserted = await upsertGroup(ctx, source, plans, { ...envelope, sha }, now, stored.has(fp) ? stored.get(fp) : undefined);
      openDelta += upserted.open_delta;
      transitions += upserted.transitions;
    }

    for (const deploy of deploys) if (await announceDeploy(ctx, source, deploy)) transitions++;

    const named = items.flatMap((i) => (i.type === "event" ? [{ name: i.name, at: i.at }] : []));
    await patchSourceStats(ctx, source, (s) => ({
      events_today: (s.events_today ?? 0) + items.length,
      ...(named.length ? { event_names: countEventNames(s.event_names, named, now) } : {}),
      groups_open: Math.max(0, (s.groups_open ?? 0) + openDelta),
      last_event_at: now,
    }), now);
    return { accepted: items.length, dropped: 0, transitions, folded };
  },
});

/** Count what the door refused, so a source shows its drops even when nothing got through. */
export const countDropped = internalMutation({
  args: { source_id: v.id("event_sources"), dropped: v.number() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source || args.dropped <= 0) return;
    await patchSourceStats(ctx, source, (s) => ({ dropped_today: (s.dropped_today ?? 0) + args.dropped }));
  },
});

/** The newest few occurrences of a batch worth keeping. A green check report is not one. */
function samplesToKeep(plans: GroupPlan[]): GroupPlan[] {
  return plans
    .filter((p) => p.occurrence.ok !== true)
    .sort((a, b) => b.occurrence.at - a.occurrence.at)
    .slice(0, SAMPLES_PER_BATCH);
}

/** A group's samples counted, for a row written before sample_count. At most samples_per_group plus one batch. */
async function countSamples(ctx: any, groupId: Id<"event_groups">): Promise<number> {
  const rows = await ctx.db.query("event_samples").withIndex("by_group_at", (q: any) => q.eq("group_id", groupId)).take(GROUP_RULES.samples_per_group + SAMPLES_PER_BATCH);
  return rows.length;
}

/**
 * A batch's kept occurrences as samples, then the oldest past the cap
 * removed. `prior` is how many the group held, so the trim reads only the
 * rows it deletes, never the group's whole set of bodies.
 */
async function appendSamples(ctx: any, source: Doc<"event_sources">, groupId: Id<"event_groups">, plans: GroupPlan[], keep: GroupPlan[], prior: number): Promise<void> {
  // Every occurrence inside a recording links the recording to its group
  // (X5), sampled or not; a kept sample also names the recording's row.
  const replays = new Map<string, Id<"replays"> | null>();
  for (const p of plans) {
    const ext = p.sample.replay_external_id;
    if (ext && !replays.has(ext)) replays.set(ext, await linkReplayToGroup(ctx, source, ext, groupId, p.occurrence.at));
  }
  if (!keep.length) return;
  for (const p of keep) {
    const replayId = p.sample.replay_external_id ? replays.get(p.sample.replay_external_id) : undefined;
    await ctx.db.insert("event_samples", { ...p.sample, workspace: source.workspace, group_id: groupId, source_id: source._id, ...(replayId ? { replay_id: replayId } : {}) });
  }
  const over = prior + keep.length - GROUP_RULES.samples_per_group;
  if (over <= 0) return;
  const oldest: Doc<"event_samples">[] = await ctx.db.query("event_samples").withIndex("by_group_at", (q: any) => q.eq("group_id", groupId)).order("asc").take(over);
  for (const extra of oldest) await ctx.db.delete(extra._id);
}

interface Announcement {
  group_id: Id<"event_groups">;
  group_short_id: string;
  kind: GroupKind;
  title: string;
  level?: string;
  count: number;
  transition: Transition;
  at: number;
  /** The resolve the transition breaks (TransitionAt.reopens). */
  reopens?: number;
  release?: string;
  environment?: string;
  /** A metric's polled value and its line. */
  value?: number;
  threshold?: number;
  signal_fingerprint: string;
  /** The cause the group already promoted to, so its later transitions land on that task's timeline. */
  cause_task_id?: Id<"tasks">;
  link?: EventLink;
}

/**
 * Where a transition happened in git, for a feed that knows (CI on a
 * repository): stored on the timeline row, and the repository lets a
 * trigger's --repo filter match the firing.
 */
export interface EventLink {
  repository?: string;
  url?: string;
  sha?: string;
  branch?: string;
}

/**
 * A transition's three effects (X3, X4, X6): the timeline row, the triggers
 * armed on its name, and a promotion when the source promotes it. A
 * transition already on the timeline (a retried batch) has had its effects
 * and fires nothing again; promotions past SOURCE_CAPS.promotions_per_hour
 * stay on the timeline and the triggers without filing a signal.
 */
async function announceTransition(ctx: any, source: Doc<"event_sources">, a: Announcement): Promise<void> {
  const eventType = transitionTriggerEvent(a.kind, a.transition);
  const { id: eventId, created } = await recordExternalEventOnce(ctx, {
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.provider,
    kind: eventType ?? a.transition,
    title: a.title,
    ...a.link,
    source_id: source._id,
    group_id: a.group_id,
    data: {
      transition: a.transition,
      group_kind: a.kind,
      group_short_id: a.group_short_id,
      source_name: source.name,
      provider: source.provider,
      count: a.count,
      level: a.level,
      release: a.release,
      environment: a.environment,
      value: a.value,
      threshold: a.threshold,
    },
    dedupe_key: `ingest:${a.group_id}:${a.transition}:${a.at}${a.reopens !== undefined ? `:after:${a.reopens}` : ""}`,
    created_at: a.at,
    task_ids: a.cause_task_id ? [a.cause_task_id] : undefined,
  });
  if (!created) return;
  if (eventType) {
    await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
      event_type: eventType,
      team_id: source.team_id,
      workspace: source.workspace,
      source: source.name,
      repository: a.link?.repository,
      event_ref: { external_event_id: eventId, group_short_id: a.group_short_id, title: a.title },
    });
  }
  const kind = transitionSignalKind(a.transition);
  if (kind && source.promote.includes(a.transition)) {
    const { granted } = await takeFromWindow(ctx.db, `ingest-promote:${source._id}`, SOURCE_CAPS.promotions_per_hour, HOUR_MS, 1);
    if (!granted) return;
    await ctx.scheduler.runAfter(0, internal.ingest.promote, {
      group_id: a.group_id,
      transition: a.transition,
      fingerprint: a.signal_fingerprint,
      external_event_id: eventId,
    });
  }
}

/**
 * A deploy marker and its triggers, once per version and environment: a
 * retried batch or an SDK that reports its version at every boot records and
 * fires nothing again. New markers past SOURCE_CAPS.deploys_per_hour are
 * skipped. Whether this call recorded one.
 */
async function announceDeploy(ctx: any, source: Doc<"event_sources">, d: Extract<ItemPlan, { type: "deploy" }>): Promise<boolean> {
  const key = deployKey(source._id, d.version, d.environment);
  if (await eventByDedupeKey(ctx, key)) return false;
  const { granted } = await takeFromWindow(ctx.db, `ingest-deploys:${source._id}`, SOURCE_CAPS.deploys_per_hour, HOUR_MS, 1);
  if (!granted) return false;
  const title = `Deployed ${d.version}${d.environment ? ` to ${d.environment}` : ""}`;
  const { id: eventId } = await recordExternalEventOnce(ctx, {
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.provider,
    kind: "deploy",
    title,
    sha: d.sha,
    source_id: source._id,
    data: { transition: "deploy", source_name: source.name, provider: source.provider, release: d.version, environment: d.environment },
    dedupe_key: key,
    created_at: d.at,
  });
  await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
    event_type: "deploy",
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.name,
    event_ref: { external_event_id: eventId, title },
  });
  return true;
}

// ── Promotion (X6) ──

export const promotionInputs = internalQuery({
  args: { group_id: v.id("event_groups") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.group_id);
    const source = group ? await ctx.db.get(group.source_id) : null;
    if (!group || !source || source.status !== "active") return null;
    return {
      group,
      source,
      filer_may_file: await workspaceGrantsAccess(ctx, source.owner_user_id, source.workspace),
    };
  },
});

export const pauseSource = internalMutation({
  args: { source_id: v.id("event_sources"), reason: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return;
    await ctx.db.patch(source._id, { status: "paused", last_error: args.reason, updated_at: Date.now() });
  },
});

/** A poll found its source's connection gone or refused (lib/sourceHealth). */
export const sourceConnectionLost = internalMutation({
  args: { source_id: v.id("event_sources"), error: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (source) await markConnectionLost(ctx, source, args.error);
  },
});

/**
 * A promotion's cause, written back: the group remembers it (so its later
 * transitions carry it, announceTransition) and the transition that promoted
 * gains it, so both show on the cause task's timeline (externalEvents.listForTask).
 */
export const linkSignal = internalMutation({
  args: { group_id: v.id("event_groups"), task_id: v.id("tasks"), external_event_id: v.optional(v.id("external_events")) },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.group_id)) await ctx.db.patch(args.group_id, { signal_task_id: args.task_id });
    const event = args.external_event_id ? await ctx.db.get(args.external_event_id) : null;
    if (!event || event.group_id !== args.group_id) return;
    const taskIds = event.task_ids ?? (event.task_id ? [event.task_id] : []);
    if (taskIds.includes(args.task_id)) return;
    const next = [...taskIds, args.task_id];
    await ctx.db.patch(event._id, { task_id: next[0], task_ids: next });
  },
});

/** The signal a promoted transition files: what the line reads to open or grow a cause. */
export function promotionSignal(
  source: Pick<Doc<"event_sources">, "provider" | "name" | "workspace" | "team_id" | "project_id">,
  group: Pick<Doc<"event_groups">, "short_id" | "kind" | "title" | "culprit" | "count" | "first_seen" | "last_seen" | "last_release">,
  transition: Transition,
  fingerprint: string,
) {
  const kind = transitionSignalKind(transition);
  if (!kind) return null;
  const detail = [
    `${transition.replace(/_/g, " ")} in ${source.provider}:${source.name}, group ${group.short_id} (${group.kind}).`,
    group.culprit ? `Culprit: ${group.culprit}` : null,
    `Seen ${group.count} times${group.last_release ? `, last in ${group.last_release}` : ""}.`,
    `Read it with \`cast events show ${group.short_id}\`.`,
  ].filter(Boolean).join("\n");
  const teamKey = source.workspace.startsWith("team:");
  return {
    source: `${source.provider}:${source.name}`,
    kind,
    fingerprint,
    title: group.title,
    detail_md: detail,
    subject: group.short_id,
    observed_at: group.last_seen,
    // Explicit, so the signal lands in the source's workspace whatever the
    // filer's active team is.
    workspace: teamKey ? ("team" as const) : ("personal" as const),
    ...(teamKey && source.team_id ? { team_id: source.team_id } : {}),
    ...(source.project_id ? { project: String(source.project_id) } : {}),
  };
}

export const promote = internalAction({
  args: {
    group_id: v.id("event_groups"),
    transition: transitionValidator,
    fingerprint: v.string(),
    // The transition's timeline row, which gains the cause it files under.
    external_event_id: v.optional(v.id("external_events")),
  },
  handler: async (ctx, args): Promise<{ task_id?: Id<"tasks">; skipped?: string }> => {
    const inputs = await ctx.runQuery(internal.ingest.promotionInputs, { group_id: args.group_id });
    if (!inputs) return { skipped: "source gone or paused" };
    const { group, source } = inputs;
    if (!inputs.filer_may_file) {
      // Retrying would fail the same way every time; the owner has to hand
      // the source to someone still in the workspace.
      await ctx.runMutation(internal.ingest.pauseSource, {
        source_id: source._id,
        reason: "The source's owner is no longer in this workspace, so its signals have nobody to file as. Resume it after giving it a new owner.",
      });
      return { skipped: "filer left" };
    }
    const signal = promotionSignal(source, group, args.transition, args.fingerprint);
    if (!signal) return { skipped: "transition does not promote" };
    const result = await ctx.runAction(internal.signals.ingestAs, { user_id: source.owner_user_id, ...signal });
    await ctx.runMutation(internal.ingest.linkSignal, { group_id: group._id, task_id: result.task_id, external_event_id: args.external_event_id });
    return { task_id: result.task_id };
  },
});

// ── Upkeep (crons.ts) ──

const SAMPLE_RETENTION_MS = 30 * 24 * 3600_000;
const UPKEEP_PAGE = 200;

/** Samples older than 30 days, oldest first, a page at a time. */
export const pruneSamples = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SAMPLE_RETENTION_MS;
    const old = await ctx.db.query("event_samples").withIndex("by_at", (q) => q.lt("at", cutoff)).take(UPKEEP_PAGE);
    const perGroup = new Map<Id<"event_groups">, number>();
    for (const s of old) {
      await ctx.db.delete(s._id);
      perGroup.set(s.group_id, (perGroup.get(s.group_id) ?? 0) + 1);
    }
    // Keep each group's sample_count true, so appendSamples trims by it correctly.
    for (const [groupId, n] of perGroup) {
      const group = await ctx.db.get(groupId);
      if (group?.sample_count !== undefined) await ctx.db.patch(groupId, { sample_count: Math.max(0, group.sample_count - n) });
      const tally = await tallyOf(ctx, groupId);
      const held = tally ? tallyFields(tally.fields_json) : null;
      if (tally && typeof held?.sample_count === "number") await ctx.db.patch(tally._id, { fields_json: tallyJson({ ...held, sample_count: Math.max(0, held.sample_count - n) }) });
    }
    if (old.length === UPKEEP_PAGE) await ctx.scheduler.runAfter(0, internal.ingest.pruneSamples, {});
    return old.length;
  },
});

// ── Vendor webhook deliveries (X2) ──

/** Vendors retry for hours, not weeks: a week covers any retry schedule. */
const DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;

/**
 * Whether this delivery is new, recording it if so. A vendor webhook route
 * calls this in the mutation that schedules its processor, so a retried
 * delivery schedules nothing.
 */
export async function claimWebhookDelivery(ctx: any, provider: string, deliveryId: string): Promise<boolean> {
  const seen = await ctx.db
    .query("webhook_deliveries")
    .withIndex("by_provider_delivery", (q: any) => q.eq("provider", provider).eq("delivery_id", deliveryId))
    .first();
  if (seen) return false;
  await ctx.db.insert("webhook_deliveries", { provider, delivery_id: deliveryId, created_at: Date.now() });
  return true;
}

export const pruneWebhookDeliveries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - DELIVERY_RETENTION_MS;
    const old = await ctx.db.query("webhook_deliveries").withIndex("by_created", (q) => q.lt("created_at", cutoff)).take(UPKEEP_PAGE);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === UPKEEP_PAGE) await ctx.scheduler.runAfter(0, internal.ingest.pruneWebhookDeliveries, {});
    return old.length;
  },
});

/**
 * Daily: groups seen inside the bucket window (and a day either side) drop
 * the hours past it, so a group that went quiet stops carrying a stale
 * sparkline. Older groups were pruned to nothing while they passed through
 * this range and are never read again. Sources need nothing: their *_today
 * counters roll to zero on the first read or write of a new day
 * (rollStats). `table` is accepted for runs scheduled before that.
 */
export const dailyUpkeep = internalMutation({
  args: { table: v.optional(v.union(v.literal("event_sources"), v.literal("event_groups"))), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const since = now - (GROUP_RULES.bucket_hours + 48) * HOUR_MS;
    const page = await ctx.db
      .query("event_groups")
      .withIndex("by_last_seen", (q) => q.gte("last_seen", since))
      .paginate({ cursor: args.table === "event_groups" ? args.cursor ?? null : null, numItems: UPKEEP_PAGE });
    for (const row of page.page) {
      const kept = pruneBuckets(row.buckets, now);
      if (kept.length !== row.buckets.length) await ctx.db.patch(row._id, { buckets: kept });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.ingest.dailyUpkeep, { table: "event_groups", cursor: page.continueCursor });
  },
});
