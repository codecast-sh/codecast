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
import { scheduleTriggerMatch } from "./lib/triggerMatch";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken, notFound, invalidScope } from "./lib/auth";
import { workspaceGrantsAccess } from "./lib/access";
import { workspaceKey as makeWorkspaceKey, parseWorkspaceKey } from "./lib/accessKeys";
import { normalizeBaseUrl, signedAppAccount, storeConnection, SIGNED_CONNECTION } from "./tokenConnectors";
import { connectionRowFor } from "./oauthConnectors";
import { sha256Hex } from "./lib/hash";
import { nextShortId } from "./counters";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { withCiRun } from "@codecast/shared/contracts/volumeWatch";
import { recordExternalEventOnce } from "./externalEvents";
import { recordDeployMarker } from "./deploys";
import { appSourceIn, refreshAppManifestSoon } from "./lib/appSource";
import { markConnectionLost } from "./lib/sourceHealth";
import { linkReplayToGroup, upsertReplayManifest } from "./replays";
import { recordMomentEvents } from "./moments";
import { takeFromWindow, windowSpent } from "./ipRateLimit";
import { readableRowByRef, rowByRef } from "./lib/rowByRef";
import { OVERFLOW_FP, SOURCE_CAPS, announceTransition, appendSamples, findGroup, GROUP_USERS_MAX, GROUP_USERS_PER_BATCH, mirrorGroups, tallyFields, tallyJson, tallyOf, upsertGroup, withTally, type EventLink, type GroupPlan, type MirroredGroup } from "./lib/groupWrite";
import { countLanded, groupView, patchSourceStats, rollStats, sourceStats, sourceView, sourceViewOf } from "./lib/sourceStats";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { deployMarkerOf, promotionSignal } from "./lib/ingestPayloads";
import { PROMOTE_SPACING_MS, promotionStep, schedulePromotion } from "./ingestPromotions";
import { commitBySha } from "./commits";
import { requireTaskByRef } from "./lib/taskGraph";
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
  type IngestItem,
} from "@codecast/shared/contracts/ingest";
import { ciCheckFingerprint, groupFingerprint, isRecordNotIssue } from "@codecast/shared/contracts/signalFingerprint";
import { clusterPeople, mergeStoredPeople, userKeys } from "./lib/groupPeople";
import type { ReplayIssue } from "@codecast/shared/replay";
import {
  HOUR_MS,
  countEventNames,
  openGroupsDelta,
  planItem,
  planReplayIssue,
  pruneBuckets,
  type ItemPlan,
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

/** How long a rotated-out key keeps working, so the product sending with it can ship the new one first. */
export const OLD_KEY_GRACE_MS = 24 * 3600_000;

/**
 * A new key for a keyed source. The old key keeps working for
 * OLD_KEY_GRACE_MS (or not at all with `end_old`, for a leaked key), so a
 * deployed SDK is not refused before the new key reaches it.
 */
export const rotateKey = mutation({
  args: { ...scopeArgs, source: v.string(), end_old: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    if (!KEYED_SOURCE_PROVIDERS.includes(row.provider)) invalidScope(`${row.short_id} is a ${row.provider} source and has no ingest key`);
    const key = generateIngestKey();
    const now = Date.now();
    const grace = row.ingest_key_hash && !args.end_old ? { old_key_hash: row.ingest_key_hash, old_key_prefix: row.key_prefix, old_key_until: now + OLD_KEY_GRACE_MS } : { old_key_hash: undefined, old_key_prefix: undefined, old_key_until: undefined };
    await ctx.db.patch(row._id, { ingest_key_hash: await sha256Hex(key), key_prefix: ingestKeyPrefix(key), ...grace, updated_at: now });
    // The old key's use is counted afresh from this rotation, so ending it early names what it still carries.
    await patchSourceStats(ctx, row, () => ({ old_key_last_at: undefined, old_key_events: 0 }), now);
    return { source: await sourceViewOf(ctx, (await ctx.db.get(row._id))!), ingest_key: key };
  },
});

/** Stop accepting a rotated-out key now rather than when its grace window ends. */
export const endOldKey = mutation({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    if (row.old_key_hash) {
      await ctx.db.patch(row._id, { old_key_hash: undefined, old_key_prefix: undefined, old_key_until: undefined, updated_at: Date.now() });
      await patchSourceStats(ctx, row, () => ({ old_key_last_at: undefined, old_key_events: 0 }));
    }
    return null;
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
      // A setting not named stays as it was (`cast sources set` names one at a time).
      patch.config = { ...row.config, ...args.config };
      // Keep applies to the bodies the source already has, not only the next ones (moments.keepBodies).
      if (args.config.moment_retention === "keep" && row.config?.moment_retention !== "keep") {
        await ctx.scheduler.runAfter(0, internal.moments.keepBodies, { source_id: row._id });
      }
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

/** Rows removeSourcePreview counts per table before it reports a floor ("1,000+"). */
const REMOVE_PREVIEW_CAP = 1000;

/**
 * What removing a source deletes, counted before the person confirms: its
 * issues (open ones and those a task is filed on), metric watches, replays and
 * app call audit. Each count stops at REMOVE_PREVIEW_CAP and says so.
 */
export const removeSourcePreview = query({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const cap = REMOVE_PREVIEW_CAP;
    const count = (rows: unknown[]) => ({ n: Math.min(rows.length, cap), capped: rows.length > cap });
    const groups = await ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", row._id)).take(cap + 1);
    const open = groups.filter((g) => g.status === "open");
    const tasked = groups.filter((g) => g.signal_task_id);
    const watches = await ctx.db.query("metric_watches").withIndex("by_source", (q) => q.eq("source_id", row._id)).take(cap + 1);
    const replays = await ctx.db.query("replays").withIndex("by_source_started", (q) => q.eq("source_id", row._id)).take(cap + 1);
    const calls = await ctx.db.query("app_calls").withIndex("by_source_created", (q) => q.eq("source_id", row._id)).take(cap + 1);
    return {
      source: row.short_id,
      issues: count(groups),
      open: { n: open.length, capped: groups.length > cap },
      tasked: { n: tasked.length, capped: groups.length > cap },
      watches: count(watches),
      replays: count(replays),
      calls: count(calls),
    };
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
      const people = await ctx.db.query("event_group_users").withIndex("by_group_user", (q) => q.eq("group_id", group._id)).take(budget);
      await del(people);
      if (budget <= 0) break;
      await del([group]);
    }
    if (budget > 0) await del(await bySource("metric_watches", budget));
    if (budget > 0) {
      const replays = await ctx.db.query("replays").withIndex("by_source_started", (q) => q.eq("source_id", args.source_id)).take(Math.ceil(budget / 2));
      for (const r of replays) await del(await ctx.db.query("replay_timelines").withIndex("by_replay", (q) => q.eq("replay_id", r._id)).collect());
      await del(replays);
    }
    if (budget > 0) await del(await ctx.db.query("replay_tallies").withIndex("by_source_person", (q) => q.eq("source_id", args.source_id)).take(budget));
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

/**
 * A source as a reference names it (`src-N` or Convex id), for the pill and
 * card a conversation renders: null when it is missing or the reader's
 * workspace does not hold it, never an error, so the reference reads as text.
 */
export const webGetSource = query({
  args: { ref: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token).catch(() => null);
    if (!userId) return null;
    const row = await readableRowByRef(ctx, "event_sources", userId, args.ref, (name) => sourceByNameAnywhere(ctx, userId, name));
    return row ? await sourceViewOf(ctx, row) : null;
  },
});

/**
 * A source by its name in any workspace the reader belongs to (their own,
 * then each team's): an Ops link carries the name, and one opened from
 * another workspace says whose it is. The first match wins.
 */
async function sourceByNameAnywhere(ctx: any, userId: Id<"users">, name: string): Promise<Doc<"event_sources"> | null> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId)).take(50);
  const keys = [`user:${userId}`, ...memberships.map((m: Doc<"team_memberships">) => `team:${m.team_id}`)];
  for (const key of keys) {
    const row = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", key).eq("name", name)).first();
    if (row) return row;
  }
  return null;
}

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
    /** Only groups last seen before this: the next page of a list a reader scrolled past. */
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), LIST_CAP);
    const before = args.before;
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    const groups = ctx.db.query("event_groups");
    // The index that takes the most of the filter; a source and a status, or
    // a kind alone, are exact.
    const upTo = <Q extends { lt: (f: "last_seen", v: number) => any }>(q: Q) => (before !== undefined ? q.lt("last_seen", before) : q);
    const base = source
      ? args.status
        ? groups.withIndex("by_source_status_last_seen", (q) => upTo(q.eq("source_id", source._id).eq("status", args.status!)))
        : groups.withIndex("by_source_last_seen", (q) => upTo(q.eq("source_id", source._id)))
      : args.status
        ? groups.withIndex("by_workspace_status_last_seen", (q) => upTo(q.eq("workspace", workspaceKey).eq("status", args.status!)))
        : args.kind
          ? groups.withIndex("by_workspace_kind_last_seen", (q) => upTo(q.eq("workspace", workspaceKey).eq("kind", args.kind!)))
          : groups.withIndex("by_workspace_last_seen", (q) => upTo(q.eq("workspace", workspaceKey)));
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
      if (isRecordNotIssue(row)) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    const now = Date.now();
    return out.map((row) => groupView(row, now));
  },
});

