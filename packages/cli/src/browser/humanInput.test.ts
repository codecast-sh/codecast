import { describe, expect, test } from "bun:test";
import { clampPoint, createHumanInput, humanInputEnabled, KEY_GAP_MS, KEY_PACED_BURST, MAX_MOVE_MS, PRESS_MS, trajectory } from "./humanInput.js";

/** Deterministic rand. */
function seeded(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** A fake clock: sleeps advance it, sends are recorded with their time. */
function rig(enabled = true) {
  let t = 0;
  const sent: Array<{ at: number; method: string; params: Record<string, unknown> }> = [];
  const h = createHumanInput({ now: () => t, sleep: async (ms) => void (t += Math.max(0, ms)), rand: seeded(), enabled: () => enabled });
  const send = async (method: string, params: Record<string, unknown>) => {
    sent.push({ at: t, method, params });
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
    return {};
  };
  /** What the caller does: pace, then send the event itself. */
  const dispatch = async (method: string, params: Record<string, unknown>) => {
    await h.beforeInput("tab", method, params, send);
    await send(method, params);
  };
  return { sent, dispatch, now: () => t };
}

describe("trajectory", () => {
  test("a curved path ending near the target, timed by distance and capped", () => {
    const short = trajectory({ x: 0, y: 0 }, { x: 60, y: 0 }, seeded());
    const long = trajectory({ x: 0, y: 0 }, { x: 1200, y: 600 }, seeded());
    const time = (p: typeof short) => p.reduce((s, x) => s + x.delay, 0);
    expect(time(long)).toBeGreaterThan(time(short));
    expect(time(long)).toBeLessThanOrEqual(MAX_MOVE_MS + 20);
    // Curved: some point leaves the straight line from (0,0) to (1200,600).
    const offLine = long.some(({ point }) => Math.abs(point.y - point.x / 2) > 5);
    expect(offLine).toBe(true);
    const last = long[long.length - 1].point;
    expect(Math.hypot(last.x - 1200, last.y - 600)).toBeLessThan(40);
  });

  test("no movement for a target under 2px away", () => {
    expect(trajectory({ x: 10, y: 10 }, { x: 11, y: 10 })).toEqual([]);
  });

  test("clampPoint keeps the pointer on screen", () => {
    expect(clampPoint({ x: -5, y: 900 }, { width: 100, height: 800 })).toEqual({ x: 0, y: 799 });
  });
});

describe("createHumanInput", () => {
  test("a click becomes a path of moves, a settle, and a 60-140 ms press", async () => {
    const r = rig();
    const at = { x: 400, y: 300, button: "left", clickCount: 1 };
    await r.dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "none" });
    await r.dispatch("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await r.dispatch("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    const mouse = r.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    const moves = mouse.filter((s) => s.params.type === "mouseMoved");
    expect(moves.length).toBeGreaterThan(5);
    const press = mouse.find((s) => s.params.type === "mousePressed")!;
    const release = mouse.find((s) => s.params.type === "mouseReleased")!;
    const held = release.at - press.at;
    expect(held).toBeGreaterThanOrEqual(PRESS_MS[0]);
    expect(held).toBeLessThanOrEqual(PRESS_MS[1]);
    // Off dead centre by a pixel or two, the same spot for press and release.
    expect(Math.abs((press.params.x as number) - 400)).toBeLessThan(6);
    expect(press.params.x).toBe(release.params.x);
  });

  test("keys are 30-110 ms apart", async () => {
    const r = rig();
    for (const key of "abcd") {
      await r.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
      await r.dispatch("Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    const downs = r.sent.filter((s) => s.params.type === "keyDown").map((s) => s.at);
    for (let i = 1; i < downs.length; i++) {
      expect(downs[i] - downs[i - 1]).toBeGreaterThanOrEqual(KEY_GAP_MS[0]);
      expect(downs[i] - downs[i - 1]).toBeLessThanOrEqual(KEY_GAP_MS[1]);
    }
  });

  test("off: events pass straight through, untouched and instant", async () => {
    const r = rig(false);
    const p = { type: "mousePressed", x: 400, y: 300, button: "left" };
    await r.dispatch("Input.dispatchMouseEvent", p);
    expect(r.sent).toHaveLength(1);
    expect(p.x).toBe(400);
    expect(r.now()).toBe(0);
  });

  test("other CDP methods are never paced", async () => {
    const r = rig();
    await r.dispatch("Runtime.evaluate", { expression: "1" });
    expect(r.sent).toHaveLength(1);
    expect(r.now()).toBe(0);
  });
});

describe("humanInputEnabled", () => {
  const never = () => false;
  test("off by default, on by itself for a tab that met a bot check", () => {
    expect(humanInputEnabled(7, {}, () => undefined, never)).toBe(false);
    expect(humanInputEnabled(7, {}, () => undefined, (t) => t === 7)).toBe(true);
    expect(humanInputEnabled(8, {}, () => undefined, (t) => t === 7)).toBe(false);
  });

  test("an explicit choice wins over the tab: env first, then the machine setting", () => {
    expect(humanInputEnabled(7, {}, () => true, never)).toBe(true);
    expect(humanInputEnabled(7, {}, () => false, () => true)).toBe(false);
    expect(humanInputEnabled(7, { CAST_BROWSER_HUMAN_INPUT: "0" }, () => true, () => true)).toBe(false);
    expect(humanInputEnabled(7, { CAST_BROWSER_HUMAN_INPUT: "on" }, () => false, never)).toBe(true);
  });
});

describe("a long type", () => {
  test("paces only the first keys of a burst, so 500 characters stay a few seconds", async () => {
    const r = rig();
    for (let i = 0; i < 500; i++) await r.dispatch("Input.dispatchKeyEvent", { type: "keyDown", text: "a" });
    expect(r.now()).toBeLessThan(KEY_PACED_BURST * KEY_GAP_MS[1]);
    expect(r.now()).toBeGreaterThan(0);
  });

  test("off, it sends every key at once", async () => {
    const r = rig(false);
    for (let i = 0; i < 500; i++) await r.dispatch("Input.dispatchKeyEvent", { type: "keyDown", text: "a" });
    expect(r.now()).toBe(0);
  });
});
