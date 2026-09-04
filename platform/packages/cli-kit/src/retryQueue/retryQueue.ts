// A persistent retry queue for failed remote operations. Extracted from
// codecast's packages/cli/src/retryQueue.ts. What is here is the generic
// machine: exponential backoff, a global rate limit hold, bounded concurrency
// with serialization by key, persistence with debounced atomic writes and a
// synchronous flush on exit, an error classifier that lets transient failures
// retry without bound while permanent ones drop, a dropped operations log
// with retention, and backoff collapse when the backend proves reachable.
// What stayed in codecast is its conversation shape: message coalescing,
// chunking, compaction, the split on timeout, and the message counts in
// health. Those plug in through `serialKey`, `classifyError`, `onFailure`,
// and `onRestore`.

import * as fs from "node:fs";
import { atomicWriteFile } from "./atomicWrite.js";

export interface RetryOperation<P = Record<string, unknown>> {
  id: string;
  type: string;
  params: P;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
  rateLimitDelayMs?: number;
}

export interface DroppedOperation<P = Record<string, unknown>> extends Omit<RetryOperation<P>, "nextRetryAt"> {
  droppedAt: number;
}

export type LogLevel = "info" | "warn" | "error";

/**
 * How a failure should be treated.
 * - network: the backend is unreachable. Retry without bound, backoff capped.
 * - overload: the backend is up but shedding load. Retry without bound, with
 *   an age ceiling as the escape for a poisoned operation.
 * - permanent: retrying the same params can never succeed. Drop now.
 * - retry: an ordinary failure. Back off, drop at maxAttempts.
 */
export type ErrorClass = "network" | "overload" | "permanent" | "retry";

export function parseRateLimitDelay(error: string): number | null {
  const match = error.match(/wait (\d+) seconds/i);
  if (match?.[1]) return parseInt(match[1], 10) * 1000 + 1000;
  if (error.toLowerCase().includes("rate limit")) return 15000;
  return null;
}

const NETWORK_PATTERNS = ["typo in the url", "unable to connect", "fetch failed", "econnrefused", "enotfound", "etimedout", "network", "socket"];

export function isNetworkError(error: string): boolean {
  const lower = error.toLowerCase();
  return NETWORK_PATTERNS.some((p) => lower.includes(p));
}

/** Convex style backpressure and client side batch timeouts. */
export function isBackendOverloadError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    /timed out after \d+/.test(lower) ||
    lower.includes("couldn't be completed") ||
    lower.includes("try again later") ||
    lower.includes("too many system operations") ||
    lower.includes("your request timed out")
  );
}

export function defaultClassifyError(error: string): ErrorClass {
  if (isNetworkError(error)) return "network";
  if (isBackendOverloadError(error)) return "overload";
  return "retry";
}

export interface RetryQueueConfig<P = Record<string, unknown>> {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  persistPath?: string;
  droppedPath?: string;
  /** Debounce window before coalesced mutations reach disk. */
  persistDebounceMs?: number;
  /** Backoff cap for network and overload failures. Default 5 minutes. */
  transientMaxDelayMs?: number;
  /** Age after which an overload class operation is dropped. Default 48 hours. */
  overloadMaxAgeMs?: number;
  /** How long dropped operations stay in the log. Default 7 days. */
  droppedRetentionMs?: number;
  /** Cap on dropped log entries. Default 1000. */
  droppedMaxEntries?: number;
  onLog?: (message: string, level?: LogLevel) => void;
  /** Fired when an operation is enqueued, so a health snapshot can refresh as
   *  backlog accumulates and not only when it drains. */
  onEnqueue?: () => void;
  /** Operations that share a key run one at a time. Return null for full
   *  parallelism. Default: every operation is independent. */
  serialKey?: (op: RetryOperation<P>) => string | null;
  classifyError?: (error: string, op: RetryOperation<P>) => ErrorClass;
  /** Return true to take over handling of a failure (for example split the
   *  operation, or shed it with `drop`). The queue then does nothing more for it. */
  onFailure?: (op: RetryOperation<P>, error: string, queue: RetryQueue<P>) => boolean;
  /** Product context appended to every drop log line, for example the session
   *  an operation belonged to. A drop is the one place data is lost, so the
   *  line has to name enough for an operator to find what went missing. */
  dropContext?: (op: RetryOperation<P>) => string;
  /** Fields merged into the dropped log entry, so the file can be read later
   *  without knowing the product's params shape. */
  droppedFields?: (op: RetryOperation<P>) => Record<string, unknown>;
  /** Transform operations restored from disk before they enter the queue. */
  onRestore?: (ops: RetryOperation<P>[]) => RetryOperation<P>[];
  now?: () => number;
}

