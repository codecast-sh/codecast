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
//
// One write per row is still one SQLite transaction per row: a journal file
// created, synced and unlinked each time. With 120 sessions heartbeating, a
// phone sitting on the inbox spent 11 to 24% of a core there, most of it nine
// writer threads waiting on the database's one lock. Given a batch writer, a
// flush goes to disk as ONE statement for its puts and one for its deletes,
// a single transaction each, and only one batch is ever in flight. A batch
// that fails falls back to the per-key path, so one bad row costs itself.
const WRITE_COALESCE_MS = 250;
const MAX_INFLIGHT = 8;
/** One batch holds at most this many rows and about this much text, so a boot
 *  migration of thousands of rows never stringifies them in one task. */
const MAX_BATCH_ROWS = 64;
const MAX_BATCH_CHARS = 512_000;
export type Produce = (() => string) | null;
/** Puts and deletes that reach disk together. Keys are distinct across both. */
export type BatchWriter = (puts: Array<[string, string]>, removes: string[]) => Promise<void>;

/**
 * A batch as SQL over kv-store's own table ("storage": key, value): one upsert
 * for every put and one delete for every remove, each a single statement and
 * so a single transaction. Keys must be distinct; an upsert cannot touch one
 * row twice.
 */
export function batchStatements(puts: Array<[string, string]>, removes: string[]): Array<{ sql: string; params: string[] }> {
  const out: Array<{ sql: string; params: string[] }> = [];
  if (puts.length > 0) {
    out.push({
      sql: `INSERT INTO storage (key, value) VALUES ${puts.map(() => "(?, ?)").join(", ")} ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      params: puts.flat(),
    });
  }
  if (removes.length > 0) {
    out.push({ sql: `DELETE FROM storage WHERE key IN (${removes.map(() => "?").join(", ")});`, params: [...removes] });
  }
  return out;
}

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

/**
 * The scheduler over one kv-store (AsyncStorage-compatible setItem/removeItem).
 * With `writeBatch`, a flush is one batch; without it, one write per key.
 */
export function createWriteBehind(storage: any, writeBatch?: BatchWriter | null) {
  const pendingWrites = new Map<string, Produce>();
  const inflightWrites = new Map<string, Promise<void>>();
  // What the batch in flight is putting, so a read in that window sees it.
  const inflightValues = new Map<string, string>();
  let inflightBatch: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleWrite(key: string, produce: Produce) {
    pendingWrites.set(key, produce);
    if (flushTimer == null) flushTimer = setTimeout(flushScheduledWrites, WRITE_COALESCE_MS);
  }

  function flushScheduledWrites() {
    flushTimer = null;
    afterInteractions(flushScheduledWritesNow);
  }

  function writeOne(key: string, value: string | null): Promise<void> {
    return Promise.resolve()
      .then(() => (value == null ? storage.removeItem(key) : storage.setItem(key, value)))
      .catch(() => {});
  }

  function flushBatchNow(write: BatchWriter) {
    if (inflightBatch || pendingWrites.size === 0) return;
    const puts: Array<[string, string]> = [];
    const removes: string[] = [];
    let chars = 0;
    for (const [key, produce] of pendingWrites) {
      if (puts.length + removes.length >= MAX_BATCH_ROWS || chars >= MAX_BATCH_CHARS) break;
      pendingWrites.delete(key);
      if (produce == null) { removes.push(key); continue; }
      let value: string;
      // A producer that throws loses its own write, as it did one key at a time.
      try { value = produce(); } catch { continue; }
      puts.push([key, value]);
      inflightValues.set(key, value);
      chars += value.length;
    }
    const backlog = pendingWrites.size > 0;
    inflightBatch = Promise.resolve()
      .then(() => write(puts, removes))
      .catch(async () => {
        for (const [key, value] of puts) await writeOne(key, value);
        for (const key of removes) await writeOne(key, null);
      })
      .then(() => {
        inflightBatch = null;
        inflightValues.clear();
        if (pendingWrites.size > 0 && flushTimer == null) {
          // What the cap left behind goes now; what arrived meanwhile folds as any burst does.
          flushTimer = setTimeout(flushScheduledWrites, backlog ? 0 : WRITE_COALESCE_MS);
        }
      });
  }

  function flushScheduledWritesNow() {
    if (writeBatch) { flushBatchNow(writeBatch); return; }
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

  const inflight = (): Promise<void>[] => (inflightBatch ? [inflightBatch, ...inflightWrites.values()] : [...inflightWrites.values()]);

  return {
    scheduleWrite,
    scheduleRemove: (key: string) => scheduleWrite(key, null),
    /** A scheduled-but-unflushed value, so a read never sees older bytes than the
     *  store has already committed to disk-in-spirit. A pending delete is absent. */
    scheduledValue(key: string): string | undefined {
      if (!pendingWrites.has(key)) return inflightValues.get(key);
      const produce = pendingWrites.get(key);
      return produce ? produce() : undefined;
    },
    clearScheduled,
    /** Wait out the writes already started. */
    settleInflight: () => Promise.allSettled(inflight()),
    /** Drain every scheduled and in-flight write. Tests and a deliberate shutdown
     *  path want a settled disk; the app itself never needs to wait. */
    async flush(): Promise<void> {
      while (pendingWrites.size > 0 || inflightWrites.size > 0 || inflightBatch) {
        if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
        // Tests and shutdown must not wait for the interaction queue.
        flushScheduledWritesNow();
        await Promise.all(inflight());
      }
    },
  };
}
