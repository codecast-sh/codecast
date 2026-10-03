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
import { sha256Hex } from "./lib/hash";
import { nextShortId } from "./counters";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { recordExternalEvent } from "./externalEvents";
import { linkReplayToGroup, upsertReplayManifest } from "./replays";
import { groupStatusValidator, groupKindValidator, sourceConfigValidator, sourceProviderValidator, transitionValidator } from "./ingestSchema";
import {
  DEFAULT_PROMOTE,
  GROUP_RULES,
  INGEST_LIMITS,
  INGEST_SHORT_ID_PREFIX,
  KEYED_SOURCE_PROVIDERS,
  generateIngestKey,
  ingestKeyPrefix,
  normalizeSourceName,
  transitionSignalKind,
  transitionTriggerEvent,
  type GroupKind,
  type IngestItem,
  type Transition,
} from "@codecast/shared/contracts/ingest";
import { groupFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import {
  SAMPLES_PER_BATCH,
  applyMirror,
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

// Which workspace a call reads or writes: the same choice signals and tasks
// take (createWorkContext). The web passes team_id or workspace "personal";
// the CLI passes what its session resolves.
export const scopeArgs = {
  api_token: v.optional(v.string()),
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
  project_path: v.optional(v.string()),
  conversation_id: v.optional(v.string()),
};
export type ScopeArgs = { api_token?: string; workspace?: "personal" | "team"; team_id?: Id<"teams">; project_path?: string; conversation_id?: string };

export async function scopeOf(ctx: any, args: ScopeArgs) {
  const userId = await requireUserOrToken(ctx, args.api_token);
  const { db } = await createWorkContext(ctx, {
    userId,
    workspace: args.workspace,
    team_id: args.team_id,
    project_path: args.project_path,
    conversation_id: args.conversation_id,
  });
  return { userId, db, workspaceKey: db.workspaceKey as string };
}

/** A source by short id, Convex id, or name inside the caller's workspace, if the caller may read it. */
export async function sourceByRef(ctx: any, userId: Id<"users">, workspaceKey: string, ref: string): Promise<Doc<"event_sources">> {
  const needle = ref.trim();
  const byShort = await ctx.db.query("event_sources").withIndex("by_short_id", (q: any) => q.eq("short_id", needle)).first();
  const id = byShort ? null : ctx.db.normalizeId("event_sources", needle);
  const byName = byShort || id
    ? null
    : await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspaceKey).eq("name", normalizeSourceName(needle))).first();
  const row: Doc<"event_sources"> | null = byShort ?? (id ? await ctx.db.get(id) : null) ?? byName;
  if (!row || !(await workspaceGrantsAccess(ctx, userId, row.workspace))) notFound(`Source ${needle} not found`);
  return row;
}

export async function groupByRef(ctx: any, userId: Id<"users">, ref: string): Promise<Doc<"event_groups">> {
  const needle = ref.trim();
  const byShort = await ctx.db.query("event_groups").withIndex("by_short_id", (q: any) => q.eq("short_id", needle)).first();
  const id = byShort ? null : ctx.db.normalizeId("event_groups", needle);
  const row: Doc<"event_groups"> | null = byShort ?? (id ? await ctx.db.get(id) : null);
  if (!row || !(await workspaceGrantsAccess(ctx, userId, row.workspace))) notFound(`Group ${needle} not found`);
  return row;
}

/** A source as any reader sees it: never the key hash. */
export function sourceView(row: Doc<"event_sources">) {
  const { ingest_key_hash: _hash, manifest_json: _manifest, ...rest } = row;
  return { ...rest, keyed: !!row.ingest_key_hash };
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
    provider: sourceProviderValidator,
    project: v.optional(v.string()),
    fingerprint_prefix: v.optional(v.string()),
    config: v.optional(sourceConfigValidator),
    promote: v.optional(v.array(transitionValidator)),
  },
  handler: async (ctx, args) => {
    const { userId, db, workspaceKey } = await scopeOf(ctx, args);
    const name = normalizeSourceName(args.name);
    if (!name || name.length > INGEST_LIMITS.name_chars) invalidScope("A source needs a name");
    const taken = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspaceKey).eq("name", name)).first();
    if (taken) invalidScope(`A source named ${name} already exists here (${taken.short_id})`);
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
      counters_day: utcDay(now),
      events_today: 0,
      dropped_today: 0,
      groups_open: 0,
      created_at: now,
      updated_at: now,
    });
    const row = (await ctx.db.get(id))!;
    // The only time the key leaves the backend: it is stored as a hash.
    return { source: sourceView(row), ...(key ? { ingest_key: key } : {}) };
  },
});

