// Capture loop behind the `stream_pane` daemon command: publish one tmux pane's
// screen so a browser on ANOTHER machine can watch it.
//
// The integrated terminal's normal transport is a loopback PTY WebSocket
// (terminalServer.ts) and it is unreachable from any other device by design.
// This is the second, much cheaper transport: repeated `capture-pane` snapshots
// pushed to the relay in packages/convex/convex/terminalStream.ts. No PTY and
// no attach — screens out, keystrokes in, nothing else.
//
// The loop is driven by a LEASE the viewer renews, and every push carries the
// answer back: `stop` means nobody is watching any more. So there is no stop
// command to deliver and no teardown to miss — a closed tab, a killed browser
// and a dead network all end the loop the same way, within one lease.
//
// TYPING RIDES THE SAME REPLY. Keystrokes the viewer queued come back in the
// push answer and go into the pane with `send-keys -H`, which writes the exact
// bytes with no key-name parsing anywhere in the path. Two consequences worth
// keeping in mind: input can only flow while a lease is live (the relay clears
// the buffer only for an authorized push), and it arrives at the loop's
// cadence — hence the faster tick while someone is mid-sentence.
//
// Unchanged screens are not pushed. An agent thinking quietly for a minute
// costs one small heartbeat every few seconds, not 150 frames.

import { tmuxRun } from "../tmux.js";
import {
  PANE_CAPTURE_INTERVAL_MS,
  PANE_HEARTBEAT_MS,
  PANE_INPUT_CHUNK_BYTES,
  PANE_INPUT_POLL_MS,
  PANE_LEASE_MS,
  PANE_TYPING_INTERVAL_MS,
  PANE_TYPING_WINDOW_MS,
  hexToBytes,
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
   *  itself failed (network, server down). `input` is whatever the viewer typed
   *  since the previous push, as hex. */
  push: (msg: PaneFramePush) => Promise<{ stop: boolean; input?: string; fast?: boolean } | null>;
  /** Type raw bytes into the pane. */
  write: (target: string, bytes: number[]) => void;
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
  // "A human has this pane focused." The relay says so on every push, because
  // only it can see the viewer. It governs BOTH how often we look at the pane
  // and how often we push an unchanged one — the second is what matters, since
  // a push is the only thing that collects waiting keystrokes, and a quiet pane
  // produces none on its own.
  let fast = false;
  // While this is in the future the loop stays at the typing cadence regardless
  // of focus. A delivered keystroke sets it, so a burst keeps the loop quick
  // and a pause lets it settle back without anyone announcing anything.
  let typingUntil = 0;
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
    // An unchanged screen is normally worth one write every few seconds. While
    // someone is focused on the pane it is worth several a second instead —
    // not for the picture, which hasn't moved, but because this request is the
    // only thing that collects their keystrokes.
    const heartbeat = fast || deps.now() < typingUntil ? PANE_INPUT_POLL_MS : PANE_HEARTBEAT_MS;
    const due = deps.now() - lastPushAt >= heartbeat;
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
        fast = !!answer.fast;
        if (changed) lastFrame = snap.frame;
        if (answer.stop) {
          deps.log?.(`[PANE] ${target}: lease lapsed, stopping`);
          return;
        }
        if (answer.input) {
          const bytes = hexToBytes(answer.input);
          if (bytes === null) {
            deps.log?.(`[PANE] ${target}: dropped malformed input`);
          } else if (bytes.length) {
            deps.write(target, bytes);
            typingUntil = deps.now() + PANE_TYPING_WINDOW_MS;
            // Don't sleep: the whole point of the fast path is that the
            // keystroke's effect reaches the person who typed it promptly, and
            // the next capture is where they see it.
            continue;
          }
        }
      }
    }

    await deps.sleep(
      fast || deps.now() < typingUntil ? PANE_TYPING_INTERVAL_MS : PANE_CAPTURE_INTERVAL_MS,
    );
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

/**
 * Type exact bytes into a pane.
 *
 * `send-keys -H` takes one hex byte per argument and writes each verbatim —
 * no key-name lookup, no `-l` literal-versus-key ambiguity, no shell. That
 * matters because a terminal's input is not text: Escape, Ctrl-C, arrow keys
 * and a pasted emoji all arrive as byte sequences, and anything that parses
 * them on the way through will eventually parse one wrong. tmux receives what
 * xterm produced, byte for byte.
 *
 * Long input is split because every byte is its own argv entry.
 */
export function writePane(target: string, bytes: number[]): void {
  if (!isValidPaneTarget(target) || bytes.length === 0) return;
  const pane = target.includes(":") ? target : `${target}:0.0`;
  for (let i = 0; i < bytes.length; i += PANE_INPUT_CHUNK_BYTES) {
    const chunk = bytes.slice(i, i + PANE_INPUT_CHUNK_BYTES);
    tmuxRun([
      "send-keys",
      "-t",
      pane,
      "-H",
      ...chunk.map((b) => (b & 0xff).toString(16).padStart(2, "0")),
    ]);
  }
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
  deps: Omit<PaneStreamDeps, "capture" | "write" | "now" | "sleep"> &
    Partial<Pick<PaneStreamDeps, "capture" | "write" | "now" | "sleep">>,
): void {
  if (active.has(target)) {
    deps.log?.(`[PANE] ${target}: already streaming`);
    return;
  }
  const full: PaneStreamDeps = {
    capture: deps.capture ?? capturePane,
    write: deps.write ?? writePane,
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
