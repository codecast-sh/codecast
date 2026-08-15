// Focus the REAL driven Chrome tab behind a `cast browser` command row.
//
// The daemon's loopback hook server exposes POST /browser/focus?tab=<id>
// (packages/cli/src/browser/focusHttp.ts). We reach it through the same
// discovery the integrated terminal uses — getTerminalEndpoint — so this works
// exactly when the viewer is on the machine whose daemon drove the browser,
// and needs no new server-side plumbing. Everything that can go wrong (other
// machine, daemon down, browser stopped, tab closed, old daemon without the
// route) comes back as `false`, and the caller falls back to opening the URL.

import type { ConvexReactClient } from "convex/react";
import { getTerminalEndpoint, termHttpBase, type TerminalEndpoint } from "./terminal/endpoint";

// A click must stay inside the browser's transient-activation window (~5s in
// Chrome) or the window.open fallback gets popup-blocked, so both halves of
// the attempt are tightly bounded: worst case ~3.3s, typical (cached
// endpoint) well under 100ms.
const DISCOVERY_BUDGET_MS = 1_800;
const FOCUS_REQUEST_TIMEOUT_MS = 1_500;

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

/** Warm the endpoint cache (e.g. on link hover) so the click itself is fast. */
export function prefetchBrowserFocusEndpoint(convex: ConvexReactClient): void {
  void getTerminalEndpoint(convex).catch(() => null);
}

/** Injectable for tests; the defaults are the real thing. */
export interface FocusTabDeps {
  getEndpoint: () => Promise<TerminalEndpoint | null>;
  fetchImpl: typeof fetch;
  discoveryBudgetMs?: number;
}

/**
 * True when the daemon confirmed it raised the tab. False means "open the URL
 * instead" — never throws, and stays quiet about why: every failure here is an
 * expected everyday condition, not an error worth a toast.
 */
export async function focusBrowserTab(
  convex: ConvexReactClient,
  tabId: string,
  deps?: Partial<FocusTabDeps>,
): Promise<boolean> {
  const getEndpoint = deps?.getEndpoint ?? (() => getTerminalEndpoint(convex));
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const budget = deps?.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS;

  // First discovery on a machine can outlast a click's activation window; give
  // up on THIS click and let the fallback open the URL, while the discovery
  // keeps running and caches the endpoint for the next one.
  const endpoint = await Promise.race([
    getEndpoint().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), budget)),
  ]);
  if (!endpoint) return false;

  try {
    const res = await fetchImpl(`${termHttpBase(endpoint)}/browser/focus?tab=${encodeURIComponent(tabId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(FOCUS_REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
