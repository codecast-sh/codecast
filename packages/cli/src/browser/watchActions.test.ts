// The action channel in isolation: the page script against a fake window,
// and the daemon-side shaping of what it reports. No Chrome, no socket.

import { describe, test, expect } from "bun:test";
import {
  ACTION_BINDING,
  ACTION_RECENT,
  ACTION_REPLAY_MAX_AGE_MS,
  ACTION_TEXT_CAP,
  actionObserverInstallExpression,
  actionObserverSource,
  normalizeAction,
  parseActionPayload,
  RecentActions,
  replayableActions,
  type WatchAction,
} from "./watchActions.js";

// ---------------------------------------------------------------------------
// A window just real enough for the script: listeners, a viewport, a binding.

type Listener = (e: Record<string, unknown>) => void;

interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  top: FakeWindow | null;
  listeners: Map<string, Listener[]>;
  reported: string[];
  addEventListener(name: string, fn: Listener, opts?: unknown): void;
  fire(name: string, e: Record<string, unknown>): void;
  __castWatch?: { recent: unknown[] };
  [ACTION_BINDING]?: (payload: string) => void;
}

function fakeWindow(opts: { binding?: boolean; nested?: boolean } = {}): FakeWindow {
  const w: FakeWindow = {
    innerWidth: 1000,
    innerHeight: 500,
    top: null,
    listeners: new Map(),
    reported: [],
    addEventListener(name, fn) {
      const list = w.listeners.get(name) ?? [];
      list.push(fn);
      w.listeners.set(name, list);
    },
    fire(name, e) {
      for (const fn of w.listeners.get(name) ?? []) fn(e);
    },
  };
  w.top = opts.nested ? ({} as FakeWindow) : w;
  if (opts.binding !== false) w[ACTION_BINDING] = (payload: string) => w.reported.push(payload);
  return w;
}

function install(w: FakeWindow): void {
  // The script names `window` and nothing else from the page's globals.
  new Function("window", actionObserverSource())(w);
}

const field = (attrs: Record<string, string>, rect = { left: 100, top: 40, width: 200, height: 20 }) => ({
  getAttribute: (name: string) => attrs[name] ?? null,
  getBoundingClientRect: () => rect,
});

const last = (w: FakeWindow) => JSON.parse(w.reported[w.reported.length - 1]) as Record<string, unknown>;

