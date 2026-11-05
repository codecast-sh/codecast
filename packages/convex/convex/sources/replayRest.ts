// The rest of a long vendor recording (docs/architecture/external-data.md X7).
// One action reads a PostHog recording up to its byte and blob caps
// (posthog.fetchRecordingEvents): a two hour session imports its first
// fifteen minutes. When a person opens such a copy, the import keeps where
// its read stopped (the next blob, and the converter's state as a carry in
// R2, vendorReplay.storeCarry) and this chain reads the rest, one part per
// action:
//
//   1. read the next blobs from where the last part stopped;
//   2. convert them with the carry, on the recording's own clock
//      (shared/replay/capture.ts readVendorCapturePart), so clicks are named
//      by the page as the earlier parts left it and masking holds;
//   3. append the part's masked capture as further DOM chunks, merge its
//      events into the stored stream, and save both (replays.importExternal
//      with the chain's gen, so a newer import of the same recording wins);
//   4. keep the new carry, and schedule the next part.
//
// PostHog throttles snapshot reads (12 a minute, 60 an hour), so parts are
// spaced, and a 429 waits out its Retry-After. A part that fails for any
// other reason stops the chain with its error on the row; opening the replay
// again starts a new one (vendorReplay.needsRest).
//
// Nobody has to open a recording for this. The sweep below walks a PostHog
// source's recordings newest first and starts a chain on the first copy that
// holds only its start (or whose reach was never stored), one chain at a time
// per source so the reads stay inside PostHog's throttle. A chain that ends,
// whole or failed, sweeps on from the recording it read; the tend cron
// (replayBackfill.tend) starts a sweep every 15 minutes, which does nothing
// while a chain is live or a bulk import is running. So every listed
// recording's length and reach come from its import, never from a person
// opening it.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../functions";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { carryFromCapture, readVendorCapturePart, type CaptureCarry } from "@codecast/shared/replay";
import { REPLAY_REST_NO_MORE, VENDOR_REFRESH_RETRY, replayCutAt } from "@codecast/shared/contracts/replay";
import { replaysBucketFromEnv } from "../lib/r2";
import { importExternalCore } from "../lib/replayImport";
import { patchReplay } from "../lib/replayIndex";
import { readDomChunkEvents, readReplayChunks, storeReplayDom } from "../lib/replayChunks";
import { connFor, fetchRecordingEvents, locateBlobAfter } from "./posthog";
import type { R2Bucket } from "../lib/r2";
import { REACH_UNKNOWN_MS as REPLAY_REST_UNKNOWN_MS, REST_STALL_MS, needsRest, readCarry, storeCarry, vendorRefreshHold } from "./vendorReplay";

/** Between parts: one part is about four snapshot calls, and PostHog allows twelve a minute. */
export const REST_STEP_MS = 20_000;
/** A rate limit with no Retry-After waits this long. */
const REST_RATE_LIMIT_MS = 60_000;

/** Start (or restart) reading a recording's rest from `next_blob`: a new chain, which a step of any older one yields to. */
export const begin = internalMutation({
  args: { replay_id: v.id("replays"), carry_key: v.string(), next_blob: v.number(), blobs: v.number(), after_t: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const gen = now;
    // updated_at too: a client redraws a replay row only when it moves (web useSyncOps replaySig).
    // vendor_refresh_after too: a chain reading is the row's state now, not the failure that held it.
    await ctx.db.patch(args.replay_id, { import_rest: { gen, next_blob: args.next_blob, blobs: args.blobs, carry_key: args.carry_key, ...(args.after_t !== undefined ? { after_t: args.after_t } : {}), updated_at: now }, vendor_refresh_after: undefined, vendor_refresh_why: undefined, updated_at: now });
    const row = await ctx.db.get(args.replay_id);
    if (row) await setReading(ctx, row.source_id, { short_id: row.short_id });
    await ctx.scheduler.runAfter(REST_STEP_MS, internal.sources.replayRest.step, { replay_id: args.replay_id, gen });
  },
});

/**
 * The source's import line names the recording being read (replay_rest.reading)
 * as chains start, wait and end, so it never names one that stopped; the tend
 * cron's recount sets it too. `ended`: clear it only if it still names that one.
 */
