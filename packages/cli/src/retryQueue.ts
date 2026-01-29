import fs from "fs";
import path from "path";

export interface RetryOperation {
  id: string;
  type: "createConversation" | "addMessage";
  params: Record<string, unknown>;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
  rateLimitDelayMs?: number;
}

export interface DroppedOperation {
  id: string;
  type: "createConversation" | "addMessage";
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
          for (const op of data) {
            if (op.id && op.type && op.params) {
              op.nextRetryAt = Date.now() + 1000;
              this.queue.set(op.id, op);
            }
          }
          if (this.queue.size > 0) {
            this.log(`Restored ${this.queue.size} operations from disk`);
          }
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

    const batch = readyOps.slice(0, this.concurrency);

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

  private handleFailure(op: RetryOperation, error: string): void {
    op.lastError = error;

    if (op.attempts >= this.maxAttempts) {
      this.log(
        `DROPPED: ${op.type} after ${op.attempts} attempts. Last error: ${error}. Session: ${op.params.sessionId || 'unknown'}`,
        "error"
      );
      this.recordDroppedOperation(op);
      this.queue.delete(op.id);
      return;
    }

    const rateLimitDelay = parseRateLimitDelay(error);
    const nextDelay = rateLimitDelay ?? this.calculateNextDelay(op.attempts);
    op.nextRetryAt = Date.now() + nextDelay;
    op.rateLimitDelayMs = rateLimitDelay ?? undefined;
    this.log(
      `Retry failed for ${op.type}: ${error}. Next retry in ${nextDelay}ms${rateLimitDelay ? ' (rate limited)' : ''} (id: ${op.id})`,
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