/** How many matches searchGroups returns at most. */
const SEARCH_CAP = 100;

/**
 * Groups whose title matches a search, across the whole workspace and not
 * only the newest windows a device holds, so a person finds an old resolved
 * issue by name. Optionally one status. Relevance order; the Issues list
 * sorts them its own way.
 */
export const searchGroups = query({
  args: { ...scopeArgs, q: v.string(), status: v.optional(groupStatusValidator), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const q = args.q.trim().slice(0, 200);
    if (!q) return [];
    const limit = Math.min(Math.max(args.limit ?? 50, 1), SEARCH_CAP);
    const rows = await ctx.db
      .query("event_groups")
      .withSearchIndex("search_title", (s) => {
        const base = s.search("title", q).eq("workspace", workspaceKey);
        return args.status ? base.eq("status", args.status) : base;
      })
      .take(limit);
    const now = Date.now();
    return rows.filter((row) => !isRecordNotIssue(row)).map((row) => groupView(row, now));
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

/**
 * Resolve, ignore, mute or reopen a group. Resolving can name the release
 * that carries the fix. `restore` is an undo: it puts back the resolve stamps
 * the group held before the gesture it takes back, so a regressed group that
 * was resolved by mistake reads as regressed again.
 */
export const setGroupStatus = mutation({
  args: {
    ...scopeArgs,
    group: v.string(),
    status: groupStatusValidator,
    resolved_in: v.optional(v.string()),
    restore: v.optional(v.object({
      resolved_at: v.union(v.number(), v.null()),
      resolved_in: v.union(v.string(), v.null()),
      resolved_via: v.optional(v.union(v.literal("person"), v.literal("recovered"), v.literal("vendor"), v.null())),
      resolved_by: v.optional(v.union(v.id("users"), v.null())),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await groupByRef(ctx, userId, args.group);
    const now = Date.now();
    const patch: Partial<Doc<"event_groups">> = { status: args.status, updated_at: now };
    if (args.restore) {
      patch.resolved_at = args.restore.resolved_at ?? undefined;
      patch.resolved_in = args.restore.resolved_in ?? undefined;
      // An older client's undo names no resolver: the stamps it puts back are the time and release alone.
      if (args.restore.resolved_via !== undefined) patch.resolved_via = args.restore.resolved_via ?? undefined;
      if (args.restore.resolved_by !== undefined) patch.resolved_by = args.restore.resolved_by ?? undefined;
    } else if (args.status === "resolved") {
      patch.resolved_at = now;
      patch.resolved_in = args.resolved_in?.trim() || undefined;
      patch.resolved_via = "person";
      patch.resolved_by = userId as Id<"users">;
    }
    await ctx.db.patch(row._id, patch);
    const delta = openGroupsDelta(row.status, args.status);
    const moved = row.status !== args.status ? await ctx.db.get(row.source_id) : null;
    if (moved) await patchSourceStats(ctx, moved, (s) => ({ groups_open: Math.max(0, (s.groups_open ?? 0) + delta), ...(s.group_counts ? { group_counts: moveGroupCount(s.group_counts, row.status, args.status) } : {}) }), now);
    return { group: groupView(await withTally(ctx, (await ctx.db.get(row._id))!), now) };
  },
});

/**
 * The fix session a person started on a group from its page: recorded on the
 * group, so the page shows it running and a second press opens it instead of
 * starting another. Only the session's own owner can name it.
 */
export const setGroupFix = mutation({
  args: { ...scopeArgs, group: v.string(), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await groupByRef(ctx, userId, args.group);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== userId) notFound("No such session");
    const now = Date.now();
    await ctx.db.patch(row._id, { fix_conversation_id: args.conversation_id, fix_started_at: now, updated_at: now });
    return { group: groupView(await withTally(ctx, (await ctx.db.get(row._id))!), now) };
  },
});

/**
 * Re-point a group at the problem task it really is, or unlink a misfiled
 * one (`task` null). The task is named by short id or id and must be one the
 * caller can read. A later promotion files a new problem only for a group
 * with no task, so an unlink lets the next transition file it again.
 */
export const setGroupTask = mutation({
  args: { ...scopeArgs, group: v.string(), task: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await groupByRef(ctx, userId, args.group);
    const task = args.task ? await requireTaskByRef(ctx, userId, args.task) : null;
    const now = Date.now();
    await ctx.db.patch(row._id, { signal_task_id: task?._id, updated_at: now });
    return { group: groupView(await withTally(ctx, (await ctx.db.get(row._id))!), now), task_id: task?._id ?? null };
  },
});

/** How far back a group's transitions are read, and how many transition rows of its source one read walks. */
const GROUP_TRANSITIONS_MAX_DAYS = 90;
const GROUP_TRANSITIONS_SCAN_MAX = 3000;

/**
 * One group's transitions over the last `days` (at most 90), and its
 * source's deploys in that span, newest first:
 * what a check or metric's failing and passing spans, and an error's
 * lifecycle, are drawn from. Read off its source's stream, so a busy source
 * may stop at the scan cap before the window's start; `complete` says
 * whether the whole window was read.
 */
export const groupTransitions = query({
  args: { ...scopeArgs, group: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await groupByRef(ctx, userId, args.group);
    const days = Math.min(Math.max(args.days ?? 30, 1), GROUP_TRANSITIONS_MAX_DAYS);
    const since = Math.max(Date.now() - days * 86_400_000, row.first_seen - 3600_000);
    const out: Doc<"external_events">[] = [];
    let scanned = 0;
    let complete = true;
    for await (const e of ctx.db.query("external_events").withIndex("by_source_created", (q) => q.eq("source_id", row.source_id).gte("created_at", since)).order("desc")) {
      if (++scanned > GROUP_TRANSITIONS_SCAN_MAX) {
        complete = false;
        break;
      }
      // The source's deploys ride along: they place the releases on the same axis.
      if (e.group_id === row._id || e.kind === "deploy") out.push(e);
    }
    return { events: out, since, complete };
  },
});

/** The transitions across a workspace's sources, newest first (the Ops timeline, `cast events ls`). */
export const listEvents = query({
  args: { ...scopeArgs, source: v.optional(v.string()), since: v.optional(v.number()), before: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), LIST_CAP);
    const since = args.since ?? 0;
    // `before` pages back: the rows strictly older than the oldest a reader holds.
    const before = args.before ?? Number.MAX_SAFE_INTEGER;
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    // Ingestion rows are the only external_events rows that carry a
    // workspace key, so this index is the ingestion timeline and nothing else.
    const rows = await (source
      ? ctx.db.query("external_events").withIndex("by_source_created", (q) => q.eq("source_id", source._id).gte("created_at", since).lt("created_at", before))
      : ctx.db.query("external_events").withIndex("by_workspace_created", (q) => q.eq("workspace", workspaceKey).gte("created_at", since).lt("created_at", before)))
      .order("desc")
      .take(limit);
    return rows;
  },
});

/** A page of the Timeline's occurrences. Small: each sample carries its stack and context. */
export const SAMPLE_PAGE = 50;

/**
 * The occurrences groups keep (event_samples, GROUP_RULES.samples_per_group
 * per group), newest first, for the Timeline's occurrence rows: each with its
 * message, stack, url, user, release and replay. `before` pages back.
 */
export const listSamples = query({
  args: { ...scopeArgs, source: v.optional(v.string()), before: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? SAMPLE_PAGE, 1), 200);
    const before = args.before ?? Number.MAX_SAFE_INTEGER;
    const source = args.source ? await sourceByRef(ctx, userId, workspaceKey, args.source) : null;
    return await (source
      ? ctx.db.query("event_samples").withIndex("by_source_at", (q) => q.eq("source_id", source._id).lt("at", before))
      : ctx.db.query("event_samples").withIndex("by_workspace_at", (q) => q.eq("workspace", workspaceKey).lt("at", before)))
      .order("desc")
      .take(limit);
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
    // The current key, or a rotated-out one still inside its grace window.
    const row = (await ctx.db.query("event_sources").withIndex("by_ingest_key_hash", (q) => q.eq("ingest_key_hash", args.key_hash)).first())
      ?? (await ctx.db.query("event_sources").withIndex("by_old_key_hash", (q) => q.eq("old_key_hash", args.key_hash)).filter((q) => q.gt(q.field("old_key_until"), Date.now())).first());
    if (!row) return null;
    return { _id: row._id, status: row.status, allowed_origins: row.config?.allowed_origins ?? null, ...(row.ingest_key_hash !== args.key_hash ? { old_key: true } : {}) };
  },
});


// Held-back promotions filed per cron pass (promoteDue).
const PROMOTE_DUE_BATCH = 100;


/** How many of `wanted` new groups the source may open now (SOURCE_CAPS); the rest fold into overflow. */
async function grantNewGroups(ctx: any, source: Doc<"event_sources">, wanted: number): Promise<number> {
  const room = Math.max(0, SOURCE_CAPS.open_groups_max - ((await sourceStats(ctx, source)).groups_open ?? 0));
  const { granted } = await takeFromWindow(ctx.db, `ingest-new-groups:${source._id}`, SOURCE_CAPS.new_groups_per_hour, HOUR_MS, Math.min(wanted, room));
  return granted;
}

function overflowPlan(plan: GroupPlan): GroupPlan {
  return {
    ...plan,
    fp: OVERFLOW_FP,
    fingerprint: groupFingerprint(undefined, plan.kind, OVERFLOW_FP),
    title: `New ${plan.kind} groups past this source's cap (${SOURCE_CAPS.new_groups_per_hour} an hour, ${SOURCE_CAPS.open_groups_max} open)`,
    culprit: undefined,
  };
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


/** Alias rows one recount reads for a group; a group holding more is left as counted. */
const GROUP_USERS_READ = 1000;

/**
 * Recounts the people of groups that counted one person twice: before
 * aliases were stored, a person who arrived once by id and once by email (or
 * by two ids beside one email) was two rows. Where the group keeps every
 * occurrence as a sample the count becomes exact; elsewhere each person the
 * kept samples show under several stored keys counts once. The missing
 * aliases are stored so the next occurrence matches. One page per run; it
 * schedules itself until every group has been read:
 * `npx convex run ingest:recountGroupUsers '{}'` through packages/convex/run.sh.
 */
export const recountGroupUsers = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("event_groups").paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_USERS_PAGE });
    let fixed = 0;
    for (const g of page.page) {
      if (!g.users || g.users < 2) continue;
      if (await ctx.db.query("event_group_tallies").withIndex("by_group", (q) => q.eq("group_id", g._id)).first()) continue;
      const rows = await ctx.db.query("event_group_users").withIndex("by_group_user", (q) => q.eq("group_id", g._id)).take(GROUP_USERS_READ + 1);
      if (rows.length > GROUP_USERS_READ) continue;
      const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", g._id)).order("desc").take(BACKFILL_USERS_SAMPLES);
      const clusters = clusterPeople(samples.map((s) => s.user));
      const { over, add } = mergeStoredPeople(clusters, new Set(rows.map((r) => r.user_key)));
      for (const key of add) await ctx.db.insert("event_group_users", { group_id: g._id, user_key: key, at: Date.now() });
      // Every occurrence kept: the samples name everyone it hit, so the count is exact and needs no "since".
      const exact = samples.length >= g.count && clusters.length > 0 ? clusters.length : null;
      const users = exact ?? Math.max(1, g.users - over);
      if (users === g.users && !(exact !== null && g.users_since)) continue;
      await ctx.db.patch(g._id, exact !== null ? { users, users_since: undefined } : { users });
      fixed++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.ingest.recountGroupUsers, { cursor: page.continueCursor });
    return { fixed, done: page.isDone };
  },
});

