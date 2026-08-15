/**
 * Watch engine for `cast browser` running on the external engine
 * (agent-browser), which isolates tabs per codecast session.
 *
 * The engine keeps its own Chrome, but that Chrome has an ordinary debugging
 * port, and the engine's tab list carries REAL CDP target ids — so streaming
 * is the same Page.startScreencast path as the built-in driver, pointed at a
 * different port. Only two things are engine-specific, and both are supplied
 * by the caller so this file compiles without the engine module present:
 *
 *   tabsFor(sessionKey)   → the tabs the engine holds for that session
 *   endpointFor(sessionKey) → the debugging port of the Chrome behind them
 *
 * (Those are `engineTabs({session})` and `engineCdpEndpoint({session})` in
 * browser/engine.ts.) The watch server never sees engine-local tab ids like
 * "t1" — they repeat across sessions — only the target id.
 */

import { CdpConnection, listTargets, type CdpTarget } from "./cdp.js";
import { openCdpScreencast, type WatchEngine, type WatchResolveError } from "./watchSource.js";

export interface EngineTabInfo {
  targetId: string;
  active?: boolean;
  title?: string;
  url?: string;
}

export interface EngineWatchDeps {
  /** Tabs the engine holds for a session key (see engineSession in engine.ts). */
  tabsFor(sessionKey: string): EngineTabInfo[];
  /** Debugging port of the Chrome behind that session, or null if it has none. */
  endpointFor(sessionKey: string): Promise<{ port: number } | null>;
  connect?(port: number): Promise<CdpConnection>;
  listTargets?(port: number): Promise<CdpTarget[]>;
}

// The engine spawns a process per query; the owner poll runs every couple of
// seconds, so answers are reused briefly rather than paid for every tick.
const TAB_CACHE_MS = 2000;

/**
 * Same sanitization as engineSession(): owner keys become session names that
 * are safe in paths and process listings. Kept in one place here so the two
 * cannot drift apart silently — a mismatch would resolve to "no tab" for
 * every viewer.
 */
export function engineSessionFor(ownerKey: string): string {
  return ownerKey.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
}

export function engineWatchEngine(deps: EngineWatchDeps): WatchEngine {
  const connect = deps.connect ?? ((port: number) => CdpConnection.fromPort(port));
  const list = deps.listTargets ?? listTargets;
  const cache = new Map<string, { at: number; tabs: EngineTabInfo[] }>();
  // Which session key a tab id was resolved under, so open() can find its port.
  const sessionByTab = new Map<string, string>();

  const tabsFor = (key: string): EngineTabInfo[] => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TAB_CACHE_MS) return hit.tabs;
    const tabs = deps.tabsFor(key);
    cache.set(key, { at: Date.now(), tabs });
    return tabs;
  };

  const resolveTab = (candidates: string[]): { tabId: string } | { error: WatchResolveError } => {
    for (const cand of candidates) {
      const key = engineSessionFor(cand);
      const tabs = tabsFor(key);
      const tab = tabs.find((t) => t.active && t.targetId) ?? tabs.find((t) => t.targetId);
      if (tab) {
        sessionByTab.set(tab.targetId, key);
        return { tabId: tab.targetId };
      }
    }
    return { error: "no-tab" };
  };

  return {
    resolveTab,
    async open(tabId, opts, handlers) {
      const key = sessionByTab.get(tabId);
      const ep = key ? await deps.endpointFor(key) : null;
      if (!ep) throw new Error("no-browser");
      // Same screencast source as the built-in driver; only the port differs.
      return openCdpScreencast(ep.port, tabId, opts, handlers, { connect, listTargets: list });
    },
  };
}
