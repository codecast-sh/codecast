// Cross-window replication wiring: election, transport, and the store hookup
// for the sync-host design (docs/architecture/sync-host.md).
//
// Exactly one window per origin is the elected sync host — it mounts the
// global feeders (gated on `syncRole` in the store), owns IndexedDB
// write-through, and broadcasts every write to the replicated slice. Every
// other window is a follower: feeders skipped, no state write-through, shared
// slice applied from the host's broadcasts, its own optimistic writes offered
// back as muts.
//
// Roles are safety-first: every window BOOTS as host (today's behavior) and
// demotes to follower only on evidence — a snapshot from a living host. A
// follower that loses its host falls back to host behavior ("solo") until a
// host answers again, so no window can be starved by a dead or absent host.
// Election uses the Web Locks API: the lock holder is the one elected host;
// the lock releasing (window closed, crashed) promotes the next eligible
// window automatically.

import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationChannel,
  type ReplicationFollower,
  type ReplicationHost,
  type ReplicationUpdate,
} from "@platform/engine";
import { useInboxStore, hasSyncRegistryEntry } from "./inboxStore";
import { writePatchesToIDB } from "./idbCache";
import {
  isReplicatedCollectionKey,
  REPLICATED_STORE_KEYS,
} from "./clientSyncRegistry";

const LOCK_NAME = "codecast-sync-host";
const CHANNEL_NAME = "codecast-replication-v1";
// A follower with no synced stream for this long acts as its own host (solo)
// until a snapshot arrives. Covers: no other window, a wedged host, a palette
// or people window running with the app closed.
const SOLO_FALLBACK_MS = 8000;

export type SyncReplicationStatus = {
  role: "host" | "follower";
  elected: boolean;
  synced: boolean;
  selfId: string;
};

let running: { stop: () => void; status: () => SyncReplicationStatus } | null = null;

function transportAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!(navigator as any).locks?.request
  );
}

// Land one batch of replicated updates through the store's own sync actions,
// so pending protection, merge policies, and the no-op bails all behave as if
// the rows came from a live query.
export function applyUpdatesToStore(updates: ReplicationUpdate[]): void {
  const state = useInboxStore.getState();
  for (const u of updates) {
    if (u.hasValue) {
      if (u.value == null) continue;
      // Twin keys: the persisted value has an in-memory Set companion the
      // ordinary sync path derives elsewhere — use their dedicated setters.
      if (u.key === "liveInboxIdList") {
        if (Array.isArray(u.value) && u.value.length > 0) state.setLiveInboxIds(u.value);
        continue;
      }
      if (u.key === "teamInboxIdSnapshot") {
        const snap = u.value as { team_id?: string | null; ids?: string[] };
        if (Array.isArray(snap.ids)) state.setTeamInboxIds(snap.ids, snap.team_id ?? null);
        continue;
      }
      // Keys with a SYNC_REGISTRY entry apply under their registered kind;
      // for the rest, derive the kind from the value's shape so a map or an
      // array is never mistaken for collection rows.
      state.syncTable(
        u.key,
        u.value,
        hasSyncRegistryEntry(u.key)
          ? undefined
          : {
              kind: Array.isArray(u.value)
                ? "list"
                : typeof u.value === "object"
                  ? "singleton"
                  : "scalar",
            },
      );
      continue;
    }
    if (u.upserts?.length) state.syncTable(u.key, u.upserts, { isDelta: true });
    if (u.removes?.length) state._applyReplicatedRemovals(u.key, u.removes);
  }
}

function setRole(role: "host" | "follower"): void {
  if (useInboxStore.getState().syncRole === role) return;
  useInboxStore.setState({ syncRole: role });
}

/**
 * Start replication for this window. Idempotent per window; `eligible` says
 * whether this window may be ELECTED host (it mounts the full shell and its
 * feeders). Ineligible windows (palette, people) are followers when a host
 * lives and solo hosts otherwise. Returns a stop for unmount/HMR.
 */
