// Client for the daemon's browser watch stream (packages/cli watchServer.ts).
//
// The transport is the integrated terminal's loopback endpoint — same port,
// same per-boot token, one more WS path — so discovery is just
// getTerminalEndpoint (lib/terminal/endpoint.ts) and this module only speaks
// the watch protocol: hello, then ready / frame / tab / action / error / exit.
// Frames arrive as base64 JPEG, at most ~3 a second, paced daemon-side by CDP
// acks. Action messages ride beside them: where the agent's hand is on the
// page (packages/cli watchActions.ts), so a viewer can draw the cursor the
// pixels never show.

import type { TerminalEndpoint } from "./terminal/endpoint";

export interface WatchTabInfo {
  title: string;
  url: string;
  /** The CDP target id (full); the row pills hold its 8-char prefix. */
  id: string;
}

export type WatchActionKind = "move" | "down" | "up" | "type" | "nav" | "scroll";

/**
 * One thing the agent did on the page; mirrors WatchAction in the CLI's
 * watchActions.ts. `x`/`y` are 0..1 of the page viewport, the same convention
 * control-mode input goes out in, so mapFromFrame puts the arrow exactly
 * where mapToFrame would send a click.
 */
export interface WatchActionFrame {
  kind: WatchActionKind;
  x: number;
  y: number;
  /** On `type`: what has been typed into the field so far (already capped). */
  text?: string;
  /** On `type` into a password or code field: there is no text, on purpose. */
  secret?: boolean;
  /** On `nav`: the main frame's new URL. */
  url?: string;
  /** Wall clock ms when the page saw it. */
  at: number;
}

export interface WatchHandlers {
  /** `control` is true when the daemon granted two-way input on this socket. */
  onReady: (tab: WatchTabInfo, control: boolean) => void;
  /** A JPEG the driven page just painted, ready for an <img> src. */
  onFrame: (dataUrl: string, w: number, h: number) => void;
  onTab: (tab: WatchTabInfo) => void;
  /** The agent moved, pressed, typed, scrolled or navigated. Optional: a
   *  viewer that only wants pixels leaves it out and the frames are unchanged. */
  onAction?: (action: WatchActionFrame) => void;
  /** Terminal failure: the stream is over and the socket is closing. */
  onError: (code: string, message: string) => void;
  /** Orderly end: tab closed, browser gone, or the daemon's time cap. */
  onExit: (reason: string) => void;
}

/** A viewer input event; mirrors WatchInput in the CLI's watchSource.ts.
 * Mouse coordinates are normalized 0..1 across the page viewport. */
export type WatchInputEvent =
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

export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the video content sits inside an <img> box rendered object-contain:
 * the frame's aspect fit inside the box and centered, with letterbox bands
 * on the axis that has room to spare. Null for a box or frame with no size.
 * The one piece of geometry both directions below share, so the arrow drawn
 * from an action and the click sent from the control surface agree.
 */
