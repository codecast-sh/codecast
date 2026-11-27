// Shared state of the terminal instance manager (termSessions.ts): the
// instance registry, the tab order, the version counter React subscribes to,
// and the types every terminal module shares. The one home of that state;
// termSessions.ts and termConnection.ts both read and write it here.

import type { Terminal, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalEndpoint } from "./endpoint";
import type { RemotePaneSource } from "./remotePane";
import type { PaneStreamFilter } from "./paneStreamFilter";

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

export interface TermInstance {
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

export const instances = new Map<string, TermInstance>();
/** Mutable tab state, held in one object so every module writes the same copy. */
export const reg: { order: string[]; activeId: string | null; currentTheme: ITheme } = {
  order: [],
  activeId: null,
  currentTheme: {},
};
let version = 0;
const listeners = new Set<() => void>();

export function bump(): void {
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

export function fitInstance(inst: TermInstance): void {
  if (!inst.container || inst.container.clientWidth < 20 || inst.container.clientHeight < 20) return;
  if (inst.state.paneSized) return; // fixed to pane size; CSS handles overflow
  try {
    const dims = inst.fit.proposeDimensions();
    if (!dims || dims.cols < MIN_FIT_COLS || dims.rows < MIN_FIT_ROWS) return;
    inst.fit.fit();
  } catch {}
}
