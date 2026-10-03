// Session replays (docs/architecture/external-data.md X5). A replay is a
// manifest row here and gzipped chunks of ReplayEvent JSON in the private
// codecast-replays R2 bucket. This module owns the row: the stub a chunk
// upload or an error's replay_id opens, the manifest update a `replay` ingest
// item carries, the link from a recording to the error groups that happened
// in it, the cached text timeline assembled from the chunks, and the import
// of a vendor recording (PostHog, Sentry) converted by fromRrweb.
//
// Access is the stored workspace key (CLAUDE.md, Workspace access vs
// routing): a reader sees a replay when they hold its `workspace`. Chunk keys
// never leave the server except as URLs signed after that check.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Gunzip, gzipSync, strToU8, strFromU8 } from "fflate";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { notFound, requireUserOrToken } from "./lib/auth";
import { readableRowByRef } from "./lib/rowByRef";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { takeFromWindow } from "./ipRateLimit";
import { nextShortId } from "./counters";
import { sha256Hex } from "./lib/hash";
import { readBodyCapped } from "./lib/tokenHttp";
import { ingestUserValidator, replayProviderValidator } from "./ingestSchema";
import {
  parseReplayChunkKey,
  r2FreshGetUrl,
  r2Presign,
  replayChunkKey,
  replaysBucketFromEnv,
  safeReplayPathSegment,
  type R2Bucket,
} from "./lib/r2";
import { REPLAY_LIMITS, type ReplayEvent, type ReplayProvider } from "@codecast/shared/contracts/replay";
import { INGEST_SHORT_ID_PREFIX, type IngestItem, type SourceProvider } from "@codecast/shared/contracts/ingest";
import { parseReplayEvents, renderTimeline, replayCounts, sortReplayEvents } from "@codecast/shared/replay";

type ReplayItem = Extract<IngestItem, { type: "replay" }>;
type Db = { db: any };
type WriteCtx = { db: any; scheduler: any };

/** How many error groups one recording links to; past this the oldest links stay and new ones are dropped. */
export const REPLAY_GROUP_LINKS_MAX = 50;
/** A manifest update waits this long before assembling, so the chunks it names have landed. */
const ASSEMBLE_DELAY_MS = 5_000;
/** A queued assembly that has not written its timeline by now is presumed dead, and the next manifest queues another. */
const ASSEMBLE_STALE_MS = 10 * 60_000;
/**
 * How long after a chunk's sign a missing object may still be an upload in
 * flight (or a failed PUT the SDK retries). Inside it an assembly that could
 * not read a chunk leaves the timeline stale; past it the chunk is given up.
 */
export const CHUNK_LANDING_MS = 10 * 60_000;
/**
 * The most a chunk may expand to when gunzipped. A real chunk is at most
 * chunk_max_events events, about 1 MB of JSON; the cap leaves room for that
 * while keeping the decoded string well inside an action's memory.
 */
export const REPLAY_CHUNK_MAX_INFLATED_BYTES = 8 * 1024 * 1024;

/**
 * New recordings one source may open per hour. Anything holding the public
 * ingest key can name a fresh replay id on every sign, error item or
 * manifest, and each opens a row and a short id; past this they are refused
 * (a chunk sign answers 400, an error keeps no recording link).
 */
export const REPLAYS_NEW_PER_HOUR = 300;

/** The provider a recording from this source is: our recorder, unless the source mirrors a vendor. */
export function replayProviderFor(source: SourceProvider): ReplayProvider {
  return source === "posthog" || source === "sentry" ? source : "sdk";
}

// ── Writes (used by the ingest door, the sign route and the adapters) ──

export async function findReplay(ctx: Db, sourceId: Id<"event_sources">, externalId: string): Promise<Doc<"replays"> | null> {
  return await ctx.db
    .query("replays")
    .withIndex("by_source_external", (q: any) => q.eq("source_id", sourceId).eq("external_id", externalId))
    .first();
}

/**
 * The manifest row for a recording, opened as a stub when this is the first
 * the backend hears of it. Any of three things may arrive first (a chunk
 * signature, an error carrying the replay id, the manifest item), so each of
 * them opens it the same way and the others fill it in. Null when the source
 * is past REPLAYS_NEW_PER_HOUR; an import a person asked for is not capped.
 */