export function frameContentRect(box: FrameBox, natural: { width: number; height: number }): FrameBox | null {
  if (!natural.width || !natural.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * Map a viewer's client point to normalized page coordinates (0..1), given
 * the <img> that renders the frame with object-contain. A click in the
 * letterbox bands maps to nothing. Pure, so the geometry is testable without
 * a DOM.
 */
export function mapToFrame(
  clientX: number,
  clientY: number,
  box: FrameBox,
  natural: { width: number; height: number },
): { nx: number; ny: number } | null {
  const rect = frameContentRect(box, natural);
  if (!rect) return null;
  const nx = (clientX - rect.left) / rect.width;
  const ny = (clientY - rect.top) / rect.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { nx, ny };
}

/**
 * The other direction: a normalized page point to a pixel offset inside the
 * box, for drawing the agent's cursor over the frame. A point outside 0..1 is
 * clamped to the content edge rather than dropped: an arrow that vanished
 * whenever the agent aimed at the very edge would read as a glitch.
 */
export function mapFromFrame(
  nx: number,
  ny: number,
  box: FrameBox,
  natural: { width: number; height: number },
): { x: number; y: number } | null {
  const rect = frameContentRect(box, natural);
  if (!rect) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { x: rect.left + clamp(nx) * rect.width, y: rect.top + clamp(ny) * rect.height };
}

const ACTION_KINDS = new Set<WatchActionKind>(["move", "down", "up", "type", "nav", "scroll"]);

/** The daemon caps typed text here (the CLI's ACTION_TEXT_CAP); the viewer
 *  holds the same line so a frame from an older or foreign daemon cannot
 *  hand the overlay a transcript. */
export const WATCH_ACTION_TEXT_CAP = 200;

const unit = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One `action` message as the socket delivered it, or null if malformed.
 * The same shape the daemon's normalizeAction produces: a point clamped to
 * the viewport, text only on `type` (and never beside `secret`), a url only
 * on `nav`. Anything else a message carries is dropped here, so the overlay
 * only ever sees frames the protocol defines.
 */
export function parseWatchAction(msg: any): WatchActionFrame | null {
  if (!msg || typeof msg.kind !== "string" || !ACTION_KINDS.has(msg.kind)) return null;
  if (typeof msg.x !== "number" || typeof msg.y !== "number" || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return null;
  const action: WatchActionFrame = {
    kind: msg.kind,
    x: unit(msg.x),
    y: unit(msg.y),
    at: typeof msg.at === "number" && Number.isFinite(msg.at) ? msg.at : Date.now(),
  };
  if (action.kind === "type") {
    if (msg.secret === true) action.secret = true;
    else if (typeof msg.text === "string") action.text = msg.text.slice(-WATCH_ACTION_TEXT_CAP);
  }
  if (action.kind === "nav" && typeof msg.url === "string") action.url = msg.url;
  return action;
}

export interface WatchConnection {
  close: () => void;
  /** Send input events (control mode). No-op before ready or after close. */
  sendInput: (events: WatchInputEvent[]) => void;
}

export function watchWsUrl(ep: TerminalEndpoint): string {
  // Literal IPv4 for the same reason as termWsUrl: macOS resolves `localhost`
  // to ::1 first and the daemon may bind IPv4 only.
  return `ws://127.0.0.1:${ep.port}/watch/ws`;
}

export function connectBrowserWatch(
  ep: TerminalEndpoint,
  session: { sessionUuid?: string | null; tmuxSession?: string | null; control?: boolean },
  handlers: WatchHandlers,
): WatchConnection {
  const ws = new WebSocket(watchWsUrl(ep));
  let done = false;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        token: ep.token,
        ...(session.sessionUuid ? { session_uuid: session.sessionUuid } : {}),
        ...(session.tmuxSession ? { tmux_session: session.tmuxSession } : {}),
        ...(session.control ? { control: true } : {}),
        // The newest protocol this viewer speaks (the CLI's WATCH_PROTOCOL_VERSION):
        // 2 adds action messages. Informational; the daemon sends its own in ready.
        protocol: 2,
        fps: 3,
      }),
    );
  };

  ws.onmessage = (ev) => {
    if (done) return;
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        handlers.onReady({ title: msg.title ?? "", url: msg.url ?? "", id: msg.targetId ?? "" }, msg.control === true);
        break;
      case "frame":
        handlers.onFrame(`data:image/jpeg;base64,${msg.data}`, msg.w ?? 0, msg.h ?? 0);
        break;
      case "tab":
        handlers.onTab({ title: msg.title ?? "", url: msg.url ?? "", id: msg.targetId ?? "" });
        break;
      case "action": {
        const action = parseWatchAction(msg);
        if (action) handlers.onAction?.(action);
        break;
      }
      case "error":
        done = true;
        handlers.onError(msg.code ?? "error", msg.message ?? "watch failed");
        break;
      case "exit":
        done = true;
        handlers.onExit(msg.reason ?? "ended");
        break;
    }
  };

  ws.onerror = () => {
    if (done) return;
    done = true;
    handlers.onError("socket", "lost the connection to the daemon");
  };

  ws.onclose = () => {
    if (done) return;
    done = true;
    handlers.onExit("closed");
  };

  return {
    close() {
      done = true;
      try {
        ws.close();
      } catch {}
    },
    sendInput(events) {
      if (done || ws.readyState !== WebSocket.OPEN || events.length === 0) return;
      ws.send(JSON.stringify({ type: "input", events }));
    },
  };
}

