// Connection layer of the terminal instance manager (termSessions.ts): the
// loopback socket with its resume and reconnect, the relay transport, the
// seat (controller/observer) protocol, and tab teardown.

import { killTerminalSession, termWsUrl, type TerminalEndpoint } from "./endpoint";
import { connectRemotePane, frameToBytes, type RemotePaneSource } from "./remotePane";
import { PaneStreamFilter } from "./paneStreamFilter";
import { bump, fitInstance, instances, reg, type OpenTerminalOptions, type TermInstance } from "./termRegistry";

// A dropped socket (a laptop lid, a network change, a phone asleep) comes
// back on its own and resumes. Backoff between tries, and a limit after which
// the tab says disconnected and offers Reconnect: the daemon keeps a dropped
// terminal resumable for minutes, not forever.
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];
const RECONNECT_GIVE_UP_MS = 3 * 60_000;

// How long a relayed pane may show nothing before we call it unreachable.
// Generous: it has to cover the daemon poll picking the command up, one
// capture, and the push landing — several seconds on a healthy machine.
const REMOTE_FIRST_FRAME_TIMEOUT_MS = 20_000;

export function connect(inst: TermInstance, opts: OpenTerminalOptions): void {
  if (opts.remote) {
    connectRemote(inst, opts.remote);
    return;
  }
  wireLocalInput(inst);
  connectLocal(inst);
}


function socketOpen(inst: TermInstance): WebSocket | null {
  return inst.ws?.readyState === WebSocket.OPEN && inst.state.status === "open" && !inst.state.reconnecting ? inst.ws : null;
}

/** Tell the server this view's size, unless it is the size the server gave
 *  us (see the echo note in wireLocalInput). Queued while no socket is up. */
function sendResize(inst: TermInstance, cols: number, rows: number): void {
  if (inst.adoptedSize && inst.adoptedSize.cols === cols && inst.adoptedSize.rows === rows) return;
  const ws = socketOpen(inst);
  if (ws) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  else inst.pendingResize = { cols, rows };
}

/** Keystrokes and size changes out, for whichever socket is current. Wired
 *  once per instance: a reconnect swaps the socket, not the listeners. */
function wireLocalInput(inst: TermInstance): void {
  const encoder = new TextEncoder();
  inst.term.onData((data) => {
    const ws = socketOpen(inst);
    if (ws && !inst.state.readOnly) ws.send(encoder.encode(data));
  });
  inst.term.onBinary((data) => {
    const ws = socketOpen(inst);
    if (ws && !inst.state.readOnly) {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      ws.send(bytes);
    }
  });
  inst.term.onResize(({ cols, rows }) => {
    if (inst.state.paneSized) return; // the pane's own size wins
    // A size ADOPTED from the server (ready/reseed) must not be echoed back
    // as a client resize. On a single-pane window the echo is a no-op (pane
    // == window), but teammate panes make the pane SMALLER than its window:
    // the echo then shrinks the window to the pane, tmux re-tiles every pane
    // into the smaller window, and the next reseed reports a narrower pane
    // still — a collapse loop (220 → 109 → 54 → 27 → …, real-tmux repro).
    sendResize(inst, cols, rows);
  });
}

/** Adopt the seat the server reports. An observer is sized to the pane and
 *  types nothing; a controller sizes the pane from its own container. */
function applyRole(inst: TermInstance, msg: Record<string, unknown>): void {
  if (msg.role !== "controller" && msg.role !== "observer") return;
  const wasController = inst.state.role === "controller";
  inst.state.role = msg.role;
  inst.state.takeoverPending = false;
  inst.state.canControl = !!msg.canControl;
  inst.state.controlledElsewhere = !!msg.controlledElsewhere;
  inst.state.viewers = typeof msg.viewers === "number" ? msg.viewers : undefined;
  if (msg.role === "controller") inst.state.controlTaken = false;
  else if (msg.reason === "taken") inst.state.controlTaken = true;
  inst.state.readOnly = msg.role === "observer";
  // An attach watcher was always pane-sized; a controller of an interactive
  // attach or a shell fits its container.
  const ownsSize = msg.role === "controller";
  inst.state.paneSized = !ownsSize || !!inst.opts.remote;
  if (ownsSize && !wasController) {
    // tmux holds one set of colours per terminal: the controller's.
    const ws = socketOpen(inst);
    if (ws) ws.send(JSON.stringify({ type: "colors", colors: { foreground: reg.currentTheme.foreground, background: reg.currentTheme.background } }));
  }
  if (ownsSize && !wasController && inst.container) {
    // The server ignored every size this view had while it watched: hand it
    // the real one now (fitInstance only sends a size that changed).
    const before = `${inst.term.cols}x${inst.term.rows}`;
    fitInstance(inst);
    // A fit that changed the size already sent it (onResize).
    if (`${inst.term.cols}x${inst.term.rows}` === before && socketOpen(inst)) sendResize(inst, inst.term.cols, inst.term.rows);
  }
}