/** Groups one backfill page reads; each reads at most BACKFILL_USERS_SAMPLES samples. */
const BACKFILL_USERS_PAGE = 50;
const BACKFILL_USERS_SAMPLES = 100;

/**
 * Counts the people a group's kept samples name, for a group that counts
 * nobody yet: groups that existed before people were counted (or whose
 * people only rode samples a source sent before) read "–" in the Issues list
 * while their page names who hit them. The count is a floor, so it says
 * since when (users_since, the oldest sample counted). A group with a tally
 * waiting to flush is left to its next batch. One page per run; it schedules
 * itself until every group has been read. Run once after a deploy:
 * `npx convex run ingest:backfillGroupUsers '{}'` through packages/convex/run.sh.
 */
export const backfillGroupUsers = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("event_groups").paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_USERS_PAGE });
    let counted = 0;
    for (const g of page.page) {
      if ((g.users ?? 0) > 0) continue;
      if (await ctx.db.query("event_group_tallies").withIndex("by_group", (q) => q.eq("group_id", g._id)).first()) continue;
      const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", g._id)).order("desc").take(BACKFILL_USERS_SAMPLES);
      const since = samples.reduce((m, s) => (userKeys(s.user).length ? Math.min(m, s.at) : m), Infinity);
      const held = new Set((await ctx.db.query("event_group_users").withIndex("by_group_user", (q) => q.eq("group_id", g._id)).take(GROUP_USERS_READ)).map((r) => r.user_key));
      let added = 0;
      for (const c of clusterPeople(samples.map((s) => s.user)).slice(0, GROUP_USERS_PER_BATCH)) {
        if (!c.some((k) => held.has(k))) added++;
        for (const key of c) if (!held.has(key)) await ctx.db.insert("event_group_users", { group_id: g._id, user_key: key, at: Date.now() });
      }
      if (!added) continue;
      await ctx.db.patch(g._id, {
        users: Math.min(GROUP_USERS_MAX, (g.users ?? 0) + added),
        users_since: g.users_since ?? (since > g.first_seen ? since : undefined),
      });
      counted++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.ingest.backfillGroupUsers, { cursor: page.continueCursor });
    return { counted, done: page.isDone };
  },
});


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
  /** How long the run took, start to its last update (the CI run series). */
  duration_ms?: number;
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
  // CI history from before this run: the failure rate and run time series start full (ciBackfill.ts).
  await ctx.scheduler.runAfter(0, internal.ciBackfill.forTeam, { team_id: teamId });
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
    // Passing runs are not kept as samples; the last one stays on the group so a red streak names its last green commit.
    ...(run.ok ? { meta: { last_ok_at: run.at, ...(run.sha ? { last_ok_sha: run.sha } : {}), ...(run.branch ? { last_ok_branch: run.branch } : {}) } } : {}),
  };
  const link: EventLink = { repository: run.repository, url: run.url, sha: run.sha, branch: run.branch };
  const out = await upsertGroup(ctx, source, [plan], {}, now, stored, link);
  await patchSourceStats(ctx, source, (s) => ({
    events_today: (s.events_today ?? 0) + 1,
    groups_open: Math.max(0, (s.groups_open ?? 0) + out.open_delta),
    last_event_at: now,
    ci_runs: withCiRun(s.ci_runs, { at: run.at, ok: run.ok, ...(run.duration_ms !== undefined ? { duration_ms: run.duration_ms } : {}) }),
  }), now);
  return { transitions: out.transitions };
}

