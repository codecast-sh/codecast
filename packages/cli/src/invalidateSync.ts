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

export class InvalidateSync {
  private _invalidated = false;
  private _invalidatedDouble = false;
  private _stopped = false;
  private _command: () => Promise<void>;
  private _pendings: (() => void)[] = [];

  constructor(command: () => Promise<void>) {
    this._command = command;
  }

  invalidate(): void {
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

  async invalidateAndAwait(): Promise<void> {
    if (this._stopped) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._pendings.push(resolve);
      this.invalidate();
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
