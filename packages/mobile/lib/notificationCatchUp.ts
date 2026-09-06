// Notification catch-up for a phone that was offline (ct-49553).
//
// A push that arrives while the app is asleep, killed or out of signal is gone:
// the server's outbox deletes the row the moment it ships, so the only thing
// the phone could ever reconstruct was the single notification it was last
// tapped from. The backend now keeps a 256-entry ring of routed pushes stamped
// with a monotonic seq and the epoch that counter belongs to; this module holds
// the phone's half — the persisted watermark, and the decision about which
// missed entries may still be shown.
//
// Two things must never happen. A notification the OS already showed must not
// come back as a replayed copy, and a replay must not fire twice. The first is
// the `seen` set (every key this device has delivered or replayed) widened at
// call time by the notifications iOS still holds in its tray. The second is the
// local notification identifier: `${host}#${key}` is stable, so presenting the
// same entry again replaces the banner instead of adding one.
//
// The host is part of every key because a seq means nothing across backends: a
// phone pointed at a local deployment and then at prod would otherwise compare
// its watermark against a counter that never produced it.

export type CatchUpStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type CatchUpWatermark = {
  /** Highest routed-push seq this device has accounted for, under `epoch`. */
  seq: number;
  /** The counter lifetime `seq` belongs to; null until the first stamped push. */
  epoch: string | null;
  /** Keys already delivered or replayed here, oldest first. */
  seen: string[];
};

export type MissedNotification = {
  key: string;
  seq: number;
  epoch: string;
  title: string;
  subtitle?: string;
  body: string;
  data?: unknown;
  channel_id?: string;
  interruption_level?: string;
};

// Matches the server ring's capacity: remembering fewer keys than the server
// can replay would let the oldest entry of a full catch-up fire twice.
export const MAX_REMEMBERED_KEYS = 256;

// A phone that has been away for hours can be owed the whole ring. Showing 256
// banners is not catching up, it is carpet bombing, so only the newest few are
// presented; the rest are marked accounted-for and the in-app notification list
// (which reads the notifications table) remains the complete record.
export const MAX_REPLAYED = 5;

export const EMPTY_WATERMARK: CatchUpWatermark = { seq: 0, epoch: null, seen: [] };

/** The local notification identifier — stable per backend and per entry. */
export function notificationKey(host: string, key: string): string {
  return `${host}#${key}`;
}

export function watermarkStorageKey(host: string, userId: string): string {
  return `notifCatchUp:${host}:${userId}`;
}

function sanitize(value: unknown): CatchUpWatermark {
  if (!value || typeof value !== "object") return EMPTY_WATERMARK;
  const raw = value as Partial<CatchUpWatermark>;
  const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0;
  const epoch = typeof raw.epoch === "string" && raw.epoch ? raw.epoch : null;
  const seen = Array.isArray(raw.seen) ? raw.seen.filter((k): k is string => typeof k === "string") : [];
  return { seq, epoch, seen: seen.slice(-MAX_REMEMBERED_KEYS) };
}

export async function loadWatermark(
  storage: CatchUpStorage,
  host: string,
  userId: string,
): Promise<CatchUpWatermark> {
  try {
    const stored = await storage.getItem(watermarkStorageKey(host, userId));
    return stored ? sanitize(JSON.parse(stored)) : EMPTY_WATERMARK;
  } catch {
    // A corrupt or unreadable watermark reads as "never caught up": the next
    // pass asks with seq 0 and an unknown epoch, which the server answers with
    // the ring, and the seen set keeps that from double firing.
    return EMPTY_WATERMARK;
  }
}

export async function saveWatermark(
  storage: CatchUpStorage,
  host: string,
  userId: string,
  watermark: CatchUpWatermark,
): Promise<void> {
  try {
    await storage.setItem(watermarkStorageKey(host, userId), JSON.stringify(watermark));
  } catch {
    // Losing the write costs a redundant catch-up, never a duplicate banner.
  }
}

function remember(seen: string[], keys: string[]): string[] {
  const next = seen.filter((k) => !keys.includes(k));
  next.push(...keys);
  return next.slice(-MAX_REMEMBERED_KEYS);
}

/**
 * A push this device just received live. It came off the live counter, so its
 * epoch is authoritative: adopting it is what keeps a phone that reinstalled,
 * or met a rotated counter, from carrying a watermark nothing can answer.
 */
export function recordDelivered(
  host: string,
  watermark: CatchUpWatermark,
  push: { key: string; seq: number; epoch: string },
): CatchUpWatermark {
  const sameEpoch = watermark.epoch === push.epoch;
  return {
    epoch: push.epoch,
    seq: sameEpoch ? Math.max(watermark.seq, push.seq) : push.seq,
    seen: remember(watermark.seen, [notificationKey(host, push.key)]),
  };
}

export type CatchUpPlan = {
  /** Entries to present locally, oldest first. */
  present: MissedNotification[];
  watermark: CatchUpWatermark;
};

/**
 * What to show, given what the server still holds. `missed` is the server's
 * answer (newer entries under a matching epoch, the whole ring under a stale
 * one), `presentedKeys` the host-qualified keys iOS is still showing — a push
 * the OS delivered while the app was killed never reached the live listener,
 * and replaying it would be the double fire.
 */
export function planCatchUp(input: {
  host: string;
  watermark: CatchUpWatermark;
  missed: MissedNotification[];
  epoch?: string | null;
  presentedKeys?: string[];
}): CatchUpPlan {
  const { host, watermark, missed } = input;
  const known = new Set([...watermark.seen, ...(input.presentedKeys ?? [])]);
  const ordered = [...missed].sort((a, b) => a.seq - b.seq);
  // A device with no epoch has never been stamped — a fresh install, or a
  // watermark that could not be read. It did not MISS these; it was not there
  // for them. So it adopts the counter silently instead of opening with a stack
  // of banners about things that happened before it existed.
  const fresh =
    watermark.epoch === null
      ? []
      : ordered.filter((entry) => !known.has(notificationKey(host, entry.key)));

  const liveEpoch = input.epoch ?? ordered[ordered.length - 1]?.epoch ?? watermark.epoch;
  const sameEpoch = liveEpoch !== null && liveEpoch === watermark.epoch;
  const highest = ordered.length > 0 ? ordered[ordered.length - 1].seq : 0;

  return {
    // Everything older than the newest few is accounted for without a banner.
    present: fresh.slice(-MAX_REPLAYED),
    watermark: {
      epoch: liveEpoch,
      // Any answer with entries names the server's head, and the head is the
      // counter — so adopt it rather than carrying a stored seq forward. That
      // is what heals a watermark left pointing past a counter that restarted;
      // only an empty answer under the same epoch keeps the stored one.
      seq: ordered.length > 0 ? highest : sameEpoch ? watermark.seq : 0,
      seen: remember(
        watermark.seen,
        ordered.map((entry) => notificationKey(host, entry.key)),
      ),
    },
  };
}

/** The {seq, epoch, key} stamp a routed push carries in its payload. */
export function readPushStamp(
  data: unknown,
): { key: string; seq: number; epoch: string } | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (
    typeof raw.notificationKey !== "string" ||
    typeof raw.notificationSeq !== "number" ||
    typeof raw.notificationEpoch !== "string"
  ) {
    return null;
  }
  return {
    key: raw.notificationKey,
    seq: raw.notificationSeq,
    epoch: raw.notificationEpoch,
  };
}
