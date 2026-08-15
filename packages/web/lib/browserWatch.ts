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
  onReady: (tab: WatchTabInfo) => void;
  /** A JPEG the driven page just painted, ready for an <img> src. */
  onFrame: (dataUrl: string, w: number, h: number) => void;
  onTab: (tab: WatchTabInfo) => void;
  /** Terminal failure: the stream is over and the socket is closing. */
  onError: (code: string, message: string) => void;
  /** Orderly end: tab closed, browser gone, or the daemon's time cap. */
  onExit: (reason: string) => void;
}

export interface WatchConnection {
  close: () => void;
}

export function watchWsUrl(ep: TerminalEndpoint): string {
  // Literal IPv4 for the same reason as termWsUrl: macOS resolves `localhost`
  // to ::1 first and the daemon may bind IPv4 only.
  return `ws://127.0.0.1:${ep.port}/watch/ws`;
}

export function connectBrowserWatch(
  ep: TerminalEndpoint,
  session: { sessionUuid?: string | null; tmuxSession?: string | null },
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
        handlers.onReady({ title: msg.title ?? "", url: msg.url ?? "" });
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
  };
}
