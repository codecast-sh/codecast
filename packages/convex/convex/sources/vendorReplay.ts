// Importing a vendor's recording (docs/architecture/external-data.md X5, X7):
// the steps PostHog and Sentry share. A mirrored recording is a replay row
// with no chunks until it is first read; then the adapter reads its rrweb
// events from the vendor, fromRrweb turns them into the semantic stream, and
// replays.importExternal stores them like our own recordings. After that the
// recording is served from our copy and the vendor is not asked again.
//
// The rrweb capture itself is kept too, masked (prepareDomCapture: no typed
// value, nothing private), as DOM chunks beside the stream, so the player can
// play the recording and agents can see frames of it
// (contracts/replayPlayer.ts). A PostHog mobile recording, which holds
// wireframes rather than a DOM, is converted to a plain page first
// (shared/replay/mobile.ts); readVendorCapture does both reads. A capture
// rrweb could not draw (no full snapshot of a page) is not kept. It is uploaded here, in the adapter's action,
// because a capture of tens of MB cannot ride an action's arguments.
//
// Each adapter supplies only the read: PostHog's snapshots (sources/posthog.ts)
// or Sentry's recording segments (sources/sentry.ts). `importLinked` is the
// door for a replay row that already exists (a Sentry replay linked to an
// issue, a PostHog recording listed before), used by `cast replay show` and
// the web replay page alike.
import { v } from "convex/values";
import { action } from "../functions";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { readVendorCapture, type CaptureCarry, type RrwebEvent } from "@codecast/shared/replay";
import { gzipSync, strFromU8, strToU8 } from "fflate";
import { REPLAYS_ROOT, r2Presign, replaysBucketFromEnv, safeReplayPathSegment, type R2Bucket } from "../lib/r2";
import { sha256Hex } from "../lib/hash";
import { readBodyCapped } from "../lib/tokenHttp";
import { gunzipCapped, putChunk, storeReplayDom } from "../replays";
import { REPLAY_LIMITS } from "@codecast/shared/contracts/replay";
import { REPLAY_DOM_LIMITS } from "@codecast/shared/contracts/replayPlayer";
import { REPLAY_REST, VENDOR_REFRESH_RETRY, needsRest, needsVendorImport, type VendorRefreshWhy } from "@codecast/shared/contracts/replay";

/** What an adapter read of one recording. */
export interface VendorRecording {
  events: RrwebEvent[];
  /** The read stopped at a byte or page cap: the import holds the recording's beginning. */
  truncated: boolean;
  started_at?: number;
  user?: { id?: string; email?: string };
  /** The vendor's own length for the recording: a floor under the stream's, which a size cap or an open tab can cut short. */
  length_ms?: number;
  /** The read held the recording's first part: where the next part starts, of how many blobs (sources/replayRest.ts). */
  rest?: { next_blob: number; blobs: number };
  /** Where the read stopped, whole or not, so a recording the vendor keeps writing is read on from there (replays.read_to). */
  read_to?: { next_blob: number; blobs: number };
  /** The vendor is still writing the recording (PostHog realtime): its later parts are not readable yet. */
  realtime?: boolean;
}

export interface ImportOutcome {
  replay_id: Id<"replays">;
  short_id: string;
  /** False when the recording was already ours and nothing was read. */
  imported: boolean;
  truncated: boolean;
  /**
   * Nothing was read, and why: the copy is whole (or holds all the vendor
   * has), a chain is already reading the rest, or the vendor is being waited
   * out until `until`. Absent when something was read.
   */
  declined?: { why: "whole" | "reading" | VendorRefreshWhy; until?: number };
}

/**
 * A vendor call that failed, keeping what a caller acts on: the status (a
 * refused token stops a bulk import, a 429 waits) and the vendor's
 * Retry-After. The message is the adapter's, safe to show.
 */
export class VendorCallError extends Error {
  readonly status?: number;
  readonly retry_after_ms?: number;
  /** The source has no working connection (none stored, or the vendor refused the token). */
  readonly lost?: boolean;
  constructor(failure: { error: string; status?: number; retry_after_ms?: number; lost?: boolean }) {
    super(failure.error);
    this.name = "VendorCallError";
    if (failure.status) this.status = failure.status;
    if (failure.lost || failure.status === 401 || failure.status === 403) this.lost = true;
    if (failure.retry_after_ms !== undefined) this.retry_after_ms = failure.retry_after_ms;
  }
}

