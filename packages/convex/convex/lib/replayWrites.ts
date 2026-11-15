// Writes to a recording's manifest row (replays.ts), used by the ingest door,
// the sign route and the adapters: the stub any first word of a recording
// opens, the manifest update, the link to an error group, and the chunk and
// stylesheet lists the player reads.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { takeFromWindow } from "../ipRateLimit";
import { nextShortId } from "../counters";
import { parseReplayChunkKey, parseReplayDomChunkKey } from "./r2";
import { REPLAY_LIMITS, cleanKeepReasons, type ReplayProvider } from "@codecast/shared/contracts/replay";
import { INGEST_SHORT_ID_PREFIX, type IngestItem, type SourceProvider } from "@codecast/shared/contracts/ingest";
import { REPLAY_DOM_LIMITS, REPLAY_STYLE_LIMITS, type ReplayChunkKind } from "@codecast/shared/contracts/replayPlayer";
import { patchReplay } from "./replayIndex";
import { moveTally } from "./replayTallies";

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
  // A source's first recording starts its tallies at zero, so they are whole from here on (lib/replayTallies.ts).
  if (source.replay_tally_at === undefined && !(await ctx.db.query("replays").withIndex("by_source_started", (q: any) => q.eq("source_id", source._id)).first())) {
    await ctx.db.patch(source._id, { replay_tally_at: now });
  }
  const id = await ctx.db.insert("replays", row);
  await moveTally(ctx, { workspace: row.workspace, source_id: row.source_id }, null, row, now);
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
  // Reasons only add up: a later manifest names the earlier ones too, but one that arrives out of order must not drop any.
  const keptFor = cleanKeepReasons([...(row.kept_for ?? []), ...(item.kept_for ?? [])]);
  if (keptFor && keptFor.join() !== (row.kept_for ?? []).join()) patch.kept_for = keptFor;
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
    await patchReplay(ctx, row, { group_ids: [...row.group_ids, groupId], updated_at: now });
  }
  return row._id;
}

/**
 * A chunk the SDK is about to upload (the sign route). Chunks are append-only:
 * a sequence number that already holds a different key keeps it and the
 * answer names it as `held`, so a holder of the public ingest key cannot
 * swap a landed chunk for its own. The sign route checks whether `held` ever
 * landed in the bucket; only if it did not (the SDK's PUT failed and it is
 * re-signing that sequence with a grown batch) does it call again with
 * `replaceUnlanded: held`, which swaps exactly that key and nothing newer.
 * Re-signing the same key (same content) is a no-op. Refuses past
 * REPLAY_LIMITS.max_chunks_per_replay.
 */
export async function recordReplayChunk(
  ctx: Db,
  source: Doc<"event_sources">,
  externalId: string,
  seq: number,
  key: string,
  now: number,
  kind: ReplayChunkKind = "events",
  replaceUnlanded?: string,
): Promise<{ ok: true; replay_id: Id<"replays">; held?: string } | { ok: false; reason: string }> {
  const max = kind === "dom" ? REPLAY_DOM_LIMITS.max_chunks_per_replay : REPLAY_LIMITS.max_chunks_per_replay;
  if (!Number.isInteger(seq) || seq < 0 || seq >= max) {
    return { ok: false, reason: `seq must be 0 to ${max - 1}` };
  }
  const row = await ensureReplay(ctx, source, externalId, now);
  if (!row) return { ok: false, reason: `this source opened ${REPLAYS_NEW_PER_HOUR} recordings in the last hour; try again later` };
  // The DOM capture the player plays is listed apart from the stream, so the
  // assembly (which reads chunk_keys) never sees it.
  const dom = kind === "dom";
  const parse = dom ? parseReplayDomChunkKey : parseReplayChunkKey;
  const current = (dom ? row.dom_chunk_keys : row.chunk_keys) ?? [];
  if (current.includes(key)) return { ok: true, replay_id: row._id };
  const existing = current.find((k) => parse(k)?.seq === seq);
  if (existing && existing !== replaceUnlanded) return { ok: true, replay_id: row._id, held: existing };
  const next = current.filter((k) => k !== existing);
  next.push(key);
  next.sort((a, b) => (parse(a)?.seq ?? 0) - (parse(b)?.seq ?? 0));
  await ctx.db.patch(row._id, dom ? { dom_chunk_keys: next, updated_at: now } : { chunk_keys: next, chunks_at: now, updated_at: now });
  return { ok: true, replay_id: row._id };
}

/**
 * Name one stylesheet a recording's DOM capture links to (contracts/replayPlayer
 * REPLAY_STYLE_LIMITS). A href already named points at the newer copy, so a
 * sheet stored again on a later day stays readable for as long as the
 * recording is. Refuses past max_per_replay.
 */
export async function recordReplayStyle(
  ctx: Db,
  source: Doc<"event_sources">,
  externalId: string,
  href: string,
  key: string,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await ensureReplay(ctx, source, externalId, now);
  if (!row) return { ok: false, reason: `this source opened ${REPLAYS_NEW_PER_HOUR} recordings in the last hour; try again later` };
  const current = row.dom_styles ?? [];
  const same = current.find((s) => s.href === href);
  if (same?.key === key) return { ok: true };
  if (!same && current.length >= REPLAY_STYLE_LIMITS.max_per_replay) return { ok: false, reason: `a recording names at most ${REPLAY_STYLE_LIMITS.max_per_replay} stylesheets` };
  await ctx.db.patch(row._id, { dom_styles: [...current.filter((s) => s.href !== href), { href, key }], updated_at: now });
  return { ok: true };
}
