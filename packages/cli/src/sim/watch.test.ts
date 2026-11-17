import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { actionsFor, hidForChar, sessionsOf, SimInputMapper, simWatchEngine, typeLines, type SimEngineDeps } from "./watch.js";
import { WatchOpenError, type FrameSourceHandlers, type WatchAction } from "../browser/watchSource.js";
import { runWatchSession, type WatchServerDeps } from "../browser/watchServer.js";
import { relaySource } from "../browser/watchRelay.js";
import { activityPath, noteSimAction, readSimAction } from "./activity.js";
import { heldBySession } from "./pool.js";
import type { SimStream, SimStreamHandlers } from "./simstream.js";
import { pollUntil } from "../test-helpers/pollUntil.js";

const SCREEN = { width: 400, height: 800 };

/** A mapper whose timers the test fires by hand. */
function mapper() {
  const sent: string[] = [];
  let pending: (() => void) | null = null;
  const m = new SimInputMapper((l) => sent.push(l), () => SCREEN, {
    set: ((fn: () => void) => ((pending = fn), 1)) as unknown as typeof setTimeout,
    clear: (() => { pending = null; }) as unknown as typeof clearTimeout,
  });
  return { m, sent, settle: () => { const fn = pending; pending = null; fn?.(); } };
}

describe("sessionsOf", () => {
  test("takes session and env keys once each, never pane keys", () => {
    expect(sessionsOf(["session:u1", "env:u1", "pane:%3@default", "env:u2"])).toEqual(["u1", "u2"]);
  });
});

describe("typing", () => {
  test("letters, digits and shifted characters map to US HID keys", () => {
    expect(hidForChar("a")).toEqual([4, false]);
    expect(hidForChar("Z")).toEqual([29, true]);
    expect(hidForChar("1")).toEqual([30, false]);
    expect(hidForChar("0")).toEqual([39, false]);
    expect(hidForChar("?")).toEqual([56, true]);
    expect(hidForChar("é")).toBeNull();
  });

  test("a capital holds shift around its key; what cannot be typed is skipped", () => {
    expect(typeLines("Hi é")).toEqual(["keydown 225", "key 11", "keyup 225", "key 12", "key 44"]);
  });
});

describe("SimInputMapper", () => {
  test("a click is a finger down and up at the same point, in points", () => {
    const { m, sent } = mapper();
    m.input({ kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.25, button: "left" });
    m.input({ kind: "mouse", type: "mouseReleased", nx: 0.5, ny: 0.25, button: "left" });
    expect(sent).toEqual(["down 200 200", "up 200 200"]);
  });

  test("a drag moves the finger live; moves with no finger down are hover and send nothing", () => {
    const { m, sent } = mapper();
    m.input({ kind: "mouse", type: "mouseMoved", nx: 0.1, ny: 0.1, button: "none" });
    m.input({ kind: "mouse", type: "mousePressed", nx: 0, ny: 0.5, button: "left" });
    m.input({ kind: "mouse", type: "mouseMoved", nx: 0.5, ny: 0.5, button: "none" });
    m.input({ kind: "mouse", type: "mouseReleased", nx: 1, ny: 0.5, button: "left" });
    m.input({ kind: "mouse", type: "mouseReleased", nx: 1, ny: 0.5, button: "left" });
    expect(sent).toEqual(["down 0 400", "down 200 400", "up 400 400"]);
  });

  test("right and middle clicks do nothing: a touchscreen has one kind of touch", () => {
    const { m, sent } = mapper();
    m.input({ kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.5, button: "right" });
    expect(sent).toEqual([]);
  });

  test("a trackpad scroll is a finger moved against the wheel, lifted once it settles", () => {
    const { m, sent, settle } = mapper();
    m.input({ kind: "mouse", type: "mouseWheel", nx: 0.5, ny: 0.5, deltaY: 30 });
    m.input({ kind: "mouse", type: "mouseWheel", nx: 0.5, ny: 0.5, deltaY: 30 });
    expect(sent).toEqual(["down 200 400", "down 200 370", "down 200 340"]);
    settle();
    expect(sent.at(-1)).toBe("up 200 340");
  });

  test("a long scroll lifts at the edge and lands again where it started", () => {
    const { m, sent } = mapper();
    m.input({ kind: "mouse", type: "mouseWheel", nx: 0.5, ny: 0.5, deltaY: 395 });
    expect(sent).toEqual(["down 200 400", "up 200 8", "down 200 400"]);
  });

  test("named keys, typed text and hardware buttons", () => {
    const { m, sent } = mapper();
    m.input({ kind: "key", type: "keyDown", key: "Enter" });
    m.input({ kind: "key", type: "keyUp", key: "Enter" });
    m.input({ kind: "insertText", text: "ok" });
    m.input({ kind: "button", button: "home" });
    expect(sent).toEqual(["key 40", "key 18", "key 14", "button home"]);
  });

  test("no touches before the screen size is known", () => {
    const sent: string[] = [];
    const m = new SimInputMapper((l) => sent.push(l), () => null);
    m.input({ kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.5, button: "left" });
    expect(sent).toEqual([]);
  });
});

