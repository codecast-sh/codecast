// Capture loop behind the `stream_pane` daemon command: publish one tmux pane's
// screen so a browser on ANOTHER machine can watch it.
//
// The integrated terminal's normal transport is a loopback PTY WebSocket
// (terminalServer.ts) and it is unreachable from any other device by design.
// This is the second, much cheaper transport for watching only: repeated
// `capture-pane` snapshots pushed to the relay in packages/convex/convex/
// terminalStream.ts. No PTY, no attach, no write path — a viewer on another
// machine can never touch the pane.
//
// The loop is driven by a LEASE the viewer renews, and every push carries the
// answer back: `stop` means nobody is watching any more. So there is no stop
// command to deliver and no teardown to miss — a closed tab, a killed browser
// and a dead network all end the loop the same way, within one lease.
//
// Unchanged screens are not pushed. An agent thinking quietly for a minute
// costs one small heartbeat every few seconds, not 150 frames.

import { tmuxRun } from "../tmux.js";
import {
  PANE_CAPTURE_INTERVAL_MS,
  PANE_HEARTBEAT_MS,
  PANE_LEASE_MS,
  isValidPaneTarget,
} from "@codecast/shared/contracts";

export interface PaneSnapshot {
  frame: string;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
}

export interface PaneFramePush {
  target: string;
  frame?: string;
  cols?: number;
  rows?: number;
  cursor_x?: number;
  cursor_y?: number;
  error?: string;
}

export interface PaneStreamDeps {
  /** Read the pane now. null = the pane is gone (or tmux is). */
  capture: (target: string) => PaneSnapshot | null;
  /** Publish to the relay. Returns the relay's answer, or null if the push
   *  itself failed (network, server down). */
  push: (msg: PaneFramePush) => Promise<{ stop: boolean } | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** Give up after this many consecutive failed pushes. Long enough to ride out
 *  a reconnect, short enough that a machine that lost the server doesn't keep
 *  capturing a pane nobody can see. */
const MAX_PUSH_FAILURES = 6;

/**
 * Stream one pane until the lease lapses, the pane dies, or pushing stops
 * working. Pure w.r.t. its deps so the whole protocol is testable without tmux
 * or a network.
 */
export async function runPaneStream(target: string, deps: PaneStreamDeps): Promise<void> {
  let lastFrame: string | null = null;
  let lastPushAt = 0;
  let failures = 0;
  // A lease is already live when the command is dispatched — this is the
  // backstop for a relay that stops answering, not the real deadline.
  const hardDeadline = deps.now() + PANE_LEASE_MS * 30;

  for (;;) {
    if (deps.now() > hardDeadline) {
      deps.log?.(`[PANE] ${target}: hard deadline reached, stopping`);
      return;
    }

    const snap = deps.capture(target);
    if (!snap) {
      // Report it once so the viewer says "pane is gone" instead of spinning
      // on "connecting", then stop: a dead pane does not come back under the
      // same name.
      await deps.push({ target, error: "pane is gone" });
      deps.log?.(`[PANE] ${target}: pane not found, stopping`);
      return;
    }

    const changed = snap.frame !== lastFrame;
    const due = deps.now() - lastPushAt >= PANE_HEARTBEAT_MS;
    if (changed || due) {
      const answer = await deps.push(
        changed
          ? {
              target,
              frame: snap.frame,
              cols: snap.cols,
              rows: snap.rows,
              cursor_x: snap.cursorX,
              cursor_y: snap.cursorY,
            }
          : { target },
      );
      if (!answer) {
        if (++failures >= MAX_PUSH_FAILURES) {
          deps.log?.(`[PANE] ${target}: ${failures} failed pushes, stopping`);
          return;
        }
      } else {
        failures = 0;
        lastPushAt = deps.now();
        if (changed) lastFrame = snap.frame;
        if (answer.stop) {
          deps.log?.(`[PANE] ${target}: lease lapsed, stopping`);
          return;
        }
      }
    }

    await deps.sleep(PANE_CAPTURE_INTERVAL_MS);
  }
}

/**
 * Read a pane's visible screen with its geometry and cursor, in ONE tmux call.
 *
 * Deliberately not `-J`: joining wrapped lines is right for scraping prose out
 * of a pane, and wrong here — a watcher wants the screen laid out in rows the
 * way tmux has it. `-e` keeps the colors.
 *
 * The metadata rides the same invocation (tmux takes `;`-separated commands) so
 * a 400ms loop spawns one process per tick instead of two. Separators must be
 * printable: tmux rewrites control characters in format output to "_".
 */
export function capturePane(target: string): PaneSnapshot | null {
  if (!isValidPaneTarget(target)) return null;
  // Managed sessions are addressed as session:window.pane everywhere else in
  // the daemon; accept a bare session name and resolve it the same way.
  const pane = target.includes(":") ? target : `${target}:0.0`;
  const r = tmuxRun([
    "display-message",
    "-p",
    "-t",
    pane,
    "-F",
    "#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}",
    ";",
    "capture-pane",
    "-p",
    "-e",
    "-t",
    pane,
  ]);
  if (r.status !== 0) return null;
  const nl = r.stdout.indexOf("\n");
  if (nl < 0) return null;
  const [cols, rows, cx, cy] = r.stdout.slice(0, nl).split("|").map((n) => parseInt(n, 10));
  if (!cols || !rows) return null;
  return {
    // capture-pane ends with a newline; keeping it would add a phantom row.
    frame: r.stdout.slice(nl + 1).replace(/\n$/, ""),
    cols,
    rows,
    cursorX: Number.isFinite(cx) ? cx : 0,
    cursorY: Number.isFinite(cy) ? cy : 0,
  };
}

// One loop per pane, however many browsers are watching: the relay row is
// shared, so a second viewer just extends the same lease. A repeated
// stream_pane command for a pane already streaming is a no-op.
const active = new Map<string, Promise<void>>();

export function isPaneStreaming(target: string): boolean {
  return active.has(target);
}

export function activePaneStreams(): string[] {
  return [...active.keys()];
}

/** Start the loop for `target` unless it is already running. */
export function startPaneStream(
  target: string,
  deps: Omit<PaneStreamDeps, "capture" | "now" | "sleep"> & Partial<Pick<PaneStreamDeps, "capture" | "now" | "sleep">>,
): void {
  if (active.has(target)) {
    deps.log?.(`[PANE] ${target}: already streaming`);
    return;
  }
  const full: PaneStreamDeps = {
    capture: deps.capture ?? capturePane,
    push: deps.push,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: deps.log,
  };
  const run = runPaneStream(target, full)
    .catch((err) => {
      full.log?.(`[PANE] ${target}: stream error ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      active.delete(target);
    });
  active.set(target, run);
}
