// The watch stream end-to-end over a standalone loopback server, with a fake
// CDP connection standing in for Chrome. Deliberately never touches the daemon
// or the managed browser on this machine.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as http from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import type { CdpConnection, CdpEvent, CdpTarget } from "./cdp.js";
import type { InstanceState } from "./instance.js";
import { attachWatchServer, ownerCandidates, resolveWatchTarget, type WatchServerDeps } from "./watchServer.js";
import { cdpWatchEngine, pollingWatchEngine, type CdpEngineDeps } from "./watchSource.js";
import { ACTION_BINDING, WATCH_PROTOCOL_VERSION } from "./watchActions.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";

const state = (tabs: Record<string, string>, active: string | null = null): InstanceState => ({
  pid: 1,
  port: 9999,
  userDataDir: "/tmp/none",
  headless: true,
  sourceProfile: null,
  channel: "chrome",
  startedAt: 0,
  tabsBySession: tabs,
  activeTargetId: active,
});

describe("ownerCandidates", () => {
  test("session uuid yields session: and env: keys", async () => {
    expect(await ownerCandidates({ session_uuid: "abc-123" }, async () => null)).toEqual([
      "session:abc-123",
      "env:abc-123",
    ]);
  });

  test("tmux session resolves to a pane key", async () => {
    expect(await ownerCandidates({ tmux_session: "cc-agent-1" }, async () => "%7")).toEqual(["pane:%7"]);
  });

  test("hostile tmux names never reach the pane lookup", async () => {
    let asked = false;
    await ownerCandidates({ tmux_session: "x; rm -rf /" }, async () => ((asked = true), "%1"));
    expect(asked).toBe(false);
  });
});

describe("resolveWatchTarget", () => {
  test("the session's own claim wins", () => {
    const s = state({ "session:u1": "tab-a", "pane:%2": "tab-b" }, "tab-c");
    expect(resolveWatchTarget(s, ["session:u1"])).toEqual({ tabId: "tab-a" });
  });

  test("another session's tab is never shown", () => {
    const s = state({ "session:other": "tab-b" }, "tab-b");
    expect(resolveWatchTarget(s, ["session:u1"])).toEqual({ error: "no-tab" });
  });

  test("with no claims at all, the shared active tab stands in", () => {
    expect(resolveWatchTarget(state({}, "tab-x"), ["session:u1"])).toEqual({ tabId: "tab-x" });
  });

  test("no browser state means no-browser", () => {
    expect(resolveWatchTarget(null, ["session:u1"])).toEqual({ error: "no-browser" });
  });
});

// ---------------------------------------------------------------------------
// Live socket tests against a fake CDP connection.

class FakeCdp {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  handlers = new Set<(ev: CdpEvent) => void>();
  closed = false;
  nextSession = 1;
  /** When set, Page.captureScreenshot answers with this JPEG (base64). */
  screenshotData: string | null = null;
  /** What the page answers when the action observer is installed: the ring
   *  a previous viewer's script left behind (JSON), see watchActions.ts. */
  pageRecent: string = "[]";

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.attachToTarget") return Promise.resolve({ sessionId: `cdp-${this.nextSession++}` });
    if (method === "Page.captureScreenshot" && this.screenshotData) return Promise.resolve({ data: this.screenshotData });
    if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: this.pageRecent } });
    return Promise.resolve({});
  }

  on(handler: (ev: CdpEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(ev: CdpEvent): void {
    for (const h of this.handlers) h(ev);
  }

  close(): void {
    this.closed = true;
  }

  ackCount(): number {
    return this.calls.filter((c) => c.method === "Page.screencastFrameAck").length;
  }
}

let server: http.Server;
let handle: { close(): void };
let port = 0;
let cdp: FakeCdp;
let cdpDeps: CdpEngineDeps;
let deps: WatchServerDeps;
let currentState: InstanceState | null;
let targets: CdpTarget[];

beforeAll(async () => {
  cdp = new FakeCdp();
  currentState = state({ "session:u1": "tab-a" });
  targets = [{ targetId: "tab-a", type: "page", title: "Example", url: "https://example.com/" }];
  cdpDeps = {
    getState: () => currentState,
    connect: async () => cdp as unknown as CdpConnection,
    listTargets: async () => targets,
  };
  deps = { engine: cdpWatchEngine(cdpDeps), paneIdFor: async () => null };
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  handle = attachWatchServer(server, { token: TOKEN, log: () => {} }, deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  handle.close();
  server.close();
});

interface Collected {
  ws: WebSocket;
  messages: any[];
  waitFor(type: string, timeoutMs?: number): Promise<any>;
  closed: Promise<void>;
}

function connect(hello: Record<string, unknown>, origin = ORIGIN): Collected {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/watch/ws`, { headers: { Origin: origin } });
  const messages: any[] = [];
  const waiters: Array<{ type: string; resolve: (m: any) => void }> = [];
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN, ...hello })));
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.type) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const closed = new Promise<void>((r) => ws.on("close", () => r()));
  return {
    ws,
    messages,
    closed,
    waitFor(type, timeoutMs = 5000) {
      const existing = messages.find((m) => m.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs}ms`)), timeoutMs).unref?.();
      });
    },
  };
}

