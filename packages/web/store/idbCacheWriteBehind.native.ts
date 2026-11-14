// ── Write-behind ─────────────────────────────────────────────────────────────
// Collections used to live as ONE JSON blob per table. A busy account's
// sessions blob is ~4.5 MB and tasks ~6.8 MB; overlay heartbeats change a
// handful of row refs many times a second, and JSON.stringify of the whole
// table on the JS thread froze taps for seconds (and, written eagerly, piled
// strings until Hermes aborted — Sentry REACT-NATIVE-J "LLVM ERROR" inside
// JSON.stringify, watchdog RAM kill REACT-NATIVE-H).
//
// Per-row keys match the web Dexie engine: a heartbeat stringifies one row,
// not the table. Writes are still scheduled, not eager — the latest producer
// wins, a short trailing delay folds a burst, and at most one write per key
// is in flight. A global inflight cap keeps a boot migration of thousands of
// row keys from opening that many SQLite statements at once. Reads of a
// scheduled key see the scheduled value; a null producer is a delete.
const WRITE_COALESCE_MS = 250;
const MAX_INFLIGHT = 8;
export type Produce = (() => string) | null;

function afterInteractions(fn: () => void) {
  try {
    const IM = require("react-native").InteractionManager;
    if (IM?.runAfterInteractions) {
      IM.runAfterInteractions(fn);
      return;
    }
  } catch { /* bun tests have no RN */ }
  fn();
}

/** The scheduler over one kv-store (AsyncStorage-compatible setItem/removeItem). */
export function createWriteBehind(storage: any) {
  const pendingWrites = new Map<string, Produce>();
  const inflightWrites = new Map<string, Promise<void>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleWrite(key: string, produce: Produce) {
    pendingWrites.set(key, produce);
    if (flushTimer == null) flushTimer = setTimeout(flushScheduledWrites, WRITE_COALESCE_MS);
  }

  function flushScheduledWrites() {
    flushTimer = null;
    afterInteractions(flushScheduledWritesNow);
  }

  function flushScheduledWritesNow() {
    for (const [key, produce] of pendingWrites) {
      if (inflightWrites.has(key)) continue;
      if (inflightWrites.size >= MAX_INFLIGHT) break;
      pendingWrites.delete(key);
      const write = Promise.resolve().then(() => {
        if (produce == null) return storage.removeItem(key);
        return storage.setItem(key, produce());
      }).catch(() => {}).then(() => {
        inflightWrites.delete(key);
        if (pendingWrites.size > 0 && flushTimer == null) flushTimer = setTimeout(flushScheduledWrites, 0);
      });
      inflightWrites.set(key, write);
    }
  }

  /** Forget everything scheduled and not yet started. */
  function clearScheduled() {
    pendingWrites.clear();
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
  }

  return {
    scheduleWrite,
    scheduleRemove: (key: string) => scheduleWrite(key, null),
    /** A scheduled-but-unflushed value, so a read never sees older bytes than the
     *  store has already committed to disk-in-spirit. A pending delete is absent. */
    scheduledValue(key: string): string | undefined {
      if (!pendingWrites.has(key)) return undefined;
      const produce = pendingWrites.get(key);
      return produce ? produce() : undefined;
    },
    clearScheduled,
    /** Wait out the writes already started. */
    settleInflight: () => Promise.allSettled([...inflightWrites.values()]),
    /** Drain every scheduled and in-flight write. Tests and a deliberate shutdown
     *  path want a settled disk; the app itself never needs to wait. */
    async flush(): Promise<void> {
      while (pendingWrites.size > 0 || inflightWrites.size > 0) {
        if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
        // Tests and shutdown must not wait for the interaction queue.
        flushScheduledWritesNow();
        await Promise.all([...inflightWrites.values()]);
      }
    },
  };
}