type ImportCtx = { runQuery: (ref: any, args: any) => Promise<any>; runAction: (ref: any, args: any) => Promise<any>; runMutation?: (ref: any, args: any) => Promise<any> };

/**
 * Import one vendor recording the first time, or answer the copy already
 * imported. `read` runs only when there is no copy (or `force`), so a second
 * read of the same recording calls the vendor not at all. With `rest`, a web
 * recording the read cut short goes on to read its later parts in the
 * background (sources/replayRest.ts), from where this read stopped.
 */
export async function importVendorRecording(
  ctx: ImportCtx,
  input: { source_id: Id<"event_sources">; provider: "posthog" | "sentry"; external_id: string },
  read: () => Promise<VendorRecording>,
  opts: { rest?: boolean; force?: boolean } = {},
): Promise<ImportOutcome> {
  const known = await ctx.runQuery(internal.replays.importedReplays, { source_id: input.source_id, external_ids: [input.external_id] });
  const existing = known[input.external_id];
  if (existing?.imported && !opts.force) return { replay_id: existing.replay_id, short_id: existing.short_id, imported: false, truncated: false };
  // A current copy that stops short of the recording is read on from where it stopped, never again from its start (that would replace an hour of it with fifteen minutes).
  if (existing?.imported && opts.rest && input.provider === "posthog") {
    const resumed: { started: boolean } = await ctx.runAction(internal.sources.replayRest.resume, { replay_id: existing.replay_id });
    if (resumed.started) return { replay_id: existing.replay_id, short_id: existing.short_id, imported: false, truncated: true };
  }
  const rec = await read();
  const user = rec.user && (rec.user.id || rec.user.email)
    ? { ...(rec.user.id ? { id: rec.user.id.slice(0, 200) } : {}), ...(rec.user.email ? { email: rec.user.email.slice(0, 200) } : {}) }
    : undefined;
  const capture = readVendorCapture(rec.events);
  const events = capture.events;
  const dom = capture.dom ? await storeDomCapture(input, capture.dom) : null;
  // The converter's state where the read stopped, kept so the next part (now, or once the vendor has written more) reads on from there.
  const carry_key = rec.read_to && capture.carry && dom ? await storeCarryQuietly(input, capture.carry) : null;
  const imported = await ctx.runAction(internal.replays.importExternal, {
    source_id: input.source_id,
    provider: input.provider,
    external_id: input.external_id,
    events,
    ...(rec.started_at ? { started_at: rec.started_at } : {}),
    ...(user ? { user } : {}),
    ...(dom ? { dom_chunk_keys: dom.dom_chunk_keys, dom_chunk_meta: dom.dom_chunk_meta, dom_bytes: dom.dom_bytes, dom_t0: dom.dom_t0 } : {}),
    ...(capture.end_t > 0 ? { capture_end_t: capture.end_t } : {}),
    ...(rec.length_ms && rec.length_ms > 0 ? { vendor_length_ms: Math.round(rec.length_ms) } : {}),
    // A recording the vendor is still writing is never whole yet, however much of it was read.
    ...(rec.truncated || rec.realtime ? {} : { whole: true }),
    ...(rec.read_to && dom ? { read_to: { ...rec.read_to, ...(carry_key ? { carry_key } : {}), at: Date.now() } } : {}),
  });
  // The copy already held more than this read (replays.importShrinks): it stays as it was.
  if (!imported.saved) return { replay_id: imported.replay_id, short_id: imported.short_id, imported: false, truncated: false };
  if (opts.rest && (rec.truncated || rec.realtime) && ctx.runMutation) {
    if (rec.rest && capture.carry && dom) await beginImportRest(ctx as Required<ImportCtx>, { replay_id: imported.replay_id, source_id: input.source_id, external_id: input.external_id, carry: capture.carry, rest: rec.rest });
    // A start whose rest cannot be read part by part: a recording PostHog is still writing (its parts exist in minutes), or a mobile capture. Opening it again must not read the start again before then.
    else if (rec.realtime) await ctx.runMutation(internal.replays.deferVendorRefresh, { replay_id: imported.replay_id, retry_at: Date.now() + VENDOR_REFRESH_RETRY.realtime_ms, why: "realtime" });
    else await ctx.runMutation(internal.replays.deferVendorRefresh, { replay_id: imported.replay_id, retry_at: Date.now() + VENDOR_REFRESH_RETRY.failed_ms, why: "unsplittable" });
  }
  return { replay_id: imported.replay_id, short_id: imported.short_id, imported: true, truncated: rec.truncated };
}