describe("the page script", () => {
  test("reports a press with the viewport it happened in", () => {
    const w = fakeWindow();
    install(w);
    w.fire("mousedown", { clientX: 250, clientY: 125 });
    expect(last(w)).toMatchObject({ kind: "down", x: 250, y: 125, w: 1000, h: 500 });
    expect(typeof last(w).at).toBe("number");
    // The same event shaped by the daemon lands at a quarter across, a quarter down.
    expect(normalizeAction(last(w))).toMatchObject({ type: "action", kind: "down", x: 0.25, y: 0.25 });
  });

  test("installs once, and never in a frame that is not the top one", () => {
    const w = fakeWindow();
    install(w);
    install(w);
    expect(w.listeners.get("mousedown")!.length).toBe(1);
    const inner = fakeWindow({ nested: true });
    install(inner);
    expect(inner.listeners.size).toBe(0);
  });

  test("coalesces a mouse move stream and keeps a bounded ring", () => {
    const w = fakeWindow();
    install(w);
    for (let i = 0; i < 20; i++) w.fire("mousemove", { clientX: i, clientY: i });
    // Within one interval only the first move is reported.
    expect(w.reported.filter((r) => JSON.parse(r).kind === "move").length).toBe(1);
    for (let i = 0; i < 20; i++) w.fire("mouseup", { clientX: i, clientY: i });
    expect(w.__castWatch!.recent.length).toBe(ACTION_RECENT);
  });

  test("a scripted click with no press still aims at the element", () => {
    const w = fakeWindow();
    install(w);
    w.fire("click", { clientX: 0, clientY: 0, target: field({}, { left: 100, top: 100, width: 50, height: 50 }) });
    const kinds = w.reported.map((r) => JSON.parse(r).kind);
    expect(kinds).toEqual(["down", "up"]);
    expect(last(w)).toMatchObject({ x: 125, y: 125 });
    // A click that followed a real press is not reported twice.
    w.fire("mousedown", { clientX: 10, clientY: 10 });
    w.fire("click", { clientX: 10, clientY: 10, target: field({}) });
    expect(w.reported.length).toBe(3);
  });

  test("typing accumulates into one caption per field and deletes back", () => {
    const w = fakeWindow();
    install(w);
    const input = field({ type: "text" });
    w.fire("input", { target: input, data: "he", inputType: "insertText" });
    w.fire("input", { target: input, data: "llo", inputType: "insertText" });
    expect(last(w)).toMatchObject({ kind: "type", text: "hello", x: 200, y: 50 });
    w.fire("input", { target: input, data: null, inputType: "deleteContentBackward" });
    expect(last(w).text).toBe("hell");
    // Another field starts its own caption.
    w.fire("input", { target: field({ type: "text" }), data: "x", inputType: "insertText" });
    expect(last(w).text).toBe("x");
  });

  test("never reads text out of a password or a one time code field", () => {
    const w = fakeWindow();
    install(w);
    w.fire("input", { target: field({ type: "password" }), data: "hunter2", inputType: "insertText" });
    expect(last(w)).toMatchObject({ kind: "type", secret: true });
    expect(JSON.stringify(last(w))).not.toContain("hunter2");
    w.fire("input", { target: field({ type: "text", autocomplete: "one-time-code" }), data: "123456", inputType: "insertText" });
    expect(last(w)).toMatchObject({ kind: "type", secret: true });
    expect(JSON.stringify(last(w))).not.toContain("123456");
    w.fire("input", { target: field({ type: "text", autocomplete: "cc-number" }), data: "4111", inputType: "insertText" });
    expect(JSON.stringify(last(w))).not.toContain("4111");
  });

  test("reports a scroll with its deltas, coalesced", () => {
    const w = fakeWindow();
    install(w);
    w.fire("wheel", { clientX: 500, clientY: 250, deltaX: 0, deltaY: 120 });
    w.fire("wheel", { clientX: 500, clientY: 250, deltaX: 0, deltaY: 120 });
    expect(w.reported.length).toBe(1);
    expect(normalizeAction(last(w))).toMatchObject({ kind: "scroll", x: 0.5, y: 0.5, dy: 120 });
  });

  test("a scripted scroll, with no wheel, is reported from the position change at the last cursor spot", () => {
    const w = fakeWindow() as FakeWindow & { scrollX: number; scrollY: number };
    install(w);
    w.fire("mousemove", { clientX: 300, clientY: 200 });
    w.scrollX = 0;
    w.scrollY = 400;
    w.fire("scroll", { target: { scrollTop: undefined } });
    expect(last(w)).toMatchObject({ kind: "scroll", x: 300, y: 200, dx: 0, dy: 400 });
    // A wheel scroll already reported is not reported again by its scroll event.
    const n = w.reported.length;
    w.scrollY = 800;
    w.fire("scroll", { target: { scrollTop: undefined } });
    expect(w.reported.length).toBe(n);
    // An inner pane reports its own delta.
    const pane = { scrollTop: 0, scrollLeft: 0 };
    w.__castWatch!.recent.length = 0;
    (w.__castWatch as unknown as { wheelAt: number }).wheelAt = 0;
    pane.scrollTop = 120;
    w.fire("scroll", { target: pane });
    expect(last(w)).toMatchObject({ kind: "scroll", dy: 120 });
  });

  test("with no binding yet the ring still fills, and the install expression hands it over", () => {
    const w = fakeWindow({ binding: false });
    install(w);
    w.fire("mousedown", { clientX: 1, clientY: 2 });
    expect(w.reported.length).toBe(0);
    expect(w.__castWatch!.recent.length).toBe(1);
    // A later viewer evaluates the install expression and gets the ring back.
    // Runtime.evaluate answers with the program's last expression; eval does the same.
    const recent = new Function("window", `return eval(${JSON.stringify(actionObserverInstallExpression())})`)(w) as string;
    expect(replayableActions(recent)).toMatchObject([{ kind: "down", x: 0.001, y: 0.004 }]);
  });
});

