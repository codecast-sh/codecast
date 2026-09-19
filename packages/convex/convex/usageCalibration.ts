// How many tokens one percentage point of a usage window is worth.
//
// The provider never says. `/api/oauth/usage` answers with `{kind, percent,
// resets_at}` per window and nothing else — limit_dollars, used_dollars and
// remaining_dollars are all null on subscription plans, and the rate-limit
// headers carry the same two numbers. So a surface that wants to say "restarting
// these spends a third of what is left" has to measure the rate itself, by
// watching our own traffic move our own meters.
//
// The fit is deliberately coarse and global. Every run pairs, per user, the
// cost-weighted tokens their sessions billed in one slot against how far their
// account meters moved over the same slot. One user-slot is one sample; the
// published rate is the median of the recent ones, so a single odd window (a
// device that was offline, a person working outside codecast) cannot move it.
// One rate serves every account: plans differ, but a shared estimate that stays
// current beats a per-account number nobody has enough samples to fit.
//
// The two halves are aligned but not identical spans: tokens are summed over a
// whole slot, while the meters are read whenever the cron happens to fire inside
// it, so each sample is offset by that fire time. Over steady traffic the offset
// cancels; over a burst it does not, which is one more reason the published rate
// is a median of many samples rather than the newest one.
//
// What the estimate cannot see, stated plainly: usage codecast did not record
// (another machine, the web app, a session whose daemon was down) still moves the
// meter, so those slots read as "many percent for few tokens" and inflate the
// rate. The median absorbs a few; requiring every one of a user's devices to have
// reported a fresh snapshot in BOTH readings removes most of the rest.