// ── Replay issues (X5) ──

/**
 * The walls one recording shows (shared/replay/issues.ts, computed by the
 * action that read its stream) folded into replay_issue groups through the
 * one upsert, and the recording linked to each. A recording counts once per
 * group: one it already links to is skipped, so assembling it again, a
 * re-import or a regroup pass adds nothing twice. New groups spend the
 * source's caps like the door's do.
 */
export async function recordReplayIssues(ctx: any, source: Doc<"event_sources">, replay: Doc<"replays">, issues: ReplayIssue[], now: number): Promise<{ groups: number; transitions: number }> {
  if (source.status === "paused" || !issues.length) return { groups: 0, transitions: 0 };
  const linked = new Set(replay.group_ids.map(String));
  const ref = { external_id: replay.external_id, started_at: replay.started_at, ...(replay.user ? { user: replay.user } : {}) };
  const plans = issues.map((i) => planReplayIssue(i, ref));
  const stored = new Map<string, Doc<"event_groups"> | null>();
  for (const p of plans) stored.set(p.fingerprint, await findGroup(ctx, source._id, p.fingerprint));
  const fresh = plans.filter((p) => !stored.get(p.fingerprint));
  const granted = fresh.length ? await grantNewGroups(ctx, source, fresh.length) : 0;
  const folded = new Set(fresh.slice(granted).map((p) => p.fingerprint));
  let openDelta = 0;
  let transitions = 0;
  let groups = 0;
  for (const raw of plans) {
    const plan = folded.has(raw.fingerprint) ? overflowPlan(raw) : raw;
    const found = stored.has(plan.fingerprint) ? stored.get(plan.fingerprint)! : await findGroup(ctx, source._id, plan.fingerprint);
    if (found && linked.has(String(found._id))) continue;
    const out = await upsertGroup(ctx, source, [plan], {}, now, found);
    stored.set(plan.fingerprint, (await ctx.db.get(out.group_id)) ?? null);
    linked.add(String(out.group_id));
    await linkReplayToGroup(ctx, source, replay.external_id, out.group_id, now);
    openDelta += out.open_delta;
    transitions += out.transitions;
    groups++;
  }
  if (groups) {
    // Each wall a recording showed is an occurrence the source sent, on the day it was recorded.
    await patchSourceStats(ctx, source, (s) => ({ ...countLanded(s, [{ at: replay.started_at, n: groups }], now), groups_open: Math.max(0, (s.groups_open ?? 0) + openDelta) }), now);
  }
  return { groups, transitions };
}

