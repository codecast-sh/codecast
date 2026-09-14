// Focus the REAL driven Chrome tab behind a `cast browser` command row, and
// bring it back when it is gone.
//
// The daemon's loopback hook server exposes POST /browser/focus?tab=<id> and
// POST /browser/reopen (packages/cli/src/browser/focusHttp.ts). We reach it
// through the same discovery the integrated terminal uses — getTerminalEndpoint
// — so this works exactly when the viewer is on the machine whose daemon drove
// the browser, and needs no new server-side plumbing.
//
// A click waits for the daemon's real answer. There is no popup fallback to
// protect (the pill never opens a fresh copy of the page), so there is no
// activation window to stay inside, and the old tight budgets only turned a
// busy daemon into a dead click: the endpoint re-probe alone took up to a
// second, the focus route another 1.5s, against budgets of 1.8s and 1.5s. Now
// the cached endpoint is trusted outright — the request itself is the probe,
// and a dead port or stale token re-runs discovery once — and the outcome is
// typed, so the pill can say what happened and offer the reopen.

import type { ConvexReactClient } from "convex/react";
import { getTerminalEndpoint, termHttpBase, type TerminalEndpoint } from "./terminal/endpoint";

// Outlasts the daemon's own patience with a busy bridge (focusHttp.ts
// BRIDGE_FOCUS_TIMEOUT_MS, 30s) so a slow answer is still an answer.
const FOCUS_REQUEST_TIMEOUT_MS = 40_000;
// An open can start the bridge host, navigate, and carry logins.
const REOPEN_REQUEST_TIMEOUT_MS = 75_000;

/**
 * The 8-char tab id from a `cast browser` row's output, e.g.
 * "tab 4A2CDC7E — next: cast browser snapshot". Last mention wins: when a
 * wedged tab was replaced mid-command, the later line names the tab the
 * command actually ended on. The bare word is required so recovery hints like
 * "cast browser close --tab 4A2CDC7E" don't count as an acted-on tab.
 */