export async function ensureReplay(ctx: Db, source: Doc<"event_sources">, externalId: string, now: number, opts: { capped?: boolean } = { capped: true }): Promise<Doc<"replays"> | null> {
  const existing = await findReplay(ctx, source._id, externalId);
  if (existing) return existing;
  if (opts.capped !== false && !(await takeFromWindow(ctx.db, `replay-new:${source._id}`, REPLAYS_NEW_PER_HOUR, 3600_000, 1)).granted) return null;
  const row = {
    workspace: source.workspace,
    team_id: source.team_id,
    source_id: source._id,
    short_id: await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.replay),
    provider: replayProviderFor(source.provider),
    external_id: externalId,
    started_at: now,
    counts: { clicks: 0, errors: 0, failed_requests: 0 },
    group_ids: [],
    chunk_keys: [],
    created_at: now,
    updated_at: now,
  };
  const id = await ctx.db.insert("replays", row);
  return { ...row, _id: id, _creationTime: now } as Doc<"replays">;
}

/**
 * A `replay` ingest item (X2): what the SDK knows about the recording. Counts
 * from the SDK stand until the chunks are assembled, which recounts them from
 * the stream itself. Schedules that assembly when chunks exist.
 */
export async function upsertReplayManifest(ctx: WriteCtx, source: Doc<"event_sources">, item: ReplayItem, now: number): Promise<Id<"replays"> | null> {
  const row = await ensureReplay(ctx, source, item.replay_id, now);
  if (!row) return null;
  const patch: Partial<Doc<"replays">> = { updated_at: now };
  if (item.url) patch.url = item.url;
  if (item.user) patch.user = item.user;
  if (item.started_at !== undefined && item.started_at < row.started_at) patch.started_at = item.started_at;
  if (item.duration_ms !== undefined) patch.duration_ms = Math.max(0, item.duration_ms);
  if (item.counts && !row.timeline_at) {
    patch.counts = {
      clicks: item.counts.clicks ?? row.counts.clicks,
      errors: item.counts.errors ?? row.counts.errors,
      failed_requests: item.counts.failed_requests ?? row.counts.failed_requests,
    };
  }
  if (shouldQueueAssembly(row, now)) {
    patch.assemble_at = now;
    await ctx.scheduler.runAfter(ASSEMBLE_DELAY_MS, internal.replays.assemble, { replay_id: row._id });
  }
  await ctx.db.patch(row._id, patch);
  return row._id;
}

/**
 * Whether a manifest update should queue an assembly: only when the cached
 * timeline is older than the chunk list, and no assembly is already queued.
 * An SDK that re-sends its manifest (or anyone holding the public ingest key)
 * would otherwise queue a download of up to 60 chunks per item. A queued
 * assembly that never reported back stops counting after ASSEMBLE_STALE_MS.
 */
export function shouldQueueAssembly(row: Pick<Doc<"replays">, "chunk_keys" | "chunks_at" | "timeline_at" | "assemble_at">, now: number): boolean {
  if (!row.chunk_keys.length) return false;
  const timelineAt = row.timeline_at ?? 0;
  if (row.timeline_at !== undefined && (row.chunks_at ?? 0) <= timelineAt) return false;
  const queued = row.assemble_at !== undefined && row.assemble_at > timelineAt && now - row.assemble_at < ASSEMBLE_STALE_MS;
  return !queued;
}

/**
 * An error item named a recording (X5): link the recording to the error's
 * group, opening the stub when the manifest has not arrived yet. Returns the
 * replay row for the sample's `replay_id`.
 */
export async function linkReplayToGroup(ctx: Db, source: Doc<"event_sources">, externalId: string, groupId: Id<"event_groups">, now: number): Promise<Id<"replays"> | null> {
  const row = await ensureReplay(ctx, source, externalId, now);
  if (!row) return null;
  if (!row.group_ids.some((g) => g === groupId) && row.group_ids.length < REPLAY_GROUP_LINKS_MAX) {
    await ctx.db.patch(row._id, { group_ids: [...row.group_ids, groupId], updated_at: now });
  }
  return row._id;
}