function connectLocal(inst: TermInstance): void {
  const opts = inst.opts;
  // Bound to a local, so the narrowing survives into the callbacks below.
  const endpoint = opts.endpoint;
  if (!endpoint) {
    inst.state.status = "error";
    inst.state.statusDetail = "no terminal transport";
    bump();
    return;
  }
  const ws = new WebSocket(termWsUrl(endpoint));
  ws.binaryType = "arraybuffer";
  inst.ws = ws;
  // What ended this socket, when the server said: no reconnect after either.
  let ended = false;

  ws.onopen = () => {
    const hello = {
      type: "hello",
      token: endpoint.token,
      mode: opts.kind === "attach" ? "attach" : "create",
      name: opts.kind === "shell" ? inst.state.sessionName : undefined,
      cwd: opts.cwd,
      target: opts.target,
      interactive: opts.interactive,
      cols: inst.term.cols,
      rows: inst.term.rows,
      colors: { foreground: reg.currentTheme.foreground, background: reg.currentTheme.background },
      viewId: inst.viewId,
      resume: inst.cursor ?? undefined,
    };
    logHello({ tabId: inst.state.id, ...hello });
    ws.send(JSON.stringify(hello));
  };

  ws.onmessage = (ev) => {
    if (ws !== inst.ws) return;
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ready") {
          const repaint = inst.painted && !msg.resumed;
          inst.painted = true;
          inst.state.status = "open";
          inst.state.statusDetail = undefined;
          inst.state.reconnecting = false;
          inst.retry = null;
          inst.state.sessionName = msg.sessionName;
          inst.state.readOnly = !!msg.readOnly;
          if (msg.readOnly) inst.state.paneSized = true;
          // A daemon without resume sends no stream: nothing to resume from.
          const at = typeof msg.stream === "string" && typeof msg.offset === "number" ? { stream: msg.stream, offset: msg.offset } : null;
          holdCursorForSeed(inst, at, msg.seedBytes);
          // An observer is sized by the pane, whatever this view was before
          // (it may have been demoted while away): adopt it below.
          if (msg.role === "observer") {
            inst.state.paneSized = true;
            inst.pendingResize = null;
          }
          // Kill requested while we were still connecting: now that the
          // session exists server-side, follow through instead of leaking it.
          if (inst.killRequested) {
            ws.send(JSON.stringify({ type: "kill" }));
            bump();
            return;
          }
          if (inst.state.kind === "shell" && !opts.title) {
            inst.state.title = shortTitle(msg.sessionName, inst.state.cwd);
          }
          // A reconnect the server could not resume (its history moved on, or
          // it is a different daemon): the seed that follows is the whole
          // screen, so clear the old one first, in write order (see reseed).
          if (repaint) {
            inst.term.write("", () => inst.term.reset());
            // The old stream may have ended mid-sequence: start the new
            // one with nothing carried over.
            inst.filter = new PaneStreamFilter({ syncFrames: true });
          }
          // Adopt the pane's size for the seed, which was captured at it. A
          // pane we don't own the size of stays there; an interactive attach
          // sizes the pane to the panel like any real terminal client — but
          // only from a laid-out container (fitInstance), never from a guess,
          // because the size we impose sticks to the agent's pane.
          if (msg.cols && msg.rows && (!inst.pendingResize || inst.state.paneSized)) {
            inst.adoptedSize = { cols: msg.cols, rows: msg.rows };
            inst.term.resize(msg.cols, msg.rows);
          }
          if (!inst.state.paneSized && inst.pendingResize) {
            const { cols, rows } = inst.pendingResize;
            inst.pendingResize = null;
            sendResize(inst, cols, rows);
          }
          // Last: a controller fits its container, which must win over the
          // pane size adopted above. Every ready is a new seat (even a resume:
          // the pane may have been resized or handed back meanwhile), so a
          // controller fits again even if it was one before.
          inst.state.role = undefined;
          applyRole(inst, msg);
          bump();
        } else if (msg.type === "reseed") {
          // The pane changed size under an attach view (another client, a
          // daemon refresh): reset and repaint at the new geometry — stale
          // columns are how spliced, garbled rows happen. The seed bytes
          // follow this frame on the wire.
          //
          // The reset rides the write queue. term.write() is asynchronous and
          // term.reset() is not: called directly, it lands in the MIDDLE of
          // the repaint the program sent for the old geometry, and the rest
          // of that repaint then paints over the fresh seed — leftover
          // fragments and misplaced text until the next full redraw. An
          // empty write's callback fires exactly after everything queued
          // before it and before anything queued after (the seed), so the
          // old repaint completes, gets wiped, and the seed lands clean.
          const at = inst.cursor ?? inst.afterSeed;
          holdCursorForSeed(inst, at && typeof msg.offset === "number" ? { stream: at.stream, offset: msg.offset } : at, msg.seedBytes);
          inst.filter = new PaneStreamFilter({ syncFrames: true });
          inst.term.write("", () => {
            inst.term.reset();
            if (msg.cols && msg.rows) {
              inst.adoptedSize = { cols: msg.cols, rows: msg.rows };
              inst.term.resize(msg.cols, msg.rows);
            }
          });
          bump();
        } else if (msg.type === "role") {
          applyRole(inst, msg);
          bump();
        } else if (msg.type === "replay_complete" || msg.type === "offset") {
          // "offset": a repaint other views got that this one does not need.
          if (inst.cursor && typeof msg.offset === "number") inst.cursor.offset = msg.offset;
        } else if (msg.type === "exit") {
          ended = true;
          inst.state.status = "exited";
          inst.state.statusDetail = msg.reason;
          // Restarting it is a new terminal: nothing to resume, and the
          // server starts a shell again only for a view without a cursor.
          inst.cursor = null;
          inst.afterSeed = null;
          inst.term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
          bump();
        } else if (msg.type === "error") {
          ended = true;
          inst.state.status = "error";
          inst.state.statusDetail = msg.message;
          inst.state.reconnecting = false;
          inst.retry = null;
          bump();
        }
      } catch {}
      return;
    }
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    if (inst.seedLeft > 0) {
      inst.seedLeft = 0;
      inst.cursor = inst.afterSeed;
      inst.afterSeed = null;
    } else if (inst.cursor) inst.cursor.offset += bytes.byteLength;
    inst.term.write(inst.filter.process(bytes));
  };

  ws.onclose = () => {
    // A socket this view already replaced (a reconnect beat its close).
    if (ws !== inst.ws) return;
    inst.ws = null;
    inst.state.takeoverPending = false;
    if (inst.disposed) return;
    if (inst.killRequested) {
      // Deferred kill completed (or died trying): the user asked for this tab
      // to be gone — remove it rather than leaving an "exited" husk.
      closeTab(inst.state.id);
      return;
    }
    if (!ended && inst.painted && (inst.state.status === "open" || inst.state.reconnecting)) {
      // Dropped, not ended: keep the screen and get the socket back.
      scheduleReconnect(inst);
      return;
    }
    if (inst.state.status === "connecting") {
      // No reply ever came — this isn't a fault, there's just no connection.
      // A server-sent fault (msg.type "error") already moved status off
      // "connecting", so it can't land here.
      inst.state.status = "offline";
      inst.state.statusDetail ??= "no connection";
    }
    bump();
  };
  ws.onerror = () => {
    // onclose follows and handles state.
  };
}

