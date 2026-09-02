// The running halves of cross-window replication (see replication.ts for the
// protocol and docs/architecture/sync-host.md in the app repo for the design).
//
// Both runtimes are transport-agnostic: they speak through a ReplicationChannel
// (the app supplies BroadcastChannel, a MessagePort, or an in-memory pair in
// tests) and apply state through callbacks the app supplies, so the engine
// never reaches into a concrete store shape.

import type { Patch } from "mutative";
import {
  createFollowerInbox,
  extractReplicationUpdates,
  snapshotEntries,
  type ReplicationMessage,
  type ReplicationUpdate,
} from "./replication";

export type ReplicationChannel = {
  post: (msg: ReplicationMessage) => void;
  /** Subscribe; returns unsubscribe. Delivery must be in-order per sender. */
  onMessage: (cb: (msg: ReplicationMessage) => void) => () => void;
};

/** How the app lands updates in its store. MUST apply through the store's
 *  sync machinery (pending protection, no-op bails), never raw assignment.
 *  `origin` names the window whose write produced the updates. */
export type ApplyUpdatesFn = (updates: ReplicationUpdate[], origin: string) => void;

export type ReplicationHostOptions = {
  hostId: string;
  channel: ReplicationChannel;
  getState: () => any;
  replicatedKeys: readonly string[];
  isCollectionKey: (key: string) => boolean;
  /** Apply a follower's mut to the host store (a sync write — the host's own
   *  write-through then persists and re-broadcasts it). */
  applyUpdates: ApplyUpdatesFn;
};

export type ReplicationHost = {
  /** The write-through tee: call with every store write's patches + post-write
   *  state (the host wraps its IDB write binding with this). Broadcasts the
   *  replicated slice of the write. */
  tee: (patches: readonly Patch[], state: any) => void;
  /** Current broadcast position (for tests and diagnostics). */
  seq: () => number;
  stop: () => void;
};

