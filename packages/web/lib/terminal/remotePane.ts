// Watching a pane that lives on ANOTHER of your machines.
//
// The normal terminal transport is a loopback WebSocket to the daemon, and it
// only ever reaches the machine this browser runs on (see endpoint.ts). When
// the agent runs somewhere else — a Mac mini, a Linux box — there is no socket
// to open, so this module supplies the other transport: whole screens relayed
// through Convex (packages/convex/convex/terminalStream.ts), repainted in place.
//
// The shape is deliberately different from the socket path, because the physics
// are: no PTY, no input, no scrollback — just the pane's current screen a few
// times a second, which is what "watch this agent" actually needs. A lease
// renewed on a timer is what keeps the far daemon capturing; letting it lapse
// is how watching stops.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { PANE_RENEW_MS } from "@codecast/shared/contracts";

export interface RemotePaneSource {
  convex: ConvexReactClient;
  deviceId: string;
  target: string;
}

export interface RemotePaneFrame {
  frame: string | null;
  cols: number | null;
  rows: number | null;
  cursor_x: number | null;
  cursor_y: number | null;
  seq: number;
  error: string | null;
  streamer_seen_at: number | null;
  updated_at: number;
}

export interface RemotePaneHandlers {
  onFrame: (f: RemotePaneFrame) => void;
  onError: (message: string) => void;
}

/**
 * Hold a lease on the pane and forward every frame the relay publishes.
 *
 * Returns the teardown. Dropping the lease is the ONLY stop signal the far
 * daemon gets, and it needs none other: it learns the lease lapsed from the
 * push it was already making.
 */
export function connectRemotePane(src: RemotePaneSource, handlers: RemotePaneHandlers): () => void {
  const args = { device_id: src.deviceId, target: src.target };
  let stopped = false;

  const renew = async () => {
    if (stopped) return;
    try {
      const res = await src.convex.mutation(api.terminalStream.watchPane, args);
      // The relay only streams your own machines. Anything else is a state the
      // user can act on (sign in as the right account, register the device),
      // so say it rather than spinning on "connecting".
      if (res && res.ok === false) handlers.onError("this machine isn't registered to your account");
    } catch (err) {
      handlers.onError(err instanceof Error ? err.message : "could not reach the relay");
    }
  };

  void renew();
  const timer = setInterval(() => void renew(), PANE_RENEW_MS);

  const watch = src.convex.watchQuery(api.terminalStream.getPane, args, {});
  const unsubscribe = watch.onUpdate(() => {
    let value: RemotePaneFrame | null | undefined;
    try {
      value = watch.localQueryResult() as RemotePaneFrame | null | undefined;
    } catch (err) {
      // A relay function missing from the deployment (a web build that shipped
      // ahead of a convex deploy) throws here. Report it and stay quiet rather
      // than re-throwing into React's render path.
      handlers.onError(err instanceof Error ? err.message : "relay unavailable");
      return;
    }
    if (!value) return;
    if (value.error) {
      handlers.onError(value.error);
      return;
    }
    handlers.onFrame(value);
  });

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
}

/**
 * Turn one captured screen into bytes xterm can write.
 *
 * Repaint in place rather than clear-then-draw: home the cursor, overwrite each
 * row and erase its tail, then erase everything below. A `\x1b[2J` between
 * frames flickers, and a clear-scrollback would fight the container's scroll
 * position on every tick.
 *
 * The attribute reset before each erase matters — `\x1b[K` clears using the
 * CURRENT background, so a row ending inside a colored span would smear that
 * color across the rest of the line.
 */
export function frameToBytes(frame: string, cursor?: { x: number; y: number } | null): string {
  const lines = frame.split("\n");
  let out = "\x1b[H";
  for (let i = 0; i < lines.length; i++) {
    out += lines[i] + "\x1b[0m\x1b[K";
    // No newline after the last row: on a full-height screen that would scroll
    // the buffer by one and walk the whole view up over time.
    if (i < lines.length - 1) out += "\r\n";
  }
  out += "\x1b[J";
  if (cursor) out += `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
  return out;
}