/** Take the cursor a ready/reseed names, but only once its seed (if any)
 *  has been drawn. */
function holdCursorForSeed(inst: TermInstance, at: { stream: string; offset: number } | null, seedBytes: unknown): void {
  inst.seedLeft = typeof seedBytes === "number" ? seedBytes : 0;
  if (inst.seedLeft > 0) {
    inst.cursor = null;
    inst.afterSeed = at;
  } else {
    inst.cursor = at;
    inst.afterSeed = null;
  }
}

function scheduleReconnect(inst: TermInstance): void {
  const now = Date.now();
  inst.retry ??= { attempt: 0, timer: null, since: now };
  if (now - inst.retry.since > RECONNECT_GIVE_UP_MS) {
    inst.retry = null;
    inst.state.reconnecting = false;
    inst.state.status = "exited";
    inst.state.statusDetail = "disconnected";
    inst.term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
    bump();
    return;
  }
  inst.state.reconnecting = true;
  const delay = RECONNECT_BACKOFF_MS[Math.min(inst.retry.attempt, RECONNECT_BACKOFF_MS.length - 1)]!;
  inst.retry.attempt++;
  if (inst.retry.timer) clearTimeout(inst.retry.timer);
  inst.retry.timer = setTimeout(() => {
    if (inst.retry) inst.retry.timer = null;
    if (!inst.disposed && !inst.ws) connectLocal(inst);
  }, delay);
  bump();
}

