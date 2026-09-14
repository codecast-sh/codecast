/**
 * Loopback routes for the driven browser: POST /browser/focus?tab=<id> raises
 * a tab, POST /browser/reopen brings a closed one back (reopenTab.ts).
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
 * each in turn. Three ship by default — the built-in driver's state file
 * (cheap, authoritative for that browser), a scan of every Chrome on the
 * machine that is listening for CDP (localChrome.ts), which is what finds a
 * tab in an agent-browser session without the daemon knowing anything about
 * the engine, and the extension bridge into the human's own Chrome
 * (bridge/host.ts), whose tabs no port scan can see: that Chrome runs no
 * debugging port, so the bridge host's CDP face is the only way to reach it.
 * An engine adapter with a cheaper or truer view can register its own.
 */

import type http from "http";
import { CdpConnection, listTargets, type CdpEndpoint, type CdpTarget } from "./cdp.js";
import { raiseAppByPid, raiseAppByPidSync } from "./raiseApp.js";
import { noteDeliberateRaise } from "./focusSentinel.js";
import { readState } from "./instance.js";
import { listChromeDebugPorts, realChromePid } from "./localChrome.js";
import { bridgeEndpoint, proveBridgeHost, readBridgeState, type BridgeState, type ProvenBridge } from "./bridge/host.js";
import { isPidAlive } from "../workspace/chrome.js";
import {
  authorizeLocalRequest,
  corsHeaders,
  type TerminalServerOptions,
} from "../terminal/terminalServer.js";
import { readBody } from "../vault/vaultServer.js";
import { ownerCandidates, tmuxPaneId } from "./watchServer.js";
import type { ReopenDeps } from "./reopenTab.js";

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
  /** The token the extension bridge host wants on its CDP face; Chrome's own
   *  endpoint has none. */
  token?: string;
  /** The browser process to bring frontmost after activation, if known. */
  pid?: number;
}

