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
  dataCbs: Array<(d: string) => void> = [];
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
    return { dispose() {} };
  }
  typeKeys(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  resets = 0;
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
  reset() {
    this.resets++;
  }
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
  static count = 0;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  sent: Array<Record<string, unknown>> = [];
  binary: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.last = this;
    FakeWebSocket.count++;
  }
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.sent.push(JSON.parse(data));
    else this.binary.push(data);
  }
  close() {}
  serverBytes(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer as ArrayBuffer });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
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
  // The first test pays for loading the module graph, which takes seconds
  // on a loaded machine.
}, 30_000);

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

test("a dropped socket reconnects with its view id and offset, and resumes without a repaint", async () => {
  const { openTerminal, getInstance, closeTab } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "shell", name: "cast-term-r", detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  const viewId = ws.sent[0]!.viewId;
  expect(typeof viewId).toBe("string");
  expect(ws.sent[0]!.resume).toBeUndefined();

  // Seed bytes repaint; they are not stream bytes and don't move the offset.
  ws.serverSays({ type: "ready", sessionName: "cast-term-r", cols: 80, rows: 24, stream: "abc123", offset: 100, seedBytes: 5, role: "controller", canControl: true });
  ws.serverBytes("SEED!");
  ws.serverBytes("abc");
  ws.serverSays({ type: "replay_complete", offset: 100 });
  ws.serverBytes("de");
  // A reseed takes the offset it names; its seed follows uncounted.
  ws.serverSays({ type: "reseed", cols: 90, rows: 20, offset: 110, seedBytes: 2 });
  ws.serverBytes("ZZ");
  ws.serverBytes("1234");
  const term = getInstance(id)!.term as unknown as FakeTerminal;
  const resetsBefore = term.resets;

  ws.drop();
  expect(getInstance(id)!.state.reconnecting).toBe(true);
  // Typing while the socket is gone goes nowhere.
  term.typeKeys("x");
  expect(ws.binary).toHaveLength(0);
  await Bun.sleep(400);
  const back = FakeWebSocket.last!;
  expect(back).not.toBe(ws);
  back.open();
  expect(back.sent[0]!.viewId).toBe(viewId);
  expect(back.sent[0]!.resume).toEqual({ stream: "abc123", offset: 114 });

  back.serverSays({ type: "ready", sessionName: "cast-term-r", cols: 90, rows: 20, stream: "abc123", offset: 114, seedBytes: 0, resumed: true, role: "controller", canControl: true });
  expect(getInstance(id)!.state.reconnecting).toBe(false);
  expect(getInstance(id)!.state.status).toBe("open");
  expect(term.resets).toBe(resetsBefore);
  term.typeKeys("y");
  expect(back.binary).toHaveLength(1);

  // The daemon could not resume (history moved on): the screen is cleared
  // before the fresh seed lands.
  back.drop();
  await Bun.sleep(400);
  const third = FakeWebSocket.last!;
  third.open();
  third.serverSays({ type: "ready", sessionName: "cast-term-r", cols: 90, rows: 20, stream: "abc123", offset: 900, seedBytes: 3, truncated: true, role: "controller", canControl: true });
  expect(term.resets).toBe(resetsBefore + 1);
  closeTab(id);
});

test("an ended session does not reconnect", async () => {
  const { openTerminal, getInstance, closeTab } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "shell", name: "cast-term-e", detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.serverSays({ type: "ready", sessionName: "cast-term-e", cols: 80, rows: 24, stream: "s", offset: 0, seedBytes: 0 });
  ws.serverSays({ type: "exit", reason: "killed" });
  const before = FakeWebSocket.count;
  ws.drop();
  await Bun.sleep(400);
  expect(FakeWebSocket.count).toBe(before);
  expect(getInstance(id)!.state.status).toBe("exited");
  closeTab(id);
});

