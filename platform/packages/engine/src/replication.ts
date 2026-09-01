// Cross-window replication for a local-first store: one window (the sync
// host) owns the server subscriptions and IndexedDB, every other window (a
// follower) mirrors the replicated slice of its state over a broadcast
// transport. See docs/architecture/sync-host.md in the application repo.
//
// This module is pure protocol + extraction. It knows nothing about
// BroadcastChannel, Web Locks, React, or Convex — the application wires those.
// The seam it builds on: mutativeMiddleware hands EVERY store write's patch
// list to the IDB write-through binding, so a host can tee row-level updates
// for the replicated keys out of the same stream that already drives
// persistence.

import type { Patch } from "mutative";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Row-level changes for one store key, derived from a write's patches. */
export type ReplicationUpdate = {
  key: string;
  /** Collection keys: full rows to upsert (read from post-write state). */
  upserts?: any[];
  /** Collection keys: row ids removed by this write. */
  removes?: string[];
  /** Non-collection keys: the whole new value. */
  value?: any;
  /** Distinguishes `value: undefined` (key cleared) from "no value field". */
  hasValue?: boolean;
};

export type ReplicationMessage =
  /** Follower asks the host for a snapshot (also: host re-announce probe). */
  | { type: "hello"; from: string }
  /** Host answers one follower (`to`) with the full replicated slice. */
  | { type: "snapshot"; hostId: string; seq: number; to: string; entries: Record<string, any> }
  /** Host broadcast of a write's replicated changes. `origin` is the window
   *  the write came from (the host itself, or the follower whose `mut` this
   *  rebroadcasts) so the origin can skip re-applying its own write. */
  | { type: "update"; hostId: string; seq: number; origin: string; updates: ReplicationUpdate[] }
  /** A follower's own optimistic write, offered to the host to apply + relay. */
  | { type: "mut"; from: string; updates: ReplicationUpdate[] };

// ---------------------------------------------------------------------------
// Patch extraction
// ---------------------------------------------------------------------------

/**
 * Distill one write's patches into row-level updates for the replicated keys.
 *
 * Values are read from the post-write state, not from the patches: a patch can
 * be arbitrarily deep ("push one comment onto row X's list"), and re-applying
 * deep patches on the far side would depend on the receiver holding the exact
 * same prior state. Whole rows are self-contained; applying them through the
 * receiver's syncTable/pending machinery is order-safe and idempotent.
 *
 * `isCollectionKey` decides row shape (id-keyed map) vs whole-value; the
 * application derives both sets from its registry.
 */
export function extractReplicationUpdates(
  patches: readonly Patch[],
  state: any,
  isReplicatedKey: (key: string) => boolean,
  isCollectionKey: (key: string) => boolean,
): ReplicationUpdate[] {
  // key → collected changes; Maps preserve first-touch order.
  const collections = new Map<string, { ids: Set<string>; removes: Set<string>; whole: boolean }>();
  const values = new Set<string>();

  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length < 1) continue;
    const key = String(path[0]);
    if (!isReplicatedKey(key)) continue;

    if (!isCollectionKey(key)) {
      values.add(key);
      continue;
    }

    let entry = collections.get(key);
    if (!entry) collections.set(key, (entry = { ids: new Set(), removes: new Set(), whole: false }));

    if (path.length === 1) {
      // The whole collection was replaced (a sync snapshot landing, a boot
      // seed). Diffing old vs new here is not possible from the patch alone —
      // mark it whole and let the caller send every row. Removals cannot be
      // derived (the pre-write keys are gone), so a whole-replace update is an
      // upsert-only overlay; true deletions ride the explicit remove patches
      // of ordinary writes, and a follower that misses one converges on its
      // next snapshot.
      entry.whole = true;
      continue;
    }

    const rowId = String(path[1]);
    if (patch.op === "remove" && path.length === 2) {
      entry.removes.add(rowId);
      entry.ids.delete(rowId);
    } else {
      entry.ids.add(rowId);
      entry.removes.delete(rowId);
    }
  }

  const updates: ReplicationUpdate[] = [];
  for (const [key, entry] of collections) {
    const table = state?.[key] ?? {};
    const upserts: any[] = [];
    if (entry.whole) {
      for (const row of Object.values(table)) upserts.push(row);
    } else {
      for (const id of entry.ids) {
        const row = table[id];
        // A row written then removed in the same batch lands in removes only.
        if (row !== undefined) upserts.push(row);
        else entry.removes.add(id);
      }
    }
    const removes = [...entry.removes];
    if (upserts.length === 0 && removes.length === 0) continue;
    updates.push({
      key,
      ...(upserts.length > 0 ? { upserts } : {}),
      ...(removes.length > 0 ? { removes } : {}),
    });
  }
  for (const key of values) {
    updates.push({ key, value: state?.[key], hasValue: true });
  }
  return updates;
}

