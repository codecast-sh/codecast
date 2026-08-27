/**
 * The engine seam for the browser watch stream.
 *
 * `cast browser` may run on the built-in CDP driver or on an external engine
 * (agent-browser). The watch server does not care which: it needs to know
 * WHICH tab a session drives, and then a source of JPEG frames for that tab
 * with the tab's current title/URL. Everything engine-specific lives behind
 * `WatchEngine`; the server only pushes frames to a socket.
 *
 * Two frame sources ship here:
 *   - screencast: CDP Page.startScreencast, frames pushed by Chrome and paced
 *     by ack (at most one frame in flight, so nothing can pile up).
 *   - polling: any "give me a JPEG of the tab now" function, called on a
 *     timer. The fallback for engines with no CDP passthrough.
 */

import { CdpConnection, listTargets, type CdpTarget } from "./cdp.js";
import { sessionTargetId } from "./engineReap.js";
import { engineSessionKey } from "./engine.js";
import { readState, type InstanceState } from "./instance.js";

export interface WatchTab {
  /** Opaque, engine-scoped. Only ever compared for equality, never parsed. */
  id: string;
  title: string;
  url: string;
}

export interface WatchFrame {
  /** JPEG bytes, base64. */
  data: string;
  width: number;
  height: number;
}

export interface FrameSourceHandlers {
  onFrame(frame: WatchFrame): void;
  /** The tab's title/URL changed (or the source could not observe them any more). */
  onTab(tab: WatchTab): void;
  /** The tab is gone: closed, or the engine lost it. */
  onGone(): void;
}

export interface FrameSourceOptions {
  /** Minimum ms between frames delivered to the viewer. */
  minIntervalMs: number;
  /** Frames wait while this returns true (viewer socket not draining). */
  shouldHold(): boolean;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  /** Set once the viewer is gone; open() should abandon work at the next await. */
  signal: AbortSignal;
}

/**
 * A viewer-originated input event, in the page's own coordinate space made
 * scale-free: nx/ny are 0..1 across the page viewport, so neither side needs
 * to know what size the other renders at. The server multiplies by the CSS
 * viewport it learns from the screencast metadata.
 */
export type WatchInput =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      nx: number;
      ny: number;
      button?: "left" | "right" | "middle" | "none";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | { kind: "key"; type: "keyDown" | "keyUp"; key: string; code?: string; text?: string; modifiers?: number }
  | { kind: "insertText"; text: string };

/** A running stream of frames for one tab. */
export interface FrameSource {
  readonly tab: WatchTab;
  /** Deliver a viewer input event to the page (control mode). Absent on
   * sources that cannot dispatch input. Fire-and-forget. */
  input?(msg: WatchInput): void;
  /** Stop delivering frames and release the underlying resources. Idempotent. */
  stop(): void;
}

export type WatchResolveError = "no-browser" | "no-tab";

export interface WatchEngine {
  /**
   * The tab this session drives, from the candidate owner keys (see
   * ownerCandidates in watchServer.ts). Called on connect AND on every poll,
   * so it must be cheap: read a state file, not the browser.
   */
  resolveTab(candidates: string[]): { tabId: string } | { error: WatchResolveError };
  /**
   * Begin streaming frames for a tab. Rejects if the tab cannot be attached
   * (closed under us, engine unreachable). The returned source calls
   * `onGone` if the tab disappears later.
   */
  open(tabId: string, opts: FrameSourceOptions, handlers: FrameSourceHandlers): Promise<FrameSource>;
}

// ---------------------------------------------------------------------------
// Built-in driver: state file + CDP screencast.

// Tab title/URL are polled: they live outside the page session and 2.5s is
// plenty current for a header line.
const TAB_POLL_MS = 2500;

export interface CdpEngineDeps {
  getState(): InstanceState | null;
  connect(port: number): Promise<CdpConnection>;
  listTargets(port: number): Promise<CdpTarget[]>;
}

const realCdpDeps: CdpEngineDeps = {
  getState: readState,
  connect: (port) => CdpConnection.fromPort(port),
  listTargets,
};

