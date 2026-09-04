/**
 * Live watch stream for the managed browser: what the agent's tab shows,
 * pushed to the web UI as JPEG frames.
 *
 * Rides the daemon's loopback hook server exactly like the integrated
 * terminal: same persisted token, same origin allowlist, one more WS path
 * (/watch/ws). The web already discovers this endpoint for the terminal
 * (get_terminal_endpoint), so watching needs no new discovery and no new
 * Convex surface — a viewer that can open the terminal can open this.
 *
 * Frames come from a `WatchEngine` (watchSource.ts): the built-in CDP driver
 * streams via Page.startScreencast, an external engine can supply a polled
 * screenshot instead. This file only knows the wire protocol, who owns which
 * tab, and when to stop.
 *
 * Read-only unless the viewer asks for control. A hello with `control: true`
 * lets the SAME authenticated socket carry input back (mouse/keys, dispatched
 * through CDP by the frame source) — this is how a human signs into an OAuth
 * page inside the agent's browser, including a browser running on a cloud
 * box whose CDP is tunneled here. The token/origin gate is the terminal's:
 * whoever may attach the integrated terminal may drive the browser.
 */

import type http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  onWsUpgrade,
  originAllowed,
  tokenMatches,
  type TerminalServerOptions,
} from "../terminal/terminalServer.js";
import { tmuxRunAsync } from "../tmux.js";
import { cdpWatchEngine, type FrameSource, type WatchEngine } from "./watchSource.js";

export { resolveOwnedTab as resolveWatchTarget } from "./watchSource.js";

const WS_PATH = "/watch/ws";

// ~3fps: enough to see a page move, cheap enough to forget about. The client
// may ask for less, never for more.
const MIN_FRAME_INTERVAL_MS = 333;
// Streaming stops on its own after this long even with the pane still open —
// a tab forgotten over lunch should not screencast all afternoon.
const MAX_WATCH_MS = 30 * 60 * 1000;
// Ownership can move (the session opens a new tab); re-resolve on this cadence.
const OWNER_POLL_MS = 2500;
// Above this many unsent bytes we hold frames instead of stacking them on a
// socket that isn't draining.
const HIGH_WATER_BYTES = 4_000_000;

const FRAME_QUALITY = 60;
const FRAME_MAX_DIM = 1280;

interface WatchHello {
  type: "hello";
  token: string;
  /** The agent session uuid (managed_sessions.session_id). */
  session_uuid?: string;
  /** The session's tmux session name, for the pane-keyed ownership fallback. */
  tmux_session?: string;
  /** Requested max frames/second (only honored downward). */
  fps?: number;
  /** Ask to send input back (mouse/keys). Granted when the frame source can
   * dispatch it; the viewer is told via the ready message. */
  control?: boolean;
}

/**
 * Owner keys this session may appear under in tabsBySession (see owner.ts):
 * the session uuid via detection or env, or the tmux pane the agent runs in.
 */
export async function ownerCandidates(
  hello: Pick<WatchHello, "session_uuid" | "tmux_session">,
  paneIdFor: (tmux: string) => Promise<string | null>,
): Promise<string[]> {
  const keys: string[] = [];
  if (hello.session_uuid) {
    keys.push(`session:${hello.session_uuid}`, `env:${hello.session_uuid}`);
  }
  if (hello.tmux_session && /^[a-zA-Z0-9_.:-]+$/.test(hello.tmux_session)) {
    const pane = await paneIdFor(hello.tmux_session);
    if (pane) keys.push(`pane:${pane}`);
  }
  return keys;
}

// The hello runs on the daemon's loop, so the pane lookup is the async tmux
// twin: a sync display-message held the loop for the whole spawn.
async function tmuxPaneId(tmuxSession: string): Promise<string | null> {
  const r = await tmuxRunAsync(["display-message", "-p", "-t", tmuxSession, "-F", "#{pane_id}"]);
  if (r.status !== 0) return null;
  const pane = r.stdout.trim();
  return /^%\d+$/.test(pane) ? pane : null;
}

export interface WatchServerDeps {
  engine: WatchEngine;
  paneIdFor(tmuxSession: string): Promise<string | null>;
}

