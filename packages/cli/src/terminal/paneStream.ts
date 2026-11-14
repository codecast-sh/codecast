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
//
// A screen leaves this machine only through redactSecrets, the same pass a
// transcript takes: a pane that just ran `cast vault get` or `env` shows real
// values, and the relay keeps frames for a day. redactFrame matches each line
// as the program wrote it, with colors stripped and wrapped rows rejoined, so
// a value wider than the pane is caught too.

import { redactSecrets } from "../redact.js";
import { tmuxRun } from "../tmux.js";
import { hasSessionServer, sessionServerSockets, targetSession, withTmuxSession } from "../tmuxRoute.js";
import { TMUX_SESSION_SOCKET_PREFIX } from "@codecast/shared/contracts";
import {
  PANE_CAPTURE_INTERVAL_MS,
  PANE_CLIPBOARD_MAINTAIN_MS,
  PANE_CLIPBOARD_POLL_MS,
  PANE_CLIPBOARD_WINDOW_MS,
  PANE_HEARTBEAT_MS,
  PANE_MAX_CLIPBOARD_CHARS,
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
  /** The clipboard bridge (see watchClipboard). Absent = no bridge. */
  clipboard?: PaneClipboardDeps;
}

/**
 * tmux paste buffers, offered to the viewer. An app that copies inside tmux
 * (Claude Code's /copy writes OSC 52) reaches the clipboard of whatever
 * terminal is attached, never a phone watching through the relay; with
 * set-clipboard on, tmux also keeps the text as a buffer. So for a short
 * window after the viewer types, the loop looks for a buffer that was not
 * there when the window opened and sends it to the relay as a clipboard offer
 * the viewer can take with one tap.
 */
export interface PaneClipboardDeps {
  /** The pane's tmux buffer names, newest first, or null when tmux cannot say. */
  list: () => string[] | null;
  /** One buffer's text, or null. */
  read: (name: string) => string | null;
  /** Publish the offer. A failure (an older relay without the route) costs nothing else. */
  push: (text: string) => Promise<unknown>;
  /** The stream ended: undo what the bridge changed on the pane's server. */
  close?: () => void;
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
  const clip = deps.clipboard ? clipboardWatch(deps.clipboard, deps.now, deps.log) : null;
  clip?.maintain();

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

    const frame = redactFrame(snap.frame, snap.cols);
    const changed = frame !== lastFrame;
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
              frame,
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
        if (changed) lastFrame = frame;
        if (answer.stop) {
          deps.log?.(`[PANE] ${target}: lease lapsed, stopping`);
          return;
        }
        if (answer.input) {
          const bytes = hexToBytes(answer.input);
          if (bytes === null) {
            deps.log?.(`[PANE] ${target}: dropped malformed input`);
          } else if (bytes.length) {
            // Armed BEFORE the write: tmux copies inside send-keys, so a
            // baseline taken after it would already name the new buffer.
            clip?.arm();
            // A lone Esc and the key after it, drained together, would reach
            // the pane as one Meta chord (Esc Up read as Meta-Up): each run
            // goes in on its own write, a beat apart.
            const runs = splitLoneEscape(bytes);
            for (let r = 0; r < runs.length; r++) {
              if (r > 0) await deps.sleep(ESCAPE_GAP_MS);
              deps.write(target, runs[r]!);
            }
            typingUntil = deps.now() + PANE_TYPING_WINDOW_MS;
            // Don't sleep: the whole point of the fast path is that the
            // keystroke's effect reaches the person who typed it promptly, and
            // the next capture is where they see it.
            continue;
          }
        }
      }
    }

    clip?.maintain();
    clip?.tick();
    await deps.sleep(
      fast || deps.now() < typingUntil ? PANE_TYPING_INTERVAL_MS : PANE_CAPTURE_INTERVAL_MS,
    );
  }
}

/** A server user option holding the set-clipboard value the bridge replaced. */
const CLIPBOARD_WAS = "@codecast-set-clipboard-was";

/** Between a lone Esc and the bytes after it: past the escape-sequence wait of the TUIs this serves. */
const ESCAPE_GAP_MS = 60;
// (Long enough for the Ink and crossterm TUIs the agents run on; an ncurses
// app waiting out its own ESCDELAY would need more.)

/**
 * Input split after every Esc that is followed by another Esc: the first is a
 * lone Esc key, the second starts the next key's sequence. Everything else
 * stays one write.
 */
export function splitLoneEscape(bytes: number[]): number[][] {
  const runs: number[][] = [];
  let start = 0;
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] === 0x1b && bytes[i - 1] === 0x1b) {
      runs.push(bytes.slice(start, i));
      start = i;
    }
  }
  runs.push(bytes.slice(start));
  return runs;
}