/**
 * Get a local tab's socket back now, keeping its view: same seat, same
 * place in the stream, so the server resumes it if it still can. `endpoint`
 * replaces the stored one (the daemon may have moved). For a remote tab, or
 * one whose session ended, the caller opens a fresh one instead.
 */
export function reconnectTab(id: string, endpoint?: TerminalEndpoint): boolean {
  const inst = instances.get(id);
  if (!inst || inst.opts.remote || inst.disposed) return false;
  if (endpoint) inst.opts = { ...inst.opts, endpoint };
  if (inst.retry?.timer) clearTimeout(inst.retry.timer);
  inst.retry = null;
  const old = inst.ws;
  inst.ws = null;
  // Not a clean close: the server keeps this view's seat for the socket
  // that replaces this one.
  try { old?.close(3000, "reconnect"); } catch {}
  // A painted view keeps its screen up while the socket comes back.
  inst.state.status = inst.painted ? "open" : "connecting";
  inst.state.reconnecting = inst.painted;
  inst.state.statusDetail = undefined;
  connectLocal(inst);
  bump();
  return true;
}

/** Ask the server to make this view the controller. */
export function takeControl(id: string): void {
  const inst = instances.get(id);
  const ws = inst ? socketOpen(inst) : null;
  if (!inst || !ws || !inst.state.canControl || inst.state.role === "controller") return;
  ws.send(JSON.stringify({ type: "takeover" }));
  inst.state.takeoverPending = true;
  bump();
}

// Coming back (network up, tab visible again) is the moment a dropped socket
// can return: skip whatever backoff is left.
function reconnectWaiting(): void {
  for (const inst of instances.values()) {
    if (inst.state.reconnecting && !inst.ws && inst.retry) {
      if (inst.retry.timer) clearTimeout(inst.retry.timer);
      inst.retry.timer = null;
      connectLocal(inst);
    }
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("online", reconnectWaiting);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectWaiting();
  });
}

/**
 * Relay transport: repaint the pane from whole screens instead of a byte
 * stream, and send keystrokes back through the same row.
 *
 * Frames only arrive when the far screen CHANGES, so "no frame for a while"
 * means either a quiet agent or a machine that went away. The daemon's
 * heartbeat is what tells those apart, and it lands as a `seq`-less update:
 * hence tracking lastFrameAt off the row's own timestamp rather than off our
 * own paint.
 *
 * Input is deliberately NOT echoed locally. A relayed pane shows exactly what
 * tmux has, so the character appears when the far end has actually accepted it
 * — slower, but it never shows a keystroke that didn't land, which is the one
 * thing a terminal must not lie about.
 */
