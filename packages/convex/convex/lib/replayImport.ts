// Importing a vendor recording (replays.ts X7): the stream summarized into
// the row's cached fields, its walls folded into issue groups, and the import
// core that stores a converted recording's chunks and saves the row.
import { v, type ObjectType } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "./hash";
import { replayChunkKey, replaysBucketFromEnv, safeReplayPathSegment } from "./r2";
import { ingestUserValidator, replayDomChunkMetaValidator, replayImportRestValidator, replayReadToValidator, replayProviderValidator } from "../ingestSchema";
import { VENDOR_CONVERTER_VERSION, type ReplayEvent, type ReplayProvider } from "@codecast/shared/contracts/replay";
import { parseReplayEvents, renderTimeline, replayCounts, replayIssues, replayShape, sortReplayEvents } from "@codecast/shared/replay";
import { chunkReplayEvents, putChunk } from "./replayChunks";

/** What an import carries about the DOM capture it stored (storeReplayDom). */
export const domArgs = {
  dom_chunk_keys: v.optional(v.array(v.string())),
  dom_bytes: v.optional(v.number()),
  /** The capture's first rrweb timestamp: the epoch the stream's t counts from. */
  dom_t0: v.optional(v.number()),
  /** Each chunk's span and size, parallel to dom_chunk_keys (storeReplayDom). */
  dom_chunk_meta: v.optional(v.array(replayDomChunkMetaValidator)),
};

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
export function summarize(events: ReplayEvent[], shortId: string) {
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

/**
 * A vendor recording, already converted (fromRrweb), stored the way our own
 * recordings are: chunks in R2 under the source, a manifest row, and the
 * timeline cached. Idempotent: the chunks are content addressed and the row
 * is keyed by the source's external id, so a second import uploads nothing
 * that is already there.
 */
export const importExternalArgs = {
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