/**
 * A chunk the SDK is about to upload (the sign route). The key replaces any
 * earlier key for the same sequence number, so a retried upload of a changed
 * chunk does not leave two. Refuses past REPLAY_LIMITS.max_chunks_per_replay.
 */
export async function recordReplayChunk(
  ctx: Db,
  source: Doc<"event_sources">,
  externalId: string,
  seq: number,
  key: string,
  now: number,
): Promise<{ ok: true; replay_id: Id<"replays"> } | { ok: false; reason: string }> {
  if (!Number.isInteger(seq) || seq < 0 || seq >= REPLAY_LIMITS.max_chunks_per_replay) {
    return { ok: false, reason: `seq must be 0 to ${REPLAY_LIMITS.max_chunks_per_replay - 1}` };
  }
  const row = await ensureReplay(ctx, source, externalId, now);
  if (!row) return { ok: false, reason: `this source opened ${REPLAYS_NEW_PER_HOUR} recordings in the last hour; try again later` };
  if (row.chunk_keys.includes(key)) return { ok: true, replay_id: row._id };
  const keys = row.chunk_keys.filter((k) => parseReplayChunkKey(k)?.seq !== seq);
  keys.push(key);
  keys.sort((a, b) => (parseReplayChunkKey(a)?.seq ?? 0) - (parseReplayChunkKey(b)?.seq ?? 0));
  await ctx.db.patch(row._id, { chunk_keys: keys, chunks_at: now, updated_at: now });
  return { ok: true, replay_id: row._id };
}

async function sourceOrThrow(ctx: Db, id: Id<"event_sources">): Promise<Doc<"event_sources">> {
  const source = await ctx.db.get(id);
  if (!source) throw new Error("Source not found");
  return source;
}

const replayItemValidator = v.object({
  type: v.literal("replay"),
  replay_id: v.string(),
  url: v.optional(v.string()),
  user: v.optional(ingestUserValidator),
  started_at: v.optional(v.number()),
  duration_ms: v.optional(v.number()),
  chunks: v.optional(v.number()),
  counts: v.optional(v.object({ clicks: v.optional(v.number()), errors: v.optional(v.number()), failed_requests: v.optional(v.number()) })),
  at: v.number(),
});

/** The manifest upsert as its own transaction, for callers outside the ingest batch. */
export const upsertManifest = internalMutation({
  args: { source_id: v.id("event_sources"), item: replayItemValidator },
  handler: async (ctx, args) => upsertReplayManifest(ctx, await sourceOrThrow(ctx, args.source_id), args.item, Date.now()),
});

export const linkGroup = internalMutation({
  args: { source_id: v.id("event_sources"), replay_external_id: v.string(), group_id: v.id("event_groups") },
  handler: async (ctx, args) => linkReplayToGroup(ctx, await sourceOrThrow(ctx, args.source_id), args.replay_external_id, args.group_id, Date.now()),
});

export const recordChunk = internalMutation({
  args: { source_id: v.id("event_sources"), replay_external_id: v.string(), seq: v.number(), key: v.string() },
  handler: async (ctx, args) => recordReplayChunk(ctx, await sourceOrThrow(ctx, args.source_id), args.replay_external_id, args.seq, args.key, Date.now()),
});

// ── Reading chunks (actions) ──

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The ingest key is public and the presigned PUT does not sign a length, so a
// chunk object can be any size: it is read through the shared capped reader.
export { readBodyCapped };

/** Input fed to the inflater per step. Deflate expands at most ~1032x, so one step yields about 1 MB at worst. */
const GUNZIP_STEP_BYTES = 1024;

/**
 * Gunzip that gives up past `max` output bytes (null), so a small gzip bomb
 * cannot exhaust the action's memory. The ISIZE trailer is not trusted: it
 * is written by the uploader and wraps at 4 GB.
 */
export function gunzipCapped(bytes: Uint8Array, max: number): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const inflater = new Gunzip((chunk) => {
    if (over) return;
    total += chunk.length;
    if (total > max) {
      over = true;
      return;
    }
    parts.push(chunk);
  });
  try {
    for (let i = 0; i < bytes.length && !over; i += GUNZIP_STEP_BYTES) {
      inflater.push(bytes.subarray(i, i + GUNZIP_STEP_BYTES), i + GUNZIP_STEP_BYTES >= bytes.length);
    }
  } catch {
    return null;
  }
  return over ? null : concatBytes(parts, total);
}