export function attachWatchServer(
  server: http.Server,
  opts: TerminalServerOptions,
  deps: WatchServerDeps = { engine: cdpWatchEngine(), paneIdFor: tmuxPaneId },
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const detach = onWsUpgrade(server, WS_PATH, (req, socket, head) => {
    if (!originAllowed(req.headers.origin, opts)) {
      opts.log(`[WATCH] Rejected WS from origin ${req.headers.origin ?? "(none)"}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, opts, deps));
  });

  return {
    close() {
      detach();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

function handleConnection(ws: WebSocket, opts: TerminalServerOptions, deps: WatchServerDeps): void {
  const { engine } = deps;
  let source: FrameSource | null = null;
  let candidates: string[] = [];
  let ownerTimer: NodeJS.Timeout | null = null;
  let lifeTimer: NodeJS.Timeout | null = null;
  let minInterval = MIN_FRAME_INTERVAL_MS;
  let controlWanted = false;
  let closed = false;
  // Guards the async open(): the viewer may leave mid-dial, and a source that
  // finishes opening after cleanup would have no owner to stop it.
  let opening = false;
  const aborter = new AbortController();

  const sendJson = (obj: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (ownerTimer) clearInterval(ownerTimer);
    if (lifeTimer) clearTimeout(lifeTimer);
    aborter.abort();
    source?.stop();
    source = null;
  };
  const exit = (reason: string) => {
    sendJson({ type: "exit", reason });
    ws.close(1000);
    cleanup();
  };
  const fail = (code: string, message: string) => {
    sendJson({ type: "error", code, message });
    ws.close(4000, code);
    cleanup();
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  const helloTimeout = setTimeout(() => fail("timeout", "hello timeout"), 10_000);
  helloTimeout.unref?.();

  ws.once("message", (raw, isBinary) => {
    clearTimeout(helloTimeout);
    if (isBinary) return fail("bad-hello", "expected hello");
    let hello: WatchHello;
    try {
      hello = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail("bad-hello", "bad hello");
    }
    if (hello.type !== "hello") return fail("bad-hello", "bad hello");
    if (!tokenMatches(hello.token, opts)) return fail("forbidden", "forbidden");
    if (typeof hello.fps === "number" && hello.fps > 0) {
      minInterval = Math.max(minInterval, Math.floor(1000 / hello.fps));
    }
    controlWanted = hello.control === true;
    if (controlWanted) {
      // After the hello the socket stays two-way: batches of input events
      // ride back on it. Dropped silently between tabs (source === null) —
      // a click into a tab that just died has nowhere meaningful to land.
      ws.on("message", (raw2, isBinary2) => {
        if (closed || isBinary2) return;
        let m: any;
        try {
          m = JSON.parse(raw2.toString("utf8"));
        } catch {
          return;
        }
        if (m?.type !== "input" || !Array.isArray(m.events) || m.events.length > 64) return;
        for (const ev of m.events) void source?.input?.(ev);
      });
    }

    void ownerCandidates(hello, deps.paneIdFor).then((keys) => {
      if (closed) return; // the viewer left during the pane lookup
      candidates = keys;
      const resolved = engine.resolveTab(candidates);
      if ("error" in resolved) {
        fail(
          resolved.error,
          resolved.error === "no-browser"
            ? "no managed browser is running on this machine"
            : "this session has not driven a browser tab",
        );
        return;
      }
      void open(resolved.tabId, true);
    });
  });

  async function open(tabId: string, first: boolean): Promise<void> {
    if (opening) return;
    opening = true;
    let next: FrameSource;
    try {
      next = await engine.open(
        tabId,
        {
          minIntervalMs: minInterval,
          shouldHold: () => ws.bufferedAmount > HIGH_WATER_BYTES,
          quality: FRAME_QUALITY,
          maxWidth: FRAME_MAX_DIM,
          maxHeight: FRAME_MAX_DIM,
          signal: aborter.signal,
        },
        {
          onFrame: (f) => {
            if (!closed) sendJson({ type: "frame", data: f.data, w: f.width, h: f.height });
          },
          onTab: (t) => {
            if (!closed) sendJson({ type: "tab", title: t.title, url: t.url, targetId: t.id });
          },
          onGone: () => {
            // The tab died. The owner poll decides whether the session has a
            // new one; drop our handle so it knows to reopen.
            source = null;
          },
        },
      );
    } catch (err) {
      opening = false;
      if (closed) return;
      const msg = err instanceof Error ? err.message : "";
      if (first) {
        return fail(
          msg === "no-browser" ? "no-browser" : "no-tab",
          msg === "no-browser"
            ? "the managed browser is not answering on this machine"
            : "could not attach to the session's browser tab",
        );
      }
      return exit("tab-closed");
    }
    opening = false;
    if (closed) {
      next.stop();
      return;
    }
    source = next;
    sendJson({
      type: "ready",
      targetId: next.tab.id,
      title: next.tab.title,
      url: next.tab.url,
      control: controlWanted && typeof next.input === "function",
    });
    if (first) {
      lifeTimer = setTimeout(() => exit("timeout"), MAX_WATCH_MS);
      lifeTimer.unref?.();
      ownerTimer = setInterval(followOwner, OWNER_POLL_MS);
      ownerTimer.unref?.();
      opts.log(`[WATCH] streaming tab ${next.tab.id.slice(0, 8)} (${minInterval}ms/frame)`);
    }
  }

  /** Follow the session: ownership moves, tabs close. */
  function followOwner(): void {
    if (closed || opening) return;
    const resolved = engine.resolveTab(candidates);
    if ("error" in resolved) {
      return exit(resolved.error === "no-browser" ? "browser-closed" : "tab-closed");
    }
    if (source && resolved.tabId === source.tab.id) return;
    // The session moved to another tab, or its tab died and it opened a new
    // one — or died with no replacement (then open() fails → tab-closed).
    source?.stop();
    source = null;
    void open(resolved.tabId, false);
  }
}
