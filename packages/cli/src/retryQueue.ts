import fs from "fs";

export interface RetryOperation {
  id: string;
  type: "createConversation" | "addMessage" | "addMessages";
  params: Record<string, unknown>;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
  rateLimitDelayMs?: number;
}

export interface DroppedOperation {
  id: string;
  type: "createConversation" | "addMessage" | "addMessages";
  params: Record<string, unknown>;
  attempts: number;
  createdAt: number;
  droppedAt: number;
  lastError?: string;
  sessionId?: string;
  conversationId?: string;
}

export function parseRateLimitDelay(error: string): number | null {
  const match = error.match(/wait (\d+) seconds/i);
  if (match) {
    return parseInt(match[1], 10) * 1000 + 1000;
  }
  if (error.toLowerCase().includes('rate limit')) {
    return 15000;
  }
  return null;
}

export type LogLevel = "info" | "warn" | "error";

export interface RetryQueueConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  persistPath?: string;
  droppedPath?: string;
  onLog?: (message: string, level?: LogLevel) => void;
}

const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_CONCURRENCY = 5;

// Match the Convex addMessages sub-batch size in syncService. Queueing a
// 5000-message blob as a single retry op meant every retry had to complete
// 200 sub-batches in serial within one mutation budget — any single
// sub-batch hitting the 60s timeout aborted the whole op, and the same
// blob got re-queued forever, jamming the concurrency=5 slots.
const RETRY_BATCH_CHUNK = 25;

export class RetryQueue {
  private queue: Map<string, RetryOperation> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private executor: ((op: RetryOperation) => Promise<boolean>) | null = null;
  private initialDelayMs: number;
  private maxDelayMs: number;
  private maxAttempts: number;
  private concurrency: number;
  private persistPath: string | null;
  private droppedPath: string | null;
  private log: (message: string, level?: LogLevel) => void;
  private processing = false;
  private rateLimitedUntil = 0;