async function setReading(ctx: { db: any }, sourceId: Id<"event_sources">, next: { short_id: string; waiting_until?: number } | { ended: string }): Promise<void> {
  const source = await ctx.db.get(sourceId);
  const tally = source?.replay_rest;
  if (!tally) return;
  if ("ended" in next) {
    if (tally.reading !== next.ended) return;
    const { reading: _r, waiting_until: _w, ...rest } = tally;
    await ctx.db.patch(sourceId, { replay_rest: rest });
    return;
  }
  if (tally.reading === next.short_id && tally.waiting_until === next.waiting_until) return;
  const { waiting_until: _w, ...rest } = tally;
  await ctx.db.patch(sourceId, { replay_rest: { ...rest, reading: next.short_id, ...(next.waiting_until ? { waiting_until: next.waiting_until } : {}) } });
}

/** A chain read its recording whole: the import line stops naming it, and the sweep goes on to the next older cut copy. */
export const endChain = internalMutation({
  args: { replay_id: v.id("replays"), source_id: v.id("event_sources"), before: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (row) await setReading(ctx, args.source_id, { ended: row.short_id });
    await ctx.scheduler.runAfter(REST_STEP_MS, internal.sources.replayRest.sweep, { source_id: args.source_id, before: args.before });
  },
});

/**
 * A chain the sweep found gone quiet (an action that ran out of memory says
 * nothing): it is stopped with that said on the row and held like a failure,
 * so the sweep goes on to the next recording instead of starting the same
 * part again.
 */
export const markStalled = internalMutation({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row?.import_rest || row.import_rest.error) return;
    const now = Date.now();
    await ctx.db.patch(args.replay_id, {
      import_rest: { ...row.import_rest, error: REST_STALLED_ERROR },
      vendor_refresh_after: now + VENDOR_REFRESH_RETRY.failed_ms,
      vendor_refresh_why: "failed",
      updated_at: now,
    });
    await setReading(ctx, row.source_id, { ended: row.short_id });
  },
});

/** What a chain that went quiet says on its row. */
export const REST_STALLED_ERROR = "Stopped without an error (the last part ran out of time or memory)";

/** What a step reads of the row: the chain, and what the stored copy holds so the part can be added to it. */
export const stepRow = internalQuery({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row || !row.import_rest) return null;
    return {
      import_rest: row.import_rest,
      source_id: row.source_id,
      external_id: row.external_id,
      provider: row.provider,
      chunk_keys: row.chunk_keys,
      started_at: row.started_at,
      dom_chunk_keys: row.dom_chunk_keys ?? [],
      dom_chunk_meta: row.dom_chunk_meta ?? [],
      dom_bytes: row.dom_bytes ?? 0,
      vendor_length_ms: row.facts?.length_ms ?? row.duration_ms ?? null,
      duration_ms: row.duration_ms ?? null,
      dom_t0: row.dom_t0 ?? null,
    };
  },
});

/** What resume reads of a row: where its last read stopped, and the capture a carry can be rebuilt from. */
export const resumeRow = internalQuery({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row || row.provider !== "posthog" || !row.imported_at) return null;
    const keys = row.dom_chunk_keys ?? [];
    const meta = row.dom_chunk_meta && row.dom_chunk_meta.length === keys.length ? row.dom_chunk_meta : null;
    return {
      external_id: row.external_id,
      source_id: row.source_id,
      chain: row.import_rest ? { next_blob: row.import_rest.next_blob, blobs: row.import_rest.blobs, carry_key: row.import_rest.carry_key, live: chainLive(row, Date.now()) } : null,
      read_to: row.read_to ?? null,
      dom_chunk_keys: keys,
      dom_chunk_meta: meta,
      dom_t0: row.dom_t0 ?? null,
    };
  },
});

/** Raw capture bytes a rebuilt carry may replay: past this, the stretch since the last full snapshot is too long to hold in an action. */
const REBUILD_MAX_RAW = 12 * 1024 * 1024;

/**
 * The converter's state at the end of a stored capture, rebuilt from it
 * (shared carryFromCapture): the chunks from the one holding the last full
 * snapshot to the end, on the recording's clock (the capture's first event).
 * Null when the capture has no full snapshot, cannot be read, or the stretch
 * is too long to hold.
 */
