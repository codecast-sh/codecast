// Terminal instance manager for the integrated terminal panel.
//
// Lives OUTSIDE inboxStore on purpose: a terminal is per-tab ephemeral state
// updating at byte granularity — wiring it into the shared store would repeat
// the heartbeat-churn re-render problem (CLAUDE.md). React subscribes through
// useSyncExternalStore to a small version counter; xterm paints itself.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { termWsUrl, type TerminalEndpoint } from "./endpoint";
import { buildTerminalTheme, observeTheme } from "./theme";
import { connectRemotePane, frameToBytes, type RemotePaneSource } from "./remotePane";
import { PaneStreamFilter } from "./paneStreamFilter";

// "offline" = the socket closed before it ever opened: nothing answered, so
// there's no terminal server to reach (daemon down / remote machine). Kept
// separate from "error" — which means the server replied with a fault — so
// the UI can render it as a warning instead of an error.
export type TermStatus = "connecting" | "open" | "exited" | "error" | "offline";

export interface TermTabState {
  id: string;
  kind: "shell" | "attach";
  /** tmux session backing this tab (known once ready) */
  sessionName?: string;
  /** attach target (agent session) */
  target?: string;
  title: string;
  status: TermStatus;
  statusDetail?: string;
  /** No input path at all — a watcher, not a participant. */
  readOnly: boolean;
  /** The far pane dictates geometry, so the xterm is sized to it and never
   *  resizes it back. Distinct from `readOnly`: a relayed pane accepts typing
   *  but must not be reshaped, because its real size belongs to whatever is
   *  attached on the other machine. */
  paneSized: boolean;
  /** Relayed from another machine (screens, not a PTY): typing works but goes
   *  at relay speed, and it can go stale without the connection ever
   *  "closing". */
  remote?: boolean;
  /** remote only: when the last screen arrived, so the UI can say "paused"
   *  instead of pretending a frozen picture is live. */
  lastFrameAt?: number;
  cwd?: string;
}

interface TermInstance {
  state: TermTabState;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  container: HTMLElement | null;
  resizeObserver: ResizeObserver | null;
  /** queued while the socket is still connecting */
  pendingResize: { cols: number; rows: number } | null;
  /** geometry adopted FROM the server (ready/reseed) — see onResize below */
  adoptedSize: { cols: number; rows: number } | null;
  /** kill asked for before the session was ready; honored on ready */
  killRequested?: boolean;
  /** lives outside the bottom panel (per-conversation split) */
  detached?: boolean;
  /** container scroll pinning teardown (see attachToContainer) */
  pinDispose?: { dispose(): void };
  /** rewrites the raw pane bytes before xterm parses them (paneStreamFilter) */
  filter: PaneStreamFilter;
  /** remote transport teardown: drops the lease that keeps the far daemon
   *  capturing (see remotePane.ts) */
  remoteDispose?: () => void;
}

// How long a relayed pane may show nothing before we call it unreachable.
// Generous: it has to cover the daemon poll picking the command up, one
// capture, and the push landing — several seconds on a healthy machine.
const REMOTE_FIRST_FRAME_TIMEOUT_MS = 20_000;

const instances = new Map<string, TermInstance>();
let order: string[] = [];
let activeId: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

let currentTheme: ITheme = {};
let nextId = 1;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeTerminals(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTerminalsVersion(): number {
  return version;
}

export function listTabs(): TermTabState[] {
  return order.flatMap((id) => {
    const inst = instances.get(id);
    return inst ? [inst.state] : [];
  });
}

export function getActiveTabId(): string | null {
  return activeId;
}

export function setActiveTab(id: string | null): void {
  activeId = id && instances.has(id) ? id : null;
  bump();
  if (activeId) {
    const inst = instances.get(activeId);
    // Focus + refit after the tab becomes visible.
    requestAnimationFrame(() => {
      if (inst?.container) {
        fitInstance(inst);
        inst.term.focus();
      }
    });
  }
}

export function getInstance(id: string): { term: Terminal; state: TermTabState } | null {
  const inst = instances.get(id);
  return inst ? { term: inst.term, state: inst.state } : null;
}

export function applyTerminalTheme(theme: ITheme, fontFamily?: string): void {
  currentTheme = theme;
  for (const inst of instances.values()) {
    inst.term.options.theme = theme;
    if (inst.ws?.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: "colors", colors: { foreground: theme.foreground, background: theme.background } }));
    }
    if (fontFamily) inst.term.options.fontFamily = fontFamily;
  }
}

// No WebGL addon, deliberately: a background tab that gets its GPU context
// evicted (observed: frozen renderer during a Vite reload storm) comes back
// with xterm silently painting nothing. The DOM renderer has no such failure
// mode and is easily fast enough at bottom-panel size.