function connectRemote(inst: TermInstance, src: RemotePaneSource): void {
  let lastSeq = -1;
  // Nothing on the relay says "that daemon can't do this". A machine that is
  // asleep, offline, or running a build that predates stream_pane all present
  // the same way: the lease is taken and no frame ever comes. Without a
  // deadline the split spins on "connecting" forever, so give silence a voice.
  const firstFrame = setTimeout(() => {
    if (inst.state.status !== "connecting") return;
    inst.state.status = "error";
    inst.state.statusDetail =
      "that machine isn't answering — its daemon may be offline, asleep, or too old to stream a pane";
    bump();
  }, REMOTE_FIRST_FRAME_TIMEOUT_MS);

  const conn = connectRemotePane(src, {
    onFrame: (f) => {
      clearTimeout(firstFrame);
      inst.state.lastFrameAt = f.streamer_seen_at ?? f.updated_at;
      if (f.seq === lastSeq || f.frame === null) {
        // Heartbeat with no new screen: still proof of life, so keep the
        // freshness stamp moving and leave the picture alone.
        bump();
        return;
      }
      lastSeq = f.seq;
      if (f.cols && f.rows && (inst.term.cols !== f.cols || inst.term.rows !== f.rows)) {
        inst.term.resize(f.cols, f.rows);
      }
      inst.term.write(
        frameToBytes(
          f.frame,
          f.cursor_x !== null && f.cursor_y !== null ? { x: f.cursor_x, y: f.cursor_y } : null,
        ),
      );
      inst.state.status = "open";
      inst.state.statusDetail = undefined;
      bump();
    },
    onError: (message) => {
      // A relay error after frames have been arriving is a hiccup, not a dead
      // view — the lease renewal restarts the far capture loop by itself. Only
      // a failure BEFORE the first frame is worth taking the view down for.
      if (inst.state.status === "open") {
        inst.state.statusDetail = message;
      } else {
        clearTimeout(firstFrame);
        inst.state.status = "error";
        inst.state.statusDetail = message;
      }
      bump();
    },
  });

  // Keystrokes out. Guarded on `open` so the characters someone types at a
  // spinner aren't queued up to land all at once when the pane finally appears.
  inst.term.onData((data) => {
    if (inst.state.status === "open" && !inst.state.readOnly) conn.write(data);
  });
  // Focus is what buys the fast poll on the far side, so report it honestly:
  // claiming it while the tab is in the background would keep a machine
  // capturing at typing speed for a pane nobody is looking at.
  const onFocus = () => conn.setInteractive(true);
  const onBlur = () => conn.setInteractive(false);
  inst.term.textarea?.addEventListener("focus", onFocus);
  inst.term.textarea?.addEventListener("blur", onBlur);
  if (document.activeElement === inst.term.textarea) conn.setInteractive(true);

  inst.remoteDispose = () => {
    clearTimeout(firstFrame);
    inst.term.textarea?.removeEventListener("focus", onFocus);
    inst.term.textarea?.removeEventListener("blur", onBlur);
    conn.close();
  };
}

function shortTitle(sessionName: string | undefined, cwd: string | undefined): string {
  if (cwd) {
    const seg = cwd.split("/").filter(Boolean).pop();
    if (seg) return seg;
  }
  return sessionName?.replace(/^cast-term-/, "") ?? "shell";
}

/** Close the tab. `killSession` also kills the backing tmux session. */
export function closeTab(id: string, opts?: { killSession?: boolean }): void {
  const inst = instances.get(id);
  if (!inst) return;
  // Between sockets (or on one that has not said ready yet) there is nobody
  // to send `kill` to in band: end the session over HTTP instead.
  if (opts?.killSession && inst.painted && (inst.state.reconnecting || !inst.ws) && inst.opts.endpoint && inst.state.sessionName && inst.state.kind === "shell") {
    void killTerminalSession(inst.opts.endpoint, inst.state.sessionName);
    opts = { ...opts, killSession: false };
  }
  if (inst.retry?.timer) clearTimeout(inst.retry.timer);
  inst.retry = null;

  if (opts?.killSession && inst.ws) {
    if (inst.ws.readyState === WebSocket.CONNECTING || inst.state.status === "connecting") {
      // Session may not exist server-side yet; defer the kill to the ready
      // handler so it can't be skipped. The tab stays until the server
      // confirms (its close event lands back here without killSession).
      inst.killRequested = true;
      bump();
      return;
    }
    if (inst.ws.readyState === WebSocket.OPEN) {
      // Send kill but let the SERVER close the socket after the tmux session
      // is actually dead — closing from this side races the daemon's control
      // client teardown against the in-flight kill-session command. The
      // detached socket force-closes on a timer in case the server never
      // answers.
      const ws = inst.ws;
      inst.ws = null;
      ws.onmessage = null;
      const deadline = setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 2500);
      ws.onclose = () => clearTimeout(deadline);
      ws.send(JSON.stringify({ type: "kill" }));
    }
  }

  inst.disposed = true;
  try {
    // A clean close: the view is gone, so its seat is free at once.
    inst.ws?.close(1000);
  } catch {}
  // Dropping the lease is what stops the far daemon capturing.
  inst.remoteDispose?.();
  inst.resizeObserver?.disconnect();
  inst.pinDispose?.dispose();
  inst.term.dispose();
  instances.delete(id);
  reg.order = reg.order.filter((x) => x !== id);
  if (reg.activeId === id) reg.activeId = reg.order[reg.order.length - 1] ?? null;
  bump();
}

const helloLog: Array<Record<string, unknown>> = [];
export function logHello(entry: Record<string, unknown>): void {
  helloLog.push({ ...entry, token: "<redacted>", at: Date.now() });
  if (helloLog.length > 20) helloLog.shift();
}
export function getHelloLog(): Array<Record<string, unknown>> {
  return helloLog.slice();
}