/** The full replicated slice, for a snapshot answer. */
export function snapshotEntries(
  state: any,
  replicatedKeys: readonly string[],
): Record<string, any> {
  const entries: Record<string, any> = {};
  for (const key of replicatedKeys) {
    const value = state?.[key];
    if (value !== undefined) entries[key] = value;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Follower ordering: seq tracking + pre-snapshot buffering
// ---------------------------------------------------------------------------

type SeqStamped = { hostId: string; seq: number };

export type FollowerInboxResult<TMsg> =
  /** Apply these messages now, in order (empty: buffered or duplicate). */
  | { action: "apply"; messages: TMsg[] }
  /** State is unreconstructable from the stream — request a fresh snapshot.
   *  The inbox has already reset itself and buffers until one arrives. */
  | { action: "resync" };

export type FollowerInbox<TMsg extends SeqStamped> = {
  onUpdate: (msg: TMsg) => FollowerInboxResult<TMsg>;
  /** A snapshot landed: adopt its position. Returns buffered messages newer
   *  than the snapshot to replay, or "resync" when the buffer itself has a
   *  gap (messages were lost while the snapshot was in flight). */
  onSnapshot: (snap: SeqStamped) => FollowerInboxResult<TMsg>;
  synced: () => boolean;
  hostId: () => string | null;
  lastSeq: () => number;
};

/**
 * Order/gap bookkeeping for one follower. The transport delivers in order per
 * sender (BroadcastChannel guarantees this), so the irregularities are: a
 * missed message (frozen window, channel churn), a host restart (new hostId),
 * and the boot window before the first snapshot. Anything unaccountable
 * degrades to "resync" — a fresh snapshot is always a correct recovery.
 */
export function createFollowerInbox<TMsg extends SeqStamped>(
  maxBuffer = 1000,
): FollowerInbox<TMsg> {
  let hostId: string | null = null;
  let lastSeq = 0;
  let synced = false;
  let buffer: TMsg[] = [];

  const reset = (): { action: "resync" } => {
    hostId = null;
    lastSeq = 0;
    synced = false;
    buffer = [];
    return { action: "resync" };
  };

  return {
    onUpdate(msg) {
      if (!synced) {
        buffer.push(msg);
        // An unbounded buffer while no snapshot arrives is a leak; drop and
        // start over — the eventual snapshot supersedes everything dropped.
        if (buffer.length > maxBuffer) buffer = [];
        return { action: "apply", messages: [] };
      }
      if (msg.hostId !== hostId) return reset();
      if (msg.seq <= lastSeq) return { action: "apply", messages: [] };
      if (msg.seq !== lastSeq + 1) return reset();
      lastSeq = msg.seq;
      return { action: "apply", messages: [msg] };
    },
    onSnapshot(snap) {
      const replay = buffer
        .filter((m) => m.hostId === snap.hostId && m.seq > snap.seq)
        .sort((a, b) => a.seq - b.seq);
      // The buffered tail must continue the snapshot contiguously; a hole
      // means an update was lost while the snapshot was in flight.
      let seq = snap.seq;
      for (const m of replay) {
        if (m.seq !== seq + 1) return reset();
        seq = m.seq;
      }
      hostId = snap.hostId;
      lastSeq = seq;
      synced = true;
      buffer = [];
      return { action: "apply", messages: replay };
    },
    synced: () => synced,
    hostId: () => hostId,
    lastSeq: () => lastSeq,
  };
}