/**
 * Every event in a recording's chunks, in time order. A chunk that is
 * missing (an upload that never finished), oversized, inflates past the cap,
 * or does not hash to the sha its key names is skipped and counted: the
 * presigned PUT cannot enforce any of that, so this is where the limits and
 * content addressing are held to.
 */
export async function readReplayChunks(bucket: R2Bucket, keys: readonly string[]): Promise<{ events: ReplayEvent[]; skipped: number }> {
  const events: ReplayEvent[] = [];
  let skipped = 0;
  for (const key of keys) {
    const res = await fetch(await r2Presign(bucket, "GET", key, REPLAY_LIMITS.signed_url_ttl_s));
    const bytes = res.ok ? await readBodyCapped(res, REPLAY_LIMITS.chunk_max_bytes) : null;
    if (!res.ok) await res.body?.cancel().catch(() => {});
    const want = parseReplayChunkKey(key)?.sha256;
    if (!bytes || (want && (await sha256Hex(bytes)) !== want)) {
      skipped++;
      continue;
    }
    const json = isGzip(bytes) ? gunzipCapped(bytes, REPLAY_CHUNK_MAX_INFLATED_BYTES) : bytes;
    if (!json) {
      skipped++;
      continue;
    }
    try {
      events.push(...parseReplayEvents(JSON.parse(strFromU8(json))));
    } catch {
      skipped++;
    }
  }
  return { events: sortReplayEvents(events), skipped };
}

/** What a stream says about its recording: the cached timeline and the recounted manifest fields. */
function summarize(events: ReplayEvent[], shortId: string) {
  const first = events[0]?.t ?? 0;
  const last = events[events.length - 1]?.t ?? 0;
  return {
    timeline_md: renderTimeline(events, { title: shortId }),
    counts: replayCounts(events),
    duration_ms: Math.max(0, last - first),
    url: events.find((e) => e.type === "nav")?.url,
  };
}

/** The one write of a replay's cached timeline, in its own table so list reads never carry it. */
export async function writeReplayTimeline(ctx: Db, replayId: Id<"replays">, timelineMd: string, now: number): Promise<void> {
  const existing = await ctx.db.query("replay_timelines").withIndex("by_replay", (q: any) => q.eq("replay_id", replayId)).first();
  if (existing) await ctx.db.patch(existing._id, { timeline_md: timelineMd, updated_at: now });
  else await ctx.db.insert("replay_timelines", { replay_id: replayId, timeline_md: timelineMd, updated_at: now });
}

async function readReplayTimeline(ctx: Db, replayId: Id<"replays">): Promise<string | null> {
  const row = await ctx.db.query("replay_timelines").withIndex("by_replay", (q: any) => q.eq("replay_id", replayId)).first();
  return row?.timeline_md ?? null;
}

export const assemblyInputs = internalQuery({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    return row ? { short_id: row.short_id, chunk_keys: row.chunk_keys } : null;
  },
});

export const saveSummary = internalMutation({
  args: {
    replay_id: v.id("replays"),
    chunk_keys: v.array(v.string()),
    timeline_md: v.string(),
    counts: v.object({ clicks: v.number(), errors: v.number(), failed_requests: v.number() }),
    duration_ms: v.number(),
    url: v.optional(v.string()),
    /** Chunks the assembly could not read (readReplayChunks). */
    skipped: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row) return;
    // Chunks that arrived while this assembly ran get their own assembly from
    // the manifest update that names them; this one must not claim them, and
    // stands down so that update can queue it.
    if (row.chunk_keys.join("\n") !== args.chunk_keys.join("\n")) {
      await ctx.db.patch(row._id, { assemble_at: undefined });
      return;
    }
    const now = Date.now();
    await writeReplayTimeline(ctx, row._id, args.timeline_md, now);
    // A chunk signed recently may only be missing because its upload has not
    // landed: the timeline then stays older than the chunk list and no
    // assembly counts as queued, so the manifest that follows the upload
    // queues another. A chunk still missing long after its sign is given up.
    const pending = (args.skipped ?? 0) > 0 && now - (row.chunks_at ?? 0) < CHUNK_LANDING_MS;
    await ctx.db.patch(row._id, {
      timeline_at: pending ? Math.max(0, (row.chunks_at ?? now) - 1) : now,
      ...(pending ? { assemble_at: undefined } : {}),
      counts: args.counts,
      duration_ms: args.duration_ms,
      ...(row.url || !args.url ? {} : { url: args.url }),
      updated_at: now,
    });
  },
});

