// Terminal instance manager for the integrated terminal panel.
//
// Lives OUTSIDE inboxStore on purpose: a terminal is per-tab ephemeral state
// updating at byte granularity — wiring it into the shared store would repeat
// the heartbeat-churn re-render problem (CLAUDE.md). React subscribes through
// useSyncExternalStore to a small version counter; xterm paints itself.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { termWsUrl, type TerminalEndpoint } from "./endpoint";

export type TermStatus = "connecting" | "open" | "exited" | "error";

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
  readOnly: boolean;
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
}

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
  return order.map((id) => instances.get(id)!.state).filter(Boolean);
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
    if (fontFamily) inst.term.options.fontFamily = fontFamily;
  }
}

async function loadWebgl(term: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose()); // fall back to DOM renderer
    term.loadAddon(addon);
  } catch {
    // DOM renderer is fine — WebGL is a fast path, not a requirement.
  }
}

export interface OpenTerminalOptions {
  endpoint: TerminalEndpoint;
  kind: "shell" | "attach";
  /** shell: reattach a specific cast-term session */
  name?: string;
  cwd?: string;
  /** attach: tmux session name of an agent session */
  target?: string;
  interactive?: boolean;
  title?: string;
}

export function openTerminal(opts: OpenTerminalOptions): string {
  // Reattaching a session that's already open in a tab: just activate it.
  if (opts.name) {
    for (const [id, inst] of instances) {
      if (inst.state.sessionName === opts.name && inst.state.status !== "exited" && inst.state.status !== "error") {
        setActiveTab(id);
        return id;
      }
    }
  }
  if (opts.kind === "attach" && opts.target) {
    for (const [id, inst] of instances) {
      if (inst.state.target === opts.target && inst.state.status !== "exited" && inst.state.status !== "error") {
        setActiveTab(id);
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
    cursorStyle: "bar",
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: currentTheme,
  });
  // App-level shortcuts that must win over the terminal: the panel toggle.
  // Returning false tells xterm not to consume it, so the global shortcut
  // listener sees the event.
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
  void loadWebgl(term);

  const inst: TermInstance = {
    state: {
      id,
      kind: opts.kind,
      target: opts.target,
      sessionName: opts.name,
      title: opts.title ?? (opts.kind === "attach" ? (opts.target ?? "attach") : "shell"),
      status: "connecting",
      readOnly: opts.kind === "attach" && !opts.interactive,
      cwd: opts.cwd,
    },
    term,
    fit,
    ws: null,
    container: null,
    resizeObserver: null,
    pendingResize: null,
  };
  instances.set(id, inst);
  order.push(id);
  activeId = id;
  connect(inst, opts);
  bump();
  return id;
}

function connect(inst: TermInstance, opts: OpenTerminalOptions): void {
  const ws = new WebSocket(termWsUrl(opts.endpoint));
  ws.binaryType = "arraybuffer";
  inst.ws = ws;
  const encoder = new TextEncoder();

  ws.onopen = () => {
    const hello = {
      type: "hello",
      token: opts.endpoint.token,
      mode: opts.kind === "attach" ? "attach" : "create",
      name: opts.kind === "shell" ? inst.state.sessionName : undefined,
      cwd: opts.cwd,
      target: opts.target,
      interactive: opts.interactive,
      cols: inst.term.cols,
      rows: inst.term.rows,
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
          if (inst.state.kind === "shell" && !opts.title) {
            inst.state.title = shortTitle(msg.sessionName, inst.state.cwd);
          }
          // Attach mode: adopt the pane's size (we must not resize it).
          if (inst.state.kind === "attach" && msg.cols && msg.rows) {
            inst.term.resize(msg.cols, msg.rows);
          } else if (inst.pendingResize) {
            const { cols, rows } = inst.pendingResize;
            inst.pendingResize = null;
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
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
    inst.term.write(new Uint8Array(ev.data as ArrayBuffer));
  };

  ws.onclose = () => {
    if (inst.state.status === "connecting") {
      inst.state.status = "error";
      inst.state.statusDetail ??= "connection failed";
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
    if (inst.state.kind === "attach") return; // viewer never resizes the pane
    if (ws.readyState === WebSocket.OPEN && inst.state.status === "open") {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } else {
      inst.pendingResize = { cols, rows };
    }
  });
}

function shortTitle(sessionName: string | undefined, cwd: string | undefined): string {
  if (cwd) {
    const seg = cwd.split("/").filter(Boolean).pop();
    if (seg) return seg;
  }
  return sessionName?.replace(/^cast-term-/, "") ?? "shell";
}

function fitInstance(inst: TermInstance): void {
  if (!inst.container || inst.container.clientWidth < 20 || inst.container.clientHeight < 20) return;
  if (inst.state.kind === "attach") return; // fixed to pane size; CSS handles overflow
  try {
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
  inst.resizeObserver?.disconnect();
  let raf = 0;
  inst.resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => fitInstance(inst));
  });
  inst.resizeObserver.observe(el);
  fitInstance(inst);
}

/** Close the tab. `killSession` also kills the backing tmux session. */
export function closeTab(id: string, opts?: { killSession?: boolean }): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (opts?.killSession && inst.ws?.readyState === WebSocket.OPEN) {
    inst.ws.send(JSON.stringify({ type: "kill" }));
  }
  try {
    inst.ws?.close();
  } catch {}
  inst.resizeObserver?.disconnect();
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
  };
}
const helloLog: Array<Record<string, unknown>> = [];
export function logHello(entry: Record<string, unknown>): void {
  helloLog.push({ ...entry, token: "<redacted>", at: Date.now() });
  if (helloLog.length > 20) helloLog.shift();
}
