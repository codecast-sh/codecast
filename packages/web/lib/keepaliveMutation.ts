import { getFunctionName } from "convex/server";

import { AUTH_JWT_STORAGE_KEY, CONVEX_URL } from "./localAuth";

/**
 * One mutation that has to outlive the page.
 *
 * The Convex client talks over a WebSocket, and a frame written in a
 * `beforeunload` handler does not reliably leave before the socket is torn
 * down. That is measured, not assumed: finalizing a live voice burst through
 * the ordinary client on a real page reload left the row `live` on the server,
 * while the identical call with the page still alive landed instantly. Every
 * unload guard built on the socket is therefore decorative — it runs, and
 * nothing arrives.
 *
 * `fetch` with `keepalive` is the channel the platform provides for exactly
 * this case: the browser owns the request once the document is gone. So the
 * last word of a dying page goes over HTTP to the same deployment, carrying
 * the same token the socket was using (`localAuth` owns that key's layout and
 * has a contract test pinning it).
 *
 * Best-effort by construction. No response is read and every failure is
 * swallowed, because there is no longer anyone to tell. Whatever server-side
 * sweep already covers the case stays the real guarantee; this only makes the
 * common case instant instead of minutes late.
 *
 * Takes the function REFERENCE, not its name. `getFunctionName` produces the
 * exact string the HTTP API wants ("chat:finalizeVoiceBurst") and a rename
 * then breaks the build instead of failing silently in an unload handler
 * nobody is watching — the one place a typo could never be noticed.
 */
export function mutateOnUnload(fn: unknown, args: Record<string, unknown>): void {
  try {
    const token = localStorage.getItem(AUTH_JWT_STORAGE_KEY);
    if (!token) return;
    const path = getFunctionName(fn as any);
    void fetch(`${CONVEX_URL}/api/mutation`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path, args, format: "json" }),
    }).catch(() => {});
  } catch {
    // No storage, no fetch, no network: there is nothing left to try and
    // nobody left to tell.
  }
}