describe("actionsFor", () => {
  test("an agent tap is the browser watch's move, down, up at 0..1 of the screen", () => {
    expect(actionsFor({ kind: "tap", x: 200, y: 200, at: 5 }, SCREEN, { x: 0.5, y: 0.5 }).map((a) => [a.kind, a.x, a.y])).toEqual([
      ["move", 0.5, 0.25], ["down", 0.5, 0.25], ["up", 0.5, 0.25],
    ]);
  });

  test("a swipe travels from start to end; typing captions at the cursor; a button draws nothing", () => {
    expect(actionsFor({ kind: "swipe", x: 0, y: 400, x2: 400, y2: 400, at: 1 }, SCREEN, { x: 0, y: 0 }).map((a) => a.kind)).toEqual(["move", "down", "move", "up"]);
    expect(actionsFor({ kind: "type", text: "hi", at: 1 }, SCREEN, { x: 0.2, y: 0.3 })).toEqual([{ type: "action", kind: "type", x: 0.2, y: 0.3, text: "hi", at: 1 }]);
    expect(actionsFor({ kind: "button", name: "home", at: 1 }, SCREEN, { x: 0, y: 0 })).toEqual([]);
  });
});

/** A fake simulator: the test pushes frames and reads what was sent to it. */
function fakeSim(over: Partial<SimEngineDeps> = {}) {
  const sent: string[] = [];
  let wakes = 0;
  let stopped = false;
  let handlers: SimStreamHandlers | null = null;
  let action: ReturnType<SimEngineDeps["readAction"]> = null;
  let now = 1_000;
  const deps: SimEngineDeps = {
    held: (s) => (s.includes("u1") ? { udid: "UDID-1", name: "iPhone 17 Pro" } : null),
    available: () => true,
    booted: () => true,
    async start(_udid, _opts, h) {
      handlers = h;
      const stream: SimStream = {
        interactive: true,
        send: (l) => sent.push(l),
        wake: () => { wakes++; },
        stop: () => { stopped = true; },
      };
      return stream;
    },
    readAction: () => action,
    now: () => now,
    ...over,
  };
  return {
    deps, sent,
    get wakes() { return wakes; },
    get stopped() { return stopped; },
    get handlers() { return handlers!; },
    setAction(a: typeof action) { action = a; },
    advance(ms: number) { now += ms; },
  };
}

const openOpts = (over: Partial<Parameters<ReturnType<typeof simWatchEngine>["open"]>[1]> = {}) => ({
  minIntervalMs: 0, shouldHold: () => false, quality: 60, maxWidth: 1280, maxHeight: 1280, signal: new AbortController().signal, ...over,
});

