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
  // Give up after this many consecutive failures instead of retrying forever,
  // rethrowing the last error so the caller can decide what to do. Undefined =
  // retry indefinitely (legacy behavior).
  maxRetries?: number;
}

export function createBackoff(opts?: BackoffOptions): BackoffFunc {
  return async <T>(callback: () => Promise<T>): Promise<T> => {
    let failures = 0;
    const minDelay = opts?.minDelay ?? 250;
    const maxDelay = opts?.maxDelay ?? 1000;
    const maxFailureCount = opts?.maxFailureCount ?? 50;
    const maxRetries = opts?.maxRetries;
    while (true) {
      try {
        return await callback();
      } catch (e) {
        failures++;
        opts?.onError?.(e, failures);
        // Stop hammering a command that never recovers (a deleted transcript, or any
        // permanently-failing sync) — it used to loop ~2/sec forever. Callers re-arm
        // on the next event, so giving up here is a bounded backoff, not a dead end.
        if (maxRetries !== undefined && failures >= maxRetries) {
          throw e;
        }
        const waitForRequest = exponentialBackoffDelay(
          Math.min(failures, maxFailureCount),
          minDelay,
          maxDelay,
          maxFailureCount
        );
        await delay(waitForRequest);
      }
    }
  };
}


export interface InvalidateSyncOptions {
  // Coalesce bursts of invalidations: wait this long after the last event before
  // running. A continuously-firing source (e.g. a streaming agent appending to its
  // JSONL) would otherwise trigger one sync per event; debouncing collapses that
  // burst into a single fat batch. Default 0 = run immediately (legacy behavior).
  debounceMs?: number;
  // Upper bound on how long a pending change can be held by debounce, so a source
  // that never goes quiet still flushes. 0 = no cap.
  maxWaitMs?: number;
  // Give up after this many consecutive command failures instead of retrying
  // forever, then re-arm on the next invalidate. Defaults to DEFAULT_MAX_RETRIES.
  maxRetries?: number;
  // Called once when the retry budget is exhausted, with the last error. Lets the
  // caller log the give-up on its own channel.
  onGiveUp?: (error: unknown) => void;
}

// A persistently-failing sync (e.g. a bug, an un-retryable server rejection) used to
// retry ~2/sec forever. Cap the burst so it backs off after ~this many tries; a real
// file change or the 5-min watchdog re-arms a fresh attempt. High enough that a
// transient blip (which recovers in a few tries) never trips it.
const DEFAULT_MAX_RETRIES = 50;

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
  private _backoff: BackoffFunc;
  private _onGiveUp?: (error: unknown) => void;

  constructor(command: () => Promise<void>, options: InvalidateSyncOptions = {}) {
    this._command = command;
    this._debounceMs = options.debounceMs ?? 0;
    this._maxWaitMs = options.maxWaitMs ?? 0;
    this._onGiveUp = options.onGiveUp;
    this._backoff = createBackoff({
      onError: (e) => {
        console.warn(e);
      },
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
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
    try {
      await this._backoff(async () => {
        if (this._stopped) {
          return;
        }
        await this._command();
      });
    } catch (e) {
      // Backoff exhausted its retry budget on a persistently-failing command. Stop
      // the loop, surface the error, and reset so the NEXT invalidate (a real file
      // change or the watchdog) starts a fresh attempt — rather than looping forever.
      this._invalidated = false;
      this._invalidatedDouble = false;
      this._onGiveUp?.(e);
      this._notifyPendings();
      return;
    }
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
