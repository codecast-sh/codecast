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
import { v, type ObjectType } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Gunzip, gzipSync, strToU8, strFromU8 } from "fflate";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { notFound, requireUserOrToken } from "./lib/auth";
import { readableRowByRef } from "./lib/rowByRef";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { takeFromWindow } from "./ipRateLimit";
import { nextShortId } from "./counters";
import { countLanded, patchSourceStats } from "./ingest";
import { sha256Hex } from "./lib/hash";
import { readBodyCapped } from "./lib/tokenHttp";
import { ingestUserValidator, replayDomChunkMetaValidator, replayImportRestValidator, replayReadToValidator, replayProviderValidator, replayShapeValidator } from "./ingestSchema";
import {
  parseReplayChunkKey,
  parseReplayDomChunkKey,
  r2FreshGetUrl,
  r2Presign,
  replayChunkKey,
  replayDomChunkKey,
  replaysBucketFromEnv,
  safeReplayPathSegment,
  type R2Bucket,
} from "./lib/r2";
import { REPLAY_LIMITS, VENDOR_CONVERTER_VERSION, VENDOR_REFRESH_WHYS, needsVendorImport, type ReplayEvent, type ReplayProvider } from "@codecast/shared/contracts/replay";
import { INGEST_SHORT_ID_PREFIX, type IngestItem, type SourceProvider } from "@codecast/shared/contracts/ingest";
import { compareReplays, currentTimelineText, exactReplayId, foldRepeatNavs, parseReplayEvents, rageClicksOf, renderTimeline, replayCounts, replayFacets, replayIssues, replayMatches, replayPeople, replayShape, sortPeople, sortReplayEvents, REPLAY_BROWSE_SCAN, REPLAY_ENV_KEYS, REPLAY_HAS, REPLAY_PEOPLE_SORTS, REPLAY_SORTS, SHAPE_VERSION, type ReplayMatch, type ReplayPeopleSort, type RrwebEvent } from "@codecast/shared/replay";
import {
  REPLAY_DOM_LIMITS,
  REPLAY_FRAME_PATH,
  REPLAY_PLAYER_ORIGIN,
  REPLAY_PLAYER_MODES,
  replayDomWindow,
  replayPlayerUrl,
  type ReplayChunkKind,
  type ReplayDomChunkMeta,
  type ReplayPlayerLink,
  type ReplayPlayerManifest,
} from "@codecast/shared/contracts/replayPlayer";
import { mintReplayCap, replayCapKey } from "./lib/replayCap";
import { patchReplay, replayIndexFields, replayIndexStale } from "./lib/replayIndex";

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

/** What an import carries about the DOM capture it stored (storeReplayDom). */
const domArgs = {
  dom_chunk_keys: v.optional(v.array(v.string())),
  dom_bytes: v.optional(v.number()),
  /** The capture's first rrweb timestamp: the epoch the stream's t counts from. */
  dom_t0: v.optional(v.number()),
  /** Each chunk's span and size, parallel to dom_chunk_keys (storeReplayDom). */
  dom_chunk_meta: v.optional(v.array(replayDomChunkMetaValidator)),
};