export async function rebuildCarry(
  bucket: R2Bucket,
  row: { dom_chunk_keys: string[]; dom_chunk_meta: { first: number; last: number; full?: number; raw: number }[] | null; dom_t0: number | null },
): Promise<CaptureCarry | null> {
  const keys = row.dom_chunk_keys;
  if (!keys.length) return null;
  const meta = row.dom_chunk_meta;
  let from = keys.length - 1;
  if (meta) {
    while (from > 0 && meta[from].full === undefined) from--;
    if (meta.slice(from).reduce((n, m) => n + m.raw, 0) > REBUILD_MAX_RAW) return null;
  }
  const t0 = meta ? meta[0].first : null;
  const chunks: any[][] = [];
  let raw = 0;
  // Without spans, walk back from the last chunk until one holds a full snapshot.
  for (let i = from; i < keys.length; i++) {
    const chunk = await readDomChunkEvents(bucket, keys[i]);
    if (!chunk) return null;
    chunks.push(chunk.events);
    raw += chunk.raw;
  }
  while (!meta && from > 0 && !chunks[0].some((e) => e?.type === 2)) {
    from--;
    const chunk = await readDomChunkEvents(bucket, keys[from]);
    if (!chunk) return null;
    raw += chunk.raw;
    if (raw > REBUILD_MAX_RAW) return null;
    chunks.unshift(chunk.events);
  }
  let first = t0;
  if (first === null) {
    const head = from === 0 ? chunks[0] : (await readDomChunkEvents(bucket, keys[0]))?.events;
    first = head?.find((e) => typeof e?.timestamp === "number")?.timestamp ?? null;
  }
  if (first === null) return null;
  return carryFromCapture(chunks.flat(), first);
}

/** The last rrweb timestamp the stored capture holds, or null. */
async function captureEnd(bucket: R2Bucket, row: { dom_chunk_keys: string[]; dom_chunk_meta: { last: number }[] | null }): Promise<number | null> {
  if (row.dom_chunk_meta?.length) return row.dom_chunk_meta[row.dom_chunk_meta.length - 1].last;
  const last = row.dom_chunk_keys[row.dom_chunk_keys.length - 1];
  const chunk = last ? await readDomChunkEvents(bucket, last) : null;
  if (!chunk) return null;
  const ts = chunk.events.map((e) => e?.timestamp).filter((t): t is number => typeof t === "number");
  return ts.length ? Math.max(...ts) : null;
}

/**
 * Read on a copy that stops short of its recording from where it stopped:
 * the chain's own next blob (a chain that died), else where the last read
 * ended (read_to: a recording PostHog kept writing after it was read whole),
 * else the first blob past the capture's last moment. The carry is the one
 * kept there, or rebuilt from the stored capture. What is stored stays; the
 * chain appends. Answers whether a chain started; when it cannot (no capture
 * to read on from), the caller may read the recording again from its start,
 * which replays.saveImported refuses to save over a longer copy.
 */
export const resume = internalAction({
  args: { replay_id: v.id("replays") },
  handler: async (ctx, args): Promise<{ started: boolean; why?: string }> => {
    const row = await ctx.runQuery(internal.sources.replayRest.resumeRow, { replay_id: args.replay_id });
    if (!row || !row.dom_chunk_keys.length) return { started: false, why: "no capture to read on from" };
    if (row.chain?.live) return { started: true };
    const bucket = replaysBucketFromEnv();
    if (!bucket) return { started: false, why: "Replays storage is not configured" };
    const end = await captureEnd(bucket, row);
    let at: { next_blob: number; blobs: number } | null = row.chain ?? row.read_to ?? null;
    if (!at && end !== null) {
      const input = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: row.source_id });
      if (!input) return { started: false, why: "The recording's source was removed" };
      const conn = await connFor(ctx, input);
      if ("error" in conn) return { started: false, why: conn.error };
      at = await locateBlobAfter(conn, row.external_id, end);
    }
    if (!at) return { started: false, why: "where the copy stopped is not known" };
    const keptKey = row.chain?.carry_key ?? row.read_to?.carry_key;
    let carry_key = keptKey && (await readCarry(bucket, keptKey)) ? keptKey : null;
    if (!carry_key) {
      const carry = await rebuildCarry(bucket, row);
      if (!carry) return { started: false, why: "the stored capture has no page to read on from" };
      carry_key = await storeCarry(bucket, { source_id: String(row.source_id), external_id: row.external_id }, carry);
    }
    // Only a read located by time re-reads part of what is stored; a kept next blob starts past it.
    const located = !row.chain && !row.read_to;
    await ctx.runMutation(internal.sources.replayRest.begin, { replay_id: args.replay_id, carry_key, next_blob: at.next_blob, blobs: at.blobs, ...(located && end !== null ? { after_t: end } : {}) });
    return { started: true };
  },
});

/** Past this since its last moment, a recording PostHog lists no more parts of has ended and been written out: what is imported is all there is. */
export const REST_SETTLED_MS = 60 * 60_000;

/** Whether a chain that found no more parts may call its copy whole: the recording's last moment (start plus length) is REST_SETTLED_MS gone. */
export function restSettled(r: { started_at: number; duration_ms?: number | null }, now: number): boolean {
  return now - (r.started_at + (r.duration_ms ?? 0)) > REST_SETTLED_MS;
}

