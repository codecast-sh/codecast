type BrowserWindowLike = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  setInterval(listener: () => void, delay: number): unknown;
  clearInterval(id: unknown): void;
};

type BrowserDocumentLike = {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

type DispatchSelfHealOptions = {
  bindDispatch: () => boolean;
  isDispatchWired: () => boolean;
  drainOutbox: () => void;
  clearDispatch: () => void;
  browserWindow: BrowserWindowLike | null;
  browserDocument: BrowserDocumentLike | null;
};

/**
 * Installs the browser signals that rebind and drain a stale dispatch.
 *
 * A failed initial bind is a race, not a terminal state: authorization can
 * change between the hook snapshot and its effect. The listeners therefore
 * stay installed even when that first capture is null.
 */
export function installBrowserDispatchSelfHeal({
  bindDispatch,
  isDispatchWired,
  drainOutbox,
  clearDispatch,
  browserWindow,
  browserDocument,
}: DispatchSelfHealOptions): () => void {
  bindDispatch();

  // React Native and SSR have no browser event loop. Preserve their one-shot
  // binding behavior; AppState/connectivity recovery is a separate capability.
  if (
    !browserWindow ||
    !browserDocument ||
    typeof browserWindow.addEventListener !== "function"
  ) {
    return clearDispatch;
  }

  const drain = () => {
    if (!isDispatchWired() && !bindDispatch()) return;
    drainOutbox();
  };
  const onVisible = () => {
    if (browserDocument.visibilityState === "visible") drain();
  };

  browserWindow.addEventListener("online", drain);
  browserDocument.addEventListener("visibilitychange", onVisible);
  const interval = browserWindow.setInterval(drain, 30_000);

  return () => {
    browserWindow.removeEventListener("online", drain);
    browserDocument.removeEventListener("visibilitychange", onVisible);
    browserWindow.clearInterval(interval);
    clearDispatch();
  };
}