/** The chunk spans a row keeps, when they still match its keys one for one; else null (the player then reads the capture whole). */
export function domChunkMeta(row: { dom_chunk_keys?: string[]; dom_chunk_meta?: ReplayDomChunkMeta[] }): ReplayDomChunkMeta[] | null {
  const keys = row.dom_chunk_keys ?? [];
  return keys.length > 0 && row.dom_chunk_meta?.length === keys.length ? row.dom_chunk_meta : null;
}

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
  await patchReplay(ctx, row, patch);
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
  kind: ReplayChunkKind = "events",
): Promise<{ ok: true; replay_id: Id<"replays"> } | { ok: false; reason: string }> {
  const max = kind === "dom" ? REPLAY_DOM_LIMITS.max_chunks_per_replay : REPLAY_LIMITS.max_chunks_per_replay;
  if (!Number.isInteger(seq) || seq < 0 || seq >= max) {
    return { ok: false, reason: `seq must be 0 to ${max - 1}` };
  }
  const row = await ensureReplay(ctx, source, externalId, now);
  if (!row) return { ok: false, reason: `this source opened ${REPLAYS_NEW_PER_HOUR} recordings in the last hour; try again later` };
  if (kind === "dom") {
    // The capture the player plays: listed apart from the stream, so the
    // assembly (which reads chunk_keys) never sees it.
    const dom = row.dom_chunk_keys ?? [];
    if (dom.includes(key)) return { ok: true, replay_id: row._id };
    const next = dom.filter((k) => parseReplayDomChunkKey(k)?.seq !== seq);
    next.push(key);
    next.sort((a, b) => (parseReplayDomChunkKey(a)?.seq ?? 0) - (parseReplayDomChunkKey(b)?.seq ?? 0));
    await ctx.db.patch(row._id, { dom_chunk_keys: next, updated_at: now });
    return { ok: true, replay_id: row._id };
  }
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
  args: { source_id: v.id("event_sources"), replay_external_id: v.string(), seq: v.number(), key: v.string(), kind: v.optional(v.union(v.literal("events"), v.literal("dom"))) },
  handler: async (ctx, args) => recordReplayChunk(ctx, await sourceOrThrow(ctx, args.source_id), args.replay_external_id, args.seq, args.key, Date.now(), args.kind ?? "events"),
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
 *
 * `serverWritten` is for a recording this backend stored itself (a vendor
 * import): chunks put before putChunk stopped marking them gzip come back
 * inflated by fetch, so their bytes cannot hash to the key, and plain JSON is
 * taken as is. An uploader's chunk is always held to its hash.
 */
export async function readReplayChunks(bucket: R2Bucket, keys: readonly string[], opts: { serverWritten?: boolean } = {}): Promise<{ events: ReplayEvent[]; skipped: number }> {
  const events: ReplayEvent[] = [];
  let skipped = 0;
  for (const key of keys) {
    const res = await fetch(await r2Presign(bucket, "GET", key, REPLAY_LIMITS.signed_url_ttl_s));
    const bytes = res.ok ? await readBodyCapped(res, REPLAY_LIMITS.chunk_max_bytes) : null;
    if (!res.ok) await res.body?.cancel().catch(() => {});
    const want = parseReplayChunkKey(key)?.sha256;
    const inflatedByFetch = !!bytes && opts.serverWritten === true && !isGzip(bytes);
    if (!bytes || (want && !inflatedByFetch && (await sha256Hex(bytes)) !== want)) {
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
  return { events: foldRepeatNavs(sortReplayEvents(events)), skipped };
}

/**
 * The summary's length run to where the capture ends, when it ends after the
 * last event. Both count from the stream's first event, the replay clock's
 * zero (dom_t0), so the row, the list and the player agree on one length.
 */
export function withCaptureLength<S extends { duration_ms: number; first_t: number }>(summary: S, captureEndT: number | undefined): S {
  if (captureEndT === undefined) return summary;
  return { ...summary, duration_ms: Math.max(summary.duration_ms, Math.round(captureEndT - summary.first_t)) };
}

/** What a stream says about its recording: the cached timeline and the recounted manifest fields. */
function summarize(events: ReplayEvent[], shortId: string) {
  const first = events[0]?.t ?? 0;
  const last = events[events.length - 1]?.t ?? 0;
  return {
    timeline_md: renderTimeline(events, { title: shortId }),
    counts: replayCounts(events),
    shape: replayShape(events),
    duration_ms: Math.max(0, last - first),
    url: events.find((e) => e.type === "nav")?.url,
    first_t: first,
  };
}

/**
 * The walls a stream shows (shared/replay/issues.ts) folded into the source's
 * replay_issue groups (ingest.recordReplayIssues). Run after the stream is
 * saved, by every action that reads one: assembly, a vendor import, a regroup.
 */
export async function applyIssues(ctx: { runMutation: any }, replayId: Id<"replays">, provider: ReplayProvider, events: ReplayEvent[], startUrl: string | undefined) {
  // Our recorder's t counts from started_at; a vendor stream's from its first event (as dom_t0 reads it).
  const issues = replayIssues(events, startUrl, provider === "sdk" ? 0 : events[0]?.t ?? 0);
  if (!issues.length) return { groups: 0, transitions: 0 };
  return await ctx.runMutation(internal.ingest.applyReplayIssues, { replay_id: replayId, issues_json: JSON.stringify(issues) });
}

/** The one write of a replay's cached timeline, in its own table so list reads never carry it. */
export async function writeReplayTimeline(ctx: Db, replayId: Id<"replays">, timelineMd: string, now: number): Promise<void> {
  const existing = await ctx.db.query("replay_timelines").withIndex("by_replay", (q: any) => q.eq("replay_id", replayId)).first();
  if (existing) await ctx.db.patch(existing._id, { timeline_md: timelineMd, updated_at: now });
  else await ctx.db.insert("replay_timelines", { replay_id: replayId, timeline_md: timelineMd, updated_at: now });
}

async function readReplayTimeline(ctx: Db, replayId: Id<"replays">): Promise<string | null> {
  const row = await ctx.db.query("replay_timelines").withIndex("by_replay", (q: any) => q.eq("replay_id", replayId)).first();
  return row ? currentTimelineText(row.timeline_md) : null;
}

export const assemblyInputs = internalQuery({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    return row ? { short_id: row.short_id, chunk_keys: row.chunk_keys, url: row.url, provider: row.provider } : null;
  },
});

export const saveSummary = internalMutation({
  args: {
    replay_id: v.id("replays"),
    chunk_keys: v.array(v.string()),
    timeline_md: v.string(),
    counts: v.object({ clicks: v.number(), errors: v.number(), failed_requests: v.number() }),
    shape: v.optional(replayShapeValidator),
    duration_ms: v.number(),
    url: v.optional(v.string()),
    /** Chunks the assembly could not read (readReplayChunks). */
    skipped: v.optional(v.number()),
    /** The stream's first event t: with started_at, where the replay clock's zero falls (dom_t0). */
    first_t: v.optional(v.number()),
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
    await patchReplay(ctx, row, {
      timeline_at: pending ? Math.max(0, (row.chunks_at ?? now) - 1) : now,
      ...(pending ? { assemble_at: undefined } : {}),
      counts: args.counts,
      ...(args.shape ? { shape: args.shape } : {}),
      // The vendor's own length is a floor: a capture cut at a size cap or a page left open runs longer than its events.
      duration_ms: Math.max(args.duration_ms, row.facts?.length_ms ?? 0),
      ...(row.url || !args.url ? {} : { url: args.url }),
      // Our recorder's t counts from started_at, and the replay clock from
      // the stream's first event, so that event's wall clock is the zero the
      // player maps the DOM capture against.
      ...(row.provider === "sdk" && args.first_t !== undefined ? { dom_t0: row.started_at + args.first_t } : {}),
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
    const summary = summarize(events, input.short_id);
    await ctx.runMutation(internal.replays.saveSummary, { replay_id: args.replay_id, chunk_keys: input.chunk_keys, skipped, ...summary });
    await applyIssues(ctx, args.replay_id, input.provider, events, input.url ?? summary.url);
    return { events: events.length, skipped };
  },
});

// ── The list shape of recordings stored before it existed ──

/** One page of the table: the recordings that have a stream but no shape yet. */
export const shapelessPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("replays").paginate({ cursor: args.cursor, numItems: 100 });
    return {
      // No shape yet, or one an older replayShape wrote (SHAPE_VERSION).
      rows: page.page.filter((r) => (!r.shape || r.shape.v < SHAPE_VERSION) && r.chunk_keys.length > 0).map((r) => ({ replay_id: r._id, chunk_keys: r.chunk_keys, provider: r.provider })),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

/** A shape read from the chunks a row still lists; a row whose chunks changed meanwhile gets its own from that assembly. */
export const saveShape = internalMutation({
  args: { replay_id: v.id("replays"), chunk_keys: v.array(v.string()), shape: replayShapeValidator },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row || (row.shape && row.shape.v >= args.shape.v) || row.chunk_keys.join("\n") !== args.chunk_keys.join("\n")) return;
    await ctx.db.patch(row._id, { shape: args.shape, updated_at: Date.now() });
  },
});

/**
 * Give every stored recording its list shape (activity strip, failure marks,
 * rage clicks, active time) by reading its own chunks from R2: the vendor is
 * never asked. A page at a time, each page scheduling the next. Run once
 * after deploying the shape: `npx convex run replays:shapeBackfill '{}'`.
 */
export const shapeBackfill = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ shaped: number; done: boolean }> => {
    const bucket = replaysBucketFromEnv();
    if (!bucket) return { shaped: 0, done: true };
    const page = await ctx.runQuery(internal.replays.shapelessPage, { cursor: args.cursor ?? null });
    let shaped = 0;
    for (const row of page.rows) {
      try {
        // A vendor import's older chunks come back inflated by fetch and cannot hash to their key (readReplayChunks).
        const { events } = await readReplayChunks(bucket, row.chunk_keys, { serverWritten: row.provider !== "sdk" });
        if (!events.length) continue;
        await ctx.runMutation(internal.replays.saveShape, { replay_id: row.replay_id, chunk_keys: row.chunk_keys, shape: replayShape(events) });
        shaped++;
      } catch (err) {
        console.warn(`replay shape for ${row.replay_id} not read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!page.done) await ctx.scheduler.runAfter(0, internal.replays.shapeBackfill, { cursor: page.cursor });
    return { shaped, done: page.done };
  },
});

// ── The length of recordings that ran past their last event ──

/** What reading a row's capture length needs: its last DOM chunk and where its clock starts. Null without a capture. */
function captureInput(r: Doc<"replays">) {
  if (!(r.dom_chunk_keys?.length ?? 0) || r.dom_t0 === undefined) return null;
  return { replay_id: r._id, last_key: r.dom_chunk_keys![r.dom_chunk_keys!.length - 1], dom_t0: r.dom_t0, duration_ms: r.duration_ms ?? 0, captured_ms: r.captured_ms };
}

/** Read one capture's length and keep it when longer (saveCaptureLength). */
async function lengthenFromCapture(ctx: { runMutation: any }, bucket: R2Bucket, row: NonNullable<ReturnType<typeof captureInput>>): Promise<boolean> {
  const last = await lastCaptureTimestamp(bucket, row.last_key);
  if (last === null) return false;
  const length = Math.round(last - row.dom_t0);
  if (length <= row.duration_ms + 1000 && row.captured_ms !== undefined) return false;
  await ctx.runMutation(internal.replays.saveCaptureLength, { replay_id: row.replay_id, last_key: row.last_key, duration_ms: length });
  return length > row.duration_ms + 1000;
}

/** One page of the table: recordings with a page capture, the key of its last chunk and where its clock starts. */
export const capturedPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), unknown_only: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("replays").paginate({ cursor: args.cursor, numItems: 25 });
    return {
      rows: page.page.map(captureInput).filter((r): r is NonNullable<typeof r> => !!r && (!args.unknown_only || r.captured_ms === undefined)),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

/** A longer length read off the capture a row still keeps; never shortens one. */
export const saveCaptureLength = internalMutation({
  args: { replay_id: v.id("replays"), last_key: v.string(), duration_ms: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    const keys = row?.dom_chunk_keys ?? [];
    if (!row || keys[keys.length - 1] !== args.last_key) return;
    // How far the capture reaches is kept either way (the stream's own end can run later); the length only ever grows.
    const captured = Math.max(args.duration_ms, row.captured_ms ?? 0);
    const longer = args.duration_ms > (row.duration_ms ?? 0);
    if (!longer && captured === row.captured_ms) return;
    await patchReplay(ctx, row, { captured_ms: captured, ...(longer ? { duration_ms: args.duration_ms } : {}), updated_at: Date.now() });
  },
});

/** The newest rrweb timestamp in one stored DOM chunk, or null when it cannot be read. */
export async function lastCaptureTimestamp(bucket: R2Bucket, key: string): Promise<number | null> {
  const span = await readDomChunkSpan(bucket, key);
  return span && span.last > 0 ? span.last : null;
}

/** One stored DOM chunk's rrweb events and JSON size, read back from R2; null when it cannot be read. */
export async function readDomChunkEvents(bucket: R2Bucket, key: string): Promise<{ events: any[]; raw: number } | null> {
  const res = await fetch(await r2Presign(bucket, "GET", key, REPLAY_LIMITS.signed_url_ttl_s));
  const bytes = res.ok ? await readBodyCapped(res, REPLAY_DOM_LIMITS.chunk_max_bytes) : null;
  if (!res.ok) await res.body?.cancel().catch(() => {});
  if (!bytes) return null;
  const json = isGzip(bytes) ? gunzipCapped(bytes, REPLAY_DOM_LIMITS.chunk_max_inflated_bytes) : bytes;
  if (!json) return null;
  try {
    const events = JSON.parse(strFromU8(json));
    return { events: Array.isArray(events) ? events : [], raw: json.length };
  } catch {
    return null;
  }
}

/** One stored DOM chunk's span (spanOf), read back from R2; null when it cannot be read. */
export async function readDomChunkSpan(bucket: R2Bucket, key: string): Promise<ReplayDomChunkMeta | null> {
  const chunk = await readDomChunkEvents(bucket, key);
  if (!chunk) return null;
  const marks = chunk.events.map((e: any) => ({ t: typeof e?.timestamp === "number" ? e.timestamp : NaN, full: e?.type === 2 }));
  return spanOf(marks, chunk.raw);
}

// ── Chunk spans for long captures (the player's window, replayDomWindow) ──

/** What reading a row's chunk spans needs, or null when it needs none (short, or spans already kept). */
function spanInput(r: Doc<"replays">) {
  const keys = r.dom_chunk_keys ?? [];
  const known = r.dom_chunk_meta ?? [];
  if (keys.length < REPLAY_DOM_LIMITS.window_min_chunks || known.length >= keys.length) return null;
  return { replay_id: r._id, keys, known };
}

export const spanRow = internalQuery({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    return row ? spanInput(row) : null;
  },
});

/** One page of the table: the long captures whose spans are not kept. */
export const spanPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("replays").paginate({ cursor: args.cursor, numItems: 50 });
    return { ids: page.page.filter((r) => !!spanInput(r)).map((r) => r._id), cursor: page.continueCursor, done: page.isDone };
  },
});

/** Keep the spans read for a row's leading chunks, while those are still its first keys (a long recording's rest may have added more since). */
export const saveDomSpans = internalMutation({
  args: { replay_id: v.id("replays"), keys: v.array(v.string()), meta: v.array(replayDomChunkMetaValidator) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    const keys = row?.dom_chunk_keys ?? [];
    if (!row || args.meta.length !== args.keys.length || keys.slice(0, args.keys.length).join("\n") !== args.keys.join("\n")) return false;
    if ((row.dom_chunk_meta?.length ?? 0) >= args.meta.length) return true;
    await ctx.db.patch(row._id, { dom_chunk_meta: args.meta });
    return true;
  },
});

/**
 * Read a long capture's chunks one at a time and keep each one's span, so the
 * player can open it a stretch at a time. A capture imported before spans
 * were kept plays whole until this has run; playerLink queues it on open.
 */
export const domMetaOne = internalAction({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args): Promise<boolean> => {
    const bucket = replaysBucketFromEnv();
    const row = await ctx.runQuery(internal.replays.spanRow, { replay_id: args.replay_id });
    if (!bucket || !row) return false;
    // Only the chunks past the spans already kept: a long recording's rest adds chunks while this reads.
    const meta: ReplayDomChunkMeta[] = [...row.known];
    for (const key of row.keys.slice(meta.length)) {
      const span = await readDomChunkSpan(bucket, key);
      // An unreadable chunk ends the spans here; the player reads the capture whole and says so if it cannot.
      if (!span) break;
      meta.push(span);
    }
    if (meta.length === row.known.length) return false;
    return await ctx.runMutation(internal.replays.saveDomSpans, { replay_id: args.replay_id, keys: row.keys.slice(0, meta.length), meta });
  },
});

/** Keep the spans of every long capture: `packages/convex/run.sh replays:domMetaBackfill '{}'`. A page at a time, each row its own action. */
export const domMetaBackfill = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ queued: number; done: boolean }> => {
    const page = await ctx.runQuery(internal.replays.spanPage, { cursor: args.cursor ?? null });
    for (let i = 0; i < page.ids.length; i++) await ctx.scheduler.runAfter(i * 20_000, internal.replays.domMetaOne, { replay_id: page.ids[i] });
    if (!page.done) await ctx.scheduler.runAfter(page.ids.length * 20_000, internal.replays.domMetaBackfill, { cursor: page.cursor });
    return { queued: page.ids.length, done: page.done };
  },
});

/**
 * Run every recording's length to the end of its page capture, for rows
 * imported before the import did (withCaptureLength): a page left open after
 * the last thing a person did was cut at that last event, so a five minute
 * PostHog recording with one navigation read as no length at all. Reads only
 * the last DOM chunk of each. A page at a time, each scheduling the next:
 * `packages/convex/run.sh replays:captureLengthBackfill '{}'`.
 */
export const captureLengthBackfill = internalAction({
  /** unknown_only: just the copies whose reach was never stored, so the list can mark the ones cut short. */
  args: { cursor: v.optional(v.union(v.string(), v.null())), unknown_only: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ lengthened: number; done: boolean }> => {
    const bucket = replaysBucketFromEnv();
    if (!bucket) return { lengthened: 0, done: true };
    const page = await ctx.runQuery(internal.replays.capturedPage, { cursor: args.cursor ?? null, ...(args.unknown_only ? { unknown_only: true } : {}) });
    let lengthened = 0;
    for (const row of page.rows) {
      try {
        if (await lengthenFromCapture(ctx, bucket, row)) lengthened++;
      } catch (err) {
        console.warn(`replay length for ${row.replay_id} not read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!page.done) await ctx.scheduler.runAfter(0, internal.replays.captureLengthBackfill, { cursor: page.cursor, ...(args.unknown_only ? { unknown_only: true } : {}) });
    return { lengthened, done: page.done };
  },
});

/** The capture input of one row, for checkCaptureLength. */
export const captureRow = internalQuery({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    return row ? captureInput(row) : null;
  },
});

/** One recording's length run to the end of its capture (checkCaptureLength). */
export const captureLengthOne = internalAction({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args): Promise<boolean> => {
    const bucket = replaysBucketFromEnv();
    const row = await ctx.runQuery(internal.replays.captureRow, { replay_id: args.replay_id });
    if (!bucket || !row) return false;
    return await lengthenFromCapture(ctx, bucket, row);
  },
});