/** A recording's issues from the action that read it (replays.assemble, replays.importExternal, the regroup pass). */
export const applyReplayIssues = internalMutation({
  args: { replay_id: v.id("replays"), issues_json: v.string() },
  handler: async (ctx, args): Promise<{ groups: number; transitions: number }> => {
    const replay = await ctx.db.get(args.replay_id);
    const source = replay ? await ctx.db.get(replay.source_id) : null;
    if (!replay || !source) return { groups: 0, transitions: 0 };
    return recordReplayIssues(ctx, source, replay, JSON.parse(args.issues_json) as ReplayIssue[], Date.now());
  },
});

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
    /** The batch came on a rotated-out key inside its grace window: counted on the source's stats. */
    old_key: v.optional(v.boolean()),
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
      const granted = await grantNewGroups(ctx, source, fresh.length);
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

    // Moment events are kept: each joins its (kind, subject) moment (moments.ts, learning-loop.md LL7).
    const momentEvents = items.filter((i): i is Extract<IngestItem, { type: "moment" }> => i.type === "moment");
    if (momentEvents.length) await recordMomentEvents(ctx, source, momentEvents, now);

    const named = items.flatMap((i) => (i.type === "event" ? [{ name: i.name, at: i.at }] : []));
    await patchSourceStats(ctx, source, (s) => ({
      events_today: (s.events_today ?? 0) + items.length,
      ...(named.length ? { event_names: countEventNames(s.event_names, named, now) } : {}),
      groups_open: Math.max(0, (s.groups_open ?? 0) + openDelta),
      last_event_at: now,
      ...(args.old_key ? { old_key_last_at: now, old_key_events: (s.old_key_events ?? 0) + items.length } : {}),
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


/**
 * Promotions the hourly cap held back, and runs that never settled
 * (ingestPromotions.ts), oldest first, each as its source's window has room
 * and spaced apart; one whose source no longer promotes that transition, is
 * gone, or is out of tries, is let go. Runs every ten minutes (crons.ts).
 */
export const promoteDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db.query("event_groups").withIndex("by_promotion_due", (q: any) => q.gt("promotion_due.at", 0)).take(PROMOTE_DUE_BATCH);
    let filed = 0;
    for (const group of due) {
      const d = group.promotion_due!;
      const step = promotionStep(d, Date.now());
      if (step === "in_flight") continue;
      const source = await ctx.db.get(group.source_id);
      if (!source || !source.promote.includes(d.transition) || step === "give_up") {
        await ctx.db.patch(group._id, { promotion_due: undefined });
        continue;
      }
      if (source.status !== "active") continue;
      const { granted } = await takeFromWindow(ctx.db, `ingest-promote:${source._id}`, SOURCE_CAPS.promotions_per_hour, HOUR_MS, 1);
      if (!granted) continue;
      await schedulePromotion(ctx, group._id, d, filed * PROMOTE_SPACING_MS);
      filed++;
    }
    return { due: due.length, filed };
  },
});

