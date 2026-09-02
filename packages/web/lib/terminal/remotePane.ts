// Watching a pane that lives on ANOTHER of your machines.
//
// The normal terminal transport is a loopback WebSocket to the daemon, and it
// only ever reaches the machine this browser runs on (see endpoint.ts). When
// the agent runs somewhere else — a Mac mini, a Linux box — there is no socket
// to open, so this module supplies the other transport: whole screens relayed
// through Convex (packages/convex/convex/terminalStream.ts), repainted in place.
//
// The shape is deliberately different from the socket path, because the physics
// are: no PTY, no scrollback — just the pane's current screen a few times a
// second, which is what "watch this agent" actually needs. A lease renewed on a
// timer is what keeps the far daemon capturing; letting it lapse is how
// watching stops.
//
// Typing works, at relay speed. Keystrokes are queued on the row and collected
// by the capture loop's next push, so a character takes a couple of hundred
// milliseconds to reach the pane and about as long again to come back on a
// frame. That is fine for answering an agent and wrong for a full-screen editor
// — which is why sends are coalesced rather than fired per keystroke, and why
// the pane's own geometry always wins over the browser's.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { PANE_RENEW_MS, bytesToHex } from "@codecast/shared/contracts";

export interface RemotePaneSource {
  convex: ConvexReactClient;
  deviceId: string;
  target: string;
  /** The conversation the pane belongs to. Required to watch a pane on an
   *  agent box (a bot account's daemon); the relay authorizes the viewer as
   *  that session's owner. Own devices need nothing. */
  conversationId?: string;
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

/** What a live relay connection lets the caller do. */
export interface RemotePaneConnection {
  /** Queue keystrokes for the pane. Bytes as xterm produced them (a string of
   *  char codes 0-255), coalesced and sent in order. */
  write: (data: string) => void;
  /** Tell the relay whether a human is focused here, which is what buys the
   *  fast poll that keeps typing responsive. */
  setInteractive: (on: boolean) => void;
  /** Drop the lease. The far loop stops on its own from the next push. */
  close: () => void;
}

/** How long keystrokes are gathered before one send. Two keys pressed together
 *  should cost one write, not two; longer than this and typing feels laggy for
 *  no saving, since the far loop polls every 250ms anyway. */
const INPUT_COALESCE_MS = 40;

/**
 * Hold a lease on the pane and forward every frame the relay publishes.
 *
 * Returns the teardown. Dropping the lease is the ONLY stop signal the far
 * daemon gets, and it needs none other: it learns the lease lapsed from the
 * push it was already making.
 */
export function connectRemotePane(
  src: RemotePaneSource,
  handlers: RemotePaneHandlers,
): RemotePaneConnection {
  const args = {
    device_id: src.deviceId,
    target: src.target,
    ...(src.conversationId ? { conversation_id: src.conversationId as any } : {}),
  };
  let stopped = false;
  let interactive = false;

  const renew = async () => {
    if (stopped) return;
    try {
      const res = await src.convex.mutation(api.terminalStream.watchPane, { ...args, interactive });
      // The relay only streams your own machines. Anything else is a state the
      // user can act on (sign in as the right account, register the device),
      // so say it rather than spinning on "connecting".
      if (res && res.ok === false) handlers.onError("this machine isn't registered to your account, and no session you own runs there");
    } catch (err) {
      handlers.onError(err instanceof Error ? err.message : "could not reach the relay");
    }
  };

  void renew();
  const timer = setInterval(() => void renew(), PANE_RENEW_MS);

  // Keystrokes: gathered for a beat, then sent as one call. `chain` keeps the
  // sends strictly ordered — two in flight at once could reach the row in
  // either order and silently transpose what someone typed.
  let outbox = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const flush = () => {
    flushTimer = null;
    if (stopped || !outbox) return;
    const bytes = new Uint8Array(outbox.length);
    for (let i = 0; i < outbox.length; i++) bytes[i] = outbox.charCodeAt(i) & 0xff;
    outbox = "";
    const data = bytesToHex(bytes);
    chain = chain
      .then(() => src.convex.mutation(api.terminalStream.sendPaneInput, { ...args, data }))
      .then((res: any) => {
        if (!res || res.ok) return;
        // Every refusal means the keystroke did NOT land, so each one has to
        // say so — a terminal that silently drops input is worse than one that
        // is plainly disconnected.
        handlers.onError(
          res.reason === "no-streamer"
            ? "not connected to that machine — nothing was typed"
            : res.reason === "backlog"
              ? "too much unsent input — that machine isn't keeping up"
              : "this pane isn't being watched any more",
        );
      })
      .catch((err) => {
        handlers.onError(err instanceof Error ? err.message : "could not send keystrokes");
      });
  };

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

  return {
    write: (data) => {
      if (stopped || !data) return;
      outbox += data;
      if (!flushTimer) flushTimer = setTimeout(flush, INPUT_COALESCE_MS);
    },
    setInteractive: (on) => {
      if (stopped || on === interactive) return;
      interactive = on;
      // Renew right away rather than waiting out the timer: focus is the signal
      // that speeds the far loop up, and a several-second delay before the
      // keyboard works would read as the feature being broken.
      if (on) void renew();
    },
    close: () => {
      stopped = true;
      clearInterval(timer);
      if (flushTimer) clearTimeout(flushTimer);
      unsubscribe();
    },
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
