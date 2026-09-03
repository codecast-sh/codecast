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
  extractReplicationUpdates,
  type ReplicationChannel,
  type ReplicationFollower,
  type ReplicationHost,
  type ReplicationUpdate,
} from "@platform/engine";
import { useInboxStore, hasSyncRegistryEntry, syncLogScopeMetaKey } from "./inboxStore";
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
  /** The Web Lock is held right now (elected AND not yet stopped). */
  holdsLock: boolean;
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

const SYNCLOG_META_PREFIX = syncLogScopeMetaKey("");

// A follower's mut: its action's writes as the host should apply them. A
// row the action only EDITED ships as the fields it wrote (`fields`), never
// as the whole row — the follower's copy of every other field is a moment
// behind the host's, and a whole-row overlay would put the host's fresher
// server state back a step (a stash the log just delivered, for one) until
// something re-delivers it. A row the action created or replaced outright
// ships whole, as before. Built from the action's own patches, so the field
// set is exact.
export type MutUpdate = ReplicationUpdate & {
  fields?: Record<string, Record<string, unknown>>;
  /** The action's time on the follower: the mirrored lock's `ts`, so the write's later acknowledgement (sent after the action) matches it. */
  ts?: number;
};

export function buildMutUpdates(patches: readonly any[], state: any): MutUpdate[] {
  const updates: MutUpdate[] = extractReplicationUpdates(patches, state, isReplicated, isReplicatedCollectionKey);
  const ts = Date.now();
  const edited = new Map<string, Map<string, Record<string, unknown>>>();
  const whole = new Map<string, Set<string>>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length < 2) continue;
    const key = String(path[0]);
    if (!isReplicated(key) || !isReplicatedCollectionKey(key)) continue;
    const id = String(path[1]);
    if (path.length === 2) {
      // The row itself was set or removed: whole-row semantics for this id.
      let w = whole.get(key);
      if (!w) whole.set(key, (w = new Set()));
      w.add(id);
      continue;
    }
    if (path.length !== 3) continue; // a nested edit: the row ships whole
    let rows = edited.get(key);
    if (!rows) edited.set(key, (rows = new Map()));
    let f = rows.get(id);
    if (!f) rows.set(id, (f = {}));
    const field = String(path[2]);
    f[field] = state?.[key]?.[id]?.[field];
  }
  for (const u of updates) {
    const rows = edited.get(u.key);
    if (!rows || !u.upserts) continue;
    const w = whole.get(u.key);
    const fields: Record<string, Record<string, unknown>> = {};
    const upserts: any[] = [];
    for (const row of u.upserts) {
      const id = String(row._id);
      const f = rows.get(id);
      if (f && !w?.has(id) && Object.keys(f).length > 0) fields[id] = f;
      else upserts.push(row);
    }
    if (Object.keys(fields).length > 0) {
      u.fields = fields;
      u.ts = ts;
    }
    if (upserts.length > 0) u.upserts = upserts; else delete u.upserts;
  }
  return updates;
}

const isReplicated = (key: string) => REPLICATED_STORE_KEYS.includes(key);