export function createReplicationHost(opts: ReplicationHostOptions): ReplicationHost {
  const { hostId, channel } = opts;
  let seq = 0;
  let stopped = false;
  // The origin attributed to writes flowing through the tee RIGHT NOW. Teed
  // writes are synchronous store commits, so setting this around a mut apply
  // is race-free; everything else is the host's own work.
  let currentOrigin = hostId;

  const isReplicated = (key: string) => opts.replicatedKeys.includes(key);
  // The collection object last broadcast, per key. A feed push that changes
  // one row replaces the whole table object, so without this every such push
  // would ship every row; with it the tee ships an identity diff.
  const shadows = new Map<string, Record<string, any>>();
  const refreshShadows = (state: any) => {
    for (const key of opts.replicatedKeys) {
      if (!opts.isCollectionKey(key)) continue;
      const table = state?.[key];
      if (table && typeof table === "object") shadows.set(key, table);
    }
  };
  refreshShadows(opts.getState());

  const broadcast = (updates: ReplicationUpdate[], origin: string) => {
    if (updates.length === 0) return;
    channel.post({ type: "update", hostId, seq: ++seq, origin, updates });
  };

  const unsubscribe = channel.onMessage((msg) => {
    if (stopped) return;
    if (msg.type === "hello") {
      channel.post({
        type: "snapshot",
        hostId,
        seq,
        to: msg.from,
        entries: snapshotEntries(opts.getState(), opts.replicatedKeys),
      });
      return;
    }
    if (msg.type === "mut") {
      // Apply as the mut's author: the store write triggers the tee below,
      // which rebroadcasts these rows to every other window with the right
      // origin so the author can skip its own echo.
      currentOrigin = msg.from;
      try {
        opts.applyUpdates(msg.updates, msg.from);
      } finally {
        currentOrigin = hostId;
      }
    }
  });

  return {
    tee(patches, state) {
      if (stopped) return;
      broadcast(
        extractReplicationUpdates(patches, state, isReplicated, opts.isCollectionKey, {
          shadowOf: (key) => shadows.get(key),
        }),
        currentOrigin,
      );
      refreshShadows(state);
    },
    seq: () => seq,
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}

export type ReplicationFollowerOptions = {
  selfId: string;
  channel: ReplicationChannel;
  replicatedKeys: readonly string[];
  isCollectionKey: (key: string) => boolean;
  /** Apply host updates/snapshot entries to the local store (sync write). */
  applyUpdates: ApplyUpdatesFn;
  /** How long to wait for a snapshot before re-sending hello. */
  helloRetryMs?: number;
  /** Called whenever the follower reaches (true) or loses (false) a synced
   *  stream — the app's "is a host present" signal (solo fallback, badges). */
  onSynced?: (synced: boolean) => void;
};

export type ReplicationFollower = {
  /** The action tee for this window (wire to _setActionTee): offers the
   *  window's own optimistic writes to the host. */
  mutTee: (actionName: string, patches: readonly Patch[], state: any) => void;
  synced: () => boolean;
  stop: () => void;
};

export function createReplicationFollower(opts: ReplicationFollowerOptions): ReplicationFollower {
  const { selfId, channel } = opts;
  const inbox = createFollowerInbox<Extract<ReplicationMessage, { type: "update" }>>();
  const helloRetryMs = opts.helloRetryMs ?? 3000;
  let stopped = false;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSynced = false;

  const isReplicated = (key: string) => opts.replicatedKeys.includes(key);

  const publishSynced = () => {
    const now = inbox.synced();
    if (now !== lastSynced) {
      lastSynced = now;
      opts.onSynced?.(now);
    }
  };

  const requestSnapshot = () => {
    if (stopped) return;
    channel.post({ type: "hello", from: selfId });
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
      if (!stopped && !inbox.synced()) requestSnapshot();
    }, helloRetryMs);
  };

  const applyMessages = (messages: Array<Extract<ReplicationMessage, { type: "update" }>>) => {
    for (const m of messages) {
      // Skip the content of our own echoed writes: our pending protection
      // already holds these values, and re-applying them through the sync path
      // would retire the field locks early (a value match reads as an echo),
      // reopening the stale-push window the locks exist to close.
      if (m.origin === selfId) continue;
      opts.applyUpdates(m.updates, m.origin);
    }
  };

  const unsubscribe = channel.onMessage((msg) => {
    if (stopped) return;
    if (msg.type === "update") {
      const res = inbox.onUpdate(msg);
      if (res.action === "resync") {
        publishSynced();
        requestSnapshot();
        return;
      }
      applyMessages(res.messages);
      publishSynced();
      return;
    }
    if (msg.type === "snapshot") {
      if (msg.to !== selfId) return;
      const res = inbox.onSnapshot(msg);
      if (res.action === "resync") {
        requestSnapshot();
        return;
      }
      // The snapshot is one big upsert overlay: every replicated key's full
      // value, applied through the same sync machinery as live updates.
      const updates: ReplicationUpdate[] = [];
      for (const [key, value] of Object.entries(msg.entries)) {
        if (!isReplicated(key)) continue;
        if (opts.isCollectionKey(key)) {
          updates.push({ key, upserts: Object.values(value ?? {}) });
        } else {
          updates.push({ key, value, hasValue: true });
        }
      }
      opts.applyUpdates(updates, msg.hostId);
      applyMessages(res.messages);
      if (helloTimer) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }
      publishSynced();
    }
  });

  requestSnapshot();

  return {
    mutTee(_actionName, patches, state) {
      if (stopped) return;
      const updates = extractReplicationUpdates(
        patches, state, isReplicated, opts.isCollectionKey,
      );
      if (updates.length > 0) channel.post({ type: "mut", from: selfId, updates });
    },
    synced: () => inbox.synced(),
    stop() {
      stopped = true;
      if (helloTimer) clearTimeout(helloTimer);
      unsubscribe();
      if (lastSynced) opts.onSynced?.(false);
    },
  };
}
