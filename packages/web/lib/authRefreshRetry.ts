// A token refresh that cannot reach Convex waits for the network and tries
// again, instead of stranding the app until a reload (ct-74162).
//
// When the server rejects the current token, Convex's AuthenticationManager
// stops the websocket and asks for a fresh token with forceRefreshToken. If
// that request dies in transit, Convex Auth either rejects (nothing catches it:
// the socket stays stopped and the rejection escapes unhandled) or, with the
// ct-91563 patch, hands back the token it already had (the manager then
// reports the person signed out). Convex never asks again in either case.
//
// So the fetchToken codecast hands to client.setAuth retries a forced refresh
// that failed in transit: when the browser says it is offline, on the next
// `online` event; otherwise with a backoff from 1s to 30s that an `online`
// event cuts short, never more than one attempt a second. A real refusal is
// untouched: a null token, or an error that came from the auth function (the
// http client's 560 path), passes straight through as before.

type FetchToken = (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;
type AuthClient = {
  setAuth: (fetchToken: FetchToken, onChange?: (isAuthenticated: boolean) => void) => void;
  clearAuth: () => void;
};

const MIN_GAP_MS = 1000;
const MAX_DELAY_MS = 30_000;

/**
 * True when the refresh never got an answer from the auth function. The only
 * answer that counts is the http client's 560 path, a function error: a
 * ConvexError, or a message the server shaped ("[Request ID: …] Server Error",
 * "Uncaught …"). Everything else (a network TypeError, a gateway page, an
 * overload, a JSON 500 from the backend, any other non-ok body the client
 * throws verbatim) died on the way and is worth asking again.
 */
export function isRefreshInTransit(error: unknown): boolean {
  if ((error as { codecastInTransit?: unknown } | null)?.codecastInTransit === true) return true;
  if ((error as { name?: unknown } | null)?.name === "ConvexError") return false;
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return !/Server Error|Uncaught /.test(message);
}

function waitToRetry(attempt: number, lastAttemptAt: number, cancelled: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const onOnline = () => {
      clearTimeout(timer);
      timer = setTimeout(done, Math.max(0, lastAttemptAt + MIN_GAP_MS - Date.now()));
    };
    if (cancelled()) return resolve();
    signal.addEventListener("abort", done);
    window.addEventListener("online", onOnline);
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const backoff = Math.min(MAX_DELAY_MS, MIN_GAP_MS * 2 ** (attempt - 1));
    timer = setTimeout(done, backoff + Math.random() * 250);
  });
}

/** Wrap a Convex fetchToken so a forced refresh that fails in transit is retried, not thrown or reported as a sign-out. */
export function retryRefreshInTransit(fetchToken: FetchToken, signal: AbortSignal): FetchToken {
  let lastToken: string | null | undefined;
  return async (args) => {
    if (!args.forceRefreshToken) {
      lastToken = await fetchToken(args);
      return lastToken;
    }
    for (let attempt = 1; ; attempt++) {
      // A newer setAuth or clearAuth replaced this config: Convex ignores the answer.
      if (signal.aborted) return null;
      const before = lastToken;
      const startedAt = Date.now();
      try {
        const token = await fetchToken(args);
        // The ct-91563-patched library gives up by returning the token it already had.
        if (token == null || token !== before) {
          lastToken = token;
          return token;
        }
      } catch (error) {
        if (!isRefreshInTransit(error)) throw error;
      }
      await waitToRetry(attempt, startedAt, () => signal.aborted, signal);
    }
  };
}

const installed = new WeakSet<object>();

/** Install the retry on a Convex client's setAuth, once per client. */
export function installRefreshRetry<C extends AuthClient>(client: C): C {
  if (installed.has(client)) return client;
  installed.add(client);
  const setAuth = client.setAuth.bind(client);
  const clearAuth = client.clearAuth.bind(client);
  let current = new AbortController();
  client.setAuth = (fetchToken, onChange) => {
    current.abort();
    current = new AbortController();
    setAuth(retryRefreshInTransit(fetchToken, current.signal), onChange);
  };
  client.clearAuth = () => {
    current.abort();
    clearAuth();
  };
  return client;
}