// ---------------------------------------------------------------------------
// Daemon-side shaping.

describe("normalizeAction", () => {
  test("normalizes to the unit square and clamps what falls outside it", () => {
    expect(normalizeAction({ kind: "move", x: 1200, y: -5, w: 1000, h: 500, at: 7 })).toEqual({
      type: "action",
      kind: "move",
      x: 1,
      y: 0,
      at: 7,
    });
  });

  test("refuses anything without a viewport to normalize against", () => {
    expect(normalizeAction({ kind: "move", x: 1, y: 1, w: 0, h: 500 })).toBeNull();
    expect(normalizeAction({ kind: "move", x: 1, y: 1 })).toBeNull();
    expect(normalizeAction({ kind: "dance", x: 1, y: 1, w: 10, h: 10 })).toBeNull();
    expect(normalizeAction("nope")).toBeNull();
    expect(normalizeAction(null)).toBeNull();
  });

  test("caps typed text and keeps the tail the agent typed last", () => {
    const long = "a".repeat(ACTION_TEXT_CAP + 50) + "END";
    const a = normalizeAction({ kind: "type", x: 1, y: 1, w: 10, h: 10, text: long })!;
    expect(a.text!.length).toBe(ACTION_TEXT_CAP);
    expect(a.text!.endsWith("END")).toBe(true);
  });

  test("a secret field carries the flag and no text, whatever the page sent", () => {
    const a = normalizeAction({ kind: "type", x: 1, y: 1, w: 10, h: 10, secret: true, text: "leak" })!;
    expect(a.secret).toBe(true);
    expect(a.text).toBeUndefined();
  });

  test("stamps the daemon's clock when the page sent none", () => {
    expect(normalizeAction({ kind: "up", x: 1, y: 1, w: 10, h: 10 }, 99)!.at).toBe(99);
  });

  test("parseActionPayload tolerates a payload that is not JSON", () => {
    expect(parseActionPayload("{nope")).toBeNull();
    expect(parseActionPayload(undefined)).toBeNull();
    expect(parseActionPayload(JSON.stringify({ kind: "up", x: 5, y: 5, w: 10, h: 10, at: 1 }))).toMatchObject({ kind: "up", x: 0.5 });
  });
});

describe("replay", () => {
  const at = (ms: number): WatchAction => ({ type: "action", kind: "move", x: 0.5, y: 0.5, at: ms });

  test("replayableActions drops what is too old to be where the cursor is now", () => {
    const now = 100_000;
    const json = JSON.stringify([
      { kind: "move", x: 1, y: 1, w: 10, h: 10, at: now - ACTION_REPLAY_MAX_AGE_MS - 1 },
      { kind: "move", x: 2, y: 2, w: 10, h: 10, at: now - 10 },
    ]);
    expect(replayableActions(json, now)).toMatchObject([{ x: 0.2 }]);
    expect(replayableActions("[", now)).toEqual([]);
    expect(replayableActions(42, now)).toEqual([]);
  });

  test("RecentActions keeps the last few per tab and forgets stale ones", () => {
    const mem = new RecentActions();
    for (let i = 0; i < ACTION_RECENT + 3; i++) mem.remember("t1", at(1000 + i));
    const now = 1000 + ACTION_RECENT + 3;
    expect(mem.recall("t1", now).length).toBe(ACTION_RECENT);
    expect(mem.recall("t1", now)[0].at).toBe(1003);
    expect(mem.recall("t1", now + ACTION_REPLAY_MAX_AGE_MS + 1)).toEqual([]);
    expect(mem.recall("other", now)).toEqual([]);
  });
});