/** The bridge's window: arm on input, poll inside it, offer each new buffer once. */
export function clipboardWatch(deps: PaneClipboardDeps, now: () => number, log?: (msg: string) => void) {
  let until = 0;
  let baseline = new Set<string>();
  let lastCheck = 0;
  // The buffers the last look found, or null while the bridge is off (a
  // terminal attached, tmux not answering). Kept fresh by maintain(), so a
  // keystroke reads it instead of calling tmux.
  let known: string[] | null = null;
  let lastMaintain = -Infinity;
  const list = (): string[] | null => {
    try { return deps.list(); } catch { return null; }
  };
  return {
    /** Once per capture-loop pass; looks at tmux at most every PANE_CLIPBOARD_MAINTAIN_MS. */
    maintain() {
      if (now() - lastMaintain < PANE_CLIPBOARD_MAINTAIN_MS) return;
      lastMaintain = now();
      known = list();
      if (!known) until = 0;
    },
    arm() {
      // No baseline, no window: without one every old buffer would look new,
      // and an hours-old copy (a token) would be offered.
      if (!known) return;
      // The baseline is taken when a window OPENS, so a buffer made by the
      // first keystroke of a burst is still new to the rest of it.
      if (now() >= until) {
        baseline = new Set(known);
        lastCheck = now();
      }
      until = now() + PANE_CLIPBOARD_WINDOW_MS;
    },
    tick() {
      if (now() >= until || now() - lastCheck < PANE_CLIPBOARD_POLL_MS) return;
      lastCheck = now();
      const names = list();
      known = names;
      if (!names) {
        until = 0;
        return;
      }
      // A SET, not "the newest": a short-lived buffer gone since the window
      // opened would otherwise make an old one look new.
      const fresh = names.find((n) => !baseline.has(n));
      for (const n of names) baseline.add(n);
      if (!fresh) return;
      let text: string | null = null;
      try { text = deps.read(fresh); } catch {}
      if (!text) return;
      // Redact the whole text first: a cut made before it could split a
      // secret so the pattern no longer matches.
      let offer = redactSecrets(text);
      if (offer.length > PANE_MAX_CLIPBOARD_CHARS) {
        offer = offer.slice(0, PANE_MAX_CLIPBOARD_CHARS);
        if (/[\ud800-\udbff]$/.test(offer)) offer = offer.slice(0, -1);
      }
      log?.(`[PANE] offering a ${offer.length}-char tmux buffer to the viewer`);
      void deps.push(offer).catch(() => {});
    },
  };
}

/**
 * The clipboard bridge's tmux side for one pane, or null when it must stay
 * off. Buffers belong to a whole tmux server, so the bridge runs only for a
 * pane on its own server (macOS agent sessions, tmuxRoute.ts): on a shared
 * server a new buffer could be anyone's, another person's session on an agent
 * box included. Only tmux's own auto-named buffers (buffer0, buffer1, ...)
 * count; the daemon's paste buffers have other names.
 */
export function paneBufferReader(target: string): Pick<PaneClipboardDeps, "list" | "read" | "close"> | null {
  const session = targetSession(target);
  if (!session || !hasSessionServer(session)) return null;
  const tmux = (args: string[]) => withTmuxSession(session, () => tmuxRun(args));
  // tmux's default set-clipboard is "external", which ignores an app's OSC 52
  // copy; "on" also keeps it as a buffer. Set on this session's own server
  // only (it serves this one agent session), never on the shared one, and
  // only while the stream runs and nobody has the session open in a terminal
  // here: with a client attached, "on" would let any app in the pane write
  // that person's system clipboard. Checked on every look (the capture loop
  // looks every PANE_CLIPBOARD_MAINTAIN_MS), so an attach mid-stream turns it
  // back within that, and a detach turns it on again.
  // The value it replaced is kept on the server itself (CLIPBOARD_WAS), so a
  // daemon that died mid-stream still restores it on the next stream's close.
  let previous: string | null = null;
  let enabled = false;
  const disable = () => {
    if (!enabled) return;
    enabled = false;
    if (previous && previous !== "on") {
      tmux(["set-option", "-s", "set-clipboard", previous]);
      tmux(["set-option", "-su", CLIPBOARD_WAS]);
    }
  };
  const enable = (): boolean => {
    const clients = tmux(["list-clients", "-t", session, "-F", "#{client_name}"]);
    if (clients.status !== 0 || clients.stdout.trim()) {
      disable();
      return false;
    }
    if (enabled) return true;
    const marker = tmux(["show-options", "-sv", CLIPBOARD_WAS]);
    const current = tmux(["show-options", "-sv", "set-clipboard"]);
    previous = marker.status === 0 && marker.stdout.trim() ? marker.stdout.trim() : current.status === 0 ? current.stdout.trim() : null;
    if (previous && previous !== "on") {
      tmux(["set-option", "-s", CLIPBOARD_WAS, previous]);
      tmux(["set-option", "-s", "set-clipboard", "on"]);
    }
    enabled = true;
    return true;
  };
  return {
    close: disable,
    list: () => {
      if (!enable()) return null;
      const r = tmux(["list-buffers", "-F", "#{buffer_name}"]);
      if (r.status !== 0) return r.stderr.includes("no buffers") ? [] : null;
      return r.stdout.split("\n").map((l) => l.trim()).filter((n) => /^buffer\d+$/.test(n));
    },
    read: (name) => {
      if (!/^buffer\d+$/.test(name)) return null;
      const r = tmux(["show-buffer", "-b", name]);
      return r.status === 0 ? r.stdout : null;
    },
  };
}