function collect() {
  const frames: string[] = [];
  const actions: WatchAction[] = [];
  let gone = 0;
  const h: FrameSourceHandlers = {
    onFrame: (f) => frames.push(f.data),
    onTab: () => {},
    onGone: () => { gone++; },
    onAction: (a) => actions.push(a),
  };
  return { h, frames, actions, get gone() { return gone; } };
}

describe("simWatchEngine", () => {
  test("resolves the device the session's lock names, and says which absence it is", () => {
    expect(simWatchEngine(fakeSim().deps).resolveTab(["session:u1"])).toEqual({ tabId: "UDID-1" });
    expect(simWatchEngine(fakeSim().deps).resolveTab(["session:u2"])).toEqual({ error: "no-sim" });
    expect(simWatchEngine(fakeSim({ available: () => false }).deps).resolveTab(["session:u2"])).toEqual({ error: "no-simulators" });
  });

  test("a device that is not booted fails with its own reason", async () => {
    const sim = fakeSim({ booted: () => false });
    const err = await simWatchEngine(sim.deps).open("UDID-1", openOpts(), collect().h).catch((e) => e);
    expect(err).toBeInstanceOf(WatchOpenError);
    expect((err as WatchOpenError).code).toBe("sim-not-booted");
  });

  test("touches go out in points once the helper reports the screen", async () => {
    const sim = fakeSim();
    const src = await simWatchEngine(sim.deps).open("UDID-1", openOpts(), collect().h);
    sim.handlers.onScreen!({ widthPx: 1200, heightPx: 2400, scale: 3 });
    src.input!({ kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.5, button: "left" });
    expect(sim.sent).toEqual(["down 200 400"]);
    expect(src.tab.id).toBe("UDID-1");
    src.stop();
    expect(sim.stopped).toBe(true);
  });

  test("a frame held back by a slow viewer still goes out once it drains", async () => {
    const sim = fakeSim();
    let hold = true;
    const c = collect();
    const src = await simWatchEngine(sim.deps).open("UDID-1", openOpts({ shouldHold: () => hold }), c.h);
    sim.handlers.onFrame({ data: "A", width: 1, height: 1 });
    sim.handlers.onFrame({ data: "B", width: 1, height: 1 });
    expect(c.frames).toEqual([]);
    hold = false;
    await pollUntil(() => c.frames.length > 0, "the held frame");
    expect(c.frames).toEqual(["B"]);
    src.stop();
  });

  test("the agent's new action becomes cursor actions and wakes the stream; the one before the stream does not replay", async () => {
    const sim = fakeSim();
    sim.setAction({ kind: "tap", x: 1, y: 1, at: 500 });
    const c = collect();
    const src = await simWatchEngine(sim.deps).open("UDID-1", openOpts(), c.h);
    sim.handlers.onScreen!({ widthPx: 1200, heightPx: 2400, scale: 3 });
    sim.setAction({ kind: "tap", x: 200, y: 400, at: 2_000 });
    await pollUntil(() => c.actions.length >= 3, "the agent's tap");
    expect(c.actions.map((a) => [a.kind, a.x, a.y])).toEqual([["move", 0.5, 0.5], ["down", 0.5, 0.5], ["up", 0.5, 0.5]]);
    expect(sim.wakes).toBe(1);
    src.stop();
  });

  test("the helper exiting is the device going away", async () => {
    const sim = fakeSim();
    const c = collect();
    await simWatchEngine(sim.deps).open("UDID-1", openOpts(), c.h);
    sim.handlers.onExit("simulator shut down");
    expect(c.gone).toBe(1);
  });
});