test("an observer types nothing until it takes control", async () => {
  const { openTerminal, getInstance, takeControl, closeTab } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "shell", name: "cast-term-o", detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.serverSays({ type: "ready", sessionName: "cast-term-o", cols: 100, rows: 30, readOnly: true, stream: "s", offset: 0, seedBytes: 0, role: "observer", canControl: true, controlledElsewhere: true, viewers: 2 });
  const state = () => getInstance(id)!.state;
  const term = getInstance(id)!.term as unknown as FakeTerminal;
  expect(state().role).toBe("observer");
  expect(state().paneSized).toBe(true);
  term.typeKeys("a");
  expect(ws.binary).toHaveLength(0);

  takeControl(id);
  expect(ws.sent.at(-1)).toEqual({ type: "takeover" });
  ws.serverSays({ type: "role", role: "controller", canControl: true, controlledElsewhere: false, viewers: 2 });
  expect(state().readOnly).toBe(false);
  expect(state().paneSized).toBe(false);
  term.typeKeys("b");
  expect(ws.binary).toHaveLength(1);

  // Taken back by the other view: watching again, and told why.
  ws.serverSays({ type: "role", role: "observer", canControl: true, controlledElsewhere: true, viewers: 2, reason: "taken" });
  expect(state().controlTaken).toBe(true);
  term.typeKeys("c");
  expect(ws.binary).toHaveLength(1);
  closeTab(id);
});

test("a watch-only attach cannot ask for control", async () => {
  const { openTerminal, takeControl, closeTab } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "attach", target: "cc-w", detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.serverSays({ type: "ready", sessionName: "cc-w", cols: 100, rows: 30, readOnly: true, stream: "s", offset: 0, seedBytes: 0, role: "observer", canControl: false, viewers: 1 });
  const sent = ws.sent.length;
  takeControl(id);
  expect(ws.sent.length).toBe(sent);
  closeTab(id);
});

test("a controller that comes back on a new screen fits its container again", async () => {
  const { openTerminal, attachToContainer, closeTab } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "attach", target: "cc-fit", interactive: true, detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  const ready = { type: "ready", sessionName: "cc-fit", readOnly: false, cols: 200, rows: 50, stream: "s1", offset: 0, seedBytes: 0, role: "controller", canControl: true };
  ws.serverSays(ready);
  proposeDims = { cols: 120, rows: 30 };
  attachToContainer(id, new FakeContainer() as unknown as HTMLElement);
  expect(ws.resizes().at(-1)).toEqual({ type: "resize", cols: 120, rows: 30 });

  // Back after the daemon restarted (a different stream): the pane is at
  // its own size again, and this view must size it once more.
  ws.drop();
  await Bun.sleep(400);
  const back = FakeWebSocket.last!;
  back.open();
  back.serverSays({ ...ready, stream: "s2", truncated: true });
  expect(back.resizes()).toEqual([{ type: "resize", cols: 120, rows: 30 }]);
  closeTab(id);
});

test("a resumed controller fits its container if the pane changed size while it was away", async () => {
  const { openTerminal, attachToContainer, closeTab } = await import("../terminal/termSessions");
  const id = openTerminal({ endpoint, kind: "attach", target: "cc-resume-fit", interactive: true, detached: true });
  const ws = FakeWebSocket.last!;
  ws.open();
  const ready = { type: "ready", sessionName: "cc-resume-fit", readOnly: false, cols: 120, rows: 30, stream: "s1", offset: 0, seedBytes: 0, role: "controller", canControl: true };
  ws.serverSays(ready);
  proposeDims = { cols: 120, rows: 30 };
  attachToContainer(id, new FakeContainer() as unknown as HTMLElement);
  ws.drop();
  await Bun.sleep(400);
  const back = FakeWebSocket.last!;
  back.open();
  // The seat hold ran out meanwhile and the agent's pane went back to 200x50.
  back.serverSays({ ...ready, cols: 200, rows: 50, offset: 10, resumed: true });
  expect(back.resizes()).toEqual([{ type: "resize", cols: 120, rows: 30 }]);
  closeTab(id);
});

test("closing a reconnecting shell with kill still ends its session", async () => {
  const { openTerminal, closeTab } = await import("../terminal/termSessions");
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  try {
    const id = openTerminal({ endpoint, kind: "shell", name: "cast-term-k", detached: true });
    const ws = FakeWebSocket.last!;
    ws.open();
    ws.serverSays({ type: "ready", sessionName: "cast-term-k", cols: 80, rows: 24, stream: "s", offset: 0, seedBytes: 0, role: "controller", canControl: true });
    ws.drop();
    closeTab(id, { killSession: true });
    expect(calls.some((u) => u.includes("/term/kill?name=cast-term-k"))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
