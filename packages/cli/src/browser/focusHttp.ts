/**
 * Loopback route that raises a driven-browser tab: POST /browser/focus?tab=<id>.
 *
 * Mounted on the daemon's hook server next to the terminal and vault routes,
 * behind the same envelope of an allowed origin and the daemon's persisted
 * loopback token (authorizeLocalRequest). The web's "open tab" link resolves
 * this server through the existing get_terminal_endpoint discovery, then asks
 * it to focus the tab a `cast browser` row printed (tabId.ts). Loopback-only by
 * construction, which IS the "same machine" test: a viewer on another machine
 * reaches their own daemon, whose browsers have no such tab, and gets a clean
 * 404 to fall back on.
 *
 * Engine-agnostic: browsers are found through FocusEngine, and the route asks
 * each in turn. Two ship by default — the built-in driver's state file (cheap,
 * authoritative for that browser) and a scan of every Chrome on the machine
 * that is listening for CDP (localChrome.ts), which is what finds a tab in an
 * agent-browser session without the daemon knowing anything about the engine.
 * An engine adapter with a cheaper or truer view can register its own.
 */

import type http from "http";
import { CdpConnection, listTargets } from "./cdp.js";
import { raiseAppByPid, raiseAppByPidSync } from "./raiseApp.js";
import { noteDeliberateRaise } from "./focusSentinel.js";
import { readState } from "./instance.js";
import { listChromeDebugPorts } from "./localChrome.js";
import { isPidAlive } from "../workspace/chrome.js";
import {
  authorizeLocalRequest,
  corsHeaders,
  type TerminalServerOptions,
} from "../terminal/terminalServer.js";

/** Why a focus request could not be honored; the web treats them all the same
 *  (fall back to opening the URL) but the distinction keeps logs debuggable. */
export type FocusFailure = "browser-stopped" | "browser-unreachable" | "tab-not-found";

export interface FocusResult {
  ok: boolean;
  reason?: FocusFailure;
}

export interface FocusTab {
  /** The CDP target id — what tabId.ts prints as `tab <id>`. */
  id: string;
  url: string;
  /** CDP port of the browser holding it. */
  port: number;
  /** The browser process to bring frontmost after activation, if known. */
  pid?: number;
}

/**
 * The seam between this route and a browser engine: the smallest capability
 * set focus needs. `listTabs` returns [] when the engine's browser is not
 * running and throws when it is running but not answering; `activate` selects
 * the tab inside its window.
 */
export interface FocusEngine {
  /** Human name for logs. */
  name: string;
  listTabs(): Promise<FocusTab[]>;
  activate(tab: FocusTab): Promise<void>;
}

/**
 * Match the way the built-in driver's `resolveTarget` matches an explicit
 * --tab: exact id first, then case-insensitive prefix — the CLI prints a
 * shortened id, so a prefix is what the web actually holds.
 */
export function matchTab<T extends { id: string }>(tabs: T[], query: string): T | null {
  if (!query) return null;
  return (
    tabs.find((t) => t.id === query) ??
    tabs.find((t) => t.id.toLowerCase().startsWith(query.toLowerCase())) ??
    null
  );
}

/** Browser-level CDP call that selects a tab in its window. */
async function activateViaCdp(tab: FocusTab): Promise<void> {
  const conn = await CdpConnection.fromPort(tab.port, 5_000);
  try {
    await conn.send("Target.activateTarget", { targetId: tab.id }, undefined, 5_000);
  } finally {
    conn.close();
  }
}

/** The built-in CDP driver's browser, from its state file (instance.ts). */
export const builtinFocusEngine: FocusEngine = {
  name: "builtin",
  async listTabs() {
    const state = readState();
    if (!state || !isPidAlive(state.pid)) return [];
    return (await listTargets(state.port)).map((t) => ({ id: t.targetId, url: t.url, port: state.port, pid: state.pid }));
  },
  activate: activateViaCdp,
};

/**
 * Every other Chrome on the machine that answers CDP — agent-browser sessions,
 * throwaway debug Chromes. A port that stopped answering between the scan and
 * the probe is skipped, not fatal: it belongs to some other agent's browser.
 */