import { internalMutation, internalQuery, query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { weightedTokens, type UsageCalibration } from "@codecast/shared/contracts";

/** One slot of traffic. Long enough that an integer percent moves by more than
 *  its own rounding error, short enough that a 5h window holds several. */
export const CALIBRATION_SLOT_MS = 20 * 60 * 1000;

/** Which slot a moment falls in. Shared with messages.rollUpUsage, which stamps
 *  the bucket this job reads. */
export function calibrationSlot(now: number): number {
  return Math.floor(now / CALIBRATION_SLOT_MS);
}

/** Percent is reported as an integer, so a small move is mostly rounding: at 1
 *  point the reading is ±50%, at 4 it is ±12%. Samples below this are dropped
 *  rather than averaged, because averaging noise in still shifts the median. */
export const MIN_PERCENT_DELTA = 4;

/** How many samples the published median is taken over. */
export const SAMPLE_WINDOW = 40;

/** Work capped per run. A calibration is a background nicety and must never be
 *  the mutation that spends the backend's budget: one rate needs a handful of
 *  samples, not every user in the fleet every twenty minutes. */
export const MAX_DEVICES_PER_RUN = 400;
export const MAX_USERS_PER_RUN = 40;

/** A snapshot must be no older than this to count as a reading of the slot it is
 *  paired with; a stale one describes usage from before the slot began. */
export const SNAPSHOT_FRESH_MS = 2 * CALIBRATION_SLOT_MS;

export type WindowReading = { key: string; percent: number; resets_at?: number; fetched_at?: number };

/** Every limit window a user's devices report right now, one entry per account
 *  and window kind. Keyed so the next run can pair the same window with itself —
 *  and the key carries `resets_at`, so a window that rolled between two readings
 *  never pairs with its own successor. */
export function windowReadingsOf(devices: any[]): WindowReading[] {
  const out = new Map<string, WindowReading>();
  for (const device of devices) {
    for (const profile of device.cc_accounts?.profiles ?? []) {
      const usage = profile.usage;
      const session = usage?.session;
      if (!usage || !session || typeof session.percent !== "number") continue;
      const key = `${profile.email || profile.name}`;
      // Several devices report the same account; the freshest reading wins.
      const seen = out.get(key);
      if (seen && (seen.fetched_at ?? 0) >= usage.fetched_at) continue;
      out.set(key, { key, percent: session.percent, resets_at: session.resets_at, fetched_at: usage.fetched_at });
    }
  }
  return [...out.values()];
}

/** Two readings describe the SAME window. The reset time is the identity, but it
 *  cannot be compared exactly: the provider recomputes it per request and returns
 *  a different sub-second fraction every time (measured 2026-09-18, one window
 *  answering …18:20:00.327288 and …18:20:00.582121 seconds apart). Exact equality
 *  therefore rejects every pair and the fit never sees a rise. A window's reset is
 *  stable to the minute, and windows are hours long, so a couple of minutes of
 *  tolerance separates "same window" from "the next one" with room to spare. */
export const WINDOW_MATCH_TOLERANCE_MS = 2 * 60 * 1000;

export function sameWindow(a: WindowReading, b: WindowReading): boolean {
  if (a.resets_at == null || b.resets_at == null) return a.resets_at === b.resets_at;
  return Math.abs(a.resets_at - b.resets_at) <= WINDOW_MATCH_TOLERANCE_MS;
}

/** How far a user's meters moved between two readings: the summed rise across
 *  every window present in BOTH, still inside the same window, and rising. A
 *  window that rolled, appeared, or fell contributes nothing — a fall means the
 *  reading describes a different window than we think it does.
 *
 *  Staleness is judged PER WINDOW, not per person. People keep many saved
 *  accounts and only the ones in use are polled, so a dormant account's snapshot
 *  is always old; disqualifying a user for holding one threw away exactly the
 *  heavy users this fit needs (measured: the two users whose meters moved were
 *  the two dropped). A window nobody re-read contributes nothing instead. */
export function percentRise(
  before: WindowReading[],
  after: WindowReading[],
  at?: { before: number; after: number },
): number {
  const fresh = (w: WindowReading, asOf: number | undefined) =>
    asOf === undefined || w.fetched_at === undefined || asOf - w.fetched_at <= SNAPSHOT_FRESH_MS;
  const prior = new Map(before.map((w) => [w.key, w]));
  let rise = 0;
  for (const now of after) {
    const was = prior.get(now.key);
    if (!was || !sameWindow(was, now)) continue;
    if (!fresh(was, at?.before) || !fresh(now, at?.after)) continue;
    if (now.percent > was.percent) rise += now.percent - was.percent;
  }
  return rise;
}

/** The published rate: the median of the recent samples. Median, not mean, so
 *  one slot where a person also worked outside codecast cannot drag it. */
export function medianOf(samples: number[]): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Fold a run's new samples into the stored window and republish the median. */
export function foldSamples(recent: number[], fresh: number[]): { recent: number[]; rate: number | null } {
  const next = [...recent, ...fresh].slice(-SAMPLE_WINDOW);
  return { recent: next, rate: medianOf(next) };
}

// ---------------------------------------------------------------------------

/** The rate, for anyone who renders a cost against a window. Public because the
 *  banner reads it; it names no account and no person, only a fleet-wide rate. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<UsageCalibration | null> => {
    const row = await ctx.db.query("usage_calibration").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (!row?.tokens_per_percent) return null;
    return {
      tokens_per_percent: row.tokens_per_percent,
      samples: row.samples ?? 0,
      updated_at: row.updated_at,
    };
  },
});

/** The fit's working state, for operating it: when the last reading was taken,
 *  which slot it belongs to, how many users it covered, and the samples behind
 *  the published rate. Internal — it is a diagnostic, not a surface. */
export const diag = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("usage_calibration").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (!row) return null;
    const now = Date.now();
    return {
      rate: row.tokens_per_percent ?? null,
      recent: row.recent ?? [],
      updated_ago_ms: now - row.updated_at,
      last_sample_at_ago_ms: row.last_sample ? now - row.last_sample.at : null,
      last_sample_slot: row.last_sample?.slot ?? null,
      current_slot: calibrationSlot(now),
      users_in_last_sample: row.last_sample?.users.length ?? 0,
      last_run: row.last_run ?? null,
    };
  },
});