/**
 * The masked capture stored as DOM chunks, or null when there is no bucket.
 * A failed upload costs the player, not the import: the stream still lands.
 */
async function storeDomCapture(input: { source_id: Id<"event_sources">; external_id: string }, events: RrwebEvent[]) {
  const bucket = replaysBucketFromEnv();
  if (!bucket) return null;
  try {
    return await storeReplayDom(bucket, { source_id: String(input.source_id), external_id: input.external_id, events });
  } catch (err) {
    console.warn(`replay DOM capture for ${input.external_id} not stored: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The adapter's words for a recording the vendor no longer has (past retention, deleted). */
const VENDOR_GONE = /answered 4(?:04|10)\b|has nothing at|has no snapshots for recording/;

/**
 * When a failed refresh may ask the vendor again: a month once it says the
 * recording is gone, else an hour or its Retry-After. The adapter runs as its
 * own action, so its VendorCallError arrives as a plain Error and the gone
 * case is read from the adapter's message as well as its status.
 */
export function vendorRefreshRetryAt(err: unknown, now: number): number {
  return vendorRefreshHold(err, now).retry_at;
}

/** vendorRefreshRetryAt, with the reason the page shows beside the time. */
export function vendorRefreshHold(err: unknown, now: number): { retry_at: number; why: VendorRefreshWhy } {
  const status = err instanceof VendorCallError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404 || status === 410 || VENDOR_GONE.test(message)) return { retry_at: now + VENDOR_REFRESH_RETRY.gone_ms, why: "gone" };
  const after = err instanceof VendorCallError ? (err.retry_after_ms ?? 0) : 0;
  const limited = status === 429 || /answered 429\b|rate.?limit|throttl/i.test(message);
  return { retry_at: now + Math.max(VENDOR_REFRESH_RETRY.failed_ms, after), why: limited ? "rate_limit" : "failed" };
}

/**
 * A replay row the caller may read, imported from its vendor if it is a
 * mirrored recording not imported yet. Our own SDK recordings and imported
 * ones answer at once. Access is the replay's workspace (recordingForImport);
 * the adapter then runs as the source, whose connection the caller never sees.
 */
export const importLinked = action({
  args: { api_token: v.optional(v.string()), replay: v.string() },
  handler: async (ctx, args): Promise<ImportOutcome> => {
    const r = await ctx.runQuery(internal.replays.recordingForImport, args);
    const now = Date.now();
    const done = { replay_id: r.replay_id, short_id: r.short_id, imported: false, truncated: false };
    // A PostHog copy holding only the start of its recording, with no chain reading the rest: read it again from the start and go on to the rest.
    const rest = r.provider === "posthog" && !needsVendorImport(r) && needsRest(r, now);
    if (!needsVendorImport(r) && !rest) return { ...done, declined: declinedWhy(r, now) };
    const adapter = r.provider === "posthog" ? internal.sources.posthog.importForSource : r.provider === "sentry" ? internal.sources.sentry.importReplay : null;
    if (!adapter) return { ...done, declined: { why: "whole" } };
    try {
      if (r.provider === "posthog") return await ctx.runAction(internal.sources.posthog.importForSource, { source_id: r.source_id, external_id: r.external_id, rest: true, ...(rest ? { force: true } : {}) });
      return await ctx.runAction(adapter, { source_id: r.source_id, external_id: r.external_id });
    } catch (err) {
      // A copy made by an older converter still reads; refreshing it waits
      // for the vendor (a rate limit, an outage, a recording past its
      // retention), and the row says how long, so the reads in between do
      // not each call the vendor again.
      if (!r.imported_at) throw err;
      const hold = vendorRefreshHold(err, Date.now());
      await ctx.runMutation(internal.replays.deferVendorRefresh, { replay_id: r.replay_id, ...hold });
      return { ...done, declined: { why: hold.why, until: hold.retry_at } };
    }
  },
});

// ── A long recording's later parts (sources/replayRest.ts) ──

/** How long a chain may go without a step before it is taken for dead (shared REPLAY_REST). */
export const REST_STALL_MS = REPLAY_REST.stall_ms;
export const REACH_UNKNOWN_MS = REPLAY_REST.reach_unknown_ms;
export { needsRest };

/** Why importLinked read nothing for a copy it was asked about. */
function declinedWhy(r: { vendor_refresh_after: number | null; vendor_refresh_why?: VendorRefreshWhy | null; import_rest: { retry_at?: number; error?: string; updated_at: number } | null }, now: number): NonNullable<ImportOutcome["declined"]> {
  if (r.vendor_refresh_after && r.vendor_refresh_after > now) return { why: r.vendor_refresh_why ?? "failed", until: r.vendor_refresh_after };
  const c = r.import_rest;
  if (c && !c.error && ((c.retry_at ?? 0) > now || now - c.updated_at <= REST_STALL_MS)) return { why: "reading", ...(c.retry_at && c.retry_at > now ? { until: c.retry_at } : {}) };
  return { why: "whole" };
}

/**
 * Keep the converter's state where a part ended, gzipped in R2 beside the
 * recording (content addressed, under the replays root so it expires with
 * the recording's chunks). Answers its key.
 */
export async function storeCarry(bucket: R2Bucket, input: { source_id: string; external_id: string }, carry: CaptureCarry): Promise<string> {
  const gz = gzipSync(strToU8(JSON.stringify(carry)));
  const key = `${REPLAYS_ROOT}${input.source_id}/${safeReplayPathSegment(input.external_id)}/carry/${await sha256Hex(gz)}.json.gz`;
  await putChunk(bucket, key, gz);
  return key;
}

/** storeCarry for an import: a failure costs reading on later, not the import. */
async function storeCarryQuietly(input: { source_id: Id<"event_sources">; external_id: string }, carry: CaptureCarry): Promise<string | null> {
  const bucket = replaysBucketFromEnv();
  if (!bucket) return null;
  try {
    return await storeCarry(bucket, { source_id: String(input.source_id), external_id: input.external_id }, carry);
  } catch (err) {
    console.warn(`replay ${input.external_id}: carry not kept: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The state storeCarry kept, or null when it is gone or unreadable. */
export async function readCarry(bucket: R2Bucket, key: string): Promise<CaptureCarry | null> {
  const res = await fetch(await r2Presign(bucket, "GET", key, REPLAY_LIMITS.signed_url_ttl_s));
  // A heavy page's converter state gzips past one chunk's cap; storeCarry wrote it whole, so it is read whole.
  const bytes = res.ok ? await readBodyCapped(res, 3 * REPLAY_DOM_LIMITS.chunk_max_bytes) : null;
  if (!res.ok) await res.body?.cancel().catch(() => {});
  if (!bytes) return null;
  const gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const json = gz ? gunzipCapped(bytes, REPLAY_DOM_LIMITS.chunk_max_inflated_bytes) : bytes;
  if (!json) return null;
  try {
    const carry = JSON.parse(strFromU8(json));
    return carry && carry.converter && carry.scrub ? (carry as CaptureCarry) : null;
  } catch {
    return null;
  }
}

/** After a first part landed: keep where it ended and start reading the rest (replayRest.begin). A failure here costs the rest, not the import. */
export async function beginImportRest(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  input: { replay_id: Id<"replays">; source_id: Id<"event_sources">; external_id: string; carry: CaptureCarry; rest: { next_blob: number; blobs: number } },
): Promise<void> {
  const bucket = replaysBucketFromEnv();
  if (!bucket) return;
  try {
    const carry_key = await storeCarry(bucket, { source_id: String(input.source_id), external_id: input.external_id }, input.carry);
    await ctx.runMutation(internal.sources.replayRest.begin, { replay_id: input.replay_id, carry_key, next_blob: input.rest.next_blob, blobs: input.rest.blobs });
  } catch (err) {
    console.warn(`replay ${input.external_id}: the rest was not queued: ${err instanceof Error ? err.message : String(err)}`);
  }
}
