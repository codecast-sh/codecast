// Chrome aborts a write with "TimeoutError: Transaction timed out due to
// inactivity" when the page stalls; the same put succeeds a moment later
// (ct-75824). Retry only that error, a bounded number of times, so a wedged
// IndexedDB still rejects and the middleware's watchdog still sees it.
export const OUTBOX_TIMEOUT_RETRIES = 2;
const OUTBOX_RETRY_DELAY_MS = 50;

function isTransientIdbTimeout(e: unknown): boolean {
  const err = e as { name?: string; inner?: { name?: string } } | null;
  return err?.name === "TimeoutError" || err?.inner?.name === "TimeoutError";
}

/** Run the dispatch outbox's put, retrying it past a transient IndexedDB TimeoutError. */
export function retryOutboxPut(put: () => Promise<unknown>, retriesLeft = OUTBOX_TIMEOUT_RETRIES): Promise<void> {
  return put().then(
    () => {},
    (e) => {
      if (retriesLeft <= 0 || !isTransientIdbTimeout(e)) throw e;
      return new Promise<void>((r) => setTimeout(r, OUTBOX_RETRY_DELAY_MS)).then(() => retryOutboxPut(put, retriesLeft - 1));
    },
  );
}