/** Read a recording's chunks and cache its text timeline and counts on the row. */
export const assemble = internalAction({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args): Promise<{ events: number; skipped: number } | null> => {
    const bucket = replaysBucketFromEnv();
    const input = await ctx.runQuery(internal.replays.assemblyInputs, { replay_id: args.replay_id });
    if (!bucket || !input || !input.chunk_keys.length) return null;
    const { events, skipped } = await readReplayChunks(bucket, input.chunk_keys);
    await ctx.runMutation(internal.replays.saveSummary, { replay_id: args.replay_id, chunk_keys: input.chunk_keys, skipped, ...summarize(events, input.short_id) });
    return { events: events.length, skipped };
  },
});

// ── Importing a vendor recording (X7) ──

/** Split a stream into chunks of at most chunk_max_events events and chunk_max_bytes gzipped. */
export function chunkReplayEvents(events: readonly ReplayEvent[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  const pack = (slice: readonly ReplayEvent[]) => {
    const gz = gzipSync(strToU8(JSON.stringify(slice)));
    if (gz.length <= REPLAY_LIMITS.chunk_max_bytes || slice.length <= 1) {
      if (gz.length <= REPLAY_LIMITS.chunk_max_bytes) out.push(gz);
      return;
    }
    const half = Math.ceil(slice.length / 2);
    pack(slice.slice(0, half));
    pack(slice.slice(half));
  };
  for (let i = 0; i < events.length; i += REPLAY_LIMITS.chunk_max_events) pack(events.slice(i, i + REPLAY_LIMITS.chunk_max_events));
  return out.slice(0, REPLAY_LIMITS.max_chunks_per_replay);
}

/** PUT one chunk unless an object with its key (and so its content) is already there. */
async function putChunk(bucket: R2Bucket, key: string, body: Uint8Array): Promise<void> {
  const head = await fetch(await r2Presign(bucket, "HEAD", key, REPLAY_LIMITS.signed_url_ttl_s), { method: "HEAD" });
  if (head.ok) return;
  const res = await fetch(await r2Presign(bucket, "PUT", key, REPLAY_LIMITS.signed_url_ttl_s), {
    method: "PUT",
    body: body as unknown as BodyInit,
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
  });
  if (!res.ok) throw new Error(`R2 put of ${key} answered ${res.status}`);
}

/** Open (or find) the row an import fills, so its short id can head the timeline. */
export const openImport = internalMutation({
  args: { source_id: v.id("event_sources"), external_id: v.string(), started_at: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ replay_id: Id<"replays">; short_id: string }> => {
    const row = (await ensureReplay(ctx, await sourceOrThrow(ctx, args.source_id), args.external_id, args.started_at ?? Date.now(), { capped: false }))!;
    return { replay_id: row._id, short_id: row.short_id };
  },
});

export const saveImported = internalMutation({
  args: {
    replay_id: v.id("replays"),
    provider: replayProviderValidator,
    chunk_keys: v.array(v.string()),
    timeline_md: v.string(),
    counts: v.object({ clicks: v.number(), errors: v.number(), failed_requests: v.number() }),
    duration_ms: v.number(),
    url: v.optional(v.string()),
    started_at: v.optional(v.number()),
    user: v.optional(ingestUserValidator),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await writeReplayTimeline(ctx, args.replay_id, args.timeline_md, now);
    await ctx.db.patch(args.replay_id, {
      provider: args.provider,
      chunk_keys: args.chunk_keys,
      chunks_at: now,
      timeline_at: now,
      imported_at: now,
      counts: args.counts,
      duration_ms: args.duration_ms,
      ...(args.url ? { url: args.url } : {}),
      ...(args.user ? { user: args.user } : {}),
      ...(args.started_at ? { started_at: args.started_at } : {}),
      updated_at: now,
    });
  },
});

/**
 * A vendor recording, already converted (fromRrweb), stored the way our own
 * recordings are: chunks in R2 under the source, a manifest row, and the
 * timeline cached. Idempotent: the chunks are content addressed and the row
 * is keyed by the source's external id, so a second import uploads nothing
 * that is already there.
 */
export const importExternal = internalAction({
  args: {
    source_id: v.id("event_sources"),
    provider: replayProviderValidator,
    external_id: v.string(),
    events: v.any(),
    started_at: v.optional(v.number()),
    user: v.optional(ingestUserValidator),
  },
  handler: async (ctx, args): Promise<{ replay_id: Id<"replays">; short_id: string; chunks: number }> => {
    const bucket = replaysBucketFromEnv();
    if (!bucket) throw new Error("Replays storage is not configured (REPLAYS_R2_*)");
    const opened = await ctx.runMutation(internal.replays.openImport, { source_id: args.source_id, external_id: args.external_id, started_at: args.started_at });
    const events = sortReplayEvents(parseReplayEvents(args.events));
    const chunks = chunkReplayEvents(events);
    const replay = safeReplayPathSegment(args.external_id);
    const keys: string[] = [];
    for (let seq = 0; seq < chunks.length; seq++) {
      const key = replayChunkKey({ sourceId: String(args.source_id), replay, seq, sha256: await sha256Hex(chunks[seq]) });
      await putChunk(bucket, key, chunks[seq]);
      keys.push(key);
    }
    await ctx.runMutation(internal.replays.saveImported, {
      replay_id: opened.replay_id,
      provider: args.provider,
      chunk_keys: keys,
      started_at: args.started_at,
      user: args.user,
      ...summarize(events, opened.short_id),
    });
    return { ...opened, chunks: keys.length };
  },
});

/** The replay rows a vendor list or import already knows, by external id: named by short id, and whether imported. */
export const importedReplays = internalQuery({
  args: { source_id: v.id("event_sources"), external_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Record<string, { replay_id: Id<"replays">; short_id: string; imported: boolean }> = {};
    for (const id of args.external_ids.slice(0, LIST_MAX)) {
      const row = await findReplay(ctx, args.source_id, id);
      if (row) out[id] = { replay_id: row._id, short_id: row.short_id, imported: row.imported_at !== undefined };
    }
    return out;
  },
});

/**
 * A replay the caller (a web session, or the CLI's api_token) may read, with
 * what importing its vendor recording needs (sources/vendorReplay.ts). A
 * refusal reads like a missing replay.
 */
export const recordingForImport = internalQuery({
  args: { api_token: v.optional(v.string()), replay: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await readableReplay(ctx, userId, args.replay);
    if (!row) notFound("Replay not found");
    return { replay_id: row!._id, short_id: row!.short_id, source_id: row!.source_id, provider: row!.provider, external_id: row!.external_id, imported_at: row!.imported_at ?? null };
  },
});

// ── Reads (web and CLI) ──

/** A list row: never the timeline or the chunk keys. */
function replayView(row: Doc<"replays">, sourceName: string | null) {
  return {
    _id: row._id,
    short_id: row.short_id,
    // The access key, so a client cache enumerates replays through the same
    // workspace boundary as every other row it holds.
    workspace: row.workspace,
    source_id: row.source_id,
    source_name: sourceName,
    provider: row.provider,
    external_id: row.external_id,
    url: row.url ?? null,
    user: row.user ?? null,
    started_at: row.started_at,
    duration_ms: row.duration_ms ?? null,
    counts: row.counts,
    group_ids: row.group_ids,
    chunks: row.chunk_keys.length,
    has_timeline: row.timeline_at !== undefined,
    imported_at: row.imported_at ?? null,
    updated_at: row.updated_at,
  };
}

/** The replay if `userId` holds its workspace, else null: a refusal reads like a missing replay. */
export async function readableReplay(ctx: Db, userId: Id<"users">, ref: string): Promise<Doc<"replays"> | null> {
  return await readableRowByRef(ctx, "replays", userId, ref);
}

const LIST_MAX = 200;
/**
 * How many of a workspace's newest replays a group filter looks through.
 * Rows carry no timeline (replay_timelines) but up to 60 chunk keys and 50
 * group ids, a few KB at worst, so this stays far under a query's read cap.
 * A group's recordings older than this window are not listed.
 */
export const REPLAY_GROUP_SCAN_MAX = 300;

async function listCore(ctx: Db, userId: Id<"users">, workspaceKey: string, opts: { source?: string; limit?: number; group_id?: Id<"event_groups"> }) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), LIST_MAX);
  // The ref every other verb takes (name, src-N or id), refused the same way when unknown.
  const sourceId: Id<"event_sources"> | null = opts.source ? (await sourceByRef(ctx, userId, workspaceKey, opts.source))._id : null;
  // A source is in one workspace, so its own index is exact; the workspace
  // check below still holds every row to the reader's key.
  const indexed = sourceId
    ? ctx.db.query("replays").withIndex("by_source_started", (q: any) => q.eq("source_id", sourceId))
    : ctx.db.query("replays").withIndex("by_workspace_started", (q: any) => q.eq("workspace", workspaceKey));
  const rows: Doc<"replays">[] = await indexed.order("desc").take(opts.group_id ? REPLAY_GROUP_SCAN_MAX : limit);
  const names = new Map<string, string | null>();
  const out = [];
  for (const row of rows) {
    if (row.workspace !== workspaceKey) continue;
    if (opts.group_id && !row.group_ids.includes(opts.group_id)) continue;
    const key = String(row.source_id);
    if (!names.has(key)) names.set(key, (await ctx.db.get(row.source_id))?.name ?? null);
    out.push(replayView(row, names.get(key) ?? null));
    if (out.length >= limit) break;
  }
  return out;
}