/**
 * A chain read every part PostHog holds of an ended recording: the copy
 * reaches the recording's end (the rest is time with nothing recorded, which
 * PostHog's player skips too), so it leaves the backlog instead of being
 * asked again every hour. Where the read stopped stays, for a later resume.
 */
export const settleWhole = internalMutation({
  args: { replay_id: v.id("replays"), gen: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row?.import_rest || row.import_rest.gen !== args.gen) return;
    const now = Date.now();
    const c = row.import_rest;
    await patchReplay(ctx, row, {
      captured_ms: Math.max(row.duration_ms ?? 0, row.facts?.length_ms ?? 0, row.captured_ms ?? 0),
      import_rest: undefined,
      read_to: { next_blob: c.next_blob, blobs: c.blobs, carry_key: c.carry_key, at: now },
      updated_at: now,
    });
    await setReading(ctx, row.source_id, { ended: row.short_id });
    await ctx.scheduler.runAfter(REST_STEP_MS, internal.sources.replayRest.sweep, { source_id: row.source_id, before: row.started_at });
  },
});

/** A step that could not read its part: wait (a rate limit) and try again, or stop the chain and say why. */
export const holdStep = internalMutation({
  args: { replay_id: v.id("replays"), gen: v.number(), retry_at: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row?.import_rest || row.import_rest.gen !== args.gen) return;
    const now = Date.now();
    await ctx.db.patch(args.replay_id, {
      import_rest: { ...row.import_rest, updated_at: now, retry_at: args.retry_at, error: args.error?.slice(0, 300) },
      updated_at: now,
      // A failed chain is not restarted by every open of the replay for an hour (vendorReplay.needsRest).
      ...(args.error ? { vendor_refresh_after: now + VENDOR_REFRESH_RETRY.failed_ms, vendor_refresh_why: "failed" as const } : {}),
    });
    if (args.retry_at && !args.error) await ctx.scheduler.runAt(args.retry_at, internal.sources.replayRest.step, { replay_id: args.replay_id, gen: args.gen });
    await setReading(ctx, row.source_id, args.error ? { ended: row.short_id } : { short_id: row.short_id, ...(args.retry_at ? { waiting_until: args.retry_at } : {}) });
    // A chain that failed leaves its recording for the next open or tend; the sweep goes on to the older ones.
    if (args.error && row.provider === "posthog") await ctx.scheduler.runAfter(SWEEP_AFTER_FAIL_MS, internal.sources.replayRest.sweep, { source_id: row.source_id, before: row.started_at });
  },
});

/** Schedule the part after this one, once it is saved; the chain's state rode the save (replays.saveImported). */
export const nextStep = internalMutation({
  args: { replay_id: v.id("replays"), gen: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.replay_id);
    if (!row?.import_rest || row.import_rest.gen !== args.gen) return;
    // A chain that lost the import line's name to one that has since ended takes it back, so the line names what is read now.
    const tally = (await ctx.db.get(row.source_id))?.replay_rest;
    if (tally && !tally.reading) await setReading(ctx, row.source_id, { short_id: row.short_id });
    await ctx.scheduler.runAfter(REST_STEP_MS, internal.sources.replayRest.step, args);
  },
});

/**
 * One part of the rest: read, convert with the carry, add to the stored copy,
 * and queue the next. A part that throws stops the chain with its error on
 * the row, so the page says it stopped and the sweep goes on, rather than
 * the row reading as busy until it goes quiet.
 */
export const step = internalAction({
  args: { replay_id: v.id("replays"), gen: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const hold = (patch: { retry_at?: number; error?: string }) => ctx.runMutation(internal.sources.replayRest.holdStep, { replay_id: args.replay_id, gen: args.gen, ...patch });
    try {
      await stepPart(ctx, args, hold);
    } catch (err) {
      await hold({ error: err instanceof Error ? err.message : String(err) });
    }
  },
});