/** A new key for a keyed source; the old one stops working at once. */
export const rotateKey = mutation({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const row = await sourceByRef(ctx, userId, workspaceKey, args.source);
    if (!KEYED_SOURCE_PROVIDERS.includes(row.provider)) invalidScope(`${row.short_id} is a ${row.provider} source and has no ingest key`);
    const key = generateIngestKey();
    await ctx.db.patch(row._id, { ingest_key_hash: await sha256Hex(key), key_prefix: ingestKeyPrefix(key), updated_at: Date.now() });
    return { source: sourceView((await ctx.db.get(row._id))!), ingest_key: key };
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
    if (args.config) patch.config = args.config;
    await ctx.db.patch(row._id, patch);
    return { source: sourceView((await ctx.db.get(row._id))!) };
  },
});

/** Removes the source now; its groups and samples go in the background. The timeline keeps its rows. */
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

const PURGE_PAGE = 100;

export const purgeSourceRows = internalMutation({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    const groups = await ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", args.source_id)).take(PURGE_PAGE);
    for (const group of groups) {
      const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", group._id)).collect();
      for (const s of samples) await ctx.db.delete(s._id);
      await ctx.db.delete(group._id);
    }
    if (groups.length === PURGE_PAGE) await ctx.scheduler.runAfter(0, internal.ingest.purgeSourceRows, args);
  },
});

export const listSources = query({
  args: { ...scopeArgs },
  handler: async (ctx, args) => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const rows = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspaceKey)).take(500);
    return rows.map(sourceView);
  },
});

export const getSource = query({
  args: { ...scopeArgs, source: v.string() },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    return sourceView(await sourceByRef(ctx, userId, workspaceKey, args.source));
  },
});

// ── Groups and the timeline ──

const LIST_CAP = 500;

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
    const base = source
      ? ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", source._id))
      : args.status
        ? ctx.db.query("event_groups").withIndex("by_workspace_status_last_seen", (q) => q.eq("workspace", workspaceKey).eq("status", args.status!))
        : ctx.db.query("event_groups").withIndex("by_workspace_last_seen", (q) => q.eq("workspace", workspaceKey));
    const out: Doc<"event_groups">[] = [];
    // Filters the index cannot take are applied while reading, so a narrow
    // filter still returns up to `limit` rows from a bounded scan.
    for await (const row of base.order("desc")) {
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
    const row = await groupByRef(ctx, userId, args.group);
    const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q) => q.eq("group_id", row._id)).order("desc").take(GROUP_RULES.samples_per_group);
    const source = await ctx.db.get(row.source_id);
    return {
      group: groupView(row, Date.now()),
      samples,
      source: source ? { _id: source._id, short_id: source.short_id, name: source.name, provider: source.provider } : null,
    };
  },
});

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
    if (source) await ctx.db.patch(source._id, { groups_open: Math.max(0, (source.groups_open ?? 0) + delta) });
    return { group: groupView((await ctx.db.get(row._id))!, now) };
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

/** What the door needs to admit a batch. Internal: the hash is compared here, never returned. */
export const sourceForKey = internalQuery({
  args: { key_hash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("event_sources").withIndex("by_ingest_key_hash", (q) => q.eq("ingest_key_hash", args.key_hash)).first();
    if (!row) return null;
    return { _id: row._id, status: row.status, allowed_origins: row.config?.allowed_origins ?? null };
  },
});

export type GroupPlan = Extract<ItemPlan, { type: "group" }>;

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

/**
 * One group's occurrences from one source folded into its row, with the
 * samples and every transition announced. The one upsert every feed goes
 * through: the door's batches and the polled adapters (metric watches) alike,
 * so a group behaves the same whichever way its facts arrive. `plans` share a
 * fingerprint. The caller moves the source's groups_open by `open_delta`.
 */