export function extractBrowserTabId(output: string): string | null {
  if (!output) return null;
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const matches = [...clean.matchAll(/(?:^|[^-\w])tab ([0-9A-Fa-f]{8})\b/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/** Warm the endpoint cache (e.g. on pill render) so the click itself is fast. */
export function prefetchBrowserFocusEndpoint(convex: ConvexReactClient): void {
  void getTerminalEndpoint(convex).catch(() => null);
}

/**
 * Why a focus or reopen did not happen.
 *  - "no-daemon": no daemon of yours answers on this machine — the browser
 *    runs elsewhere, or cast is not running here. Nothing to reopen into.
 *  - "tab-gone": the browser is up but has no such tab (closed, or the
 *    browser restarted). The reopen offer is for this one.
 *  - "browser-stopped": no driven browser is running here. Reopening starts
 *    one, so the offer stands.
 *  - "unreachable": a browser is there but not answering, or the daemon took
 *    too long. Worth a second click, not a reopen.
 *  - "open-failed": the reopen ran and the CLI refused or failed; `detail`
 *    carries its last line.
 */
export type BrowserTabFailure = "no-daemon" | "tab-gone" | "browser-stopped" | "unreachable" | "open-failed";

export type FocusOutcome = { ok: true } | { ok: false; reason: BrowserTabFailure; detail?: string };
export type ReopenOutcome = { ok: true; tabId: string } | { ok: false; reason: BrowserTabFailure; detail?: string };

/** Injectable for tests; the defaults are the real thing. */
export interface FocusTabDeps {
  getEndpoint: (opts: { trustCache?: boolean; force?: boolean }) => Promise<TerminalEndpoint | null>;
  fetchImpl: typeof fetch;
}

function realDeps(convex: ConvexReactClient, deps?: Partial<FocusTabDeps>): FocusTabDeps {
  return {
    getEndpoint: deps?.getEndpoint ?? ((opts) => getTerminalEndpoint(convex, opts)),
    fetchImpl: deps?.fetchImpl ?? fetch,
  };
}

type Sent = { res: Response; body: any } | { transport: "failed" | "timeout" };

/**
 * One request to the daemon, tried first against the trusted cache and again
 * after a forced discovery when the cached endpoint was dead (connection
 * refused, or a 403 from a token an older daemon boot issued).
 */
async function sendToDaemon(deps: FocusTabDeps, path: string, init: RequestInit, timeoutMs: number): Promise<Sent | "no-daemon"> {
  const attempt = async (endpoint: TerminalEndpoint): Promise<Sent> => {
    try {
      const res = await deps.fetchImpl(`${termHttpBase(endpoint)}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${endpoint.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* a 404 from an older daemon without the route has no JSON body */
      }
      return { res, body };
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      return { transport: name === "TimeoutError" || name === "AbortError" ? "timeout" : "failed" };
    }
  };

  const cached = await deps.getEndpoint({ trustCache: true }).catch(() => null);
  if (cached) {
    const first = await attempt(cached);
    const stale = ("transport" in first && first.transport === "failed") || (!("transport" in first) && first.res.status === 403);
    if (!stale) return first;
  }
  const fresh = await deps.getEndpoint({ force: true }).catch(() => null);
  if (!fresh) return "no-daemon";
  return attempt(fresh);
}

function failureOf(sent: Sent | "no-daemon"): { reason: BrowserTabFailure; detail?: string } {
  if (sent === "no-daemon") return { reason: "no-daemon" };
  if ("transport" in sent) return { reason: "unreachable" };
  const daemonReason = sent.body?.reason;
  if (daemonReason === "tab-not-found") return { reason: "tab-gone" };
  if (daemonReason === "browser-stopped") return { reason: "browser-stopped" };
  if (daemonReason === "open-failed") return { reason: "open-failed", detail: typeof sent.body?.detail === "string" ? sent.body.detail : undefined };
  return { reason: "unreachable" };
}

/** Ask the daemon to raise the tab. Never throws. */
export async function focusBrowserTab(convex: ConvexReactClient, tabId: string, deps?: Partial<FocusTabDeps>): Promise<FocusOutcome> {
  const d = realDeps(convex, deps);
  const sent = await sendToDaemon(d, `/browser/focus?tab=${encodeURIComponent(tabId)}`, { method: "POST" }, FOCUS_REQUEST_TIMEOUT_MS);
  if (sent !== "no-daemon" && !("transport" in sent) && sent.res.ok) return { ok: true };
  return { ok: false, ...failureOf(sent) };
}

/** Which session the page belongs to, the way the watch stream names it. */
export interface BrowserSessionRef {
  sessionUuid?: string | null;
  tmuxSession?: string | null;
}

/**
 * Bring a closed tab back: the daemon runs `cast browser open <url>` as the
 * session, so the page returns under the session's own tab, then raises it.
 * Never throws.
 */
export async function reopenBrowserTab(
  convex: ConvexReactClient,
  page: { url: string } & BrowserSessionRef,
  deps?: Partial<FocusTabDeps>,
): Promise<ReopenOutcome> {
  const d = realDeps(convex, deps);
  const body = JSON.stringify({
    url: page.url,
    ...(page.sessionUuid ? { session_uuid: page.sessionUuid } : {}),
    ...(page.tmuxSession ? { tmux_session: page.tmuxSession } : {}),
  });
  const sent = await sendToDaemon(
    d,
    "/browser/reopen",
    { method: "POST", headers: { "Content-Type": "application/json" }, body },
    REOPEN_REQUEST_TIMEOUT_MS,
  );
  if (sent !== "no-daemon" && !("transport" in sent) && sent.res.ok && typeof sent.body?.tabId === "string") {
    return { ok: true, tabId: sent.body.tabId };
  }
  return { ok: false, ...failureOf(sent) };
}