describe("runWatchSession with source sim", () => {
  const sink = () => {
    const msgs: Record<string, unknown>[] = [];
    let end: Record<string, unknown> | null = null;
    return { msgs, get end() { return end; }, sink: { send: (m: Record<string, unknown>) => msgs.push(m), finish: (m: Record<string, unknown>) => { end = m; }, backlogged: () => false } };
  };
  const browserEngine = { resolveTab: () => { throw new Error("the browser engine must not be asked"); }, open: async () => { throw new Error("no"); } };

  test("streams from the simulator engine, never the browser's", async () => {
    const sim = fakeSim();
    const s = sink();
    const deps: WatchServerDeps = { engine: browserEngine as any, loadSimEngine: async () => simWatchEngine(sim.deps), paneIdFor: async () => null };
    const h = runWatchSession({ source: "sim", session_uuid: "u1", minIntervalMs: 0, control: true, quality: 60, maxDim: 1280, log: () => {} }, s.sink, deps);
    await pollUntil(() => s.msgs.some((m) => m.type === "ready"), "ready");
    expect(s.msgs.find((m) => m.type === "ready")).toMatchObject({ targetId: "UDID-1", title: "iPhone 17 Pro", control: true });
    h.stop();
  });

  test("a session holding no simulator gets that sentence", async () => {
    const s = sink();
    const deps: WatchServerDeps = { engine: browserEngine as any, loadSimEngine: async () => simWatchEngine(fakeSim().deps), paneIdFor: async () => null };
    runWatchSession({ source: "sim", session_uuid: "u9", minIntervalMs: 0, control: true, quality: 60, maxDim: 1280, log: () => {} }, s.sink, deps);
    await pollUntil(() => s.end !== null, "the ending");
    expect(s.end).toEqual({ type: "error", code: "no-sim", message: "this session holds no simulator" });
  });

  test("a daemon with no simulator engine says so instead of streaming the browser", async () => {
    const s = sink();
    runWatchSession({ source: "sim", session_uuid: "u1", minIntervalMs: 0, control: true, quality: 60, maxDim: 1280, log: () => {} }, s.sink, { engine: browserEngine as any, paneIdFor: async () => null });
    await pollUntil(() => s.end !== null, "the ending");
    expect(s.end).toMatchObject({ type: "error", code: "no-simulators" });
  });
});

describe("relaySource", () => {
  test("a sim: key streams the simulator, anything else the browser", () => {
    expect(relaySource("sim:218444ea")).toBe("sim");
    expect(relaySource("218444ea")).toBe("browser");
    expect(relaySource("cc-agent-1")).toBe("browser");
  });
});

describe("activity and the pool lookup", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sim-watch-test-"));

  test("the last action round-trips, typed text capped", () => {
    const d = dir();
    noteSimAction("U", { kind: "type", text: "x".repeat(500) }, d, 42);
    expect(readSimAction("U", d)).toEqual({ kind: "type", text: "x".repeat(200), at: 42 });
    noteSimAction("U", { kind: "tap", x: 1, y: 2 }, d, 43);
    expect(readSimAction("U", d)).toEqual({ kind: "tap", x: 1, y: 2, at: 43 });
  });

  test("a malformed action reads as none", () => {
    const d = dir();
    fs.writeFileSync(activityPath("U", d), JSON.stringify({ kind: "tap", x: "1", y: 2, at: 1 }));
    expect(readSimAction("U", d)).toBeNull();
    expect(readSimAction("missing", d)).toBeNull();
  });

  test("heldBySession finds the live lock naming the session, and ignores a dead holder's", () => {
    const d = dir();
    const lock = (udid: string, pid: number, session: string) => {
      fs.mkdirSync(path.join(d, `${udid}.lock`));
      fs.writeFileSync(path.join(d, `${udid}.lock`, "pid"), `${pid}\n`);
      fs.writeFileSync(path.join(d, `${udid}.lock`, "session"), `${session}\n`);
    };
    lock("A", 999_999, "u1");
    lock("B", process.pid, "u1");
    const pool = [{ udid: "A", name: "a" }, { udid: "B", name: "b" }, { udid: "C", name: "c" }];
    expect(heldBySession(["u1"], pool, d)?.udid).toBe("B");
    expect(heldBySession(["u2"], pool, d)).toBeUndefined();
    expect(heldBySession([], pool, d)).toBeUndefined();
  });
});