/**
 * Which tab this session is driving. The session's own claim wins; when NO
 * session has claimed any tab, the shared active tab stands in (a human
 * driving from a bare shell records no ownership). A tab claimed by another
 * session is never shown — the whole point of per-session ownership is that
 * agents don't look at each other's pages by accident.
 */
export function resolveOwnedTab(
  state: InstanceState | null,
  candidates: string[],
): { tabId: string } | { error: WatchResolveError } {
  if (!state) return { error: "no-browser" };
  const tabs = state.tabsBySession ?? {};
  for (const key of candidates) {
    const owned = tabs[key];
    if (owned) return { tabId: owned };
  }
  if (Object.keys(tabs).length === 0 && state.activeTargetId) {
    return { tabId: state.activeTargetId };
  }
  return { error: "no-tab" };
}

export interface ScreencastDeps {
  connect(port: number): Promise<CdpConnection>;
  listTargets(port: number): Promise<CdpTarget[]>;
}

/**
 * Stream one tab over CDP Page.startScreencast on the Chrome at `port`. The
 * shared heart of every CDP-backed engine: built-in driver, external engine,
 * the extension bridge — they differ only in which port and which tab.
 */
export async function openCdpScreencast(
  port: number,
  tabId: string,
  opts: FrameSourceOptions,
  handlers: FrameSourceHandlers,
  deps: ScreencastDeps,
): Promise<FrameSource> {
  const conn = await deps.connect(port);
  if (opts.signal.aborted) {
    conn.close();
    throw new Error("aborted");
  }
  let stopped = false;
  let cdpSessionId: string | null = null;
  let ackTimer: NodeJS.Timeout | null = null;
  let lastAckAt = 0;
  const tab: WatchTab = { id: tabId, title: "", url: "" };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (ackTimer) clearTimeout(ackTimer);
    clearInterval(pollTimer);
    clearInterval(fallbackTimer);
    // Best effort: the CDP connection is ours alone, so closing it tears
    // the screencast down browser-side even if stopScreencast never lands.
    if (cdpSessionId) void conn.send("Page.stopScreencast", {}, cdpSessionId, 2000).catch(() => {});
    conn.close();
  };

  /** Ack when the pacing interval has passed AND the viewer is draining.
   *  Paced against the PREVIOUS ack, not this frame's arrival — Chrome
   *  keeps a couple of frames in flight past each ack, so per-frame
   *  pacing lets the real rate creep well above the cap. A newer frame
   *  supersedes any ack still waiting: acking the newest releases all. */
  const scheduleAck = (frameSession: number) => {
    if (ackTimer) clearTimeout(ackTimer);
    const attempt = () => {
      if (stopped || !cdpSessionId) return;
      if (opts.shouldHold()) {
        ackTimer = setTimeout(attempt, 100);
        ackTimer.unref?.();
        return;
      }
      ackTimer = null;
      lastAckAt = Date.now();
      void conn.send("Page.screencastFrameAck", { sessionId: frameSession }, cdpSessionId, 10_000).catch(() => {});
    };
    ackTimer = setTimeout(attempt, Math.max(0, lastAckAt + opts.minIntervalMs - Date.now()));
    ackTimer.unref?.();
  };

  // The CSS viewport the page renders at, learned from screencast metadata
  // (and refreshed by it on every real frame — resizes follow automatically).
  // Input events arrive normalized 0..1 and scale by this.
  const viewport = { w: 0, h: 0 };

  conn.on((ev) => {
    if (stopped) return;
    if (ev.method === "Page.screencastFrame" && ev.sessionId === cdpSessionId) {
      const p = ev.params as { data: string; metadata: Record<string, number>; sessionId: number };
      lastFrameAt = Date.now();
      if (p.metadata?.deviceWidth && p.metadata?.deviceHeight) {
        viewport.w = p.metadata.deviceWidth;
        viewport.h = p.metadata.deviceHeight;
      }
      handlers.onFrame({ data: p.data, width: p.metadata?.deviceWidth ?? 0, height: p.metadata?.deviceHeight ?? 0 });
      scheduleAck(p.sessionId);
    } else if (ev.method === "Target.detachedFromTarget" && (ev.params as any).sessionId === cdpSessionId) {
      stop();
      handlers.onGone();
    }
  });

  // Keys Chrome only acts on when the event carries its Windows virtual key
  // code — a bare {key: "Enter"} reaches the page's listeners but never
  // submits a form or moves a caret, which makes control feel broken exactly
  // on the keys an OAuth form needs most.
  const VIRTUAL_KEYS: Record<string, number> = {
    Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };

  const input = (msg: WatchInput): void => {
    if (stopped || !cdpSessionId) return;
    const send = (method: string, params: Record<string, unknown>) =>
      void conn.send(method, params, cdpSessionId!, 5000).catch(() => {});
    if (msg.kind === "mouse") {
      if (!viewport.w || !viewport.h) return; // no frame yet — nowhere to aim
      send("Input.dispatchMouseEvent", {
        type: msg.type,
        x: Math.round(msg.nx * viewport.w),
        y: Math.round(msg.ny * viewport.h),
        button: msg.button ?? "none",
        clickCount: msg.clickCount ?? 0,
        deltaX: msg.deltaX ?? 0,
        deltaY: msg.deltaY ?? 0,
        modifiers: msg.modifiers ?? 0,
        pointerType: "mouse",
      });
    } else if (msg.kind === "key") {
      const vk = VIRTUAL_KEYS[msg.key];
      const text = msg.type === "keyDown" ? (msg.key === "Enter" ? "\r" : msg.text) : undefined;
      send("Input.dispatchKeyEvent", {
        // keyDown without text is a rawKeyDown in CDP terms; sending the
        // right subtype keeps IME/autofill listeners from double-firing.
        type: msg.type === "keyDown" && !text ? "rawKeyDown" : msg.type,
        key: msg.key,
        code: msg.code ?? "",
        ...(text ? { text } : {}),
        ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
        modifiers: msg.modifiers ?? 0,
      });
    } else if (msg.kind === "insertText") {
      if (typeof msg.text === "string" && msg.text.length <= 8192) {
        send("Input.insertText", { text: msg.text });
      }
    }
  };

  // The screencast rides the compositor, and Chrome only composites VISIBLE
  // tabs — a background tab, or the active tab of an occluded or minimized
  // window, paints nothing and the screencast goes silent while staying
  // "started". In a one-Chrome-many-agents world that is the common case, so
  // silence is watched for: once no frame has arrived for a while, poll
  // Page.captureScreenshot instead, which forces a frame regardless of
  // visibility. Real screencast frames resuming (tab brought back to front)
  // starve the watchdog and the stream switches back on its own.
  let lastFrameAt = Date.now();
  let lastFallbackData = "";
  let capturing = false;
  const staleAfterMs = Math.max(1200, opts.minIntervalMs * 3);
  const fallbackTimer = setInterval(() => {
    if (stopped || !cdpSessionId || capturing) return;
    if (opts.shouldHold()) return;
    if (Date.now() - lastFrameAt < staleAfterMs) return;
    capturing = true;
    conn
      .send<{ data?: string }>("Page.captureScreenshot", { format: "jpeg", quality: opts.quality }, cdpSessionId, 5000)
      .then((shot) => {
        if (stopped || !shot?.data) return;
        // A hidden page is usually static: don't resend the identical JPEG.
        if (shot.data === lastFallbackData) return;
        lastFallbackData = shot.data;
        lastFrameAt = Date.now();
        handlers.onFrame({ data: shot.data, width: 0, height: 0 });
      })
      .catch(() => {})
      .finally(() => {
        capturing = false;
      });
  }, Math.max(250, opts.minIntervalMs));
  fallbackTimer.unref?.();

  const pollTimer = setInterval(() => {
    if (stopped) return;
    deps
      .listTargets(port)
      .then((targets) => {
        if (stopped) return;
        const t = targets.find((x) => x.targetId === tabId);
        if (!t) {
          stop();
          handlers.onGone();
          return;
        }
        if (t.title !== tab.title || t.url !== tab.url) {
          tab.title = t.title;
          tab.url = t.url;
          handlers.onTab({ ...tab });
        }
      })
      .catch(() => {
        if (stopped) return;
        stop();
        handlers.onGone();
      });
  }, TAB_POLL_MS);
  pollTimer.unref?.();

  try {
    const { sessionId } = await conn.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: tabId, flatten: true },
      undefined,
      10_000,
    );
    cdpSessionId = sessionId;
    if (opts.signal.aborted) throw new Error("aborted");
    await conn.send("Page.enable", {}, sessionId, 10_000);
    if (opts.signal.aborted) throw new Error("aborted");
    await conn.send(
      "Page.startScreencast",
      { format: "jpeg", quality: opts.quality, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight, everyNthFrame: 1 },
      sessionId,
      10_000,
    );
    const t = (await deps.listTargets(port)).find((x) => x.targetId === tabId);
    tab.title = t?.title ?? "";
    tab.url = t?.url ?? "";
  } catch (err) {
    stop();
    throw err;
  }
  return { tab, stop, input };
}

