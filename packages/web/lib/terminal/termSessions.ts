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
import { buildTerminalTheme, observeTheme } from "./theme";
import { PaneStreamFilter } from "./paneStreamFilter";
import { setLiveScreenReader } from "./liveScreen";
import { bump, fitInstance, instances, reg, type OpenTerminalOptions, type TermInstance, type TermTabState } from "./termRegistry";
import { closeTab, connect, getHelloLog } from "./termConnection";

export type { OpenTerminalOptions, TermStatus, TermTabState } from "./termRegistry";
export { subscribeTerminals, getTerminalsVersion } from "./termRegistry";
export { closeTab, logHello, reconnectTab, takeControl } from "./termConnection";

let nextId = 1;

export function listTabs(): TermTabState[] {
  return reg.order.flatMap((id) => {
    const inst = instances.get(id);
    return inst ? [inst.state] : [];
  });
}

export function getActiveTabId(): string | null {
  return reg.activeId;
}

export function setActiveTab(id: string | null): void {
  reg.activeId = id && instances.has(id) ? id : null;
  bump();
  if (reg.activeId) {
    const inst = instances.get(reg.activeId);
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
  reg.currentTheme = theme;
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
    theme: reg.currentTheme,
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
    reg.order.push(id);
    reg.activeId = id;
  }
  connect(inst, opts);
  bump();
  return id;
}

function newViewId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
    active: () => reg.activeId,
    hellos: () => getHelloLog(),
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


// Dev console access, like `__inboxStore`: `__terms()` lists live instances
// (id, state, xterm) so a pane can be diffed against `tmux capture-pane`
// when hunting rendering divergence.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).__terms = () => [...instances.values()].map((i) => ({ id: i.state.id, state: i.state, term: i.term }));
}