/**
 * A deploy marker and its triggers, once per version and environment: a
 * retried batch or an SDK that reports its version at every boot records and
 * fires nothing again. New markers past SOURCE_CAPS.deploys_per_hour are
 * skipped. Whether this call recorded one.
 */
async function announceDeploy(ctx: any, source: Doc<"event_sources">, d: Extract<ItemPlan, { type: "deploy" }>): Promise<boolean> {
  const key = deployKey(source._id, d.version, d.environment);
  const seen = await eventByDedupeKey(ctx, key);
  if (seen) {
    // A second report of the same version (the deploy path's own, after an
    // api's boot announced it) adds what it knows: the run, the commit range.
    if (d.url || d.commits?.length || d.previous_sha) await recordDeployMarker(ctx, deployMarkerOf(source, d, seen._id));
    return false;
  }
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
  await recordDeployMarker(ctx, deployMarkerOf(source, d, eventId));
  await scheduleTriggerMatch(ctx, {
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
        reason: "The source's owner is no longer in this workspace, so its reports have nobody to file as. Resume it after giving it a new owner.",
      });
      return { skipped: "filer left" };
    }
    const signal = promotionSignal(source, group, args.transition, args.fingerprint);
    const result = signal ? await ctx.runAction(internal.signals.ingestAs, { user_id: source.owner_user_id, ...signal }) : null;
    // Filed, held or not promotable: done either way. A throw leaves promotion_due for promoteDue to run again.
    await ctx.runMutation(internal.ingestPromotions.settlePromotion, { group_id: group._id });
    if (!result) return { skipped: "transition does not promote" };
    // A held signal (no finder converts this source, LE4) reached no cause yet.
    if (!result.task_id) return { skipped: "held as a finding" };
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