export function cdpWatchEngine(deps: CdpEngineDeps = realCdpDeps): WatchEngine {
  return {
    resolveTab: (candidates) => {
      const state = deps.getState();
      const own = resolveOwnedTab(state, candidates);
      if (!("error" in own) || own.error === "no-browser") return own;
      // The engine path keeps no tabsBySession: each session's daemon records
      // the tab it is pinned to in its own target file, keyed by the same
      // owner key flattened into an engine session name (engine.ts).
      for (const cand of candidates) {
        const tabId = sessionTargetId(engineSessionKey(cand));
        if (tabId) return { tabId };
      }
      return own;
    },
    open(tabId, opts, handlers) {
      const state = deps.getState();
      if (!state) return Promise.reject(new Error("no-browser"));
      return openCdpScreencast(state.port, tabId, opts, handlers, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Polling fallback: for engines that expose "screenshot the tab" but no CDP.

export interface PollingEngineDeps {
  resolveTab: WatchEngine["resolveTab"];
  /** JPEG bytes (base64) + dimensions, or null if the tab is gone. */
  screenshot(tabId: string, opts: { quality: number; maxWidth: number; maxHeight: number }): Promise<WatchFrame | null>;
  /** Current title/URL, or null if the tab is gone. */
  describe(tabId: string): Promise<{ title: string; url: string } | null>;
}

export function pollingWatchEngine(deps: PollingEngineDeps): WatchEngine {
  return {
    resolveTab: deps.resolveTab,
    async open(tabId, opts, handlers) {
      const first = await deps.describe(tabId);
      if (opts.signal.aborted) throw new Error("aborted");
      if (!first) throw new Error("no-tab");
      const tab: WatchTab = { id: tabId, ...first };
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
      // One request in flight at a time, so a slow engine slows the stream
      // instead of stacking requests.
      const tick = async () => {
        if (stopped) return;
        if (!opts.shouldHold()) {
          try {
            const [frame, info] = await Promise.all([
              deps.screenshot(tabId, { quality: opts.quality, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight }),
              deps.describe(tabId),
            ]);
            if (stopped) return;
            if (!frame || !info) {
              stop();
              handlers.onGone();
              return;
            }
            handlers.onFrame(frame);
            if (info.title !== tab.title || info.url !== tab.url) {
              tab.title = info.title;
              tab.url = info.url;
              handlers.onTab({ ...tab });
            }
          } catch {
            if (stopped) return;
            stop();
            handlers.onGone();
            return;
          }
        }
        timer = setTimeout(() => void tick(), opts.minIntervalMs);
        timer.unref?.();
      };
      timer = setTimeout(() => void tick(), 0);
      return { tab, stop };
    },
  };
}