const DEFAULTS = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 10,
  concurrency: 5,
  persistDebounceMs: 1000,
  transientMaxDelayMs: 5 * 60 * 1000,
  overloadMaxAgeMs: 48 * 60 * 60 * 1000,
  droppedRetentionMs: 7 * 24 * 60 * 60 * 1000,
  droppedMaxEntries: 1000,
};

export interface RetryQueueHealth {
  ops: number;
  keys: number;
  oldestPendingMs: number;
}

export class RetryQueue<P = Record<string, unknown>> {
  private queue = new Map<string, RetryOperation<P>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private executor: ((op: RetryOperation<P>) => Promise<boolean>) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private exitFlushRegistered = false;
  private processing = false;
  private rateLimitedUntil = 0;
  private activeKeys = new Set<string>();
  private activeOpIds = new Set<string>();
  private readonly cfg: typeof DEFAULTS & RetryQueueConfig<P>;
  private readonly log: (message: string, level?: LogLevel) => void;
  private readonly now: () => number;

  constructor(config: RetryQueueConfig<P> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.log = config.onLog ?? (() => {});
    this.now = config.now ?? (() => Date.now());
    this.load();
  }

  // ── persistence ──
  private load(): void {
    const p = this.cfg.persistPath;
    if (!p) return;
    try {
      if (!fs.existsSync(p)) return;
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (!Array.isArray(data)) return;
      let ops: RetryOperation<P>[] = data.filter((op) => op && op.id && op.type && op.params);
      const before = ops.length;
      if (this.cfg.onRestore) ops = this.cfg.onRestore(ops);
      for (const op of ops) {
        op.nextRetryAt = this.now() + 1000;
        this.queue.set(op.id, op);
      }
      if (this.queue.size > 0) {
        const healed = before !== this.queue.size ? ` (healed ${before} -> ${this.queue.size})` : "";
        this.log(`Restored ${this.queue.size} operations from disk${healed}`);
      }
      if (before !== this.queue.size) this.persistSync();
    } catch {
      this.log("Failed to load retry queue from disk");
    }
  }

