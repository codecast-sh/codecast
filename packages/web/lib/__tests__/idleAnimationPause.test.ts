import { describe, expect, test } from "bun:test";
import { followWindowIdle } from "../idleAnimationPause";

type Fake = { playState: string; iterations: number; pauses: number; plays: number; pause(): void; play(): void; effect: { getComputedTiming(): { iterations: number } } | null };
const animation = (iterations: number, playState = "running"): Fake => {
  const a: Fake = {
    playState, iterations, pauses: 0, plays: 0,
    pause() { a.pauses++; a.playState = "paused"; },
    play() { a.plays++; a.playState = "running"; },
    effect: { getComputedTiming: () => ({ iterations }) },
  };
  return a;
};

function world(animations: Fake[]) {
  const docListeners = new Map<string, Set<(e: Event) => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  const state = { focused: true, visibility: "visible", attributeWrites: 0 };
  const doc = {
    hasFocus: () => state.focused,
    get visibilityState() { return state.visibility; },
    getAnimations: () => animations,
    addEventListener: (type: string, l: (e: Event) => void) => { (docListeners.get(type) ?? docListeners.set(type, new Set()).get(type)!).add(l); },
    removeEventListener: (type: string, l: (e: Event) => void) => { docListeners.get(type)?.delete(l); },
  };
  const win = {
    addEventListener: (type: string, l: () => void) => { (winListeners.get(type) ?? winListeners.set(type, new Set()).get(type)!).add(l); },
    removeEventListener: (type: string, l: () => void) => { winListeners.get(type)?.delete(l); },
  };
  const fire = (type: string) => { for (const l of winListeners.get(type) ?? []) l(); };
  const fireDoc = (type: string, event: unknown = {}) => { for (const l of docListeners.get(type) ?? []) l(event as Event); };
  return {
    doc, win, state,
    blur() { state.focused = false; fire("blur"); },
    focus() { state.focused = true; fire("focus"); },
    hide() { state.visibility = "hidden"; fireDoc("visibilitychange"); },
    show() { state.visibility = "visible"; fireDoc("visibilitychange"); },
    start(target: { getAnimations(): Fake[] }) { fireDoc("animationstart", { target }); },
    listening: (type: string) => (docListeners.get(type)?.size ?? 0) + (winListeners.get(type)?.size ?? 0),
  };
}

describe("followWindowIdle", () => {
  test("a window that loses focus pauses its endless animations and resumes them on the way back", () => {
    const pulse = animation(Infinity);
    const slideIn = animation(1);
    const w = world([pulse, slideIn]);
    followWindowIdle(w.doc, w.win);
    expect(pulse.pauses).toBe(0);

    w.blur();
    expect(pulse.playState).toBe("paused");
    // An animation that ends on its own is left to end.
    expect(slideIn.pauses).toBe(0);

    w.focus();
    expect(pulse.playState).toBe("running");
    expect(pulse.plays).toBe(1);
  });

  test("an animation the app paused itself stays paused", () => {
    const parked = animation(Infinity, "paused");
    const w = world([parked]);
    followWindowIdle(w.doc, w.win);
    w.blur();
    w.focus();
    expect(parked.pauses).toBe(0);
    expect(parked.plays).toBe(0);
    expect(parked.playState).toBe("paused");
  });

  test("an animation that starts while the window is away is paused as it starts", () => {
    const w = world([]);
    followWindowIdle(w.doc, w.win);
    w.blur();
    const late = animation(Infinity);
    w.start({ getAnimations: () => [late] });
    expect(late.playState).toBe("paused");
    w.focus();
    expect(late.playState).toBe("running");
    // Back in front, a new animation just runs.
    const fresh = animation(Infinity);
    w.start({ getAnimations: () => [fresh] });
    expect(fresh.pauses).toBe(0);
    expect(w.listening("animationstart")).toBe(0);
  });

  test("a window that opens in the background starts paused, and a hidden one counts as away", () => {
    const pulse = animation(Infinity);
    const w = world([pulse]);
    w.state.focused = false;
    followWindowIdle(w.doc, w.win);
    expect(pulse.playState).toBe("paused");
    w.focus();
    expect(pulse.playState).toBe("running");
    w.hide();
    expect(pulse.playState).toBe("paused");
    w.show();
    expect(pulse.playState).toBe("running");
  });

  test("a repeated blur pauses nothing twice, and uninstalling resumes what was held", () => {
    const pulse = animation(Infinity);
    const w = world([pulse]);
    const stop = followWindowIdle(w.doc, w.win);
    w.blur();
    w.blur();
    w.hide();
    expect(pulse.pauses).toBe(1);
    stop();
    expect(pulse.playState).toBe("running");
    expect(w.listening("focus") + w.listening("blur") + w.listening("visibilitychange") + w.listening("animationstart")).toBe(0);
  });

  test("an animation that throws (its element left the page) does not stop the others", () => {
    const gone = animation(Infinity);
    gone.pause = () => { throw new Error("detached"); };
    const pulse = animation(Infinity);
    const w = world([gone, pulse]);
    followWindowIdle(w.doc, w.win);
    expect(() => w.blur()).not.toThrow();
    expect(pulse.playState).toBe("paused");
  });
});