describe("watch socket", () => {
  test("bad token is refused before any CDP work", async () => {
    const before = cdp.calls.length;
    const c = connect({ token: "wrong", session_uuid: "u1" });
    const err = await c.waitFor("error");
    expect(err.code).toBe("forbidden");
    await c.closed;
    expect(cdp.calls.length).toBe(before);
  });

  test("disallowed origin never completes the handshake", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/watch/ws`, {
      headers: { Origin: "https://evil.example" },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  test("a session with no driven tab gets no-tab", async () => {
    const c = connect({ session_uuid: "nobody" });
    const err = await c.waitFor("error");
    expect(err.code).toBe("no-tab");
    await c.closed;
  });

  test("streams frames for the owning session, paced by acks", async () => {
    const c = connect({ session_uuid: "u1", fps: 30 });
    const ready = await c.waitFor("ready");
    expect(ready.targetId).toBe("tab-a");
    expect(ready.url).toBe("https://example.com/");

    // The screencast must have been started on the attached CDP session.
    const start = cdp.calls.find((call) => call.method === "Page.startScreencast");
    expect(start).toBeTruthy();
    const cdpSession = start!.sessionId!;

    // Chrome pushes a frame; it must reach the socket and then be acked.
    const acksBefore = cdp.ackCount();
    cdp.emit({
      method: "Page.screencastFrame",
      params: { data: "aGVsbG8=", metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 42 },
      sessionId: cdpSession,
    });
    const frame = await c.waitFor("frame");
    expect(frame.data).toBe("aGVsbG8=");
    expect(frame.w).toBe(800);

    // The ack is paced, so it lands shortly after the interval — poll for it.
    const deadline = Date.now() + 3000;
    while (cdp.ackCount() <= acksBefore && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(cdp.ackCount()).toBe(acksBefore + 1);
    const ack = cdp.calls.filter((call) => call.method === "Page.screencastFrameAck").pop()!;
    expect(ack.params.sessionId).toBe(42);

    c.ws.close();
    await c.closed;
  });

  test("a viewer that leaves mid-dial does not leak the CDP connection", async () => {
    // Stand up a second server whose connect() resolves only when told to,
    // so the viewer can hang up while the daemon is still dialing Chrome.
    const slow = new FakeCdp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowDeps: WatchServerDeps = {
      paneIdFor: async () => null,
      engine: cdpWatchEngine({
        ...cdpDeps,
        connect: async () => {
          await gate;
          return slow as unknown as CdpConnection;
        },
      }),
    };
    const srv = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const h = attachWatchServer(srv, { token: TOKEN, log: () => {} }, slowDeps);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/watch/ws`, { headers: { Origin: ORIGIN } });
      await new Promise<void>((r) => ws.on("open", () => r()));
      ws.send(JSON.stringify({ type: "hello", token: TOKEN, session_uuid: "u1" }));
      // Give the server a tick to reach connect(), then hang up before it answers.
      await new Promise((r) => setTimeout(r, 100));
      const closed = new Promise<void>((r) => ws.on("close", () => r()));
      ws.close();
      await closed;
      // The client saw the close handshake finish; give the server's own
      // 'close' event a moment to run cleanup() before Chrome "answers".
      await new Promise((r) => setTimeout(r, 200));
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(slow.closed).toBe(true);
      expect(slow.calls.some((c) => c.method === "Page.startScreencast")).toBe(false);
    } finally {
      h.close();
      srv.close();
    }
  });

  test("a tab that never paints still streams via the captureScreenshot fallback", async () => {
    // A hidden tab (background tab, occluded window) starts the screencast
    // fine but Chrome never emits a frame. The watchdog must notice the
    // silence and deliver polled screenshots instead.
    cdp.screenshotData = "c2hvdA==";
    try {
      const c = connect({ session_uuid: "u1" });
      await c.waitFor("ready");
      const frame = await c.waitFor("frame", 5000);
      expect(frame.data).toBe("c2hvdA==");
      // A static hidden page produces identical JPEGs; those are not resent.
      await new Promise((r) => setTimeout(r, 900));
      expect(c.messages.filter((m) => m.type === "frame").length).toBe(1);
      c.ws.close();
      await c.closed;
    } finally {
      cdp.screenshotData = null;
    }
  });

  test("closing the tab ends the stream with tab-closed", async () => {
    const c = connect({ session_uuid: "u1" });
    await c.waitFor("ready");
    // The tab disappears from both the ownership map and the target list.
    currentState = state({ "session:other": "tab-z" });
    const exit = await c.waitFor("exit", 10_000);
    expect(exit.reason).toBe("tab-closed");
    await c.closed;
    // Restore for any later test.
    currentState = state({ "session:u1": "tab-a" });
  });
});