async function stepPart(ctx: any, args: { replay_id: Id<"replays">; gen: number }, hold: (patch: { retry_at?: number; error?: string }) => Promise<unknown>): Promise<void> {
    const row = await ctx.runQuery(internal.sources.replayRest.stepRow, { replay_id: args.replay_id });
    if (!row || row.import_rest.gen !== args.gen || row.provider !== "posthog") return;
    const bucket = replaysBucketFromEnv();
    if (!bucket) return void (await hold({ error: "Replays storage is not configured" }));
    const input = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: row.source_id });
    if (!input) return void (await hold({ error: "The recording's source was removed" }));
    const conn = await connFor(ctx, input);
    if ("error" in conn) return void (await hold({ error: conn.error }));
    // A kept state that is gone is rebuilt from the capture already stored, which ends where this part begins.
    const carry = (await readCarry(bucket, row.import_rest.carry_key)) ?? (await rebuildCarry(bucket, { dom_chunk_keys: row.dom_chunk_keys, dom_chunk_meta: row.dom_chunk_meta.length === row.dom_chunk_keys.length ? row.dom_chunk_meta : null, dom_t0: row.dom_t0 }));
    if (!carry) return void (await hold({ error: "The page state where the last part ended could not be rebuilt" }));

    const read = await fetchRecordingEvents(conn, row.external_id, fetch, row.import_rest.next_blob);
    if (!read.ok) {
      if (read.status === 429) return void (await hold({ retry_at: Date.now() + Math.max(read.retry_after_ms ?? 0, REST_RATE_LIMIT_MS) }));
      return void (await hold({ error: read.error }));
    }
    if (read.next_blob <= row.import_rest.next_blob) {
      // An ended recording PostHog holds nothing more of: every part it has is imported, so the copy is whole, and the sweep goes on.
      if (!read.realtime && restSettled(row, Date.now())) return void (await ctx.runMutation(internal.sources.replayRest.settleWhole, { replay_id: args.replay_id, gen: args.gen }));
      return void (await hold({ error: REPLAY_REST_NO_MORE }));
    }

    const after = row.import_rest.after_t;
    const part = readVendorCapturePart(after !== undefined ? read.events.filter((e) => typeof e?.timestamp === "number" && e.timestamp > after) : read.events, carry);
    const sourceId = String(row.source_id);
    const dom = await storeReplayDom(bucket, { source_id: sourceId, external_id: row.external_id, events: part.dom, first_seq: row.dom_chunk_keys.length });
    // Everything already stored, with this part added: the stream is small next to the capture, and the summary is of the whole.
    const stored = await readReplayChunks(bucket, row.chunk_keys, { serverWritten: true });
    // Saving over a stream that could not be read whole would drop the parts already in.
    if (stored.skipped > 0) return void (await hold({ error: `${stored.skipped} stored chunk${stored.skipped === 1 ? "" : "s"} could not be read` }));
    const more = read.next_blob < read.blobs;
    // Kept at the end too: a recording PostHog is still writing is read on from here once it has more (resume).
    const carry_key = await storeCarry(bucket, { source_id: sourceId, external_id: row.external_id }, part.carry);
    // In place, not through runAction: a long recording's whole stream is more elements than an action argument may hold (8192).
    const saved = await importExternalCore(ctx, {
      source_id: row.source_id,
      provider: "posthog",
      external_id: row.external_id,
      events: [...stored.events, ...part.events],
      dom_chunk_keys: [...row.dom_chunk_keys, ...dom.dom_chunk_keys],
      // The part's spans go on only when every stored chunk has its span; else the ones kept stay, and replays.domMetaOne reads the rest.
      dom_chunk_meta: row.dom_chunk_meta.length === row.dom_chunk_keys.length ? [...row.dom_chunk_meta, ...dom.dom_chunk_meta] : row.dom_chunk_meta,
      dom_bytes: row.dom_bytes + dom.dom_bytes,
      dom_t0: carry.converter.t0,
      capture_end_t: part.end_t,
      ...(row.vendor_length_ms ? { vendor_length_ms: row.vendor_length_ms } : {}),
      expect_gen: args.gen,
      ...(more ? { import_rest: { gen: args.gen, next_blob: read.next_blob, blobs: read.blobs, carry_key, updated_at: Date.now() } } : { whole: true }),
      read_to: { next_blob: read.next_blob, blobs: read.blobs, carry_key, at: Date.now() },
    });
    // Chunks stored before their spans were kept: read those spans now, so the longer capture can play a stretch at a time.
    if (saved.saved && row.dom_chunk_meta.length !== row.dom_chunk_keys.length) await ctx.scheduler.runAfter(0, internal.replays.domMetaOne, { replay_id: args.replay_id });
    if (saved.saved && more) await ctx.runMutation(internal.sources.replayRest.nextStep, { replay_id: args.replay_id as Id<"replays">, gen: args.gen });
    // The whole recording is in: the sweep goes on to the next older copy that holds only its start.
    else if (saved.saved) await ctx.runMutation(internal.sources.replayRest.endChain, { replay_id: args.replay_id, source_id: row.source_id, before: row.started_at });
}

// ── The sweep: every cut recording of a source, newest first ──

