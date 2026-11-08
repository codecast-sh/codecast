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
import { killTerminalSession, termWsUrl, type TerminalEndpoint } from "./endpoint";
import { buildTerminalTheme, observeTheme } from "./theme";
import { connectRemotePane, frameToBytes, type RemotePaneSource } from "./remotePane";
import { PaneStreamFilter } from "./paneStreamFilter";
import { setLiveScreenReader } from "./liveScreen";

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
  /** The socket dropped and this view is getting it back: the screen stays
   *  up (it resumes from where it was) but nothing typed can land. */
  reconnecting?: boolean;
  /** Loopback only, from a daemon that shares a terminal between views: this
   *  view's seat. One controller types and sizes the pane; observers watch. */
  role?: "controller" | "observer";
  /** This view may take control (a shell, or an interactive attach). */
  canControl?: boolean;
  /** Someone else holds control (or is reconnecting to it). */
  controlledElsewhere?: boolean;
  /** Control was taken from this view by another one. */
  controlTaken?: boolean;
  /** Views on this terminal, this one included. */
  viewers?: number;
  /** Asked to take control; the server has not answered yet. */
  takeoverPending?: boolean;
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
  /** How this instance was opened: a reconnect asks for the same thing. */
  opts: OpenTerminalOptions;
  /** Names this view to the server across reconnects, so it reclaims its own
   *  seat and replaces its own stale socket. */
  viewId: string;
  /** Where this view stands in the server's output stream (stream id +
   *  absolute offset), presented on reconnect to resume instead of repaint. */
  cursor: { stream: string; offset: number } | null;
  /** Seed bytes still expected after a ready/reseed: they repaint, they are
   *  not stream bytes, so they don't move the cursor. */
  seedLeft: number;
  /** The cursor this view holds once its pending seed has landed. Until
   *  then it holds none: a drop mid-seed must come back to a fresh screen,
   *  not resume past a picture it never drew. */
  afterSeed: { stream: string; offset: number } | null;
  /** Has had a first screen on some socket: a later non-resumed ready
   *  repaints over it. */
  painted: boolean;
  /** Auto-reconnect after a dropped socket. */
  retry: { attempt: number; timer: ReturnType<typeof setTimeout> | null; since: number } | null;
  /** The view was closed: nothing reconnects it. */
  disposed?: boolean;
}

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

/** The live screen of an attached pane for `target` (tmux session name).
 *  Reads the bottom of the buffer, not the scrolled viewport, so a person
 *  looking through history still reports what the agent is drawing now. */
function readLiveScreenText(target: string): string | null {
  if (!target) return null;
  for (const inst of instances.values()) {
    if (inst.state.target !== target && inst.state.sessionName !== target) continue;
    try {
      const buf = inst.term.buffer.active;
      const rows = inst.term.rows || 0;
      if (rows <= 0) continue;
      const start = buf.baseY;
      const lines: string[] = [];
      for (let i = 0; i < rows; i++) lines.push(buf.getLine(start + i)?.translateToString(true) ?? "");
      const text = lines.join("\n").trim();
      if (text) return text;
    } catch {
      continue;
    }
  }
  return null;
}
setLiveScreenReader(readLiveScreenText);

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
    opts,
    viewId: newViewId(),
    cursor: null,
    seedLeft: 0,
    afterSeed: null,
    painted: false,
    retry: null,
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
  wireLocalInput(inst);
  connectLocal(inst);
}

function newViewId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
    if (ws) ws.send(JSON.stringify({ type: "colors", colors: { foreground: currentTheme.foreground, background: currentTheme.background } }));
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
      colors: { foreground: currentTheme.foreground, background: currentTheme.background },
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
// view reconnects by itself (its pending retry resumes with the page).
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const inst of instances.values()) {
      try {
        // Clean: a reload or navigation starts a new view, which must not
        // find the old one's seat held against it.
        inst.ws?.close(1000);
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