/**
 * The player found the capture running past the stored length: read the
 * capture's last chunk on the server and keep the longer length, so the list,
 * the header and the person's recordings agree with the player. The page's
 * number is never stored; only what the capture itself says.
 */
export const checkCaptureLength = mutation({
  args: { replay: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { queued: false };
    const row = await readableReplay(ctx, userId, args.replay);
    if (!row || !captureInput(row)) return { queued: false };
    await ctx.scheduler.runAfter(0, internal.replays.captureLengthOne, { replay_id: row._id });
    return { queued: true };
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

/** PUT one chunk unless an object with its key (and so its content) is already there. Moment bodies use it too (moments.ts). */
export async function putChunk(bucket: R2Bucket, key: string, body: Uint8Array): Promise<void> {
  const head = await fetch(await r2Presign(bucket, "HEAD", key, REPLAY_LIMITS.signed_url_ttl_s), { method: "HEAD" });
  if (head.ok) return;
  const res = await fetch(await r2Presign(bucket, "PUT", key, REPLAY_LIMITS.signed_url_ttl_s), {
    method: "PUT",
    body: body as unknown as BodyInit,
    // No Content-Encoding, as the SDK uploads (platform analytics replay.ts):
    // the object is these exact bytes and its key names their sha256. Marked
    // gzip, every fetch hands it back inflated and the hash no longer matches.
    // Every reader unzips gzip bytes itself.
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`R2 put of ${key} answered ${res.status}`);
}

/**
 * A DOM capture as gzipped chunks, produced one at a time: events packed
 * until their JSON passes chunk_target_raw_bytes, each event serialized once.
 * A chunk that gzips past chunk_max_bytes is halved; a single event past it
 * (a page too heavy to keep) comes out as "dropped". The import runs in the
 * default runtime's 64 MiB beside the parsed recording, so a caller that
 * uploads each chunk as it comes holds one chunk's text and bytes at a time.
 */
export function* domChunkStream(events: readonly RrwebEvent[]): Generator<{ gz: Uint8Array; meta: ReplayDomChunkMeta } | "dropped"> {
  type Part = { json: string; t: number; full: boolean };
  function* pack(parts: Part[]): Generator<{ gz: Uint8Array; meta: ReplayDomChunkMeta } | "dropped"> {
    if (!parts.length) return;
    const text = `[${parts.map((p) => p.json).join(",")}]`;
    const gz = gzipSync(strToU8(text));
    if (gz.length <= REPLAY_DOM_LIMITS.chunk_max_bytes) {
      yield { gz, meta: spanOf(parts, text.length) };
      return;
    }
    if (parts.length === 1) {
      yield "dropped";
      return;
    }
    const half = Math.ceil(parts.length / 2);
    yield* pack(parts.slice(0, half));
    yield* pack(parts.slice(half));
  }
  let parts: Part[] = [];
  let raw = 0;
  for (const event of events) {
    const json = JSON.stringify(event);
    parts.push({ json, t: typeof event.timestamp === "number" ? event.timestamp : 0, full: event.type === 2 });
    raw += json.length + 1;
    if (raw >= REPLAY_DOM_LIMITS.chunk_target_raw_bytes) {
      yield* pack(parts);
      parts = [];
      raw = 0;
    }
  }
  yield* pack(parts);
}

/** One chunk's span: its first and last timestamps, its first full snapshot's, and its JSON size. */
export function spanOf(events: readonly { t: number; full: boolean }[], raw: number): ReplayDomChunkMeta {
  let first = Infinity;
  let last = -Infinity;
  let full: number | undefined;
  for (const e of events) {
    if (!Number.isFinite(e.t) || e.t <= 0) continue;
    if (e.t < first) first = e.t;
    if (e.t > last) last = e.t;
    if (e.full && (full === undefined || e.t < full)) full = e.t;
  }
  if (first === Infinity) first = last = 0;
  return { first, last, ...(full !== undefined ? { full } : {}), raw };
}

/** Every chunk of a capture at once (domChunkStream), held to max_chunks_per_replay; chunks past it count as dropped. */
export function chunkDomEvents(events: readonly RrwebEvent[]): { chunks: Uint8Array[]; dropped: number } {
  const chunks: Uint8Array[] = [];
  let dropped = 0;
  for (const c of domChunkStream(events)) {
    if (c === "dropped" || chunks.length >= REPLAY_DOM_LIMITS.max_chunks_per_replay) dropped++;
    else chunks.push(c.gz);
  }
  return { chunks, dropped };
}

/**
 * Store a recording's DOM capture (already masked, prepareDomCapture) beside
 * its stream: content addressed under the recording's `dom/` prefix, so a
 * re-import uploads only what changed. Each chunk is uploaded as it is
 * packed, and packing stops at max_chunks_per_replay (the rest of a capture
 * that long is not kept). Answers what saveImported records.
 */
export async function storeReplayDom(
  bucket: R2Bucket,
  /** first_seq: where a later part of a long recording continues the numbering (sources/replayRest.ts). */
  input: { source_id: string; external_id: string; events: readonly RrwebEvent[]; first_seq?: number },
): Promise<{ dom_chunk_keys: string[]; dom_chunk_meta: ReplayDomChunkMeta[]; dom_bytes: number; dom_t0: number; dropped: number }> {
  const replay = safeReplayPathSegment(input.external_id);
  const first = input.first_seq ?? 0;
  const keys: string[] = [];
  const meta: ReplayDomChunkMeta[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const chunk of domChunkStream(input.events)) {
    if (chunk === "dropped") {
      dropped++;
      continue;
    }
    if (first + keys.length >= REPLAY_DOM_LIMITS.max_chunks_per_replay) {
      dropped++;
      break;
    }
    const key = replayDomChunkKey({ sourceId: input.source_id, replay, seq: first + keys.length, sha256: await sha256Hex(chunk.gz) });
    await putChunk(bucket, key, chunk.gz);
    keys.push(key);
    meta.push(chunk.meta);
    bytes += chunk.gz.length;
  }
  return { dom_chunk_keys: keys, dom_chunk_meta: meta, dom_bytes: bytes, dom_t0: input.events[0]?.timestamp ?? 0, dropped };
}

/** Open (or find) the row an import fills, so its short id can head the timeline. */
export const openImport = internalMutation({
  args: { source_id: v.id("event_sources"), external_id: v.string(), started_at: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ replay_id: Id<"replays">; short_id: string }> => {
    const source = await sourceOrThrow(ctx, args.source_id);
    const known = await findReplay(ctx, source._id, args.external_id);
    const row = known ?? (await ensureReplay(ctx, source, args.external_id, args.started_at ?? Date.now(), { capped: false }))!;
    // A recording new to codecast is part of what the source sent, on the day it was recorded (ingest countLanded).
    if (!known) await patchSourceStats(ctx, source, (s) => countLanded(s, [{ at: row.started_at, n: 1 }], Date.now()));
    return { replay_id: row._id, short_id: row.short_id };
  },
});

/**
 * A fresh read (not a later part of the row's own chain) that would replace a
 * current copy with less of the recording: what a recording PostHog keeps
 * writing hands a read from its start, while the copy already holds an hour
 * of it. The copy stays; the rest is read on from where it stopped
 * (sources/replayRest.ts resume). A copy by an older converter is replaced,
 * since that is what the refresh is for.
 */
export function importShrinks(
  row: { imported_at?: number; converter_version?: number; captured_ms?: number; dom_chunk_keys?: string[] },
  incoming: { duration_ms: number; dom_chunk_keys?: string[] },
): boolean {
  if (!row.imported_at || (row.converter_version ?? 1) !== VENDOR_CONVERTER_VERSION) return false;
  const lessTime = (row.captured_ms ?? 0) > incoming.duration_ms + 1000;
  const lessCapture = (row.dom_chunk_keys?.length ?? 0) > (incoming.dom_chunk_keys?.length ?? 0);
  return lessTime && lessCapture;
}

export const saveImported = internalMutation({
  args: {
    replay_id: v.id("replays"),
    provider: replayProviderValidator,
    chunk_keys: v.array(v.string()),
    timeline_md: v.string(),
    counts: v.object({ clicks: v.number(), errors: v.number(), failed_requests: v.number() }),
    shape: v.optional(replayShapeValidator),
    duration_ms: v.number(),
    url: v.optional(v.string()),
    started_at: v.optional(v.number()),
    user: v.optional(ingestUserValidator),
    ...domArgs,
    first_t: v.optional(v.number()),
    /** The length the vendor reports (PostHog recording_duration): a floor under the stream's own. */
    vendor_length_ms: v.optional(v.number()),
    /** Where a long recording's later parts stand (sources/replayRest.ts); absent clears it. */
    import_rest: v.optional(replayImportRestValidator),
    /** A later part saves only while its chain is the row's own: a newer import started another. */
    expect_gen: v.optional(v.number()),
    /** The read got everything the vendor holds: the copy reaches the recording's end, though its events stop sooner (a tab left idle records nothing). */
    whole: v.optional(v.boolean()),
    /** Where this read stopped, so a later read goes on from there (replays.read_to); absent clears it. */
    read_to: v.optional(replayReadToValidator),
  },
  handler: async (ctx, args): Promise<{ saved: boolean }> => {
    const now = Date.now();
    const row = await ctx.db.get(args.replay_id);
    if (args.expect_gen !== undefined && row?.import_rest?.gen !== args.expect_gen) return { saved: false };
    if (args.expect_gen === undefined && row && importShrinks(row, args)) return { saved: false };
    if (!row) return { saved: false };
    await writeReplayTimeline(ctx, args.replay_id, args.timeline_md, now);
    await patchReplay(ctx, row, {
      provider: args.provider,
      chunk_keys: args.chunk_keys,
      chunks_at: now,
      timeline_at: now,
      imported_at: now,
      converter_version: VENDOR_CONVERTER_VERSION,
      vendor_refresh_after: undefined,
      vendor_refresh_why: undefined,
      counts: args.counts,
      ...(args.shape ? { shape: args.shape } : {}),
      duration_ms: Math.max(args.duration_ms, args.vendor_length_ms ?? 0, row?.facts?.length_ms ?? 0),
      captured_ms: args.whole ? Math.max(args.duration_ms, args.vendor_length_ms ?? 0, row?.facts?.length_ms ?? 0) : args.duration_ms,
      ...(args.vendor_length_ms ? { facts: { ...(row?.facts ?? { at: now }), length_ms: args.vendor_length_ms } } : {}),
      ...(args.url ? { url: args.url } : {}),
      ...(args.user ? { user: args.user } : {}),
      ...(args.started_at ? { started_at: args.started_at } : {}),
      // A re-import replaces the capture too: a copy whose read kept none
      // (an unplayable capture) must not keep an older one's keys.
      dom_chunk_keys: args.dom_chunk_keys ?? [],
      // The spans of the leading chunks are kept even when later ones are not known yet (domMetaOne reads only the rest); readers use them once they cover every key.
      dom_chunk_meta: args.dom_chunk_meta && args.dom_chunk_meta.length <= (args.dom_chunk_keys ?? []).length ? args.dom_chunk_meta : undefined,
      dom_bytes: args.dom_bytes ?? 0,
      ...(args.dom_t0 !== undefined ? { dom_t0: args.dom_t0 + (args.first_t ?? 0) } : {}),
      import_rest: args.import_rest,
      read_to: args.read_to,
      updated_at: now,
    });
    return { saved: true };
  },
});

/**
 * A vendor recording, already converted (fromRrweb), stored the way our own
 * recordings are: chunks in R2 under the source, a manifest row, and the
 * timeline cached. Idempotent: the chunks are content addressed and the row
 * is keyed by the source's external id, so a second import uploads nothing
 * that is already there.
 */
const importExternalArgs = {
    source_id: v.id("event_sources"),
    provider: replayProviderValidator,
    external_id: v.string(),
    events: v.any(),
    started_at: v.optional(v.number()),
    user: v.optional(ingestUserValidator),
    ...domArgs,
    /** Where the capture ends on the events' base (VendorCapture.end_t): a page left open runs past the last event. */
    capture_end_t: v.optional(v.number()),
    /** The vendor's own length for the recording, kept as a floor (saveImported). */
    vendor_length_ms: v.optional(v.number()),
    /** A later part of a long recording (sources/replayRest.ts): the chain's state, saved only while `expect_gen` is the row's chain. */
    import_rest: v.optional(replayImportRestValidator),
    expect_gen: v.optional(v.number()),
    /** Nothing of the vendor's recording was left unread (saveImported). */
    whole: v.optional(v.boolean()),
    /** Where this read stopped (saveImported). */
    read_to: v.optional(replayReadToValidator),
};

/**
 * The import itself, for an action that already holds the events: the chain
 * reading a long recording's rest calls this in place, because passing a
 * long stream through runAction meets Convex's 8192 element cap on an
 * argument array (an eight hour recording has more events than that).
 */
export async function importExternalCore(ctx: { runMutation: any }, args: ObjectType<typeof importExternalArgs>): Promise<{ replay_id: Id<"replays">; short_id: string; chunks: number; saved: boolean }> {
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
    const { saved } = await ctx.runMutation(internal.replays.saveImported, {
      replay_id: opened.replay_id,
      provider: args.provider,
      chunk_keys: keys,
      started_at: args.started_at,
      user: args.user,
      ...(args.dom_chunk_keys ? { dom_chunk_keys: args.dom_chunk_keys, dom_bytes: args.dom_bytes, dom_t0: args.dom_t0, ...(args.dom_chunk_meta ? { dom_chunk_meta: args.dom_chunk_meta } : {}) } : {}),
      ...(args.vendor_length_ms ? { vendor_length_ms: args.vendor_length_ms } : {}),
      ...(args.import_rest ? { import_rest: args.import_rest } : {}),
      ...(args.expect_gen !== undefined ? { expect_gen: args.expect_gen } : {}),
      ...(args.whole ? { whole: true } : {}),
      ...(args.read_to ? { read_to: args.read_to } : {}),
      ...withCaptureLength(summarize(events, opened.short_id), args.capture_end_t),
    });
    if (saved) await applyIssues(ctx, opened.replay_id, args.provider, events, events.find((e) => e.type === "nav")?.url);
    return { ...opened, chunks: keys.length, saved };
}

export const importExternal = internalAction({
  args: importExternalArgs,
  handler: async (ctx, args) => await importExternalCore(ctx, args),
});

/** The replay rows a vendor list or import already knows, by external id: named by short id, and whether imported. */
export const importedReplays = internalQuery({
  args: { source_id: v.id("event_sources"), external_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Record<string, { replay_id: Id<"replays">; short_id: string; imported: boolean }> = {};
    for (const id of args.external_ids.slice(0, LIST_MAX)) {
      const row = await findReplay(ctx, args.source_id, id);
      if (row) out[id] = { replay_id: row._id, short_id: row.short_id, imported: !needsVendorImport(row) };
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
    return { replay_id: row!._id, short_id: row!.short_id, source_id: row!.source_id, provider: row!.provider, external_id: row!.external_id, imported_at: row!.imported_at ?? null, converter_version: row!.converter_version ?? null, vendor_refresh_after: row!.vendor_refresh_after ?? null, captured_ms: row!.captured_ms ?? null, duration_ms: row!.duration_ms ?? null, import_rest: row!.import_rest ?? null, vendor_refresh_why: row!.vendor_refresh_why ?? null };
  },
});

/** A refresh of an older copy failed: hold off asking the vendor again until `retry_at`. The copy keeps serving. */
export const deferVendorRefresh = internalMutation({
  args: { replay_id: v.id("replays"), retry_at: v.number(), why: v.optional(v.union(...VENDOR_REFRESH_WHYS.map((w) => v.literal(w)))) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.replay_id, { vendor_refresh_after: args.retry_at, vendor_refresh_why: args.why, updated_at: Date.now() });
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
    /** Activity, failures, rage clicks and active time (shared/replay/list.ts); null until the stream is read. */
    shape: row.shape ?? null,
    /** What the vendor says of it: length, activity, browser, OS, device, country, referrer (shared/replay/list.ts ReplayFacts). */
    facts: row.facts ?? null,
    group_ids: row.group_ids,
    chunks: row.chunk_keys.length,
    /** DOM chunks: the capture the player plays. 0 means the replay reads as text only. */
    dom_chunks: row.dom_chunk_keys?.length ?? 0,
    dom_bytes: row.dom_bytes ?? null,
    /** How far an imported copy reaches; below duration_ms when the import stopped short of the vendor's recording. Null when unknown. */
    captured_ms: row.captured_ms ?? null,
    /** A long recording's later parts being read (sources/replayRest.ts): how far, and whether it waits or failed. Null when none runs. */
    import_rest: row.import_rest ? { next_blob: row.import_rest.next_blob, blobs: row.import_rest.blobs, retry_at: row.import_rest.retry_at ?? null, error: row.import_rest.error ?? null, updated_at: row.import_rest.updated_at } : null,
    has_timeline: row.timeline_at !== undefined,
    imported_at: row.imported_at ?? null,
    converter_version: row.converter_version ?? null,
    vendor_refresh_after: row.vendor_refresh_after ?? null,
    /** Why the vendor is waited out until then (shared VENDOR_REFRESH_WHYS). */
    vendor_refresh_why: row.vendor_refresh_why ?? null,
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

/**
 * How many of a workspace's (or a source's) newest recordings a browse reads.
 * A row is a few KB at worst (chunk keys, group ids, the shape), so this stays
 * well inside a query's read cap; past it the total says "at least".
 */
export const REPLAY_BROWSE_SCAN_MAX = REPLAY_BROWSE_SCAN;
const BROWSE_PAGE_MAX = 500;
/** People a grouped browse answers by default, and the most a page of them may ask for. */
const BROWSE_PEOPLE_MAX = 200;
const BROWSE_PEOPLE_LIMIT_MAX = 2000;

/**
 * The replay list as a person browses it: the recordings that match a filter
 * (shared/replay/list.ts replayMatches), in the sort they asked for, the first
 * `limit` of them, and how many match in all. The filter runs over the
 * newest REPLAY_BROWSE_SCAN_MAX recordings of the scope (a date filter
 * narrows the scan by the index first), so search, toggles and sorts reach
 * past any one page. `people` also folds the matches by person.
 */
export async function browseCore(
  ctx: Db,
  userId: Id<"users">,
  workspaceKey: string,
  opts: ReplayMatch & { source?: string; sort?: string; limit?: number; people?: boolean; people_sort?: string; people_limit?: number; identified?: boolean },
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), BROWSE_PAGE_MAX);
  const sourceId: Id<"event_sources"> | null = opts.source ? (await sourceByRef(ctx, userId, workspaceKey, opts.source))._id : null;
  const since = opts.since;
  const indexed = sourceId
    ? ctx.db.query("replays").withIndex("by_source_started", (q: any) => (since !== undefined ? q.eq("source_id", sourceId).gte("started_at", since) : q.eq("source_id", sourceId)))
    : ctx.db.query("replays").withIndex("by_workspace_started", (q: any) => (since !== undefined ? q.eq("workspace", workspaceKey).gte("started_at", since) : q.eq("workspace", workspaceKey)));
  // A search for one recording's id reads that recording by its index, however old: the scan would miss one past the newest REPLAY_BROWSE_SCAN_MAX.
  const exact = exactReplayId(opts.q);
  const named = exact ? await ctx.db.query("replays").withIndex("by_short_id", (q: any) => q.eq("short_id", exact)).first() : null;
  // One person's recordings, or the partly imported ones, are read by their own index (lib/replayIndex.ts), so the count the person card and the import line print is the list's exact count, however old the rows.
  const range = (q: any) => (since !== undefined ? q.gte("started_at", since) : q);
  const byPerson = !exact && opts.person
    ? sourceId
      ? ctx.db.query("replays").withIndex("by_source_person", (q: any) => range(q.eq("source_id", sourceId).eq("person_key", opts.person)))
      : ctx.db.query("replays").withIndex("by_workspace_person", (q: any) => range(q.eq("workspace", workspaceKey).eq("person_key", opts.person)))
    : null;
  const byCut = !exact && !byPerson && opts.has?.includes("partial")
    ? sourceId
      ? ctx.db.query("replays").withIndex("by_source_cut", (q: any) => range(q.eq("source_id", sourceId).eq("rest_cut", true)))
      : ctx.db.query("replays").withIndex("by_workspace_cut", (q: any) => range(q.eq("workspace", workspaceKey).eq("rest_cut", true)))
    : null;
  const rows: Doc<"replays">[] = exact
    ? named && named.workspace === workspaceKey && (!sourceId || named.source_id === sourceId) ? [named] : []
    : await (byPerson ?? byCut ?? indexed).order("desc").take(REPLAY_BROWSE_SCAN_MAX);
  const match: ReplayMatch = {
    ...(opts.q?.trim() ? { q: opts.q.trim().toLowerCase() } : {}),
    ...(opts.person ? { person: opts.person } : {}),
    ...(opts.has?.length ? { has: opts.has.filter((h) => (REPLAY_HAS as readonly string[]).includes(h)) } : {}),
    ...(opts.min_ms !== undefined ? { min_ms: opts.min_ms } : {}),
    ...(opts.max_ms !== undefined ? { max_ms: opts.max_ms } : {}),
    ...(opts.active_min_ms ? { active_min_ms: opts.active_min_ms } : {}),
    ...(opts.group ? { group: opts.group } : {}),
    ...(since !== undefined ? { since } : {}),
    ...Object.fromEntries(REPLAY_ENV_KEYS.filter((k) => opts[k]).map((k) => [k, opts[k]!.slice(0, 100)])),
  };
  const matched = rows.filter((row) => row.workspace === workspaceKey && replayMatches(row, match));
  // Each environment filter's options, counted over the rows every other filter keeps, so a picker never offers a dead end.
  const facets = Object.fromEntries(
    REPLAY_ENV_KEYS.map((k) => {
      const rest = { ...match, [k]: undefined };
      return [k, replayFacets(rows.filter((row) => row.workspace === workspaceKey && replayMatches(row, rest)))[k]];
    }),
  );
  const sort = (REPLAY_SORTS as readonly string[]).includes(opts.sort ?? "") ? (opts.sort as (typeof REPLAY_SORTS)[number]) : "newest";
  if (sort !== "newest") matched.sort(compareReplays(sort));
  const names = new Map<string, string | null>();
  const out = [];
  for (const row of matched.slice(0, limit)) {
    const key = String(row.source_id);
    if (!names.has(key)) names.set(key, (await ctx.db.get(row.source_id))?.name ?? null);
    out.push(replayView(row, names.get(key) ?? null));
  }
  const folded = replayPeople(matched);
  const people = sortPeople(opts.identified ? folded.filter((p) => !p.anonymous) : folded, (REPLAY_PEOPLE_SORTS as readonly string[]).includes(opts.people_sort ?? "") ? (opts.people_sort as ReplayPeopleSort) : "recent");
  const peopleLimit = Math.min(Math.max(opts.people_limit ?? BROWSE_PEOPLE_MAX, 1), BROWSE_PEOPLE_LIMIT_MAX);
  // A rage filter can only test recordings whose shape was read: say how many it could not, so an empty answer is not taken for "none".
  const rageUnchecked = match.has?.includes("rage")
    ? rows.filter((row) => row.workspace === workspaceKey && rageClicksOf(row) === undefined && replayMatches(row, { ...match, has: match.has!.filter((h) => h !== "rage") })).length
    : 0;
  // The active-time floor hides short recordings: say how many, so the list can offer them rather than hold them back in silence.
  const belowActive = match.active_min_ms ? rows.filter((row) => row.workspace === workspaceKey && replayMatches(row, { ...match, active_min_ms: undefined })).length - matched.length : 0;
  return {
    workspace: workspaceKey,
    rows: out,
    total: matched.length,
    /** When the oldest match started: what "since" means beside the total. Null when nothing matched. */
    oldest_at: matched.length ? matched.reduce((m, r) => Math.min(m, r.started_at), Infinity) : null,
    /** Recordings every other filter keeps that the active-time floor leaves out. */
    below_active: Math.max(0, belowActive),
    /** The scan stopped at REPLAY_BROWSE_SCAN_MAX: older recordings were not looked at, so `total` is a floor. */
    capped: rows.length >= REPLAY_BROWSE_SCAN_MAX,
    people_total: people.length,
    people: opts.people ? people.slice(0, peopleLimit) : null,
    /** People who are known only by an id, among all of them (before `identified`). */
    people_anonymous: folded.filter((p) => p.anonymous).length,
    rage_unchecked: rageUnchecked,
    /** Browser, OS, device and country values with their counts (replayFacets), for the list's pickers. */
    facets,
  };
}

/**
 * Stamp every replay row's index fields (lib/replayIndex.ts), a page at a
 * time, each page scheduling the next: `packages/convex/run.sh
 * replays:indexBackfill '{}'` once after the fields were added. Writes only
 * rows that differ, and never moves a tally (the tend cron recounts).
 */
export const indexBackfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), stamped: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ stamped: number; done: boolean }> => {
    const page = await ctx.db.query("replays").paginate({ cursor: args.cursor ?? null, numItems: 200 });
    let stamped = args.stamped ?? 0;
    for (const row of page.page) {
      if (!replayIndexStale(row)) continue;
      await ctx.db.patch(row._id, replayIndexFields(row));
      stamped++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.replays.indexBackfill, { cursor: page.continueCursor, stamped });
    else console.log(`replays.indexBackfill stamped ${stamped}`);
    return { stamped, done: page.isDone };
  },
});

/** The Replays tab's list: a filtered, sorted page of the workspace's recordings with its total (browseCore). */
export const browse = query({
  args: {
    ...scopeArgs,
    source: v.optional(v.string()),
    q: v.optional(v.string()),
    person: v.optional(v.string()),
    has: v.optional(v.array(v.string())),
    min_ms: v.optional(v.number()),
    max_ms: v.optional(v.number()),
    active_min_ms: v.optional(v.number()),
    group: v.optional(v.string()),
    since: v.optional(v.number()),
    sort: v.optional(v.string()),
    limit: v.optional(v.number()),
    people: v.optional(v.boolean()),
    people_sort: v.optional(v.string()),
    people_limit: v.optional(v.number()),
    identified: v.optional(v.boolean()),
    browser: v.optional(v.string()),
    os: v.optional(v.string()),
    device: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    return await browseCore(ctx, userId, workspaceKey, { ...args, has: args.has as ReplayMatch["has"] });
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
 * A replay as a reference names it (`rp-N` or Convex id), for the pill and
 * the moment embed a conversation renders: the list row, or null when it is
 * missing or the reader's workspace does not hold it, never an error, so the
 * reference reads as text. Never the timeline: a pill needs a name, and the
 * timeline is the replay's content.
 */
export const webGetReplay = query({
  args: { ref: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token).catch(() => null);
    if (!userId) return null;
    const row = await readableReplay(ctx, userId, args.ref);
    if (!row) return null;
    return replayView(row, (await ctx.db.get(row.source_id))?.name ?? null);
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
  args: { user_id: v.optional(v.id("users")), api_token: v.optional(v.string()), replay: v.string(), seq: v.number(), kind: v.optional(v.union(v.literal("events"), v.literal("dom"))) },
  handler: async (ctx, args): Promise<string | null> => {
    const userId = args.user_id ?? (args.api_token ? (await verifyApiToken(ctx, args.api_token))?.userId : undefined);
    if (!userId) return null;
    const row = await readableReplay(ctx, userId, args.replay);
    if (!row) return null;
    if (args.kind === "dom") return (row.dom_chunk_keys ?? []).find((k: string) => parseReplayDomChunkKey(k)?.seq === args.seq) ?? null;
    return row.chunk_keys.find((k) => parseReplayChunkKey(k)?.seq === args.seq) ?? null;
  },
});

// ── The player (contracts/replayPlayer.ts) ──

/** Who may open a replay's player, and whether there is anything to play. A refusal reads like a missing replay. */
export const playerTarget = internalQuery({
  args: { api_token: v.optional(v.string()), replay: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await readableReplay(ctx, userId, args.replay);
    if (!row) notFound("Replay not found");
    const meta = domChunkMeta(row!);
    const chunks = row!.dom_chunk_keys?.length ?? 0;
    return {
      replay_id: row!._id,
      user_id: userId,
      short_id: row!.short_id,
      has_dom: chunks > 0,
      dom_chunk_meta: meta,
      t0: row!.dom_t0 ?? row!.started_at,
      // A long capture whose spans were never read (imported before they were kept): read them, so the next open plays it a stretch at a time.
      needs_meta: !meta && chunks >= REPLAY_DOM_LIMITS.window_min_chunks,
    };
  },
});

const playerModeValidator = v.union(...REPLAY_PLAYER_MODES.map((m) => v.literal(m)));

/**
 * A link to the player for one replay the caller may read: a capability good
 * for REPLAY_CAP_TTL_MS, the player URL at a moment, and where frames are
 * rendered. The web embeds `player_url` in an iframe; the CLI posts `cap` to
 * `frame_url`. Mint a fresh link each time the player is opened: it is a
 * bearer for the replay until it lapses.
 */
export const playerLink = action({
  args: {
    api_token: v.optional(v.string()),
    replay: v.string(),
    t_ms: v.optional(v.number()),
    mode: v.optional(playerModeValidator),
    controls: v.optional(v.boolean()),
    autoplay: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ReplayPlayerLink> => {
    const target = await ctx.runQuery(internal.replays.playerTarget, { api_token: args.api_token, replay: args.replay });
    const now = Date.now();
    const frame_url = `${REPLAY_PLAYER_ORIGIN}${REPLAY_FRAME_PATH}`;
    const key = await replayCapKey();
    if (!target.has_dom || !key) return { short_id: target.short_id, has_dom: false, cap: null, player_url: null, frame_url, expires_at: now };
    if (target.needs_meta) await ctx.scheduler.runAfter(0, internal.replays.domMetaOne, { replay_id: target.replay_id });
    // A person's player reads the stretch around where it opens; the frame renderer seeks anywhere with one capability, so it reads the whole.
    const interactive = (args.mode ?? "interactive") === "interactive";
    const t_ms = Math.max(0, args.t_ms ?? 0);
    const window = interactive ? replayDomWindow(target.dom_chunk_meta, target.t0, t_ms) : null;
    const { cap, expires_at } = await mintReplayCap(key, { replay_id: String(target.replay_id), user_id: String(target.user_id), now, ...(window ? { t_ms } : {}) });
    const player_url = replayPlayerUrl({ cap, t_ms: args.t_ms ?? null, mode: args.mode, controls: args.controls, autoplay: args.autoplay });
    return { short_id: target.short_id, has_dom: true, cap, player_url, frame_url, expires_at, window: window ? { start_ms: window.start_ms, end_ms: window.end_ms } : null };
  },
});

/**
 * What an opened capability reads: the replay's DOM keys and clock, if the
 * person it was minted for can still read it (a removal from the team takes
 * effect on the next load, not when the token lapses). Internal: the route
 * signs the keys before anything leaves.
 */
export const playerManifestRow = internalQuery({
  args: { replay_id: v.string(), user_id: v.string(), t_ms: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("users", args.user_id);
    if (!userId) return null;
    const row = await readableReplay(ctx, userId, args.replay_id);
    if (!row || !(row.dom_chunk_keys?.length)) return null;
    const keys = row.dom_chunk_keys as string[];
    // A capability minted at a time names the stretch of a long capture around it, as playerLink computed it.
    const window = args.t_ms !== undefined ? replayDomWindow(domChunkMeta(row), row.dom_t0 ?? row.started_at, args.t_ms) : null;
    return {
      dom_chunk_keys: window ? keys.slice(window.from, window.to + 1) : keys,
      replay: { short_id: row.short_id, provider: row.provider, url: row.url ?? null, started_at: row.started_at, duration_ms: row.duration_ms ?? null },
      t0: row.dom_t0 ?? row.started_at,
    };
  },
});

/** The manifest the player reads, with the DOM keys swapped for URLs signed now. */
export async function signPlayerManifest(
  row: { dom_chunk_keys: string[]; replay: ReplayPlayerManifest["replay"]; t0: number },
  expiresAt: number,
  bucket: R2Bucket,
  now: number = Date.now(),
): Promise<ReplayPlayerManifest> {
  const dom_urls: string[] = [];
  for (const key of row.dom_chunk_keys) dom_urls.push((await r2FreshGetUrl(bucket, key, now)).url);
  return { replay: row.replay, t0: row.t0, dom_urls, expires_at: expiresAt };
}

/** What a player opened at t on this replay would read: `packages/convex/run.sh replays:windowFor '{"short_id":"rp-1","t_ms":0}'`. */
export const windowFor = internalQuery({
  args: { short_id: v.string(), t_ms: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("replays").withIndex("by_short_id", (q) => q.eq("short_id", args.short_id)).first();
    if (!row) return null;
    const meta = domChunkMeta(row);
    return {
      keys: row.dom_chunk_keys?.length ?? 0,
      spans: row.dom_chunk_meta?.length ?? 0,
      raw_mb: meta ? Math.round(meta.reduce((n, m) => n + m.raw, 0) / 1024 / 1024) : null,
      window: replayDomWindow(meta, row.dom_t0 ?? row.started_at, args.t_ms),
      import_rest: row.import_rest ?? null,
      vendor_refresh_after: row.vendor_refresh_after ?? null,
      vendor_refresh_why: row.vendor_refresh_why ?? null,
    };
  },
});
