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
import { readVendorCapture, type RrwebEvent } from "@codecast/shared/replay";
import { replaysBucketFromEnv } from "../lib/r2";
import { storeReplayDom } from "../replays";
import { VENDOR_REFRESH_RETRY, needsVendorImport } from "@codecast/shared/contracts/replay";

/** What an adapter read of one recording. */
export interface VendorRecording {
  events: RrwebEvent[];
  /** The read stopped at a byte or page cap: the import holds the recording's beginning. */
  truncated: boolean;
  started_at?: number;
  user?: { id?: string; email?: string };
}

export interface ImportOutcome {
  replay_id: Id<"replays">;
  short_id: string;
  /** False when the recording was already ours and nothing was read. */
  imported: boolean;
  truncated: boolean;
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

type ImportCtx = { runQuery: (ref: any, args: any) => Promise<any>; runAction: (ref: any, args: any) => Promise<any> };

/**
 * Import one vendor recording the first time, or answer the copy already
 * imported. `read` runs only when there is no copy, so a second read of the
 * same recording calls the vendor not at all.
 */
export async function importVendorRecording(
  ctx: ImportCtx,
  input: { source_id: Id<"event_sources">; provider: "posthog" | "sentry"; external_id: string },
  read: () => Promise<VendorRecording>,
): Promise<ImportOutcome> {
  const known = await ctx.runQuery(internal.replays.importedReplays, { source_id: input.source_id, external_ids: [input.external_id] });
  const existing = known[input.external_id];
  if (existing?.imported) return { replay_id: existing.replay_id, short_id: existing.short_id, imported: false, truncated: false };
  const rec = await read();
  const user = rec.user && (rec.user.id || rec.user.email)
    ? { ...(rec.user.id ? { id: rec.user.id.slice(0, 200) } : {}), ...(rec.user.email ? { email: rec.user.email.slice(0, 200) } : {}) }
    : undefined;
  const capture = readVendorCapture(rec.events);
  const events = capture.events;
  const dom = capture.dom ? await storeDomCapture(input, capture.dom) : null;
  const imported = await ctx.runAction(internal.replays.importExternal, {
    source_id: input.source_id,
    provider: input.provider,
    external_id: input.external_id,
    events,
    ...(rec.started_at ? { started_at: rec.started_at } : {}),
    ...(user ? { user } : {}),
    ...(dom ? { dom_chunk_keys: dom.dom_chunk_keys, dom_bytes: dom.dom_bytes, dom_t0: dom.dom_t0 } : {}),
  });
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
  const status = err instanceof VendorCallError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404 || status === 410 || VENDOR_GONE.test(message)) return now + VENDOR_REFRESH_RETRY.gone_ms;
  const after = err instanceof VendorCallError ? (err.retry_after_ms ?? 0) : 0;
  return now + Math.max(VENDOR_REFRESH_RETRY.failed_ms, after);
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
    const done = { replay_id: r.replay_id, short_id: r.short_id, imported: false, truncated: false };
    if (!needsVendorImport(r)) return done;
    const adapter = r.provider === "posthog" ? internal.sources.posthog.importForSource : r.provider === "sentry" ? internal.sources.sentry.importReplay : null;
    if (!adapter) return done;
    try {
      return await ctx.runAction(adapter, { source_id: r.source_id, external_id: r.external_id });
    } catch (err) {
      // A copy made by an older converter still reads; refreshing it waits
      // for the vendor (a rate limit, an outage, a recording past its
      // retention), and the row says how long, so the reads in between do
      // not each call the vendor again.
      if (!r.imported_at) throw err;
      await ctx.runMutation(internal.replays.deferVendorRefresh, { replay_id: r.replay_id, retry_at: vendorRefreshRetryAt(err, Date.now()) });
      return done;
    }
  },
});