export function startSyncReplication(opts: { eligible: boolean }): () => void {
  if (running) return running.stop;
  if (!transportAvailable()) {
    // No transport (React Native, SSR, ancient browser): stay host, changed
    // nothing. Share pages and tests land here too.
    return () => {};
  }

  const selfId =
    typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const bc = new BroadcastChannel(CHANNEL_NAME);
  const channel: ReplicationChannel = {
    post: (msg) => {
      try {
        bc.postMessage(msg);
      } catch (error) {
        // A non-cloneable value in a row is a bug upstream; replication must
        // never take the write path down with it.
        console.error("[replication] failed to post", error);
      }
    },
    onMessage: (cb) => {
      const handler = (e: MessageEvent) => cb(e.data);
      bc.addEventListener("message", handler);
      return () => bc.removeEventListener("message", handler);
    },
  };

  let stopped = false;
  let elected = false;
  let follower: ReplicationFollower | null = null;
  let host: ReplicationHost | null = null;
  let soloTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseLock: (() => void) | null = null;
  const lockAbort = new AbortController();

  const armSoloFallback = () => {
    if (soloTimer) clearTimeout(soloTimer);
    soloTimer = setTimeout(() => {
      if (!stopped && !elected && !follower?.synced()) {
        // No living host answered — behave as our own (feeders on, own
        // write-through, no mut tee). The follower runtime stays up: a later
        // snapshot demotes us again.
        const internals = useInboxStore.getState() as any;
        internals._setActionTee(null);
        internals._setIDBWrite(writePatchesToIDB);
        setRole("host");
      }
    }, SOLO_FALLBACK_MS);
  };

  const startFollower = () => {
    follower = createReplicationFollower({
      selfId,
      channel,
      replicatedKeys: REPLICATED_STORE_KEYS,
      isCollectionKey: isReplicatedCollectionKey,
      applyUpdates: applyUpdatesToStore,
      onSynced: (synced) => {
        if (stopped || elected) return;
        if (synced) {
          if (soloTimer) clearTimeout(soloTimer);
          setRole("follower");
          (useInboxStore.getState() as any)._setIDBWrite(null);
          (useInboxStore.getState() as any)._setActionTee(
            (name: string, patches: any[], state: any) => follower?.mutTee(name, patches, state),
          );
        } else {
          armSoloFallback();
        }
      },
    });
    armSoloFallback();
  };

  const becomeElectedHost = () => {
    if (stopped) return;
    elected = true;
    if (soloTimer) clearTimeout(soloTimer);
    follower?.stop();
    follower = null;
    setRole("host");
    const internals = useInboxStore.getState() as any;
    internals._setActionTee(null);
    host = createReplicationHost({
      hostId: selfId,
      channel,
      getState: () => useInboxStore.getState(),
      replicatedKeys: REPLICATED_STORE_KEYS,
      isCollectionKey: isReplicatedCollectionKey,
      applyUpdates: applyUpdatesToStore,
    });
    // The write-through tee: persist first, then broadcast the same patches.
    internals._setIDBWrite((patches: any[], state: any) => {
      const persisted = writePatchesToIDB(patches, state);
      host?.tee(patches, state);
      return persisted;
    });
  };

  startFollower();

  if (opts.eligible) {
    (navigator as any).locks
      .request(
        LOCK_NAME,
        { mode: "exclusive", signal: lockAbort.signal },
        () =>
          new Promise<void>((resolve) => {
            releaseLock = resolve;
            becomeElectedHost();
          }),
      )
      .catch(() => {
        /* aborted on stop — never an error path */
      });
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (soloTimer) clearTimeout(soloTimer);
    follower?.stop();
    host?.stop();
    lockAbort.abort();
    releaseLock?.();
    bc.close();
    const internals = useInboxStore.getState() as any;
    internals._setActionTee(null);
    // Whatever role we were in, leave the window as a self-sufficient host
    // (today's behavior): write-through restored, feeders gate open.
    internals._setIDBWrite(writePatchesToIDB);
    setRole("host");
    running = null;
  };

  running = {
    stop,
    status: () => ({
      role: useInboxStore.getState().syncRole,
      elected,
      synced: follower?.synced() ?? false,
      selfId,
    }),
  };
  if (typeof window !== "undefined") {
    (window as any).__syncReplication = running.status;
  }
  return stop;
}
