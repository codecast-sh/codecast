// One drain on its way per key.
//
// A drain that delivers a whole batch makes every other job scheduled for the
// same key a no-op, and each no-op still costs the scheduler a slot. So the
// writer that makes work pending asks claimDrain first and schedules only when
// it wins.
//
// The marker is a point read for every writer and a write only on the edges:
// when the key goes from idle to busy (claim) and when a drain finds nothing
// left (release). That suits a key whose writers are few and tolerant of a
// retry (a repository's CI webhooks). It does not suit a key that turns over
// many times a second under user saves: the sync outbox tried it on
// 2026-10-14 and busy scopes' saves exhausted their retries on the marker.

type Ctx = { db: any };

async function markersFor(ctx: Ctx, key: string) {
  return await ctx.db.query("drain_markers").withIndex("by_key", (q: any) => q.eq("key", key)).collect();
}

/**
 * True when the caller should schedule a drain for `key`: none is on its way,
 * or (with `staleMs`) the one on its way was scheduled so long ago that it was
 * lost.
 */
export async function claimDrain(ctx: Ctx, key: string, opts: { staleMs?: number } = {}): Promise<boolean> {
  const marker = (await markersFor(ctx, key))[0];
  const now = Date.now();
  if (marker?.scheduled && (opts.staleMs === undefined || now - marker.scheduled_at < opts.staleMs)) return false;
  if (marker) await ctx.db.patch(marker._id, { scheduled: true, scheduled_at: now });
  else await ctx.db.insert("drain_markers", { key, scheduled: true, scheduled_at: now });
  return true;
}

/** A drain that scheduled its own next pass keeps the claim fresh. */
export async function renewDrain(ctx: Ctx, key: string): Promise<void> {
  for (const marker of await markersFor(ctx, key)) await ctx.db.patch(marker._id, { scheduled: true, scheduled_at: Date.now() });
}

/** A drain that found nothing left hands the key back to the next writer. */
export async function releaseDrain(ctx: Ctx, key: string): Promise<void> {
  for (const marker of await markersFor(ctx, key)) if (marker.scheduled) await ctx.db.patch(marker._id, { scheduled: false });
}
