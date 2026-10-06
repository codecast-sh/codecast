// Importing a vendor's recording (docs/architecture/external-data.md X5, X7):
// the steps PostHog and Sentry share. A mirrored recording is a replay row
// with no chunks until it is first read; then the adapter reads its rrweb
// events from the vendor, fromRrweb turns them into the semantic stream, and
// replays.importExternal stores them like our own recordings. After that the
// recording is served from our copy and the vendor is not asked again.
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
import { fromRrweb, type RrwebEvent } from "@codecast/shared/replay";
import { needsVendorImport } from "@codecast/shared/contracts/replay";

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
  const imported = await ctx.runAction(internal.replays.importExternal, {
    source_id: input.source_id,
    provider: input.provider,
    external_id: input.external_id,
    events: fromRrweb(rec.events),
    ...(rec.started_at ? { started_at: rec.started_at } : {}),
    ...(user ? { user } : {}),
  });
  return { replay_id: imported.replay_id, short_id: imported.short_id, imported: true, truncated: rec.truncated };
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
    if (r.provider === "posthog") return await ctx.runAction(internal.sources.posthog.importForSource, { source_id: r.source_id, external_id: r.external_id });
    if (r.provider === "sentry") return await ctx.runAction(internal.sources.sentry.importReplay, { source_id: r.source_id, external_id: r.external_id });
    return done;
  },
});
