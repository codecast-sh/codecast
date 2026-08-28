// Client for the daemon's browser watch stream (packages/cli watchServer.ts).
//
// The transport is the integrated terminal's loopback endpoint — same port,
// same per-boot token, one more WS path — so discovery is just
// getTerminalEndpoint (lib/terminal/endpoint.ts) and this module only speaks
// the watch protocol: hello, then ready / frame / tab / error / exit. Frames
// arrive as base64 JPEG, at most ~3 a second, paced daemon-side by CDP acks.

import type { TerminalEndpoint } from "./terminal/endpoint";

export interface WatchTabInfo {
  title: string;
  url: string;
}

export interface WatchHandlers {
  /** `control` is true when the daemon granted two-way input on this socket. */
  onReady: (tab: WatchTabInfo, control: boolean) => void;
  /** A JPEG the driven page just painted, ready for an <img> src. */
  onFrame: (dataUrl: string, w: number, h: number) => void;
  onTab: (tab: WatchTabInfo) => void;
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

/**
 * Map a viewer's client point to normalized page coordinates (0..1), given
 * the <img> that renders the frame with object-contain. The video content
 * sits letterboxed inside the img box; a click in the letterbox bands maps
 * to nothing. Pure, so the geometry is testable without a DOM.
 */
export function mapToFrame(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): { nx: number; ny: number } | null {
  if (!natural.width || !natural.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const w = natural.width * scale;
  const h = natural.height * scale;
  const left = box.left + (box.width - w) / 2;
  const top = box.top + (box.height - h) / 2;
  const nx = (clientX - left) / w;
  const ny = (clientY - top) / h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { nx, ny };
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
        handlers.onReady({ title: msg.title ?? "", url: msg.url ?? "" }, msg.control === true);
        break;
      case "frame":
        handlers.onFrame(`data:image/jpeg;base64,${msg.data}`, msg.w ?? 0, msg.h ?? 0);
        break;
      case "tab":
        handlers.onTab({ title: msg.title ?? "", url: msg.url ?? "" });
        break;
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