/** Rows read per page of the sweep's walk, and the pages one sweep walks at most. */
export const SWEEP_PAGE = 100;
const SWEEP_MAX_PAGES = 30;
/** After a chain or a first read failed, the sweep waits this long before the next recording. */
export const SWEEP_AFTER_FAIL_MS = 60_000;
/** The sweep reads recordings this recent: PostHog keeps a recording 30 days, so an older one answers "not found". Opening one still asks. */
export const SWEEP_MAX_AGE_MS = 30 * 86_400_000;

/** The sweep's first lane: short recordings that ended inside this window, so one opened the same day plays whole. */
export const SWEEP_RECENT_MS = 24 * 3_600_000;
/** How long a recording may be and still go in the first lane: under this, its rest is a part or two. */
export const SWEEP_SHORT_MS = 30 * 60_000;
/** A recording ended this long ago is written out at PostHog (it flushes a live recording to blobs within minutes). */
export const SWEEP_ENDED_MS = VENDOR_REFRESH_RETRY.realtime_ms;

/**
 * Which lane of the sweep a cut recording reads in, first to last: 0, a short
 * recording that ended in the last day (the one a person opens from the list
 * today); 1, one an issue caught or with errors in it (what an agent or a
 * person opens to see a failure); 2, every other. A copy PostHog answered no
 * more for leaves the first lane, so it does not take the front every hour.
 */
export function sweepLane(r: { started_at: number; duration_ms?: number | null; group_ids?: readonly unknown[]; counts?: { errors?: number } | null; import_rest?: { error?: string } | null }, now: number): 0 | 1 | 2 {
  const end = r.started_at + (r.duration_ms ?? 0);
  if (r.started_at >= now - SWEEP_RECENT_MS && (r.duration_ms ?? 0) <= SWEEP_SHORT_MS && now - end > SWEEP_ENDED_MS && r.import_rest?.error !== REPLAY_REST_NO_MORE) return 0;
  if ((r.group_ids?.length ?? 0) > 0 || (r.counts?.errors ?? 0) > 0) return 1;
  return 2;
}

/** The lanes in the order the sweep walks them; a lane takes rows of its own lane and any before it. */
const SWEEP_LANES = ["recent", "linked", "all"] as const;
type SweepLaneName = (typeof SWEEP_LANES)[number];

type SweepRow = {
  provider: string;
  imported_at?: number | null;
  captured_ms?: number | null;
  duration_ms?: number | null;
  vendor_refresh_after?: number | null;
  import_rest?: { retry_at?: number; error?: string; updated_at: number } | null;
};

/** A chain reading this row's rest that is still alive: stepping, or waiting out a rate limit. */
export function chainLive(r: Pick<SweepRow, "import_rest">, now: number): boolean {
  const c = r.import_rest;
  if (!c || c.error) return false;
  return (c.retry_at ?? 0) > now || now - c.updated_at <= REST_STALL_MS;
}

/** Whether the sweep should read this row's rest: an imported PostHog copy that holds only its start, or may (vendorReplay.needsRest). */
export function sweepWants(r: SweepRow, now: number): boolean {
  if (r.provider !== "posthog" || !r.imported_at) return false;
  return needsRest({ captured_ms: r.captured_ms ?? null, duration_ms: r.duration_ms ?? null, imported_at: r.imported_at, vendor_refresh_after: r.vendor_refresh_after ?? null, import_rest: r.import_rest ?? null }, now);
}

/** One page of the walk: stop at a live chain (busy) or at the first row to read, else the cursor on. */
export const sweepPage = internalQuery({
  args: { source_id: v.id("event_sources"), before: v.union(v.number(), v.null()), cursor: v.union(v.string(), v.null()), now: v.number(), lane: v.optional(v.union(...SWEEP_LANES.map((l) => v.literal(l)))), linked_only: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source || source.provider !== "posthog" || source.status !== "active" || source.replay_backfill?.status === "running") return { busy: true as const };
    const lane: SweepLaneName = args.lane ?? (args.linked_only ? "linked" : "all");
    const most = SWEEP_LANES.indexOf(lane);
    // The first lane reads only the last day, so its walk is short however long the backlog.
    const from = lane === "recent" ? args.now - SWEEP_RECENT_MS : null;
    const page = await ctx.db
      .query("replays")
      .withIndex("by_source_started", (q) => {
        const src = q.eq("source_id", args.source_id);
        if (args.before !== null) return from !== null ? src.gte("started_at", from).lt("started_at", args.before) : src.lt("started_at", args.before);
        return from !== null ? src.gte("started_at", from) : src;
      })
      .order("desc")
      .paginate({ cursor: args.cursor, numItems: SWEEP_PAGE });
    for (const r of page.page) {
      if (chainLive(r, args.now)) return { busy: true as const };
      if (r.started_at < args.now - SWEEP_MAX_AGE_MS) return { busy: false as const, next: null, cursor: null, done: true };
      if (sweepWants(r, args.now) && sweepLane(r, args.now) <= most) return { busy: false as const, next: { replay_id: r._id, external_id: r.external_id, started_at: r.started_at, stalled: !!r.import_rest && !r.import_rest.error }, cursor: null, done: true };
    }
    return { busy: false as const, next: null, cursor: page.continueCursor, done: page.isDone };
  },
});