async function detailCore(ctx: Db, row: Doc<"replays">) {
  const source = await ctx.db.get(row.source_id);
  const groups = [];
  for (const id of row.group_ids) {
    const g = await ctx.db.get(id);
    if (g) groups.push({ _id: g._id, short_id: g.short_id, kind: g.kind, title: g.title, status: g.status });
  }
  return { ...replayView(row, source?.name ?? null), groups, timeline_md: await readReplayTimeline(ctx, row._id), timeline_at: row.timeline_at ?? null };
}

/** The workspace's newest recordings: the Ops page's replay list and `cast replay ls` (/cli/replays/list). */
export const list = query({
  args: {
    ...scopeArgs,
    source: v.optional(v.string()),
    group_id: v.optional(v.id("event_groups")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    return await listCore(ctx, userId, workspaceKey, args);
  },
});

/** One replay with its linked groups and cached timeline. Chunks are read through the redirect route. */
export const get = query({
  args: { replay: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await readableReplay(ctx, userId, args.replay);
    return row ? await detailCore(ctx, row) : null;
  },
});

/**
 * `cast replay show|repro`: the detail plus the chunk keys, which the
 * /cli/replays/get route swaps for URLs signed at request time
 * (signReplayChunks). Internal so the keys never reach a client unsigned.
 */
export const cliGet = internalQuery({
  args: { api_token: v.string(), replay: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await readableReplay(ctx, userId, args.replay);
    if (!row) notFound("Replay not found");
    return { ...(await detailCore(ctx, row!)), chunk_keys: row!.chunk_keys };
  },
});

/** The route's answer: chunk URLs signed now and short, keys removed. */
export async function signReplayChunks<T extends { chunk_keys: string[] }>(res: T, now: number = Date.now()) {
  const bucket = replaysBucketFromEnv();
  const { chunk_keys, ...rest } = res;
  const chunk_urls: string[] = [];
  if (bucket) for (const key of chunk_keys) chunk_urls.push((await r2FreshGetUrl(bucket, key, now)).url);
  return { ...rest, chunk_urls, server_now: now };
}

/** The object behind one chunk of a replay the user may read, for the redirect route; null otherwise. */
export const chunkObject = internalQuery({
  args: { user_id: v.optional(v.id("users")), api_token: v.optional(v.string()), replay: v.string(), seq: v.number() },
  handler: async (ctx, args): Promise<string | null> => {
    const userId = args.user_id ?? (args.api_token ? (await verifyApiToken(ctx, args.api_token))?.userId : undefined);
    if (!userId) return null;
    const row = await readableReplay(ctx, userId, args.replay);
    return row?.chunk_keys.find((k) => parseReplayChunkKey(k)?.seq === args.seq) ?? null;
  },
});
