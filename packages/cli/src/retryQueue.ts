export interface RetryOperation {
  id: string;
  type: "createConversation" | "addMessage";
  params: Record<string, unknown>;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
}

export interface RetryQueueConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  checkIntervalMs?: number;
  onLog?: (message: string) => void;
}

const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_CHECK_INTERVAL = 500;

export class RetryQueue {
  private queue: Map<string, RetryOperation> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private executor: ((op: RetryOperation) => Promise<boolean>) | null = null;
  private initialDelayMs: number;
  private maxDelayMs: number;
  private maxAttempts: number;
  private checkIntervalMs: number;
  private log: (message: string) => void;
  private processing = false;

  constructor(config: RetryQueueConfig = {}) {
    this.initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY;
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL;
    this.log = config.onLog ?? (() => {});
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
    const op: RetryOperation = {
      id,
      type,
      params,
      attempts: 0,
      nextRetryAt: Date.now() + this.initialDelayMs,
      createdAt: Date.now(),
      lastError: error,
    };
    this.queue.set(id, op);
    this.log(`Queued ${type} for retry (id: ${id})`);
    this.ensureTimerRunning();
    return id;
  }

  private calculateNextDelay(attempts: number): number {
    const delay = this.initialDelayMs * Math.pow(2, attempts);
    return Math.min(delay, this.maxDelayMs);
  }

  private ensureTimerRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.processQueue(), this.checkIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.executor || this.queue.size === 0) return;

    this.processing = true;
    const now = Date.now();

    for (const [id, op] of this.queue) {
      if (op.nextRetryAt > now) continue;

      op.attempts++;
      this.log(
        `Retrying ${op.type} (attempt ${op.attempts}/${this.maxAttempts}, id: ${id})`
      );

      try {
        const success = await this.executor(op);
        if (success) {
          this.queue.delete(id);
          this.log(`Retry succeeded for ${op.type} (id: ${id})`);
        } else {
          this.handleFailure(op, "Operation returned false");
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.handleFailure(op, errorMsg);
      }
    }

    if (this.queue.size === 0) {
      this.stopTimer();
    }

    this.processing = false;
  }

  private handleFailure(op: RetryOperation, error: string): void {
    op.lastError = error;

    if (op.attempts >= this.maxAttempts) {
      this.log(
        `Max retries reached for ${op.type} (id: ${op.id}), dropping operation`
      );
      this.queue.delete(op.id);
      return;
    }

    const nextDelay = this.calculateNextDelay(op.attempts);
    op.nextRetryAt = Date.now() + nextDelay;
    this.log(
      `Retry failed for ${op.type}: ${error}. Next retry in ${nextDelay}ms (id: ${op.id})`
    );
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  getPendingOperations(): RetryOperation[] {
    return Array.from(this.queue.values());
  }

  clear(): void {
    this.queue.clear();
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