export async function upsertGroup(
  ctx: any,
  source: Doc<"event_sources">,
  plans: GroupPlan[],
  envelope: { release?: string; environment?: string },
  now: number,
): Promise<{ group_id: Id<"event_groups">; short_id: string; open_delta: number; transitions: number }> {
  const plan = plans[0];
  const existing: Doc<"event_groups"> | null = await ctx.db
    .query("event_groups")
    .withIndex("by_source_fingerprint", (q: any) => q.eq("source_id", source._id).eq("fingerprint", plan.fingerprint))
    .first();
  const folded = foldOccurrences(existing ? stateOf(existing) : null, plans.map((p) => p.occurrence), now);
  const next = folded.next!;
  // The newest occurrence names the group: a title that drifts with the
  // message (a clipped stack, a new culprit) follows what is happening now.
  const newest = plans.reduce((a, b) => (b.occurrence.at >= a.occurrence.at ? b : a));
  const meta = next.meta || newest.meta ? { ...existing?.meta, ...newest.meta, ...next.meta } : existing?.meta;
  const fields = {
    ...next,
    title: newest.title,
    culprit: newest.culprit ?? existing?.culprit,
    level: newest.level ?? existing?.level,
    meta: meta as Doc<"event_groups">["meta"],
    updated_at: now,
  };
  const { group_id: groupId, short_id: shortId } = await writeGroup(ctx, source, existing, plan.fingerprint, fields);
  await appendSamples(ctx, source, groupId, plans);

  for (const t of folded.transitions) {
    await announceTransition(ctx, source, {
      group_id: groupId,
      group_short_id: shortId,
      kind: plan.kind,
      title: newest.title,
      level: fields.level,
      count: next.count,
      transition: t.transition,
      at: t.at,
      release: envelope.release,
      environment: envelope.environment,
      value: newest.meta?.value,
      threshold: newest.meta?.threshold,
      signal_fingerprint: groupFingerprint(source.fingerprint_prefix, plan.kind, plan.fp),
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
  const existing: Doc<"event_groups"> | null = await ctx.db
    .query("event_groups")
    .withIndex("by_source_fingerprint", (q: any) => q.eq("source_id", source._id).eq("fingerprint", fingerprint))
    .first();
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
      release: m.release,
      signal_fingerprint: groupFingerprint(source.fingerprint_prefix, m.kind, m.fp),
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
    const sameDay = source.counters_day === utcDay(now);
    await ctx.db.patch(source._id, {
      counters_day: utcDay(now),
      events_today: (sameDay ? source.events_today ?? 0 : 0) + added,
      groups_open: Math.max(0, (source.groups_open ?? 0) + openDelta),
      ...(added ? { last_event_at: now } : {}),
      updated_at: now,
    });
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

/**
 * One batch from the door, in one transaction. `items_json` is the validated
 * items as JSON: product payloads carry object keys Convex refuses as field
 * names ($current_url), so they cross as a string and are stored as strings.
 */
export const applyBatch = internalMutation({
  args: {
    source_id: v.id("event_sources"),
    items_json: v.string(),
    release: v.optional(v.string()),
    environment: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accepted: number; dropped: number; transitions: number }> => {
    const items = JSON.parse(args.items_json) as IngestItem[];
    const source = await ctx.db.get(args.source_id);
    if (!source || source.status === "paused") return { accepted: 0, dropped: items.length, transitions: 0 };
    const now = Date.now();
    const envelope = { release: args.release, environment: args.environment };

    const groups = new Map<string, { plan: GroupPlan; plans: GroupPlan[] }>();
    const deploys: Extract<ItemPlan, { type: "deploy" }>[] = [];
    for (const item of items) {
      const plan = planItem(item, envelope);
      if (plan.type === "group") {
        const entry = groups.get(plan.fingerprint);
        if (entry) entry.plans.push(plan);
        else groups.set(plan.fingerprint, { plan, plans: [plan] });
      } else if (plan.type === "deploy") deploys.push(plan);
      // A recording's manifest is the replays module's row (X5), not a group.
      if (item.type === "replay") await upsertReplayManifest(ctx, source, item, now);
    }

    let openDelta = 0;
    let transitions = 0;
    for (const { plans } of groups.values()) {
      const upserted = await upsertGroup(ctx, source, plans, envelope, now);
      openDelta += upserted.open_delta;
      transitions += upserted.transitions;
    }

    for (const deploy of deploys) {
      transitions++;
      await announceDeploy(ctx, source, deploy);
    }

    const sameDay = source.counters_day === utcDay(now);
    await ctx.db.patch(source._id, {
      counters_day: utcDay(now),
      events_today: (sameDay ? source.events_today ?? 0 : 0) + items.length,
      groups_open: Math.max(0, (source.groups_open ?? 0) + openDelta),
      last_event_at: now,
      updated_at: now,
    });
    return { accepted: items.length, dropped: 0, transitions };
  },
});

/** Count what the door refused, so a source shows its drops even when nothing got through. */
export const countDropped = internalMutation({
  args: { source_id: v.id("event_sources"), dropped: v.number() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source || args.dropped <= 0) return;
    const now = Date.now();
    const sameDay = source.counters_day === utcDay(now);
    await ctx.db.patch(source._id, {
      counters_day: utcDay(now),
      events_today: sameDay ? source.events_today ?? 0 : 0,
      dropped_today: (sameDay ? source.dropped_today ?? 0 : 0) + args.dropped,
    });
  },
});

/**
 * The newest few occurrences of a batch as samples, then the oldest beyond
 * the cap removed. A green check report is not an occurrence worth keeping.
 */
async function appendSamples(ctx: any, source: Doc<"event_sources">, groupId: Id<"event_groups">, plans: GroupPlan[]): Promise<void> {
  const keep = plans
    .filter((p) => p.occurrence.ok !== true)
    .sort((a, b) => b.occurrence.at - a.occurrence.at)
    .slice(0, SAMPLES_PER_BATCH);
  // Every occurrence inside a recording links the recording to its group
  // (X5), sampled or not; a kept sample also names the recording's row.
  const replays = new Map<string, Id<"replays">>();
  for (const p of plans) {
    const ext = p.sample.replay_external_id;
    if (ext && !replays.has(ext)) replays.set(ext, await linkReplayToGroup(ctx, source, ext, groupId, p.occurrence.at));
  }
  if (!keep.length) return;
  for (const p of keep) {
    const replayId = p.sample.replay_external_id ? replays.get(p.sample.replay_external_id) : undefined;
    await ctx.db.insert("event_samples", { ...p.sample, workspace: source.workspace, group_id: groupId, source_id: source._id, ...(replayId ? { replay_id: replayId } : {}) });
  }
  const all: Doc<"event_samples">[] = await ctx.db.query("event_samples").withIndex("by_group_at", (q: any) => q.eq("group_id", groupId)).order("desc").collect();
  for (const extra of all.slice(GROUP_RULES.samples_per_group)) await ctx.db.delete(extra._id);
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
  release?: string;
  environment?: string;
  /** A metric's polled value and its line. */
  value?: number;
  threshold?: number;
  signal_fingerprint: string;
}

/**
 * A transition's three effects (X3, X4, X6): the timeline row, the triggers
 * armed on its name, and a promotion when the source promotes it.
 */
async function announceTransition(ctx: any, source: Doc<"event_sources">, a: Announcement): Promise<void> {
  const eventType = transitionTriggerEvent(a.kind, a.transition);
  const eventId = await recordExternalEvent(ctx, {
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.provider,
    kind: eventType ?? a.transition,
    title: a.title,
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
    dedupe_key: `ingest:${a.group_id}:${a.transition}:${a.at}`,
    created_at: a.at,
  });
  if (eventType) {
    await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
      event_type: eventType,
      team_id: source.team_id,
      workspace: source.workspace,
      source: source.name,
      event_ref: { external_event_id: eventId, group_short_id: a.group_short_id, title: a.title },
    });
  }
  const kind = transitionSignalKind(a.transition);
  if (kind && source.promote.includes(a.transition)) {
    await ctx.scheduler.runAfter(0, internal.ingest.promote, {
      group_id: a.group_id,
      transition: a.transition,
      fingerprint: a.signal_fingerprint,
    });
  }
}

async function announceDeploy(ctx: any, source: Doc<"event_sources">, d: Extract<ItemPlan, { type: "deploy" }>): Promise<void> {
  const title = `Deployed ${d.version}${d.environment ? ` to ${d.environment}` : ""}`;
  const eventId = await recordExternalEvent(ctx, {
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.provider,
    kind: "deploy",
    title,
    sha: d.sha,
    source_id: source._id,
    data: { transition: "deploy", source_name: source.name, provider: source.provider, release: d.version, environment: d.environment },
    // A retried batch or a redeploy of one version is one marker.
    dedupe_key: `ingest:${source._id}:deploy:${d.version}:${d.environment ?? ""}`,
    created_at: d.at,
  });
  await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
    event_type: "deploy",
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.name,
    event_ref: { external_event_id: eventId, title },
  });
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

