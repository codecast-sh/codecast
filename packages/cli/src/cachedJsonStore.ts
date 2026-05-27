import * as fs from "fs";
import * as path from "path";

/**
 * In-memory-cached, keyed JSON store with debounced async persistence.
 *
 * Replaces the "read-modify-write the whole file on every mutation" pattern that
 * made the sync ledger and position tracker O(total-sessions-ever) per sync. With
 * a large fleet syncing many times a second, fully rewriting a multi-megabyte JSON
 * file synchronously on every `markSynced`/`setPosition` froze the daemon's single
 * event loop — starving heartbeats, message delivery, and the retry-queue timer,
 * and even tripping the 60s Convex client timeouts (which are `setTimeout`-based and
 * so only fire once the blocked loop frees up). Cost also grew without bound because
 * dead-file entries were never pruned.
 *
 * Design:
 *  - Reads hit an in-memory cache loaded once (lazily).
 *  - Mutations update the cache instantly and journal the change (pendingWrites /
 *    pendingDeletes), then schedule a single debounced async flush that coalesces
 *    thousands of mutations into one write.
 *  - Flush re-reads the current on-disk file and applies only the journaled changes
 *    on top — preserving the original per-key "last writer wins" semantics so a
 *    concurrent CLI process (`cast sync`, repair) can't be clobbered wholesale.
 *  - `keepOnLoad` prunes dead entries (e.g. deleted transcripts) so the file stays
 *    small and cost stays bounded.
 *  - `flushSync()` runs on `process.on("exit")` (which fires on the daemon's
 *    SIGTERM/SIGINT graceful shutdown, since those call `process.exit`), so a
 *    restart never loses journaled state. A SIGKILL loses at most one debounce
 *    window, which re-syncs idempotently via server-side uuid dedup.
 */
export class CachedJsonStore<V> {
  private cache: Record<string, V> | null = null;
  private pendingWrites = new Map<string, V>();
  private pendingDeletes = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private exitHandlerRegistered = false;

  private readonly filePath: string;
  private readonly flushDelayMs: number;
  private readonly keepOnLoad?: (key: string, value: V) => boolean;

  constructor(opts: {
    filePath: string;
    /** Debounce window before an async flush; coalesces bursts of mutations. */
    flushDelayMs?: number;
    /** Return false to drop an entry at load time (e.g. its file no longer exists). */
    keepOnLoad?: (key: string, value: V) => boolean;
  }) {
    this.filePath = opts.filePath;
    this.flushDelayMs = opts.flushDelayMs ?? 1000;
    this.keepOnLoad = opts.keepOnLoad;
  }

  private readFromDisk(): Record<string, V> {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        if (parsed && typeof parsed === "object") return parsed as Record<string, V>;
      }
    } catch {
      /* corrupt/partial file — start fresh rather than crash the daemon */
    }
    return {};
  }

  private ensureLoaded(): Record<string, V> {
    if (this.cache) return this.cache;
    const data = this.readFromDisk();

    if (this.keepOnLoad) {
      let pruned = 0;
      for (const key of Object.keys(data)) {
        if (!this.keepOnLoad(key, data[key])) {
          delete data[key];
          // Persist the prune through the normal merge-flush path.
          this.pendingDeletes.add(key);
          pruned++;
        }
      }
      if (pruned > 0) this.scheduleFlush();
    }

    this.cache = data;
    this.registerExitFlush();
    return data;
  }

  get(key: string): V | undefined {
    return this.ensureLoaded()[key];
  }

  has(key: string): boolean {
    return key in this.ensureLoaded();
  }

  /** Live reference for fast iteration. Callers must treat it as read-only. */
  getAll(): Record<string, V> {
    return this.ensureLoaded();
  }

  set(key: string, value: V): void {
    const cache = this.ensureLoaded();
    cache[key] = value;
    this.pendingWrites.set(key, value);
    this.pendingDeletes.delete(key);
    this.scheduleFlush();
  }

  delete(key: string): void {
    const cache = this.ensureLoaded();
    if (key in cache) delete cache[key];
    this.pendingDeletes.add(key);
    this.pendingWrites.delete(key);
    this.scheduleFlush();
  }

  private hasPending(): boolean {
    return this.pendingWrites.size > 0 || this.pendingDeletes.size > 0;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushAsync();
    }, this.flushDelayMs);
    // Never keep a short-lived CLI process alive solely to flush — the exit
    // handler guarantees the write happens before the process leaves.
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Build the next on-disk state by re-reading the current file and layering only
   * the journaled changes on top, then serialize. Mirrors the old read-modify-write
   * semantics so a concurrent writer's untouched keys survive.
   */
  private buildMerged(
    writes: Array<[string, V]>,
    deletes: string[],
  ): string {
    const disk = this.readFromDisk();
    for (const [k, v] of writes) disk[k] = v;
    for (const k of deletes) delete disk[k];
    return JSON.stringify(disk);
  }

  private async flushAsync(): Promise<void> {
    if (this.flushing) {
      // A flush is already running; coalesce — it (or a follow-up) will pick up
      // whatever is pending. Re-arm so nothing is stranded.
      this.scheduleFlush();
      return;
    }
    if (!this.hasPending()) return;

    // Snapshot + clear the journal BEFORE any await so concurrent mutations during
    // the async write land in a fresh journal and aren't lost.
    const writes = [...this.pendingWrites.entries()];
    const deletes = [...this.pendingDeletes];
    this.pendingWrites.clear();
    this.pendingDeletes.clear();

    this.flushing = (async () => {
      const data = this.buildMerged(writes, deletes);
      const tmp = `${this.filePath}.tmp`;
      try {
        this.ensureDir();
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, this.filePath);
      } catch {
        // Re-journal so the next flush retries. Don't clobber a newer pending value.
        for (const [k, v] of writes) if (!this.pendingWrites.has(k) && !this.pendingDeletes.has(k)) this.pendingWrites.set(k, v);
        for (const k of deletes) if (!this.pendingWrites.has(k)) this.pendingDeletes.add(k);
        this.scheduleFlush();
      }
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
    // Mutations may have queued during the write; ensure they get flushed too.
    if (this.hasPending()) this.scheduleFlush();
  }

  /** Synchronous flush for the process-exit path (async I/O can't run there). */
  flushSync(): void {
    if (!this.hasPending()) return;
    const writes = [...this.pendingWrites.entries()];
    const deletes = [...this.pendingDeletes];
    this.pendingWrites.clear();
    this.pendingDeletes.clear();
    const data = this.buildMerged(writes, deletes);
    const tmp = `${this.filePath}.tmp`;
    try {
      this.ensureDir();
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.filePath);
    } catch {
      for (const [k, v] of writes) if (!this.pendingWrites.has(k)) this.pendingWrites.set(k, v);
      for (const k of deletes) if (!this.pendingWrites.has(k)) this.pendingDeletes.add(k);
    }
  }

  private registerExitFlush(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;
    process.once("exit", () => this.flushSync());
  }
}