/**
 * Put back set-clipboard on every per-session server a stream left it on: a
 * daemon killed mid-stream never ran close(), and the server would keep
 * letting apps write the clipboard of whoever attaches later. Servers with a
 * live stream are left alone. Returns how many it restored.
 */
export function restoreStrandedClipboardBridges(): number {
  let restored = 0;
  for (const socket of sessionServerSockets()) {
    const session = socket.slice(TMUX_SESSION_SOCKET_PREFIX.length);
    if (!session || isPaneStreaming(session)) continue;
    const tmux = (args: string[]) => tmuxRun(["-L", socket, ...args]);
    const marker = tmux(["show-options", "-sv", CLIPBOARD_WAS]);
    const was = marker.status === 0 ? marker.stdout.trim() : "";
    if (!was) continue;
    tmux(["set-option", "-s", "set-clipboard", was]);
    tmux(["set-option", "-su", CLIPBOARD_WAS]);
    restored++;
  }
  return restored;
}

/** Colors (SGR) and the other escapes capture-pane -e emits, OSC 8 links included. */
const ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

/** Cells a row's text takes, counting anything past U+1100 as wide: an overcount only joins a row that did not wrap, never misses one that did. */
function cellWidth(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0)! >= 0x1100 ? 2 : 1;
  return n;
}

/**
 * A frame with every secret masked, row layout kept. capture-pane gives
 * screen rows, so a value longer than the pane is split across rows with a
 * newline, and a color change can split one inside a row; neither matches
 * redactSecrets. Each logical line (a row that fills the width runs on into
 * the next) is matched with its escapes stripped. A line that holds a secret
 * is rewritten as its redacted text, wrapped back into the same rows without
 * colors; every other row keeps its colors and still goes through
 * redactSecrets, which also covers a value inside an escape (a link's URL).
 */
export function redactFrame(frame: string, cols: number): string {
  const rows = frame.split("\n");
  const plain = rows.map((r) => r.replace(ESCAPE_RE, ""));
  const lines: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0, end = 0; start < rows.length; start = end) {
    end = start + 1;
    while (end < rows.length && cellWidth(plain[end - 1]!) >= cols) end++;
    lines.push({ start, end, text: plain.slice(start, end).join("") });
  }
  // Most ticks hold no secret: one pass over every line at once says so.
  const all = lines.map((l) => l.text).join("\n");
  if (redactSecrets(all) === all) return redactSecrets(frame);
  const out: string[] = [];
  for (const { start, end, text } of lines) {
    const redacted = redactSecrets(text);
    if (redacted === text) {
      for (let i = start; i < end; i++) out.push(redactSecrets(rows[i]!));
      continue;
    }
    const chars = [...redacted];
    for (let i = 0; i < end - start; i++) out.push(chars.slice(i * cols, (i + 1) * cols).join(""));
  }
  return out.join("\n");
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
 * `send-keys -H` takes one hex BYTE per argument and delivers each verbatim —
 * no key-name lookup, no `-l` literal-versus-key ambiguity, no shell. That is
 * what this path needs, because terminal input is not text: Escape, Ctrl-C,
 * arrow keys and a pasted emoji are all byte sequences, and anything that
 * interprets them on the way through will eventually interpret one wrong. tmux
 * hands the pane's process what xterm produced, byte for byte.
 *
 * Worth knowing when a character seems to vanish: the pane's own program may
 * still discard it. A shell whose readline is running without a UTF-8 locale
 * drops multi-byte input at its own input layer, long after tmux delivered it
 * correctly — a pane environment problem, not a relay one.
 *
 * Long input is split because every byte is its own argv entry.
 */
export function writePane(target: string, bytes: number[]): boolean {
  if (!isValidPaneTarget(target) || bytes.length === 0) return false;
  const pane = target.includes(":") ? target : `${target}:0.0`;
  for (let i = 0; i < bytes.length; i += PANE_INPUT_CHUNK_BYTES) {
    const chunk = bytes.slice(i, i + PANE_INPUT_CHUNK_BYTES);
    const result = tmuxRun([
      "send-keys",
      "-t",
      pane,
      "-H",
      ...chunk.map((b) => (b & 0xff).toString(16).padStart(2, "0")),
    ]);
    if (result.status !== 0) return false;
  }
  return true;
}

// One loop per pane, however many browsers are watching: the relay row is
// shared, so a second viewer just extends the same lease. A repeated
// stream_pane command for a pane already streaming is a no-op.
const active = new Map<string, Promise<void>>();

export function isPaneStreaming(target: string): boolean {
  return active.has(target);
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
    clipboard: deps.clipboard,
  };
  const run = runPaneStream(target, full)
    .catch((err) => {
      full.log?.(`[PANE] ${target}: stream error ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      active.delete(target);
      try { full.clipboard?.close?.(); } catch {}
    });
  active.set(target, run);
}
