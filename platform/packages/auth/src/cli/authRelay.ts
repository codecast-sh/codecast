// Relay half of the CLI auth flow: polls the backend for a token the web page
// deposited because it couldn't reach our localhost listener (CLI on a remote
// machine; see the cliAuth functions in @platform/auth/convex). Runs alongside
// AuthServer.waitForCallback; whichever path delivers first wins.
import type { AuthResult } from "./authServer.js";

export interface RelayPoller {
  /** Resolves with credentials when a deposit is claimed; never on its own. */
  promise: Promise<AuthResult>;
  /** Ends the poll loop (the promise is abandoned, not rejected). */
  stop: () => void;
}

/** A fetch with a per attempt timeout. The cast CLI passes its cliFetch here. */
export type RelayFetch = (
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number },
) => Promise<Response>;

const POLL_INTERVAL_MS = 2500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const defaultRelayFetch: RelayFetch = (url, init, { timeoutMs }) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

export function startRelayPoller(
  convexSiteUrl: string,
  nonce: string,
  opts: { intervalMs?: number; fetchImpl?: RelayFetch; path?: string } = {}
): RelayPoller {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const doFetch = opts.fetchImpl ?? defaultRelayFetch;
  const path = opts.path ?? "/cli/claim-auth";
  let stopped = false;

  const promise = (async (): Promise<AuthResult> => {
    while (true) {
      await sleep(intervalMs);
      if (stopped) break;
      try {
        const response = await doFetch(
          `${convexSiteUrl}${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nonce }),
          },
          { timeoutMs: 10_000 }
        );
        if (stopped) break;
        if (!response.ok) continue;
        const data = await response.json();
        if (data && data.auth_token && data.user_id) {
          return { userId: data.user_id, apiToken: data.auth_token, nonce };
        }
      } catch {
        // Transient network failure; the next tick is the retry.
      }
    }
    // Abandoned: stay pending forever so Promise.race ignores us.
    return new Promise<AuthResult>(() => {});
  })();

  return { promise, stop: () => { stopped = true; } };
}