export const linkSignal = internalMutation({
  args: { group_id: v.id("event_groups"), task_id: v.id("tasks") },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.group_id)) await ctx.db.patch(args.group_id, { signal_task_id: args.task_id });
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
  args: { group_id: v.id("event_groups"), transition: transitionValidator, fingerprint: v.string() },
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
    await ctx.runMutation(internal.ingest.linkSignal, { group_id: group._id, task_id: result.task_id });
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
    for (const s of old) await ctx.db.delete(s._id);
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
 * Daily: every source's counters start the new day at zero, and every
 * group's buckets drop the hours past the window, so a group that went
 * quiet stops carrying a stale sparkline.
 */
export const dailyUpkeep = internalMutation({
  args: { table: v.optional(v.union(v.literal("event_sources"), v.literal("event_groups"))), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const table = args.table ?? "event_sources";
    const now = Date.now();
    const page = await ctx.db.query(table).paginate({ cursor: args.cursor ?? null, numItems: UPKEEP_PAGE });
    for (const row of page.page as any[]) {
      if (table === "event_sources") {
        if (row.counters_day !== utcDay(now)) await ctx.db.patch(row._id, { counters_day: utcDay(now), events_today: 0, dropped_today: 0 });
      } else {
        const kept = pruneBuckets(row.buckets, now);
        if (kept.length !== row.buckets.length) await ctx.db.patch(row._id, { buckets: kept });
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.ingest.dailyUpkeep, { table, cursor: page.continueCursor });
    else if (table === "event_sources") await ctx.scheduler.runAfter(0, internal.ingest.dailyUpkeep, { table: "event_groups" });
  },
});