  constructor(config: RetryQueueConfig = {}) {
    this.initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY;
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    this.persistPath = config.persistPath ?? null;
    this.droppedPath = config.droppedPath ?? null;
    this.log = config.onLog ?? (() => {});
    this.load();
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
        if (Array.isArray(data)) {
          let splitFrom = 0;
          let dedupedMsgs = 0;
          // Per-conversation set of message_uuids already restored. A queue that
          // jammed (e.g. an image batch stuck under OCC contention) accumulates the
          // SAME messages many times over as the live path re-enqueues the backlog
          // each poll — heal it here so a 16MB, 283-op file collapses to its distinct
          // messages on restart instead of draining the duplicates one slow op at a time.
          const seenByConv = new Map<string, Set<string>>();
          for (const op of data) {
            if (!op.id || !op.type || !op.params) continue;

            if (op.type === "addMessages" && Array.isArray(op.params?.messages)) {
              const convId = typeof op.params.conversationId === "string" ? op.params.conversationId : null;
              if (convId) {
                let seen = seenByConv.get(convId);
                if (!seen) { seen = new Set(); seenByConv.set(convId, seen); }
                const before = op.params.messages.length;
                const kept = op.params.messages.filter((m: unknown) => {
                  const uuid = m && typeof m === "object" ? (m as { messageUuid?: string }).messageUuid : undefined;
                  if (!uuid) return true; // can't dedup without a uuid — keep it
                  if (seen!.has(uuid)) return false;
                  seen!.add(uuid);
                  return true;
                });
                dedupedMsgs += before - kept.length;
                if (kept.length === 0) continue; // every message already restored elsewhere
                op.params = { ...op.params, messages: kept };
              }

              // Heal oversized addMessages ops so they fit a single mutation budget
              // and don't jam the concurrency slots. Split children inherit the
              // parent's attempts so genuinely-failing ops still age toward drop.
              const msgs = op.params.messages;
              if (msgs.length > RETRY_BATCH_CHUNK) {
                splitFrom++;
                for (let i = 0; i < msgs.length; i += RETRY_BATCH_CHUNK) {
                  const chunkId = `${op.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c${i}`;
                  this.queue.set(chunkId, {
                    id: chunkId,
                    type: op.type,
                    params: { ...op.params, messages: msgs.slice(i, i + RETRY_BATCH_CHUNK) },
                    attempts: op.attempts ?? 0,
                    nextRetryAt: Date.now() + 1000,
                    createdAt: op.createdAt ?? Date.now(),
                    lastError: op.lastError,
                  });
                }
                continue;
              }
            }
            op.nextRetryAt = Date.now() + 1000;
            this.queue.set(op.id, op);
          }
          if (this.queue.size > 0) {
            const heals = [
              splitFrom > 0 ? `split ${splitFrom} oversized` : "",
              dedupedMsgs > 0 ? `deduped ${dedupedMsgs} duplicate msgs` : "",
            ].filter(Boolean).join(", ");
            this.log(`Restored ${this.queue.size} operations from disk${heals ? ` (${heals})` : ""}`);
          }
          // Rewrite the healed queue so the duplicate/raw-base64 bloat doesn't persist.
          if (dedupedMsgs > 0 || splitFrom > 0) this.persist();
        }
      }
    } catch {
      this.log("Failed to load retry queue from disk");
    }
  }

  start(): void {
    if (this.queue.size > 0) {
      this.scheduleNextCheck();
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const data = Array.from(this.queue.values());
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {
      this.log("Failed to persist retry queue to disk");
    }
  }

  setExecutor(executor: (op: RetryOperation) => Promise<boolean>): void {
    this.executor = executor;
  }

  add(
    type: RetryOperation["type"],
    params: Record<string, unknown>,
    error?: string
  ): string {
    if (type === "addMessages") {
      let msgs = (params as { messages?: unknown[] }).messages;
      const conversationId = (params as { conversationId?: string }).conversationId;

      // Coalesce: drop messages already waiting in the queue for this conversation.
      // The live sync path re-reads and re-enqueues the same backlog every poll
      // while a batch is stuck, so without this the queue piles up the same
      // messages 12x. Server-side addMessages dedups by message_uuid anyway, so
      // dropping already-queued uuids here is purely a queue-size guard.
      if (Array.isArray(msgs) && typeof conversationId === "string") {
        const pending = this.pendingMessageUuids(conversationId);
        if (pending.size > 0) {
          const before = msgs.length;
          msgs = msgs.filter(
            (m) => !(m && typeof m === "object" && pending.has((m as { messageUuid?: string }).messageUuid ?? ""))
          );
          if (msgs.length === 0) {
            this.log(`Coalesced addMessages: all ${before} msgs already queued for ${conversationId}, skipping`);
            return "";
          }
          if (msgs.length < before) {
            this.log(`Coalesced addMessages: dropped ${before - msgs.length}/${before} already-queued msgs for ${conversationId}`);
          }
          params = { ...params, messages: msgs };
        }
      }

      if (Array.isArray(msgs) && msgs.length > RETRY_BATCH_CHUNK) {
        const ids: string[] = [];
        for (let i = 0; i < msgs.length; i += RETRY_BATCH_CHUNK) {
          const chunk = msgs.slice(i, i + RETRY_BATCH_CHUNK);
          ids.push(this.addSingle(type, { ...params, messages: chunk }, error));
        }
        this.log(`Split oversized addMessages (${msgs.length} msgs) into ${ids.length} retry chunks`);
        return ids[0] ?? "";
      }
    }
    return this.addSingle(type, params, error);
  }

  // All message_uuids currently queued (pending or in-flight — failed in-flight
  // ops stay in the queue until they succeed) for a conversation.
  private pendingMessageUuids(conversationId: string): Set<string> {
    const uuids = new Set<string>();
    for (const op of this.queue.values()) {
      if (op.type !== "addMessages") continue;
      if (op.params.conversationId !== conversationId) continue;
      const msgs = op.params.messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        const uuid = m && typeof m === "object" ? (m as { messageUuid?: string }).messageUuid : undefined;
        if (uuid) uuids.add(uuid);
      }
    }
    return uuids;
  }

  private addSingle(
    type: RetryOperation["type"],
    params: Record<string, unknown>,
    error?: string
  ): string {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rateLimitDelay = error ? parseRateLimitDelay(error) : null;
    const delay = rateLimitDelay ?? this.initialDelayMs;
    const op: RetryOperation = {
      id,
      type,
      params,
      attempts: 0,
      nextRetryAt: Date.now() + delay,
      createdAt: Date.now(),
      lastError: error,
      rateLimitDelayMs: rateLimitDelay ?? undefined,
    };
    this.queue.set(id, op);
    this.persist();
    this.log(`Queued ${type} for retry${rateLimitDelay ? ` (rate limited, ${delay}ms)` : ''} (id: ${id})`);
    this.scheduleNextCheck();
    return id;
  }

  // Serialization key for per-conversation concurrency control. Ops carrying a
  // conversationId share a key (so they run one at a time); ops without one key
  // off their unique id (so they stay fully parallel).
  private conversationKey(op: RetryOperation): string {
    const convId = op.params.conversationId;
    return typeof convId === "string" ? `conv:${convId}` : `op:${op.id}`;
  }

  private calculateNextDelay(attempts: number): number {
    const delay = this.initialDelayMs * Math.pow(2, attempts);
    return Math.min(delay, this.maxDelayMs);
  }

  private scheduleNextCheck(): void {
    this.stopTimer();

    if (this.queue.size === 0) {
      return;
    }

    const now = Date.now();

    let earliestRetryAt = this.rateLimitedUntil > now ? this.rateLimitedUntil : Infinity;
    for (const op of this.queue.values()) {
      if (op.nextRetryAt < earliestRetryAt) {
        earliestRetryAt = op.nextRetryAt;
      }
    }

    if (this.rateLimitedUntil > now && earliestRetryAt < this.rateLimitedUntil) {
      earliestRetryAt = this.rateLimitedUntil;
    }

    const delay = Math.max(10, earliestRetryAt - now);
    this.timer = setTimeout(() => this.processQueue(), delay);
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
    const now = Date.now();

    if (this.rateLimitedUntil > now) {
      this.processing = false;
      this.scheduleNextCheck();
      return;
    }

    const readyOps: RetryOperation[] = [];
    for (const op of this.queue.values()) {
      if (op.nextRetryAt <= now) {
        readyOps.push(op);
      }
    }

    if (readyOps.length === 0) {
      this.processing = false;
      this.scheduleNextCheck();
      return;
    }

    // Never run two ops for the same conversation concurrently. The server
    // addMessages mutation reads+patches the conversation doc, so parallel ops
    // for one conversation collide on that hot-doc → Convex OCC-retries the whole
    // mutation → some exceed the 60s client timeout → re-queue → worse contention.
    // That self-inflicted stampede is what turned one slow image batch into a
    // permanent 283-op stall. Pick at most one ready op per conversation per cycle;
    // siblings wait for the next cycle (which only runs after this batch fully drains).
    const batch: RetryOperation[] = [];
    const claimedConversations = new Set<string>();
    for (const op of readyOps) {
      if (batch.length >= this.concurrency) break;
      const key = this.conversationKey(op);
      if (claimedConversations.has(key)) continue;
      claimedConversations.add(key);
      batch.push(op);
    }

    const processOp = async (op: RetryOperation): Promise<void> => {
      op.attempts++;
      this.log(
        `Retrying ${op.type} (attempt ${op.attempts}/${this.maxAttempts}, id: ${op.id})`
      );

      try {
        const success = await this.executor!(op);
        if (success) {
          this.queue.delete(op.id);
          this.log(`Retry succeeded for ${op.type} (id: ${op.id})`);
        } else {
          this.handleFailure(op, "Operation returned false");
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const rateLimitDelay = parseRateLimitDelay(errorMsg);
        if (rateLimitDelay) {
          this.rateLimitedUntil = Date.now() + rateLimitDelay;
          this.log(`Rate limited globally for ${rateLimitDelay}ms`, "warn");
        }
        this.handleFailure(op, errorMsg);
      }
    };

    await Promise.all(batch.map(processOp));
    this.persist();

    this.processing = false;
    this.scheduleNextCheck();
  }

  private isNetworkError(error: string): boolean {
    const networkPatterns = ["typo in the url", "unable to connect", "fetch failed", "econnrefused", "enotfound", "etimedout", "network", "socket"];
    const lower = error.toLowerCase();
    return networkPatterns.some(p => lower.includes(p));
  }

  // Errors that mean the cached conversation_id is permanently invalid against the
  // current api_token. Retrying with the same params will fail forever — the only
  // recovery is for the caller to re-resolve the conversation (which happens on the
  // next processSessionFile pass once the local conversation cache is dropped).
  private isStaleConversationError(error: string): boolean {
    return error.includes("Conversation not found") ||
      error.includes("Unauthorized: can only add messages to your own conversations");
  }

  private handleFailure(op: RetryOperation, error: string): void {
    op.lastError = error;

    if (this.isStaleConversationError(error)) {
      this.log(
        `DROPPED ${op.type}: stale conversation ${op.params.conversationId || 'unknown'} (${error}). Will re-resolve on next sync.`,
        "warn"
      );
      this.recordDroppedOperation(op);
      this.queue.delete(op.id);
      return;
    }

    const isNetwork = this.isNetworkError(error);

    if (isNetwork && Date.now() - op.createdAt > 24 * 60 * 60 * 1000) {
      this.log(
        `Network op retrying >24h: ${op.type} (${op.attempts} attempts, id: ${op.id}). Still persisting.`,
        "error"
      );
    }

    if (op.attempts >= this.maxAttempts && !isNetwork) {
      this.log(
        `Max retries reached. DROPPED: ${op.type} after ${op.attempts} attempts. Last error: ${error}. Session: ${op.params.sessionId || 'unknown'}`,
        "error"
      );
      this.recordDroppedOperation(op);
      this.queue.delete(op.id);
      return;
    }

    const rateLimitDelay = parseRateLimitDelay(error);
    // Network errors cap at 5 min backoff and retry indefinitely
    const maxDelay = isNetwork ? 5 * 60 * 1000 : this.maxDelayMs;
    // After many attempts, network errors settle at max delay instead of growing
    const effectiveAttempts = isNetwork ? Math.min(op.attempts, 10) : op.attempts;
    const baseDelay = rateLimitDelay ?? this.calculateNextDelay(effectiveAttempts);
    const nextDelay = Math.min(baseDelay, maxDelay);
    op.nextRetryAt = Date.now() + nextDelay;
    op.rateLimitDelayMs = rateLimitDelay ?? undefined;
    this.log(
      `Retry failed for ${op.type}: ${error}. Next retry in ${nextDelay}ms${rateLimitDelay ? ' (rate limited)' : ''}${isNetwork ? ' (network, indefinite)' : ''} (id: ${op.id})`,
      "warn"
    );
  }

  private recordDroppedOperation(op: RetryOperation): void {
    if (!this.droppedPath) return;

    const dropped: DroppedOperation = {
      id: op.id,
      type: op.type,
      params: op.params,
      attempts: op.attempts,
      createdAt: op.createdAt,
      droppedAt: Date.now(),
      lastError: op.lastError,
      sessionId: op.params.sessionId as string | undefined,
      conversationId: op.params.conversationId as string | undefined,
    };

    try {
      let existing: DroppedOperation[] = [];
      if (fs.existsSync(this.droppedPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(this.droppedPath, "utf-8"));
        } catch {
          existing = [];
        }
      }

      existing.push(dropped);

      // Keep only last 1000 dropped operations
      if (existing.length > 1000) {
        existing = existing.slice(-1000);
      }

      fs.writeFileSync(this.droppedPath, JSON.stringify(existing, null, 2));
      this.log(`Recorded dropped operation to ${this.droppedPath}`);
    } catch (err) {
      this.log(`Failed to record dropped operation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getDroppedOperations(): DroppedOperation[] {
    if (!this.droppedPath || !fs.existsSync(this.droppedPath)) {
      return [];
    }
    try {
      return JSON.parse(fs.readFileSync(this.droppedPath, "utf-8"));
    } catch {
      return [];
    }
  }

  clearDroppedOperations(): void {
    if (this.droppedPath && fs.existsSync(this.droppedPath)) {
      fs.unlinkSync(this.droppedPath);
    }
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  // Live sync-backlog snapshot for the heartbeat. `oldestPendingMs` is the age
  // of the longest-waiting queued op, which lets the web distinguish a real
  // stall (op stuck for minutes) from a transient retry that self-heals.
  getHealth(): { pending: number; oldestPendingMs: number } {
    const now = Date.now();
    let oldestPendingMs = 0;
    for (const op of this.queue.values()) {
      const age = now - op.createdAt;
      if (age > oldestPendingMs) oldestPendingMs = age;
    }
    return { pending: this.queue.size, oldestPendingMs };
  }

  getPendingOperations(): RetryOperation[] {
    return Array.from(this.queue.values());
  }

  clear(): void {
    this.queue.clear();
    this.persist();
    this.stopTimer();
  }

  stop(): void {
    this.stopTimer();
  }

  async waitForCompletion(timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();

    while (this.queue.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        this.log(`Timeout waiting for retry queue to drain (${this.queue.size} operations remaining)`);
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.log("All retry queue operations completed");
    return true;
  }
}