export interface OpenTerminalOptions {
  /** Loopback transport: the daemon on THIS machine. Omitted for `remote`. */
  endpoint?: TerminalEndpoint;
  /**
   * Relay transport: the pane lives on another of the user's machines, so
   * there is no socket to open and the view is repainted from relayed screens
   * (remotePane.ts). Always read-only.
   */
  remote?: RemotePaneSource;
  kind: "shell" | "attach";
  /** shell: reattach a specific cast-term session */
  name?: string;
  cwd?: string;
  /** attach: tmux session name of an agent session */
  target?: string;
  interactive?: boolean;
  title?: string;
  /**
   * Detached instances live outside the bottom panel: no tab, no activeId —
   * the caller owns mounting (attachToContainer) and closing (closeTab).
   * Used by the per-conversation attach split. Same registry, so all the
   * lifecycle machinery (theme, kill, dispose) applies unchanged.
   */
  detached?: boolean;
}

// Theme self-initializes with the first terminal, HERE and not in a panel
// component: a conversation split can be the first terminal on the page, and
// theming-by-whoever-mounted-first left it on xterm's default black whenever
// the bottom panel hadn't been opened yet.
let themeInitialized = false;
function ensureTheme(): void {
  if (themeInitialized || typeof document === "undefined") return;
  themeInitialized = true;
  const apply = () => applyTerminalTheme(buildTerminalTheme());
  apply();
  observeTheme(apply);
}

export function openTerminal(opts: OpenTerminalOptions): string {
  ensureTheme();
  const live = (inst: TermInstance) =>
    inst.state.status !== "exited" && inst.state.status !== "error" && inst.state.status !== "offline";
  // Dedupe within the same surface only: a panel tab never adopts a detached
  // split's instance (they'd fight over the one DOM element) and vice versa.
  if (opts.name) {
    for (const [id, inst] of instances) {
      if (inst.detached === !!opts.detached && inst.state.sessionName === opts.name && live(inst)) {
        if (!opts.detached) setActiveTab(id);
        return id;
      }
    }
  }
  if (opts.kind === "attach" && opts.target) {
    for (const [id, inst] of instances) {
      if (inst.detached === !!opts.detached && inst.state.target === opts.target && live(inst)) {
        if (!opts.detached) setActiveTab(id);
        return id;
      }
    }
  }

  const id = `t${nextId++}`;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
    fontSize: 12,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    scrollback: 20000,
    macOptionIsMeta: true,
    minimumContrastRatio: 7,
    theme: currentTheme,
  });
  // The panel toggle is the ONE chord the app keeps while the terminal is
  // focused. The app's capture-phase listener actually intercepts it before
  // xterm runs (see ShortcutProvider's inTerminal guard); this handler is the
  // backstop for when that shortcut isn't registered — without it xterm would
  // feed the chord to the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") return false;
    return true;
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    // Plain click opens; keeps text selection unaffected.
    if (!event.defaultPrevented) window.open(uri, "_blank", "noopener");
  }));
  // Unicode 11 width tables: without these, the glyphs agent TUIs lean on
  // (spinners, emoji, ambiguous-width ornaments) measure one cell narrower
  // than in VS Code's terminal and every divider drifts.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  const inst: TermInstance = {
    state: {
      id,
      kind: opts.kind,
      target: opts.target,
      sessionName: opts.name,
      title: opts.title ?? (opts.kind === "attach" ? (opts.target ?? "attach") : "shell"),
      status: "connecting",
      readOnly: opts.kind === "attach" && !opts.interactive && !opts.remote,
      // A relayed pane's size belongs to the machine it lives on: we are
      // reading a screen tmux already laid out, and resizing it from here would
      // reflow it under whoever is attached there.
      paneSized: !!opts.remote || (opts.kind === "attach" && !opts.interactive),
      remote: !!opts.remote,
      cwd: opts.cwd,
    },
    term,
    fit,
    ws: null,
    container: null,
    resizeObserver: null,
    pendingResize: null,
    adoptedSize: null,
    filter: new PaneStreamFilter({ syncFrames: true }),
  };
  inst.detached = !!opts.detached;
  instances.set(id, inst);
  if (!opts.detached) {
    order.push(id);
    activeId = id;
  }
  connect(inst, opts);
  bump();
  return id;
}