// ---------------------------------------------------------------------------
// The polling engine: an external browser engine with screenshots but no CDP.

describe("polling engine", () => {
  test("delivers screenshots on the pacing interval and reports the tab", async () => {
    let shots = 0;
    let alive = true;
    const engine = pollingWatchEngine({
      resolveTab: (cands) => (cands.includes("session:p1") ? { tabId: "ext-7" } : { error: "no-tab" }),
      screenshot: async () => (alive ? { data: "Zg==", width: 10, height: 10 } : null),
      describe: async () => (alive ? { title: shots++ < 3 ? "One" : "Two", url: "https://x.test/" } : null),
    });
    const srv = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const h = attachWatchServer(srv, { token: TOKEN, log: () => {} }, { engine, paneIdFor: async () => null });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/watch/ws`, { headers: { Origin: ORIGIN } });
      const msgs: any[] = [];
      ws.on("message", (raw) => msgs.push(JSON.parse(String(raw))));
      await new Promise<void>((r) => ws.on("open", () => r()));
      ws.send(JSON.stringify({ type: "hello", token: TOKEN, session_uuid: "p1", fps: 20 }));
      const until = async (pred: () => boolean, ms = 4000) => {
        const dl = Date.now() + ms;
        while (!pred() && Date.now() < dl) await new Promise((r) => setTimeout(r, 20));
        return pred();
      };
      expect(await until(() => msgs.some((m) => m.type === "ready" && m.targetId === "ext-7"))).toBe(true);
      expect(await until(() => msgs.filter((m) => m.type === "frame").length >= 3)).toBe(true);
      expect(await until(() => msgs.some((m) => m.type === "tab" && m.title === "Two"))).toBe(true);
      // Tab dies → orderly exit.
      alive = false;
      expect(await until(() => msgs.some((m) => m.type === "exit"))).toBe(true);
      expect(msgs.find((m) => m.type === "exit").reason).toBe("tab-closed");
    } finally {
      h.close();
      srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The agent-browser adapter: tabs from the engine, frames over its Chrome's port.

import { engineWatchEngine, engineSessionFor } from "./watchEngineAdapter.js";

describe("engine adapter", () => {
  test("session key sanitization matches engineSession()", () => {
    expect(engineSessionFor("session:abc-123")).toBe("session-abc-123");
    expect(engineSessionFor("pane:%7")).toBe("pane-7");
  });

  test("resolves the session's ACTIVE tab by real target id and streams over the engine port", async () => {
    const eng = new FakeCdp();
    const asked: string[] = [];
    const engine = engineWatchEngine({
      tabsFor: (key) => {
        asked.push(key);
        return key === "session-u9"
          ? [
              { targetId: "T-OLD", active: false, title: "old" },
              { targetId: "T-ACTIVE", active: true, title: "Now" },
            ]
          : [];
      },
      endpointFor: async (key) => (key === "session-u9" ? { port: 4242 } : null),
      connect: async (port) => {
        expect(port).toBe(4242);
        return eng as unknown as CdpConnection;
      },
      listTargets: async () => [{ targetId: "T-ACTIVE", type: "page", title: "Now", url: "https://e.test/" }],
    });
    // Engine-local ids ("t1") never appear: the resolved id is the CDP target.
    expect(engine.resolveTab(["session:u9", "env:u9"])).toEqual({ tabId: "T-ACTIVE" });
    expect(engine.resolveTab(["session:nobody"])).toEqual({ error: "no-tab" });

    const srv = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const h = attachWatchServer(srv, { token: TOKEN, log: () => {} }, { engine, paneIdFor: async () => null });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/watch/ws`, { headers: { Origin: ORIGIN } });
      const msgs: any[] = [];
      ws.on("message", (raw) => msgs.push(JSON.parse(String(raw))));
      await new Promise<void>((r) => ws.on("open", () => r()));
      ws.send(JSON.stringify({ type: "hello", token: TOKEN, session_uuid: "u9" }));
      const dl = Date.now() + 4000;
      while (!msgs.some((m) => m.type === "ready") && Date.now() < dl) await new Promise((r) => setTimeout(r, 20));
      const ready = msgs.find((m) => m.type === "ready");
      expect(ready?.targetId).toBe("T-ACTIVE");
      expect(ready?.url).toBe("https://e.test/");
      const start = eng.calls.find((c) => c.method === "Page.startScreencast");
      expect(start).toBeTruthy();
      const attach = eng.calls.find((c) => c.method === "Target.attachToTarget");
      expect(attach?.params.targetId).toBe("T-ACTIVE");
      ws.close();
    } finally {
      h.close();
      srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Control mode: input rides back on the same socket, only when asked for.

describe("control mode", () => {
  test("input is dispatched through CDP, scaled by the page viewport", async () => {
    const c = connect({ session_uuid: "u1", control: true });
    const ready = await c.waitFor("ready");
    expect(ready.control).toBe(true);
    // The fake accumulates sessions across tests — take THIS connection's.
    const cdpSession = cdp.calls.filter((call) => call.method === "Page.startScreencast").pop()!.sessionId!;

    // No frame yet → no viewport → a click has nowhere to land and is dropped.
    const before = cdp.calls.length;
    c.ws.send(JSON.stringify({ type: "input", events: [{ kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.5, button: "left", clickCount: 1 }] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(cdp.calls.filter((x) => x.method === "Input.dispatchMouseEvent").length).toBe(0);
    expect(cdp.calls.length).toBe(before);

    // A frame teaches the viewport; normalized coordinates scale by it.
    cdp.emit({
      method: "Page.screencastFrame",
      params: { data: "aGVsbG8=", metadata: { deviceWidth: 1000, deviceHeight: 500 }, sessionId: 7 },
      sessionId: cdpSession,
    });
    await c.waitFor("frame");
    c.ws.send(
      JSON.stringify({
        type: "input",
        events: [
          { kind: "mouse", type: "mousePressed", nx: 0.25, ny: 0.5, button: "left", clickCount: 1 },
          { kind: "key", type: "keyDown", key: "Enter", code: "Enter" },
          { kind: "insertText", text: "hello" },
        ],
      }),
    );
    const deadline = Date.now() + 2000;
    while (!cdp.calls.some((x) => x.method === "Input.insertText") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const mouse = cdp.calls.find((x) => x.method === "Input.dispatchMouseEvent")!;
    expect(mouse.sessionId).toBe(cdpSession);
    expect(mouse.params).toMatchObject({ type: "mousePressed", x: 250, y: 250, button: "left", clickCount: 1 });
    const key = cdp.calls.find((x) => x.method === "Input.dispatchKeyEvent")!;
    // Enter carries the virtual key code and a CR — without them Chrome
    // delivers the event but never submits the form.
    expect(key.params).toMatchObject({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(cdp.calls.find((x) => x.method === "Input.insertText")!.params).toEqual({ text: "hello" });

    c.ws.close();
    await c.closed;
  });

  test("a watch-only viewer's input is ignored and ready says so", async () => {
    const c = connect({ session_uuid: "u1" });
    const ready = await c.waitFor("ready");
    expect(ready.control).toBe(false);
    const cdpSession = cdp.calls.filter((call) => call.method === "Page.startScreencast").pop()!.sessionId!;
    cdp.emit({
      method: "Page.screencastFrame",
      params: { data: "aGVsbG8=", metadata: { deviceWidth: 1000, deviceHeight: 500 }, sessionId: 8 },
      sessionId: cdpSession,
    });
    await c.waitFor("frame");
    const before = cdp.calls.filter((x) => x.method.startsWith("Input.")).length;
    c.ws.send(JSON.stringify({ type: "input", events: [{ kind: "insertText", text: "nope" }] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(cdp.calls.filter((x) => x.method.startsWith("Input.")).length).toBe(before);
    c.ws.close();
    await c.closed;
  });
});

// ---------------------------------------------------------------------------
// The action channel: what the page reports about the agent's hand reaches
// the viewer as `action` frames, normalized to the viewport.

describe("action channel", () => {
  const sessionOf = () => cdp.calls.filter((call) => call.method === "Page.startScreencast").pop()!.sessionId!;
  const report = (cdpSession: string, raw: Record<string, unknown>) =>
    cdp.emit({ method: "Runtime.bindingCalled", params: { name: ACTION_BINDING, payload: JSON.stringify(raw), executionContextId: 1 }, sessionId: cdpSession });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  test("ready names the protocol, the observer is installed, and a report becomes a normalized action frame", async () => {
    const c = connect({ session_uuid: "u1" });
    const ready = await c.waitFor("ready");
    expect(ready.protocol).toBe(WATCH_PROTOCOL_VERSION);
    const cdpSession = sessionOf();
    await settle();
    const onSession = cdp.calls.filter((x) => x.sessionId === cdpSession).map((x) => x.method);
    expect(onSession).toContain("Runtime.addBinding");
    expect(cdp.calls.find((x) => x.method === "Runtime.addBinding" && x.sessionId === cdpSession)!.params).toEqual({ name: ACTION_BINDING });
    expect(onSession).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(onSession).toContain("Runtime.evaluate");

    const at = Date.now();
    report(cdpSession, { kind: "down", x: 400, y: 150, w: 800, h: 600, at });
    const action = await c.waitFor("action");
    expect(action).toEqual({ type: "action", kind: "down", x: 0.5, y: 0.25, at });

    // Text is a caption, and a secret field never carries one.
    report(cdpSession, { kind: "type", x: 100, y: 100, w: 800, h: 600, at: at + 1, text: "hello" });
    report(cdpSession, { kind: "type", x: 100, y: 100, w: 800, h: 600, at: at + 2, secret: true, text: "leak" });
    await settle();
    const typed = c.messages.filter((m) => m.type === "action" && m.kind === "type");
    expect(typed[0]).toMatchObject({ text: "hello" });
    expect(typed[1]).toMatchObject({ secret: true });
    expect(typed[1].text).toBeUndefined();

    // A report from another CDP session, or under another binding name, is not ours.
    cdp.emit({ method: "Runtime.bindingCalled", params: { name: "other", payload: JSON.stringify({ kind: "up", x: 1, y: 1, w: 2, h: 2 }) }, sessionId: cdpSession });
    cdp.emit({ method: "Runtime.bindingCalled", params: { name: ACTION_BINDING, payload: JSON.stringify({ kind: "up", x: 1, y: 1, w: 2, h: 2 }) }, sessionId: "cdp-elsewhere" });
    await settle();
    expect(c.messages.filter((m) => m.type === "action" && m.kind === "up").length).toBe(0);

    c.ws.close();
    await c.closed;
  });

  test("a main frame navigation is an action with the url, at the last known cursor", async () => {
    const c = connect({ session_uuid: "u1" });
    await c.waitFor("ready");
    const cdpSession = sessionOf();
    report(cdpSession, { kind: "move", x: 200, y: 300, w: 800, h: 600, at: Date.now() });
    await c.waitFor("action");
    cdp.emit({ method: "Page.frameNavigated", params: { frame: { id: "child", parentId: "main", url: "https://ad.example/" } }, sessionId: cdpSession });
    cdp.emit({ method: "Page.frameNavigated", params: { frame: { id: "main", url: "https://example.com/next" } }, sessionId: cdpSession });
    await settle();
    const navs = c.messages.filter((m) => m.type === "action" && m.kind === "nav");
    expect(navs.length).toBe(1);
    expect(navs[0]).toMatchObject({ url: "https://example.com/next", x: 0.25, y: 0.5 });
    c.ws.close();
    await c.closed;
  });

  test("a viewer who connects mid flow gets the recent actions right after ready", async () => {
    const first = connect({ session_uuid: "u1" });
    await first.waitFor("ready");
    const at = Date.now();
    report(sessionOf(), { kind: "down", x: 80, y: 60, w: 800, h: 600, at });
    await first.waitFor("action");

    const second = connect({ session_uuid: "u1" });
    await second.waitFor("ready");
    await settle();
    const idx = second.messages.findIndex((m) => m.type === "ready");
    const replayed = second.messages.slice(idx + 1).filter((m) => m.type === "action");
    expect(replayed.some((m) => m.kind === "down" && m.x === 0.1 && m.y === 0.1 && m.at === at)).toBe(true);
    // Nothing arrived before ready.
    expect(second.messages.slice(0, idx).some((m) => m.type === "action")).toBe(false);

    first.ws.close();
    second.ws.close();
    await Promise.all([first.closed, second.closed]);
  });

  test("what the page already saw before any viewer came is replayed from its own ring", async () => {
    const at = Date.now();
    cdp.pageRecent = JSON.stringify([
      { kind: "move", x: 8, y: 6, w: 80, h: 60, at: at - 60_000 }, // too old to be the cursor now
      { kind: "up", x: 40, y: 30, w: 80, h: 60, at },
    ]);
    try {
      const c = connect({ session_uuid: "u1" });
      await c.waitFor("ready");
      const deadline = Date.now() + 2000;
      while (!c.messages.some((m) => m.type === "action" && m.at === at) && Date.now() < deadline) await settle();
      const mine = c.messages.filter((m) => m.type === "action" && (m.at === at || m.at === at - 60_000));
      expect(mine).toEqual([{ type: "action", kind: "up", x: 0.5, y: 0.5, at }]);
      c.ws.close();
      await c.closed;
    } finally {
      cdp.pageRecent = "[]";
    }
  });

  test("the page's echo of a viewer's own input is not an agent action", async () => {
    const c = connect({ session_uuid: "u1", control: true });
    await c.waitFor("ready");
    const cdpSession = sessionOf();
    cdp.emit({
      method: "Page.screencastFrame",
      params: { data: "aGVsbG8=", metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 9 },
      sessionId: cdpSession,
    });
    await c.waitFor("frame");
    c.ws.send(JSON.stringify({ type: "input", events: [{ kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.5, button: "left", clickCount: 1 }] }));
    await settle();
    const at = Date.now();
    report(cdpSession, { kind: "down", x: 400, y: 300, w: 800, h: 600, at });
    await settle();
    expect(c.messages.some((m) => m.type === "action" && m.at === at)).toBe(false);
    c.ws.close();
    await c.closed;
  });
});
