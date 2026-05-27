export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function exponentialBackoffDelay(
  currentFailureCount: number,
  minDelay: number,
  maxDelay: number,
  maxFailureCount: number
): number {
  const maxDelayRet =
    minDelay +
    ((maxDelay - minDelay) / maxFailureCount) *
      Math.max(currentFailureCount, maxFailureCount);
  return Math.round(Math.random() * maxDelayRet);
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export interface BackoffOptions {
  onError?: (e: unknown, failuresCount: number) => void;
  minDelay?: number;
  maxDelay?: number;
  maxFailureCount?: number;
}

export function createBackoff(opts?: BackoffOptions): BackoffFunc {
  return async <T>(callback: () => Promise<T>): Promise<T> => {
    let currentFailureCount = 0;
    const minDelay = opts?.minDelay ?? 250;
    const maxDelay = opts?.maxDelay ?? 1000;
    const maxFailureCount = opts?.maxFailureCount ?? 50;
    while (true) {
      try {
        return await callback();
      } catch (e) {
        if (currentFailureCount < maxFailureCount) {
          currentFailureCount++;
        }
        opts?.onError?.(e, currentFailureCount);
        const waitForRequest = exponentialBackoffDelay(
          currentFailureCount,
          minDelay,
          maxDelay,
          maxFailureCount
        );
        await delay(waitForRequest);
      }
    }
  };
}

export const backoff = createBackoff({
  onError: (e) => {
    console.warn(e);
  },
});

export interface InvalidateSyncOptions {
  // Coalesce bursts of invalidations: wait this long after the last event before
  // running. A continuously-firing source (e.g. a streaming agent appending to its
  // JSONL) would otherwise trigger one sync per event; debouncing collapses that
  // burst into a single fat batch. Default 0 = run immediately (legacy behavior).
  debounceMs?: number;
  // Upper bound on how long a pending change can be held by debounce, so a source
  // that never goes quiet still flushes. 0 = no cap.
  maxWaitMs?: number;
}

export class InvalidateSync {
  private _invalidated = false;
  private _invalidatedDouble = false;
  private _stopped = false;
  private _command: () => Promise<void>;
  private _pendings: (() => void)[] = [];
  private _debounceMs: number;
  private _maxWaitMs: number;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _firstPendingAt = 0;

  constructor(command: () => Promise<void>, options: InvalidateSyncOptions = {}) {
    this._command = command;
    this._debounceMs = options.debounceMs ?? 0;
    this._maxWaitMs = options.maxWaitMs ?? 0;
  }

  invalidate(): void {
    if (this._stopped) {
      return;
    }
    if (this._debounceMs > 0) {
      this._scheduleDebounced();
      return;
    }
    this._invalidateNow();
  }

  private _invalidateNow(): void {
    if (this._stopped) {
      return;
    }
    if (!this._invalidated) {
      this._invalidated = true;
      this._invalidatedDouble = false;
      this._doSync();
    } else {
      if (!this._invalidatedDouble) {
        this._invalidatedDouble = true;
      }
    }
  }

  private _scheduleDebounced(): void {
    const now = Date.now();
    if (this._firstPendingAt === 0) {
      this._firstPendingAt = now;
    }
    // Cap total hold time so a session that streams without pause still flushes.
    if (this._maxWaitMs > 0 && now - this._firstPendingAt >= this._maxWaitMs) {
      this._fireDebounced();
      return;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => this._fireDebounced(), this._debounceMs);
  }

  private _fireDebounced(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._firstPendingAt = 0;
    this._invalidateNow();
  }

  async invalidateAndAwait(): Promise<void> {
    if (this._stopped) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._pendings.push(resolve);
      // Explicit await means the caller wants the work to run now — bypass debounce
      // and flush any pending debounced change immediately.
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._firstPendingAt = 0;
      this._invalidateNow();
    });
  }

  async awaitQueue(): Promise<void> {
    if (this._stopped || (!this._invalidated && this._pendings.length === 0)) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._pendings.push(resolve);
    });
  }

  stop(): void {
    if (this._stopped) {
      return;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._notifyPendings();
    this._stopped = true;
  }

  private _notifyPendings = (): void => {
    for (const pending of this._pendings) {
      pending();
    }
    this._pendings = [];
  };

  private _doSync = async (): Promise<void> => {
    await backoff(async () => {
      if (this._stopped) {
        return;
      }
      await this._command();
    });
    if (this._stopped) {
      this._notifyPendings();
      return;
    }
    if (this._invalidatedDouble) {
      this._invalidatedDouble = false;
      this._doSync();
    } else {
      this._invalidated = false;
      this._notifyPendings();
    }
  };
}