/** One calibration run: read the slot that just closed, pair it with the meters,
 *  store this run's reading for the next one to diff against. A run whose
 *  predecessor did not land in the slot being summed takes no sample — cron
 *  drift makes that happen now and then, and a missed sample costs nothing
 *  while a mispaired one would move the published rate. */
export const sample = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const slot = calibrationSlot(now) - 1; // the slot that just closed
    const row = await ctx.db.query("usage_calibration").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    const before = row?.last_sample;

    // Every user whose devices report a limit window. The meters are the scarce
    // half of the pair, so they decide whose traffic is worth summing.
    const devices = await ctx.db.query("devices").take(MAX_DEVICES_PER_RUN);
    const byUser = new Map<string, any[]>();
    for (const device of devices) {
      if (!device.user_id) continue;
      const key = String(device.user_id);
      (byUser.get(key) ?? byUser.set(key, []).get(key)!).push(device);
    }

    const users: { user_id: Id<"users">; windows: WindowReading[] }[] = [];
    const fresh: number[] = [];
    // Why a run produced nothing is the first question anyone asks of a fitted
    // number, so every rejection is counted and returned rather than inferred
    // from a silent zero.
    const skipped = { unpaired: 0, below_floor: 0, no_tokens: 0 };
    // The largest rise any user showed, kept even when nothing qualified: it is
    // the difference between "nobody is working" and "the floor is too high".
    let bestRise = 0;
    for (const [userKey, userDevices] of [...byUser].slice(0, MAX_USERS_PER_RUN)) {
      const windows = windowReadingsOf(userDevices);
      if (!windows.length) continue;
      const userId = userDevices[0].user_id as Id<"users">;
      users.push({ user_id: userId, windows });

      // Pair with the previous reading. Both halves must describe the same slot:
      // no previous reading, or one taken outside the slot, means no sample.
      const prior = before?.users.find((u) => String(u.user_id) === userKey);
      if (!prior || !before || before.slot !== slot) { skipped.unpaired++; continue; }
      const rise = percentRise(prior.windows, windows, { before: before.at, after: now });
      bestRise = Math.max(bestRise, rise);
      if (rise < MIN_PERCENT_DELTA) { skipped.below_floor++; continue; }

      const tokens = await slotTokensForUser(ctx, userId, slot, now);
      if (tokens <= 0) { skipped.no_tokens++; continue; }
      fresh.push(tokens / rise);
    }

    const folded = foldSamples(row?.recent ?? [], fresh);
    const patch = {
      key: "global" as const,
      updated_at: now,
      recent: folded.recent,
      samples: folded.recent.length,
      ...(folded.rate != null ? { tokens_per_percent: folded.rate } : {}),
      last_sample: { at: now, slot: calibrationSlot(now), users },
      last_run: { users: users.length, added: fresh.length, ...skipped, best_rise: bestRise },
    };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("usage_calibration", patch);
    return { samples: folded.recent.length, added: fresh.length, rate: folded.rate, users: users.length, skipped };
  },
});

/** Cost-weighted tokens one user's sessions billed inside `slot`. Reads only the
 *  conversations that were touched around it (by_user_updated), and each carries
 *  its own slot stamp, so a row that last billed in an earlier slot contributes
 *  nothing. */
async function slotTokensForUser(ctx: any, userId: Id<"users">, slot: number, now: number): Promise<number> {
  const since = (slot - 1) * CALIBRATION_SLOT_MS;
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q: any) => q.eq("user_id", userId).gt("updated_at", since))
    .take(500);
  let total = 0;
  for (const conv of rows) {
    const totals = conv.usage_totals;
    if (!totals || totals.slot !== slot) continue;
    total += totals.slot_weighted ?? 0;
  }
  return total;
}

// Re-exported so messages.rollUpUsage stamps the same slot this job reads.
export { weightedTokens };