// ── Exact group counts per status ──

type GroupCounts = { open: number; resolved: number; ignored: number };
type GroupStatusName = Doc<"event_groups">["status"];

/** Which count a status lands in: muted is a kind of ignored. */
function countKey(status: GroupStatusName): keyof GroupCounts {
  return status === "resolved" ? "resolved" : status === "ignored" || status === "muted" ? "ignored" : "open";
}

/** A person's triage moved one group from one status to another: the counts follow at once, and the next recount confirms them. */
export function moveGroupCount(counts: GroupCounts, from: GroupStatusName, to: GroupStatusName): GroupCounts {
  const a = countKey(from);
  const b = countKey(to);
  if (a === b) return counts;
  return { ...counts, [a]: Math.max(0, counts[a] - 1), [b]: counts[b] + 1 };
}

/** Groups one recount page reads. */
const RECOUNT_PAGE = 200;
/** Sources one sweep page walks. */
const RECOUNT_SOURCES_PAGE = 25;

/**
 * Counts a source's groups by status, one page per run, and writes the exact
 * counts with the time the count began. groups_open is set to the counted
 * open too: the increments every ingest path adds to it drift (a resolve at
 * the vendor, a mirror that reopens), and the Issues list reads the counts as
 * its totals once its own open window is full.
 */