  private schedulePersist(): void {
    if (!this.cfg.persistPath) return;
    this.registerExitFlush();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.writeQueueFile();
    }, this.cfg.persistDebounceMs);
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }

  private serializeQueue(): string {
    return JSON.stringify(Array.from(this.queue.values()));
  }

  private async writeQueueFile(): Promise<void> {
    const p = this.cfg.persistPath;
    if (!p) return;
    try {
      await fs.promises.writeFile(`${p}.tmp`, this.serializeQueue());
      await fs.promises.rename(`${p}.tmp`, p);
    } catch {
      this.log("Failed to persist retry queue to disk");
    }
  }

  private persistSync(): void {
    const p = this.cfg.persistPath;
    if (!p) return;
    this.registerExitFlush();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      atomicWriteFile(p, this.serializeQueue());
    } catch {
      this.log("Failed to persist retry queue to disk");
    }
  }

  private registerExitFlush(): void {
    if (this.exitFlushRegistered || !this.cfg.persistPath) return;
    this.exitFlushRegistered = true;
    process.once("exit", () => this.persistSync());
  }

  /** Flush on demand, for example after an executor shrank an op's params in
   *  place. Debounced by default; `{ sync: true }` writes before returning, for
   *  a caller that must survive a crash in the next millisecond. */
  persistNow(opts: { sync?: boolean } = {}): void {
    if (opts.sync) this.persistSync();
    else this.schedulePersist();
  }

  // ── lifecycle ──
  setExecutor(executor: (op: RetryOperation<P>) => Promise<boolean>): void {
    this.executor = executor;
  }

  start(): void {
    if (this.queue.size > 0) this.scheduleNextCheck();
  }

  stop(): void {
    this.stopTimer();
  }

  clear(): void {
    this.queue.clear();
    this.persistSync();
    this.stopTimer();
  }

  /** Pull every retry forward to now after a reconnect. A server side rate
   *  limit hold is still honored by scheduleNextCheck. */
  notifyConnectionRestored(): void {
    if (this.queue.size === 0) return;
    const now = this.now();
    for (const op of this.queue.values()) {
      if (op.nextRetryAt > now) op.nextRetryAt = now;
    }
    this.log(`Connection restored — retrying ${this.queue.size} queued operation(s) now`);
    this.scheduleNextCheck();
  }

  // ── enqueue ──
  add(type: string, params: P, error?: string): string {
    const op = this.buildOperation(type, params, error);
    this.queue.set(op.id, op);
    this.schedulePersist();
    this.log(`Queued ${type} for retry${op.rateLimitDelayMs ? ` (rate limited, ${op.rateLimitDelayMs}ms)` : ""} (id: ${op.id})`);
    this.scheduleNextCheck();
    this.cfg.onEnqueue?.();
    return op.id;
  }

  /** Build an operation without enqueueing it. Used by `replace`. */
  buildOperation(type: string, params: P, error?: string, base?: Partial<RetryOperation<P>>): RetryOperation<P> {
    const rateLimitDelay = error ? parseRateLimitDelay(error) : null;
    const delay = rateLimitDelay ?? this.cfg.initialDelayMs;
    return {
      id: `${type}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      params,
      attempts: 0,
      nextRetryAt: this.now() + delay,
      createdAt: this.now(),
      lastError: error,
      rateLimitDelayMs: rateLimitDelay ?? undefined,
      ...base,
    };
  }

  /** Replace queued operations with new ones in one step (used by an
   *  `onFailure` hook that splits or merges work). Preserves nothing else. */
  replace(removeIds: string[], ops: RetryOperation<P>[]): void {
    for (const id of removeIds) this.queue.delete(id);
    for (const op of ops) this.queue.set(op.id, op);
    this.schedulePersist();
    this.scheduleNextCheck();
  }

  remove(id: string): boolean {
    const removed = this.queue.delete(id);
    if (removed) this.schedulePersist();
    return removed;
  }

  // ── scheduling ──
  private keyOf(op: RetryOperation<P>): string {
    return this.cfg.serialKey?.(op) ?? `op:${op.id}`;
  }

  private calculateNextDelay(attempts: number): number {
    return Math.min(this.cfg.initialDelayMs * Math.pow(2, attempts), this.cfg.maxDelayMs);
  }

  private scheduleNextCheck(): void {
    this.stopTimer();
    if (this.queue.size === 0) return;
    const now = this.now();
    let earliest = this.rateLimitedUntil > now ? this.rateLimitedUntil : Infinity;
    for (const op of this.queue.values()) {
      if (op.nextRetryAt < earliest) earliest = op.nextRetryAt;
    }
    if (this.rateLimitedUntil > now && earliest < this.rateLimitedUntil) earliest = this.rateLimitedUntil;
    this.timer = setTimeout(() => this.processQueue(), Math.max(10, earliest - now));
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.executor || this.queue.size === 0) return;
    this.processing = true;
    const now = this.now();
    if (this.rateLimitedUntil > now) {
      this.processing = false;
      this.scheduleNextCheck();
      return;
    }
    const ready: RetryOperation<P>[] = [];
    for (const op of this.queue.values()) {
      if (op.nextRetryAt <= now && !this.activeKeys.has(this.keyOf(op))) ready.push(op);
    }
    if (ready.length === 0) {
      this.processing = false;
      if (this.activeKeys.size === 0) this.scheduleNextCheck();
      return;
    }
    // At most one ready op per serial key per cycle; siblings wait.
    const batch: RetryOperation<P>[] = [];
    const claimed = new Set<string>();
    const slots = Math.max(0, this.cfg.concurrency - this.activeKeys.size);
    for (const op of ready) {
      if (batch.length >= slots) break;
      const key = this.keyOf(op);
      if (claimed.has(key)) continue;
      claimed.add(key);
      batch.push(op);
    }
    if (batch.length === 0) {
      this.processing = false;
      return;
    }
    for (const op of batch) {
      this.activeKeys.add(this.keyOf(op));
      this.activeOpIds.add(op.id);
      void this.runOne(op);
    }
    this.processing = false;
    this.scheduleNextCheck();
  }

  private async runOne(op: RetryOperation<P>): Promise<void> {
    op.attempts++;
    this.log(`Retrying ${op.type} (attempt ${op.attempts}/${this.cfg.maxAttempts}, id: ${op.id})`);
    try {
      const success = await this.executor!(op);
      if (success) {
        this.queue.delete(op.id);
        this.log(`Retry succeeded for ${op.type} (id: ${op.id})`);
        this.collapseBackoffOnRecovery(this.keyOf(op));
      } else {
        this.handleFailure(op, "Operation returned false");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimitDelay = parseRateLimitDelay(msg);
      if (rateLimitDelay) {
        this.rateLimitedUntil = this.now() + rateLimitDelay;
        this.log(`Rate limited globally for ${rateLimitDelay}ms`, "warn");
      }
      this.handleFailure(op, msg);
    } finally {
      this.activeKeys.delete(this.keyOf(op));
      this.activeOpIds.delete(op.id);
      this.schedulePersist();
      this.scheduleNextCheck();
      this.processQueue().catch(() => {});
    }
  }

  /** One success proves the backend is up: pull every parked retry to now
   *  (never earlier than a rate limit hold, never touching in flight ops,
   *  never zeroing attempts so a poisoned op still ages out). */
  private collapseBackoffOnRecovery(succeededKey: string): void {
    const now = this.now();
    const floor = this.rateLimitedUntil > now ? this.rateLimitedUntil : now;
    let collapsed = 0;
    for (const op of this.queue.values()) {
      if (this.activeOpIds.has(op.id)) continue;
      if (op.nextRetryAt > floor) {
        op.nextRetryAt = floor;
        op.rateLimitDelayMs = undefined;
        collapsed++;
      }
    }
    if (collapsed > 0) {
      this.log(`Backend recovered (drained ${succeededKey}); collapsed backoff on ${collapsed} queued op(s)`);
      this.schedulePersist();
      this.scheduleNextCheck();
    }
  }

  /** Shed an operation: write it to the dropped log and remove it from the
   *  queue. The queue calls this for a permanent failure, an overload class
   *  operation past the age ceiling, and an ordinary one at maxAttempts; an
   *  `onFailure` hook calls it to shed on a rule of its own, with its own
   *  wording for the log line. */
  drop(op: RetryOperation<P>, message?: string, level: LogLevel = "error"): void {
    if (message) this.log(message, level);
    this.recordDroppedOperation(op);
    this.queue.delete(op.id);
  }

  private dropContext(op: RetryOperation<P>): string {
    return this.cfg.dropContext?.(op) ?? "";
  }

  private handleFailure(op: RetryOperation<P>, error: string): void {
    op.lastError = error;
    if (this.cfg.onFailure?.(op, error, this)) return;

    const cls = (this.cfg.classifyError ?? defaultClassifyError)(error, op);
    const age = this.now() - op.createdAt;

    if (cls === "permanent") {
      this.drop(op, `DROPPED ${op.type}: permanent failure (${error}) (id: ${op.id})${this.dropContext(op)}`, "warn");
      return;
    }
    const isTransient = cls === "network" || cls === "overload";
    if (isTransient && age > 24 * 60 * 60 * 1000) {
      this.log(`${cls} op retrying >24h: ${op.type} (${op.attempts} attempts, id: ${op.id}). Still persisting.`, "error");
    }
    if (cls === "overload" && age > this.cfg.overloadMaxAgeMs) {
      this.drop(
        op,
        `Overload op still failing after age ceiling. DROPPED: ${op.type} after ${op.attempts} attempts. Last error: ${error}${this.dropContext(op)}`,
      );
      return;
    }
    if (op.attempts >= this.cfg.maxAttempts && !isTransient) {
      this.drop(
        op,
        `Max retries reached. DROPPED: ${op.type} after ${op.attempts} attempts. Last error: ${error}${this.dropContext(op)}`,
      );
      return;
    }
    const rateLimitDelay = parseRateLimitDelay(error);
    const maxDelay = isTransient ? this.cfg.transientMaxDelayMs : this.cfg.maxDelayMs;
    const effectiveAttempts = isTransient ? Math.min(op.attempts, 10) : op.attempts;
    const nextDelay = Math.min(rateLimitDelay ?? this.calculateNextDelay(effectiveAttempts), maxDelay);
    op.nextRetryAt = this.now() + nextDelay;
    op.rateLimitDelayMs = rateLimitDelay ?? undefined;
    this.log(
      `Retry failed for ${op.type}: ${error}. Next retry in ${nextDelay}ms${rateLimitDelay ? " (rate limited)" : ""}${isTransient ? ` (${cls}, indefinite)` : ""} (id: ${op.id})`,
      "warn",
    );
  }

  // ── dropped log ──
  private recordDroppedOperation(op: RetryOperation<P>): void {
    const p = this.cfg.droppedPath;
    if (!p) return;
    const { nextRetryAt: _omit, ...rest } = op;
    const dropped: DroppedOperation<P> = { ...rest, droppedAt: this.now(), ...this.cfg.droppedFields?.(op) };
    try {
      let existing: DroppedOperation<P>[] = [];
      if (fs.existsSync(p)) {
        try {
          existing = JSON.parse(fs.readFileSync(p, "utf-8"));
        } catch {
          existing = [];
        }
      }
      existing.push(dropped);
      const cutoff = this.now() - this.cfg.droppedRetentionMs;
      existing = existing.filter((d) => (d.droppedAt ?? 0) >= cutoff);
      if (existing.length > this.cfg.droppedMaxEntries) existing = existing.slice(-this.cfg.droppedMaxEntries);
      fs.writeFileSync(p, JSON.stringify(existing, null, 2));
      this.log(`Recorded dropped operation to ${p}`);
    } catch (err) {
      this.log(`Failed to record dropped operation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Count without materializing the JSON: the file can be large and this
   *  runs on a health tick. Falls back to a parse for an unexpected shape. */
  getDroppedOperationCount(): number {
    const p = this.cfg.droppedPath;
    if (!p || !fs.existsSync(p)) return 0;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const m = raw.match(/^  \{/gm);
      if (m) return m.length;
      if (raw.trim() === "[]") return 0;
      return (JSON.parse(raw) as unknown[]).length;
    } catch {
      return 0;
    }
  }

  getDroppedOperations(): DroppedOperation<P>[] {
    const p = this.cfg.droppedPath;
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  clearDroppedOperations(): void {
    const p = this.cfg.droppedPath;
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  }

  // ── inspection ──
  getQueueSize(): number {
    return this.queue.size;
  }

  getPendingOperations(): RetryOperation<P>[] {
    return Array.from(this.queue.values());
  }

  hasPending(predicate: (op: RetryOperation<P>) => boolean): boolean {
    for (const op of this.queue.values()) if (predicate(op)) return true;
    return false;
  }

  isActive(id: string): boolean {
    return this.activeOpIds.has(id);
  }

  getHealth(): RetryQueueHealth {
    const now = this.now();
    let oldestPendingMs = 0;
    const keys = new Set<string>();
    for (const op of this.queue.values()) {
      oldestPendingMs = Math.max(oldestPendingMs, now - op.createdAt);
      keys.add(this.keyOf(op));
    }
    return { ops: this.queue.size, keys: keys.size, oldestPendingMs };
  }

  async waitForCompletion(timeoutMs = 10000): Promise<boolean> {
    const start = this.now();
    while (this.queue.size > 0) {
      if (this.now() - start > timeoutMs) {
        this.log(`Timeout waiting for retry queue to drain (${this.queue.size} operations remaining)`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.log("All retry queue operations completed");
    return true;
  }
}