// Land one batch of replicated updates through the store's own sync actions,
// so pending protection, merge policies, and the no-op bails all behave as if
// the rows came from a live query.
//
// `optimistic` marks a follower's mut applied on the host: the rows are a
// sibling window's local writes, not server truth, so a lock this window
// already holds on them (the gesture bridge's, planted a moment earlier for
// the same gesture) survives the merge. Without that the value echo of the
// mut itself retires the bridge lock, and any stale push in flight (a live
// window result, a crawl page) undoes the gesture on the host — the
// 2026-09-02 desktop resurrection. Only held locks are carried: a follower's
// row also ships every field it did NOT write, so a diff against this
// window's copy would lock stale values the server never echoes.
//
// Authoritative rows arriving on a follower release that window's SETTLED
// locks first (same bound as the host's heal, releaseSettledFieldLocks): a
// lock whose echo never comes — the write was superseded elsewhere — would
// otherwise re-assert the follower's stale value over every host row forever.
export function applyUpdatesToStore(updates: MutUpdate[], opts?: { optimistic?: boolean }): void {
  const state = useInboxStore.getState();
  for (const u of updates) {
    if (u.fields && opts?.optimistic) {
      // The sibling's field writes land as the gesture bridge lands a triage
      // gesture: the value, and a lock on it until the server echoes it.
      useInboxStore.getState().applyReplicatedFields(u.key, u.fields, u.ts);
    }
    if (u.hasValue) {
      if (u.value == null) continue;
      if (u.key === "sessionsProjection") {
        state.applyReplicatedProjection(u.value as any);
        continue;
      }

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
      if (u.key === "syncMeta") {
        // The host's scope cursors: rows through each position have already
        // arrived (the host tees in commit order, and it stamps the cursor
        // after the page's rows), so every lock acked at or below it retires
        // now — the follower's own log applier event.
        const meta = u.value as Record<string, { cursor?: number } | undefined>;
        for (const key in meta) {
          if (!key.startsWith(SYNCLOG_META_PREFIX)) continue;
          const cursor = meta[key]?.cursor;
          if (typeof cursor === "number") useInboxStore.getState().retireAckedPending(key.slice(SYNCLOG_META_PREFIX.length), cursor);
        }
      }
      continue;
    }
    if (u.upserts?.length) {
      if (opts?.optimistic) {
        const current = useInboxStore.getState();
        // Every lock this window holds on the sibling's rows, which the merge
        // below would read as a value echo and retire.
        const entries: Array<{ id: string; field: string; value: unknown; ts?: number }> = [];
        for (const row of u.upserts) {
          const prefix = `${u.key}:${String(row._id)}:`;
          for (const [k, entry] of Object.entries(current.pending)) {
            if (!k.startsWith(prefix) || (entry as any)?.type !== "field") continue;
            entries.push({ id: String(row._id), field: k.slice(prefix.length), value: (entry as any).value, ts: (entry as any).ts });
          }
        }
        current.syncTable(u.key, u.upserts, { isDelta: true });
        if (entries.length) useInboxStore.getState().protectReplicatedWrite(u.key, entries);
      } else {
        state.releaseSettledFieldLocks(u.upserts.map((row: any) => String(row._id)));
        state.syncTable(u.key, u.upserts, { isDelta: true });
      }
    }
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
  let holdsLock = false;
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
      // The host's rows: authoritative for this window (see applyUpdatesToStore).
      applyUpdates: (updates) => applyUpdatesToStore(updates),
      onSynced: (synced) => {
        if (stopped || elected) return;
        if (synced) {
          if (soloTimer) clearTimeout(soloTimer);
          setRole("follower");
          (useInboxStore.getState() as any)._setIDBWrite(null);
          (useInboxStore.getState() as any)._setActionTee((_name: string, patches: any[], state: any) => {
            // The engine's own mutTee ships whole rows; a field-level mut is
            // built here so an edited row never overlays the host's copy.
            const updates = buildMutUpdates(patches, state);
            if (updates.length > 0) channel.post({ type: "mut", from: selfId, updates });
          });
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
      // A follower's mut: its optimistic rows, held under the same locks.
      applyUpdates: (updates) => applyUpdatesToStore(updates, { optimistic: true }),
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
        () => {
          // A grant that lands after stop() (the abort raced it: React's dev
          // double mount stops and restarts within one tick) must not be
          // held — returning releases it at once. Holding it here left a dead
          // instance as the origin's permanent lock holder, so every later
          // window fell back to solo host and never replicated.
          if (stopped) return;
          // Hold the lock until stop(). The holder promise is created BEFORE
          // any host work runs and never rejects: a throw inside the promise
          // executor would settle it and release the lock while this window
          // still believed it was host — two "elected" hosts on one origin.
          const held = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          holdsLock = true;
          try {
            becomeElectedHost();
          } catch (error) {
            console.error("[replication] failed to become host", error);
          }
          return held;
        },
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
    holdsLock = false;
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
      holdsLock,
      synced: follower?.synced() ?? false,
      selfId,
    }),
  };
  if (typeof window !== "undefined") {
    (window as any).__syncReplication = running.status;
  }
  return stop;
}