export const recountSourceGroups = internalMutation({
  args: {
    source_id: v.id("event_sources"),
    cursor: v.optional(v.union(v.string(), v.null())),
    acc: v.optional(v.object({ open: v.number(), resolved: v.number(), ignored: v.number() })),
    started: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return { done: true };
    const started = args.started ?? Date.now();
    const acc: GroupCounts = { ...(args.acc ?? { open: 0, resolved: 0, ignored: 0 }) };
    const page = await ctx.db
      .query("event_groups")
      .withIndex("by_source_last_seen", (q) => q.eq("source_id", source._id))
      .paginate({ cursor: args.cursor ?? null, numItems: RECOUNT_PAGE });
    for (const g of page.page) if (!isRecordNotIssue(g)) acc[countKey(g.status)]++;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ingest.recountSourceGroups, { source_id: source._id, cursor: page.continueCursor, acc, started });
      return { done: false };
    }
    await patchSourceStats(ctx, source, () => ({ group_counts: acc, groups_counted_at: started, groups_open: acc.open }));
    return { done: true, counts: acc };
  },
});

/**
 * The sweep behind the exact counts: every source that took anything since
 * its last count (an event, a poll, or never counted) is recounted. A quiet
 * source keeps its count; a person's triage moves it as it happens.
 */
export const recountGroups = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("event_sources").paginate({ cursor: args.cursor ?? null, numItems: RECOUNT_SOURCES_PAGE });
    let queued = 0;
    for (const source of page.page) {
      const s = await sourceStats(ctx, source);
      const moved = Math.max(s.last_event_at ?? 0, s.last_poll_at ?? 0, source.updated_at ?? 0);
      if (s.group_counts && s.groups_counted_at !== undefined && moved <= s.groups_counted_at) continue;
      await ctx.scheduler.runAfter(0, internal.ingest.recountSourceGroups, { source_id: source._id });
      queued++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.ingest.recountGroups, { cursor: page.continueCursor });
    return { queued, done: page.isDone };
  },
});