// ---------------------------------------------------------------------------
// What the stream is doing, and how to say it
// ---------------------------------------------------------------------------
//
// The status a viewer sees is the same whether the stream is docked over a
// conversation or open as a pane, so the wording lives here rather than in
// either host: one sentence per way a stream can end, written once, pinned by
// tests. The hosts render; this module decides what is true.

export type WatchStatus =
  /** Dialing: the endpoint, then the socket, then the daemon's first frame. */
  | { kind: "connecting" }
  | { kind: "live" }
  /** Deliberately off: nobody is looking, so the socket went away and the
   *  last frame stands in for it. A redial is automatic when the view returns. */
  | { kind: "paused" }
  | {
      kind: "failed";
      message: string;
      /** A redial could work — the failure is about this attempt, not the setup. */
      canRetry: boolean;
      /** It failed for want of a tab, so reopening the page would fix it. */
      tabGone: boolean;
      /** The daemon's own time cap, not a fault: resuming is the whole fix. */
      capped: boolean;
    };

function failed(
  message: string,
  opts?: { canRetry?: boolean; tabGone?: boolean; capped?: boolean },
): WatchStatus {
  return {
    kind: "failed",
    message,
    canRetry: opts?.canRetry ?? true,
    tabGone: opts?.tabGone ?? false,
    capped: opts?.capped ?? false,
  };
}

/** An orderly end the daemon announced (`exit`). */
export function watchExitStatus(reason: string): WatchStatus {
  switch (reason) {
    case "tab-closed":
      return failed("the agent's browser tab was closed", { tabGone: true });
    case "browser-closed":
      return failed("the managed browser is no longer running", { tabGone: true });
    case "timeout":
      return failed("stream paused after 30 minutes — resume to keep watching", { capped: true });
    default:
      return failed("stream ended");
  }
}

/** A terminal failure the daemon named (`error`). */
export function watchErrorStatus(code: string, message: string): WatchStatus {
  switch (code) {
    case "no-browser":
      return failed("no managed browser is running on the agent's machine", { tabGone: true });
    case "no-tab":
      return failed("this session hasn't driven a browser tab yet", { tabGone: true });
    case "forbidden":
      return failed("the daemon refused the stream — reload to refresh the endpoint");
    default:
      return failed(message || "could not open the stream");
  }
}

/**
 * Nothing to dial: the machine the agent runs on is not one this viewer can
 * reach. `foreign` is another person's machine — relaying it would mean
 * driving their browser, so the answer is the machine's name and a full stop.
 * Otherwise a daemon of ours simply is not answering here.
 */
export function watchUnreachableStatus(a: {
  foreign: boolean;
  machineName: string | null;
  /** The lookup named a device, so the browser is on another machine of yours. */
  hasDevice: boolean;
}): WatchStatus {
  if (a.foreign) {
    return failed(
      `This agent's browser runs on ${a.machineName ?? "someone else's machine"}, which only its owner can watch.`,
      { canRetry: false },
    );
  }
  if (a.hasDevice) {
    return failed(
      `The browser runs on ${a.machineName ?? "another of your machines"} — watching works from a browser on that machine.`,
    );
  }
  return failed("No local daemon reachable — watching needs cast running on this machine.");
}

/** The pane's "there is no tab" sentence: whose session, and where it last was. */
export function missingTabMessage(sessionTitle: string | null, lastUrl: string | null): string {
  const who = sessionTitle?.trim() || "This session";
  const where = lastUrl ? ` Its last page was ${lastUrl}.` : "";
  return `${who} has no browser tab open right now.${where}`;
}

/** Everything a host needs to draw its own chrome around the stream. */
export type BrowserStreamReport = {
  status: WatchStatus;
  /** The tab being streamed, as last named by the daemon. */
  tab: WatchTabInfo | null;
  /** The daemon granted two-way input, so a drive toggle is worth offering. */
  controlAvailable: boolean;
  /** A frame has painted; a paused or failed stream still shows it. */
  hasFrame: boolean;
  /** The agent's last navigation, for a host that flashes the address when it
   *  changes. `tab.url` already carries the new address; this says WHEN, so a
   *  flash keyed on it restarts per navigation and never on a re-render. */
  nav: { url: string; at: number } | null;
};