/**
 * Find a source's newest recording whose copy holds only its start and read
 * the rest: its start again with the chain's carry (posthog.importForSource
 * with `rest`), then the chain above. One recording per sweep; the chain's end
 * sweeps on from it.
 */
export const sweep = internalAction({
  args: { source_id: v.id("event_sources"), before: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ started: string | null }> => {
    const now = Date.now();
    let next: { replay_id: Id<"replays">; external_id: string; started_at: number; stalled?: boolean } | null = null;
    // Lanes in order (sweepLane): short recordings that ended today, then those an issue caught or with errors, each from the newest; then every other cut copy, older than the last one read.
    for (const lane of SWEEP_LANES) {
      let cursor: string | null = null;
      for (let i = 0; i < SWEEP_MAX_PAGES && !next; i++) {
        const page: any = await ctx.runQuery(internal.sources.replayRest.sweepPage, { source_id: args.source_id, before: lane === "all" ? (args.before ?? null) : null, cursor, now, lane });
        if (page.busy) return { started: null };
        next = page.next;
        if (page.done) break;
        cursor = page.cursor;
      }
      if (next) break;
    }
    if (!next) return { started: null };
    // A chain that went quiet is not started on the same part again: it is marked stopped and held, and the sweep goes on.
    if (next.stalled) {
      await ctx.runMutation(internal.sources.replayRest.markStalled, { replay_id: next.replay_id });
      await ctx.scheduler.runAfter(0, internal.sources.replayRest.sweep, { source_id: args.source_id, ...(args.before !== undefined ? { before: args.before } : {}) });
      return { started: null };
    }
    const onAfter = (ms: number) => ctx.scheduler.runAfter(ms, internal.sources.replayRest.sweep, { source_id: args.source_id, before: next!.started_at });
    try {
      const out = await ctx.runAction(internal.sources.posthog.importForSource, { source_id: args.source_id, external_id: next.external_id, rest: true, force: true });
      // A chain began: its end sweeps on. Whole (or a start that cannot be read part by part): on at once.
      const chain = out.truncated ? await ctx.runQuery(internal.sources.replayRest.stepRow, { replay_id: next.replay_id }) : null;
      if (!chain || chain.import_rest.error) await onAfter(REST_STEP_MS);
    } catch (err) {
      const hold = vendorRefreshHold(err, Date.now());
      // PostHog's throttle is the project's, not the recording's: the next recording would meet it too, so the sweep waits it out and asks for this one again.
      if (hold.why === "rate_limit") {
        const retryAfter = (err as { retry_after_ms?: number }).retry_after_ms ?? 0;
        await ctx.scheduler.runAfter(Math.max(SWEEP_AFTER_FAIL_MS, retryAfter), internal.sources.replayRest.sweep, { source_id: args.source_id, ...(args.before !== undefined ? { before: args.before } : {}) });
        return { started: null };
      }
      await ctx.runMutation(internal.replays.deferVendorRefresh, { replay_id: next.replay_id, ...hold });
      await onAfter(SWEEP_AFTER_FAIL_MS);
    }
    return { started: next.external_id };
  },
});

/**
 * Where a PostHog source's recordings stand, for checking the sweep:
 * `packages/convex/run.sh sources/replayRest:census '{"source_id":"..."}'`.
 * Imported copies whole, cut, of unknown reach, waited out, and the chain
 * reading (or stopped on) a rest.
 */
export const census = internalQuery({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const out = { rows: 0, imported: 0, not_imported: 0, whole: 0, cut: 0, unknown_reach: 0, unknown_short: 0, deferred: {} as Record<string, number>, reading: [] as string[], stopped: [] as { id: string; error: string | null }[], wanted: 0 };
    for await (const r of ctx.db.query("replays").withIndex("by_source_started", (q) => q.eq("source_id", args.source_id))) {
      out.rows++;
      if (!r.imported_at) {
        out.not_imported++;
        continue;
      }
      out.imported++;
      if (r.captured_ms === undefined) (r.duration_ms ?? 0) >= REPLAY_REST_UNKNOWN_MS ? out.unknown_reach++ : out.unknown_short++;
      else if (replayCutAt(r.captured_ms, r.duration_ms) !== null) out.cut++;
      else out.whole++;
      if (r.vendor_refresh_after && r.vendor_refresh_after > now) out.deferred[r.vendor_refresh_why ?? "unknown"] = (out.deferred[r.vendor_refresh_why ?? "unknown"] ?? 0) + 1;
      if (r.import_rest) {
        if (chainLive(r, now)) out.reading.push(r.short_id);
        else out.stopped.push({ id: r.short_id, error: r.import_rest.error ?? null });
      }
      if (sweepWants(r, now)) out.wanted++;
    }
    return out;
  },
});