/** The CDP endpoint a tab is reached through (cdp.ts CdpEndpoint). */
export function focusEndpoint(tab: Pick<FocusTab, "port" | "token">): CdpEndpoint {
  return tab.token ? { port: tab.port, token: tab.token } : tab.port;
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
  const conn = await CdpConnection.fromPort(focusEndpoint(tab), 5_000);
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

/** What the bridge engine reads and calls; injectable for tests. */
export interface BridgeFocusDeps {
  readState(): BridgeState | null;
  isPidAlive(pid: number): boolean;
  prove(state: BridgeState): Promise<ProvenBridge>;
  listTargets(ep: CdpEndpoint): Promise<CdpTarget[]>;
  /** The human's Chrome process, to bring frontmost; null when unknown. */
  realChromePid(): number | null;
}

/**
 * The human's own Chrome, through the extension bridge host. The host's
 * `/json/list` is the tab list and `Target.activateTarget` on its socket
 * becomes `chrome.tabs.update({active}) + chrome.windows.update({focused})`
 * in the extension, so activation here selects the tab AND raises its window
 * inside Chrome; the pid raise then brings Chrome itself over other apps.
 * The token rides on the endpoint, never on a command line.
 *
 * Silence rules match the other engines: no config or a dead host is "no
 * browser here" ([]), a host that answers but cannot prove itself or refuses
 * the list throws (browser-unreachable).
 */
export function makeBridgeFocusEngine(deps: BridgeFocusDeps): FocusEngine {
  return {
    name: "bridge",
    async listTabs() {
      const state = deps.readState();
      if (!state?.token) return [];
      if (!state.hostPid || !deps.isPidAlive(state.hostPid)) return [];
      const ep = bridgeEndpoint(await deps.prove(state));
      const pid = deps.realChromePid() ?? undefined;
      return (await deps.listTargets(ep)).map((t) => ({ id: t.targetId, url: t.url, port: state.port, token: state.token, pid }));
    },
    activate: activateViaCdp,
  };
}

// The bridge host and the extension answer through a Chrome that may be
// busy: a proof that normally lands in tens of milliseconds took 9s on a
// loaded machine (load average 330, 2026-09-13), and the default 1.2s proof
// and 5s list turned every "open tab" click into "tab not found" — the
// bridge threw, and "unreachable" ranks below the clone's honest miss. Same
// patience the watch stream dials with (watchSource.ts realCdpDeps).
const BRIDGE_FOCUS_TIMEOUT_MS = 30_000;

export const bridgeFocusEngine: FocusEngine = makeBridgeFocusEngine({
  readState: readBridgeState,
  isPidAlive,
  prove: (state) => proveBridgeHost(state, BRIDGE_FOCUS_TIMEOUT_MS),
  listTargets: (ep) => listTargets(ep, BRIDGE_FOCUS_TIMEOUT_MS),
  realChromePid: () => realChromePid(),
});

// Activating a tab selects it inside its window, but a window behind other
// apps stays behind them — so the route also brings that Chrome frontmost,
// via the pid-addressed Apple event in raiseApp.ts. Best effort; tab
// selection already happened if it fails.

/**
 * Engines the route consults, in order. An engine adapter registers itself
 * here (e.g. at daemon boot); the defaults stay last so they remain the
 * fallback.
 */
const engines: FocusEngine[] = [builtinFocusEngine, localChromeFocusEngine, bridgeFocusEngine];

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
  /** How /browser/reopen runs the open; injectable for tests. */
  reopen?: ReopenDeps;
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
 * Ask every engine for its tabs at once; the first engine to REPORT the tab
 * wins, and the others are not waited for. A CDP target id is unique across
 * browsers, so whichever engine finds it has found the tab, and order only
 * matters for the failure report. Listing is where the time goes — a `ps`
 * pass over 1,500 processes (8s on a loaded machine), a bridge proof, a
 * `/json/list` from a busy Chrome — and a tab in the human's Chrome sits
 * behind the last engine: asked in sequence, or waited for together, the
 * route outlived the web's patience and the click did nothing.
 *
 * When no engine has it, the reported failure is the most hopeful one seen:
 * a stopped engine beside a running one that merely lacks the tab reads as
 * "tab-not-found", not "browser-stopped".
 */
export async function focusBrowserTab(query: string, deps: FocusDeps = defaultDeps()): Promise<FocusResult> {
  let reason: FocusFailure = "browser-stopped";
  const rank: Record<FocusFailure, number> = { "browser-stopped": 0, "browser-unreachable": 1, "tab-not-found": 2 };
  const worse = (r: FocusFailure) => {
    if (rank[r] > rank[reason]) reason = r;
  };

  // Listings settle in arrival order onto a queue the loop below drains, so
  // a fast engine that has the tab is acted on while a slow one is still
  // scanning.
  type Listed = { engine: FocusEngine; tabs: FocusTab[] | null };
  const queue: Listed[] = [];
  let wake: (() => void) | null = null;
  let pending = deps.engines.length;
  for (const engine of deps.engines) {
    engine.listTabs().then(
      (tabs) => queue.push({ engine, tabs }),
      () => queue.push({ engine, tabs: null }),
    ).finally(() => {
      pending -= 1;
      wake?.();
    });
  }

  while (queue.length || pending) {
    if (!queue.length) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
      continue;
    }
    const { engine, tabs } = queue.shift()!;
    if (tabs === null) {
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
      // Both outcomes are logged: a click that did nothing is otherwise
      // invisible from every side (the web stays quiet by design).
      opts.log(result.ok ? `[BROWSER] Focused tab ${tab}` : `[BROWSER] Could not focus tab ${tab}: ${result.reason}`);
      res.writeHead(result.ok ? 200 : 404, headers);
      res.end(JSON.stringify(result));
    });
    return true;
  }

  // The tab is gone and the human said to bring the page back: open it as
  // the session (reopenTab.ts), then raise it like a focus would. The body
  // names the page and the session the way the watch stream's hello does.
  if (req.method === "POST" && url.startsWith("/browser/reopen")) {
    void (async () => {
      const raw = await readBody(req, 16 * 1024);
      let body: { url?: unknown; session_uuid?: unknown; tmux_session?: unknown } = {};
      try {
        body = raw ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        /* handled below as a bad request */
      }
      const pageUrl = typeof body.url === "string" ? body.url : "";
      const candidates = await ownerCandidates(
        {
          session_uuid: typeof body.session_uuid === "string" ? body.session_uuid : undefined,
          tmux_session: typeof body.tmux_session === "string" ? body.tmux_session : undefined,
        },
        tmuxPaneId,
      );
      // Loaded on the reopen route only (boot graph guard).
      const { reopenBrowserTab } = await import("./reopenTab.js");
      const result = await reopenBrowserTab({ url: pageUrl, candidates }, deps.reopen);
      if (!result.ok) {
        opts.log(`[BROWSER] Could not reopen ${pageUrl}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
        res.writeHead(result.reason === "bad-request" ? 400 : 502, headers);
        res.end(JSON.stringify(result));
        return;
      }
      opts.log(`[BROWSER] Reopened ${pageUrl} as tab ${result.tabId}`);
      const focused = await focusBrowserTab(result.tabId, { ...deps, log: deps.log ?? opts.log });
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, tabId: result.tabId, focused: focused.ok }));
    })();
    return true;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found" }));
  return true;
}