export const localChromeFocusEngine: FocusEngine = {
  name: "local-chrome",
  async listTabs() {
    const tabs: FocusTab[] = [];
    await Promise.all(
      listChromeDebugPorts().map(async ({ port, pid }) => {
        try {
          for (const t of await listTargets(port)) tabs.push({ id: t.targetId, url: t.url, port, pid });
        } catch {
          /* not ours to worry about */
        }
      }),
    );
    return tabs;
  },
  activate: activateViaCdp,
};

// Activating a tab selects it inside its window, but a window behind other
// apps stays behind them — so the route also brings that Chrome frontmost,
// via the pid-addressed Apple event in raiseApp.ts. Best effort; tab
// selection already happened if it fails.

/**
 * Engines the route consults, in order. An engine adapter registers itself
 * here (e.g. at daemon boot); the defaults stay last so they remain the
 * fallback.
 */
const engines: FocusEngine[] = [builtinFocusEngine, localChromeFocusEngine];

export function registerFocusEngine(engine: FocusEngine): () => void {
  engines.unshift(engine);
  return () => {
    const i = engines.indexOf(engine);
    if (i >= 0) engines.splice(i, 1);
  };
}

export interface FocusDeps {
  engines: FocusEngine[];
  raiseApp: (pid: number, log?: (line: string) => void) => void;
  log?: (line: string) => void;
}

const defaultDeps = (raiseApp = raiseAppByPid): FocusDeps => ({ engines, raiseApp });

/**
 * The same raise for a CLI that keeps working afterwards (`cast browser
 * login`). The raise must have LANDED before the next engine call: the focus
 * guard (focusGuard.ts) reads who is frontmost before each call and hands
 * focus back if the managed Chrome took it during the call — an async raise
 * that completes mid-call is read as a theft and undone.
 */
export function focusBrowserTabBlocking(query: string): Promise<FocusResult> {
  return focusBrowserTab(query, defaultDeps(raiseAppByPidSync));
}

/**
 * Ask each engine for the tab; the first one that has it wins. The reported
 * failure is the most hopeful one seen: a stopped engine beside a running one
 * that merely lacks the tab reads as "tab-not-found", not "browser-stopped".
 */
export async function focusBrowserTab(query: string, deps: FocusDeps = defaultDeps()): Promise<FocusResult> {
  let reason: FocusFailure = "browser-stopped";
  const rank: Record<FocusFailure, number> = { "browser-stopped": 0, "browser-unreachable": 1, "tab-not-found": 2 };
  const worse = (r: FocusFailure) => {
    if (rank[r] > rank[reason]) reason = r;
  };

  for (const engine of deps.engines) {
    let tabs: FocusTab[];
    try {
      tabs = await engine.listTabs();
    } catch {
      worse("browser-unreachable");
      continue;
    }
    if (!tabs.length) continue;

    const tab = matchTab(tabs, query);
    if (!tab) {
      worse("tab-not-found");
      continue;
    }

    try {
      await engine.activate(tab);
    } catch {
      worse("browser-unreachable");
      continue;
    }
    // This raise is asked for — tell the sentinel not to bounce it.
    noteDeliberateRaise();
    if (tab.pid) deps.raiseApp(tab.pid, deps.log);
    return { ok: true };
  }
  return { ok: false, reason };
}

/**
 * HTTP endpoint for tab focus, mounted on the daemon's loopback hook server.
 * Returns true when the request was handled.
 */
export function handleBrowserFocusHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TerminalServerOptions,
  deps: FocusDeps = defaultDeps(),
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/browser/")) return false;
  const headers = { "Content-Type": "application/json", ...corsHeaders(req.headers.origin, opts) };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return true;
  }

  if (!authorizeLocalRequest(req, opts)) {
    res.writeHead(403, headers);
    res.end(JSON.stringify({ error: "forbidden" }));
    return true;
  }

  if (req.method === "POST" && url.startsWith("/browser/focus")) {
    const tab = new URL(url, "http://localhost").searchParams.get("tab") ?? "";
    void focusBrowserTab(tab, { ...deps, log: deps.log ?? opts.log }).then((result) => {
      if (result.ok) opts.log(`[BROWSER] Focused tab ${tab}`);
      res.writeHead(result.ok ? 200 : 404, headers);
      res.end(JSON.stringify(result));
    });
    return true;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found" }));
  return true;
}
