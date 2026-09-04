// An interactive attach must never echo a size it ADOPTED from the server
// (the ready and reseed frames) back as a client resize. On a single-pane
// window the echo is a harmless fixed point (pane == window), but Claude
// Code's teammate panes make the pane smaller than its window: the echo then
// shrinks the window to the pane, tmux re-tiles every pane into the smaller
// window, and the next reseed reports a narrower pane still — the split
// collapses the agent's real window (220 → 109 → 54 → 27 → … with real tmux).

import { expect, mock, test } from "bun:test";

// Headless stand-in: the real xterm Terminal needs a DOM. Implements only
// what termSessions touches; resize fires onResize synchronously, exactly
// like the real thing — that synchronous event IS the echo under test.
class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
  unicode = { activeVersion: "" };
  private resizeCbs: Array<(s: { cols: number; rows: number }) => void> = [];
  onResize(cb: (s: { cols: number; rows: number }) => void) {
    this.resizeCbs.push(cb);
    return { dispose() {} };
  }
  onData() {
    return { dispose() {} };
  }
  onBinary() {
    return { dispose() {} };
  }
  onWriteParsed() {
    return { dispose() {} };
  }
  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    for (const cb of this.resizeCbs) cb({ cols, rows });
  }
  write(_data: unknown, cb?: () => void) {
    cb?.();
  }
  reset() {}
  element: { parentElement: unknown } | undefined;
  open(el: unknown) {
    this.element = { parentElement: el };
  }
  loadAddon(addon: { activate?: (t: FakeTerminal) => void }) {
    addon.activate?.(this);
  }
  attachCustomKeyEventHandler() {}
  focus() {}
  dispose() {}
}

// Just enough container for attachToContainer: a laid-out box that can be
// observed, scrolled and listened to.
class FakeContainer {
  clientWidth = 1200;
  clientHeight = 100;
  scrollTop = 0;
  scrollHeight = 0;
  addEventListener() {}
  removeEventListener() {}
  appendChild() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: () => void) => {
  cb();
  return 0;
};
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
// The fit proposal is driven per test: `proposeDims` is what the container
// "measures", and fit() applies it like the real addon (resize → onResize).
let proposeDims: { cols: number; rows: number } | undefined;
mock.module("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: FakeTerminal | null = null;
    activate(t: FakeTerminal) {
      this.term = t;
    }
    proposeDimensions() {
      return proposeDims;
    }
    fit() {
      if (proposeDims && this.term) this.term.resize(proposeDims.cols, proposeDims.rows);
    }
  },
}));
mock.module("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
mock.module("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  serverSays(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  resizes() {
    return this.sent.filter((m) => m?.type === "resize");
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

const endpoint = { port: 1, token: "t", deviceId: "d", tmux: true };

test("terminal colors reach tmux at startup and on theme changes", async () => {
  const { applyTerminalTheme, openTerminal, getInstance, closeTab } = await import("../terminal/termSessions");
  const light = { foreground: "#073642", background: "#fdf6e3" };
  applyTerminalTheme(light);
  const id = openTerminal({ endpoint, kind: "shell", detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  expect(ws.sent[0]?.colors).toEqual(light);
  expect(getInstance(id)!.term.options.minimumContrastRatio).toBe(7);
  ws.serverSays({ type: "ready", sessionName: "cast-term-colors", cols: 80, rows: 24 });
  const dark = { foreground: "#ececec", background: "#212121" };
  applyTerminalTheme(dark);
  expect(ws.sent.at(-1)).toEqual({ type: "colors", colors: dark });
  expect(getInstance(id)!.term.options.theme).toEqual(dark);
  closeTab(id);
});

test("adopted ready/reseed sizes are not echoed back; genuine resizes still are", async () => {
  const { openTerminal, getInstance } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "attach", target: "cc-x", interactive: true, detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();

  // ready: the client adopts the pane's size (109x49 lead of a split window).
  ws.serverSays({ type: "ready", sessionName: "cc-x", readOnly: false, cols: 109, rows: 49 });
  expect(getInstance(id)!.term.cols).toBe(109);
  expect(ws.resizes()).toHaveLength(0);

  // reseed after tmux re-tiled: adopt again, still no echo.
  ws.serverSays({ type: "reseed", cols: 54, rows: 12 });
  expect(getInstance(id)!.term.cols).toBe(54);
  expect(ws.resizes()).toHaveLength(0);

  // A genuine fit (container-driven) must still reach the server.
  (getInstance(id)!.term as unknown as FakeTerminal).resize(200, 45);
  expect(ws.resizes()).toEqual([{ type: "resize", cols: 200, rows: 45 }]);
});

// Claude Code can't render below ~80x12, and an interactive attach's fit IS
// the agent's screen size — a split too short to fit that must leave the
// pane alone (and scroll it), never squeeze the agent into it.
test("a fit below the agent floor is not applied or sent; a fit above it is", async () => {
  const { openTerminal, getInstance, attachToContainer } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "attach", target: "cc-y", interactive: true, detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.serverSays({ type: "ready", sessionName: "cc-y", readOnly: false, cols: 220, rows: 50 });

  proposeDims = { cols: 165, rows: 6 };
  attachToContainer(id, new FakeContainer() as unknown as HTMLElement);
  expect(getInstance(id)!.term.rows).toBe(50);
  expect(ws.resizes()).toHaveLength(0);

  proposeDims = { cols: 165, rows: 16 };
  attachToContainer(id, new FakeContainer() as unknown as HTMLElement);
  expect(getInstance(id)!.term.rows).toBe(16);
  expect(ws.resizes()).toEqual([{ type: "resize", cols: 165, rows: 16 }]);
});