// ── The tally the Replays tab shows beside the import ──

/** How often the tend cron recounts a source (tally). */
export const TALLY_EVERY_MS = 60 * 60_000;

/** The most of the sweep's queue the tally keeps on the source, for "queued · #N" on a replay page. */
export const TALLY_QUEUE_MAX = 200;

/**
 * One page of a source's recordings, counted: cut short (shared replayCutAt,
 * the list's Partly imported rule, any provider), reach unknown, a live
 * chain, and the ones the sweep would read, linked or not, for its queue.
 */
export const tallyPage = internalQuery({
  args: { source_id: v.id("event_sources"), cursor: v.union(v.string(), v.null()), now: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("replays")
      .withIndex("by_source_started", (q) => q.eq("source_id", args.source_id))
      .paginate({ cursor: args.cursor, numItems: 200 });
    let cut = 0;
    let unknown = 0;
    let reading: { short_id: string; waiting_until?: number } | null = null;
    const wanted: { short_id: string; started_at: number; lane: number }[] = [];
    for (const r of page.page) {
      if (replayCutAt(r.captured_ms, r.duration_ms) !== null) cut++;
      if (!r.imported_at || r.provider !== "posthog") continue;
      if (r.captured_ms === undefined && (r.duration_ms ?? 0) >= REPLAY_REST_UNKNOWN_MS) unknown++;
      if (!reading && r.import_rest && chainLive(r, args.now)) reading = { short_id: r.short_id, ...(r.import_rest.retry_at && r.import_rest.retry_at > args.now ? { waiting_until: r.import_rest.retry_at } : {}) };
      if (r.started_at >= args.now - SWEEP_MAX_AGE_MS && sweepWants(r, args.now)) wanted.push({ short_id: r.short_id, started_at: r.started_at, lane: sweepLane(r, args.now) });
    }
    return { cut, unknown, reading, wanted, cursor: page.continueCursor, done: page.isDone };
  },
});

/** The sweep's order: by lane (sweepLane), each newest first. */
export function sweepQueue(rows: readonly { short_id: string; started_at: number; lane: number }[], max = TALLY_QUEUE_MAX): string[] {
  return [...rows].sort((a, b) => a.lane - b.lane || b.started_at - a.started_at).slice(0, max).map((r) => r.short_id);
}

export const saveTally = internalMutation({
  args: { source_id: v.id("event_sources"), cut: v.number(), unknown: v.number(), reading: v.optional(v.string()), waiting_until: v.optional(v.number()), queue: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const { source_id, ...tally } = args;
    const old = (await ctx.db.get(source_id))?.replay_rest;
    // The recount before this one, by its own count, so the line can say how the backlog moved since.
    const prev = old ? { cut: old.counted ?? old.cut, at: old.at } : undefined;
    await ctx.db.patch(source_id, { replay_rest: { ...tally, at: Date.now(), counted: args.cut, ...(prev ? { prev } : {}) } });
  },
});

/** Count a PostHog source's cut copies and the chain reading one, onto the source row (event_sources.replay_rest). */
export const tally = internalAction({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    const now = Date.now();
    let cursor: string | null = null;
    let cut = 0;
    let unknown = 0;
    let reading: { short_id: string; waiting_until?: number } | null = null;
    const wanted: { short_id: string; started_at: number; lane: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const page: any = await ctx.runQuery(internal.sources.replayRest.tallyPage, { source_id: args.source_id, cursor, now });
      cut += page.cut;
      unknown += page.unknown;
      reading = reading ?? page.reading;
      wanted.push(...page.wanted);
      if (page.done) break;
      cursor = page.cursor;
    }
    const queue = sweepQueue(wanted.filter((w) => w.short_id !== reading?.short_id));
    await ctx.runMutation(internal.sources.replayRest.saveTally, { source_id: args.source_id, cut, unknown, queue, ...(reading ? { reading: reading.short_id, ...(reading.waiting_until ? { waiting_until: reading.waiting_until } : {}) } : {}) });
    return { cut, unknown, reading };
  },
});