function connect(inst: TermInstance, opts: OpenTerminalOptions): void {
  if (opts.remote) {
    connectRemote(inst, opts.remote);
    return;
  }
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
  const encoder = new TextEncoder();

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
      colors: { foreground: currentTheme.foreground, background: currentTheme.background },
    };
    logHello({ tabId: inst.state.id, ...hello });
    ws.send(JSON.stringify(hello));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ready") {
          inst.state.status = "open";
          inst.state.sessionName = msg.sessionName;
          inst.state.readOnly = !!msg.readOnly;
          if (msg.readOnly) inst.state.paneSized = true;
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
          // Adopt the pane's size for the seed, which was captured at it. A
          // pane we don't own the size of stays there; an interactive attach
          // sizes the pane to the panel like any real terminal client — but
          // only from a laid-out container (fitInstance), never from a guess,
          // because the size we impose sticks to the agent's pane.
          if (msg.cols && msg.rows && !inst.pendingResize) {
            inst.adoptedSize = { cols: msg.cols, rows: msg.rows };
            inst.term.resize(msg.cols, msg.rows);
          }
          if (!inst.state.paneSized && inst.pendingResize) {
            const { cols, rows } = inst.pendingResize;
            inst.pendingResize = null;
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
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
          inst.term.write("", () => {
            inst.term.reset();
            if (msg.cols && msg.rows) {
              inst.adoptedSize = { cols: msg.cols, rows: msg.rows };
              inst.term.resize(msg.cols, msg.rows);
            }
          });
          bump();
        } else if (msg.type === "exit") {
          inst.state.status = "exited";
          inst.state.statusDetail = msg.reason;
          inst.term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
          bump();
        } else if (msg.type === "error") {
          inst.state.status = "error";
          inst.state.statusDetail = msg.message;
          bump();
        }
      } catch {}
      return;
    }
    inst.term.write(inst.filter.process(new Uint8Array(ev.data as ArrayBuffer)));
  };

  ws.onclose = () => {
    if (inst.killRequested) {
      // Deferred kill completed (or died trying): the user asked for this tab
      // to be gone — remove it rather than leaving an "exited" husk.
      inst.ws = null;
      closeTab(inst.state.id);
      return;
    }
    if (inst.state.status === "connecting") {
      // No reply ever came — this isn't a fault, there's just no connection.
      // A server-sent fault (msg.type "error") already moved status off
      // "connecting", so it can't land here.
      inst.state.status = "offline";
      inst.state.statusDetail ??= "no connection";
    } else if (inst.state.status === "open") {
      inst.state.status = "exited";
      inst.state.statusDetail ??= "disconnected";
      inst.term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
    }
    inst.ws = null;
    bump();
  };
  ws.onerror = () => {
    // onclose follows and handles state.
  };

  inst.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN && inst.state.status === "open" && !inst.state.readOnly) {
      ws.send(encoder.encode(data));
    }
  });
  inst.term.onBinary((data) => {
    if (ws.readyState === WebSocket.OPEN && inst.state.status === "open" && !inst.state.readOnly) {
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
    if (inst.adoptedSize && inst.adoptedSize.cols === cols && inst.adoptedSize.rows === rows) return;
    if (ws.readyState === WebSocket.OPEN && inst.state.status === "open") {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } else {
      inst.pendingResize = { cols, rows };
    }
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

// The smallest geometry an interactive attach may impose on an agent's real
// pane. Claude Code's renderer needs roughly a composer, a footer and a few
// content rows; below that it drops and splices lines, and because the pane
// IS the agent's screen that damage lands in its scrollback for good (a pane
// squeezed to 165x6 lost a line of every reply, 2026-08-21). A split that
// can't fit this keeps the pane at its current size and scrolls it — the
// attach view is built for a pane taller than its container — rather than
// reshaping the agent to a size nothing can render in. The daemon enforces
// the same floor server-side for older clients (terminalServer.ts).
const MIN_FIT_COLS = 80;
const MIN_FIT_ROWS = 12;

function fitInstance(inst: TermInstance): void {
  if (!inst.container || inst.container.clientWidth < 20 || inst.container.clientHeight < 20) return;
  if (inst.state.paneSized) return; // fixed to pane size; CSS handles overflow
  try {
    const dims = inst.fit.proposeDimensions();
    if (!dims || dims.cols < MIN_FIT_COLS || dims.rows < MIN_FIT_ROWS) return;
    inst.fit.fit();
  } catch {}
}

/** Mount a terminal into its tab's DOM container (idempotent). */
export function attachToContainer(id: string, el: HTMLElement): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.container === el) return;
  inst.container = el;
  if (!inst.term.element) {
    inst.term.open(el);
  } else if (inst.term.element.parentElement !== el) {
    el.appendChild(inst.term.element);
  }
  let pinned = true;

  // ONE scroll surface for attach views. Two scrollable layers exist (the
  // container sliding over the fixed-size pane, and xterm's buffer history)
  // and raw wheel events pick one arbitrarily. Instead: while the app in the
  // pane captures the mouse (CC actively tracking), the wheel is the app's —
  // the universal terminal rule. Otherwise scroll continuously: up moves
  // through the visible screen, then on into history; down reverses back to
  // the live bottom.
  const onWheel = (e: WheelEvent) => {
    if (inst.state.kind !== "attach") return; // fitted shells: xterm default
    if ((inst.term.modes as { mouseTrackingMode?: string }).mouseTrackingMode !== "none") return;
    e.preventDefault();
    e.stopPropagation();
    const buf = inst.term.buffer.active;
    const scrolledIntoHistory = buf.viewportY < buf.baseY;
    if (e.deltaY < 0) {
      if (el.scrollTop > 0) {
        el.scrollTop = Math.max(0, el.scrollTop + e.deltaY);
      } else {
        inst.term.scrollLines(Math.min(-1, Math.round(e.deltaY / 16)));
      }
    } else if (e.deltaY > 0) {
      if (scrolledIntoHistory) {
        inst.term.scrollLines(Math.max(1, Math.round(e.deltaY / 16)));
      } else {
        el.scrollTop = el.scrollTop + e.deltaY;
      }
    }
  };
  el.addEventListener("wheel", onWheel, { passive: false, capture: true });

  inst.resizeObserver?.disconnect();
  let raf = 0;
  inst.resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      fitInstance(inst);
      // Re-pin on container RESIZE too: shrinking the split grows the
      // scrollable overflow with no accompanying write, which used to leave
      // scrollTop where it was — showing the pane's middle instead of its
      // bottom until the next output arrived.
      if (pinned) el.scrollTop = el.scrollHeight;
    });
  });
  inst.resizeObserver.observe(el);
  fitInstance(inst);

  // Attach views are fixed to the agent pane's size, which is usually taller
  // than the container — so the container scrolls, and the action lives at
  // the pane's BOTTOM. Keep the container pinned there while new output
  // arrives, unless the user has deliberately scrolled up (then leave them
  // be; scrolling back near the bottom re-engages the pin). No-op for fitted
  // shells, whose xterm exactly fills the container.
  inst.pinDispose?.dispose();
  const onScroll = () => {
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  const writeDisposable = inst.term.onWriteParsed(() => {
    if (pinned) el.scrollTop = el.scrollHeight;
  });
  inst.pinDispose = {
    dispose() {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      writeDisposable.dispose();
    },
  };
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

/** Close the tab. `killSession` also kills the backing tmux session. */
export function closeTab(id: string, opts?: { killSession?: boolean }): void {
  const inst = instances.get(id);
  if (!inst) return;

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

  try {
    inst.ws?.close();
  } catch {}
  // Dropping the lease is what stops the far daemon capturing.
  inst.remoteDispose?.();
  inst.resizeObserver?.disconnect();
  inst.pinDispose?.dispose();
  inst.term.dispose();
  instances.delete(id);
  order = order.filter((x) => x !== id);
  if (activeId === id) activeId = order[order.length - 1] ?? null;
  bump();
}

export function closeAll(): void {
  for (const id of [...order]) closeTab(id);
}

/** Re-key helpers for the panel: is any tab open for this tmux session? */
export function findTabBySession(sessionName: string): string | null {
  for (const [id, inst] of instances) {
    if (inst.state.sessionName === sessionName) return id;
  }
  return null;
}

// Dev console access, mirroring window.__inboxStore: inspect tab states and
// the hello each socket sent when debugging connect issues.
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as any).__termDebug = {
    tabs: () => listTabs().map((t) => ({ ...t })),
    active: () => activeId,
    hellos: () => helloLog.slice(),
    // Full scrollback text of any instance (panel tab or detached split) —
    // the only reliable way to inspect buffers from the console: a dynamic
    // import of this module mints a second, empty registry.
    buffer: (id: string) => {
      const inst = instances.get(id);
      if (!inst) return null;
      const buf = inst.term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n");
    },
  };
}
// Release every live connection when the page goes away. Without this, a
// real navigation parks the document in the back/forward cache WITH its
// sockets open (observed via lsof): the daemon never sees a close, so an
// interactive attach keeps its size imposed on the agent's real window
// until Chrome evicts the cached page. Closing here lets the server detach
// and restore the pane immediately; if the page returns from the cache, the
// tab shows its normal disconnected state with a Reconnect button.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const inst of instances.values()) {
      try {
        inst.ws?.close();
      } catch {}
      inst.remoteDispose?.();
    }
  });
}

const helloLog: Array<Record<string, unknown>> = [];
export function logHello(entry: Record<string, unknown>): void {
  helloLog.push({ ...entry, token: "<redacted>", at: Date.now() });
  if (helloLog.length > 20) helloLog.shift();
}

// Dev console access, like `__inboxStore`: `__terms()` lists live instances
// (id, state, xterm) so a pane can be diffed against `tmux capture-pane`
// when hunting rendering divergence.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).__terms = () => [...instances.values()].map((i) => ({ id: i.state.id, state: i.state, term: i.term }));
}
