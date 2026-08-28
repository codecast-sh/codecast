// THE STRIP AND THE DOCK ARE ONE NODE.
//
// That is the whole claim of the morph, and it is the one thing a test can
// hold: if the element the strip drew is the element the dock draws, then the
// upgrade IS a layout animation of one surface, and no amount of later
// refactoring can quietly turn it back into a fade between two mounts.
//
// The rest of what is pinned here follows from it: one root in the document at
// a time, an invert that maps the new box back onto the old rectangle, an
// outgoing layer that lives exactly as long as the animation, and reduced
// motion meaning no animation at all rather than a fast one.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { morphKeyframes } from "../calls/useSurfaceMorph";
import { surfaceShape } from "../calls/CallSurfaceRoot";

// ── a browser that can animate ──────────────────────────────────────────────

type FakeAnimation = {
  keyframes: Keyframe[];
  target: Element;
  finish: () => void;
  cancelled: boolean;
};

let animations: FakeAnimation[] = [];
let reducedMotion = false;
/** What each element reports as its rectangle, by the shape on screen. */
const rects: Record<string, { left: number; top: number; width: number; height: number }> = {};

const hadGlobals = new Map<string, { had: boolean; was: unknown }>();

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as any;
  for (const k of ["window", "document", "navigator", "Element", "HTMLElement", "Node", "MutationObserver", "ResizeObserver", "getComputedStyle"]) {
    hadGlobals.set(k, { had: k in g, was: g[k] });
  }
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.MutationObserver = dom.window.MutationObserver;
  g.getComputedStyle = dom.window.getComputedStyle;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(dom.window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
  dom.window.matchMedia = ((q: string) => ({
    matches: reducedMotion && q.includes("reduced-motion"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as any;

  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };

  // jsdom has no layout, so every element would measure zero. The root reports
  // the rectangle of whichever shape it is CURRENTLY showing, read off its own
  // attribute — which is what makes the invert a real number, and what makes
  // the "First" measurement honest: during the render phase the attribute is
  // still the old shape's, exactly as the pixels on screen still are.
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const r = el.classList?.contains("call-surface-root")
      ? rects[el.getAttribute("data-shape") ?? ""]
      : null;
    const box = r ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    } as DOMRect;
  };

  dom.window.Element.prototype.animate = function (this: Element, frames: Keyframe[]) {
    const listeners: Record<string, (() => void)[]> = {};
    const anim: any = {
      keyframes: frames,
      target: this,
      cancelled: false,
      addEventListener: (name: string, fn: () => void) => {
        (listeners[name] ??= []).push(fn);
      },
      removeEventListener: () => {},
      cancel() {
        anim.cancelled = true;
        for (const fn of listeners.cancel ?? []) fn();
      },
      finish() {
        for (const fn of listeners.finish ?? []) fn();
      },
    };
    animations.push(anim);
    return anim;
  } as any;
});

afterAll(() => {
  const g = globalThis as any;
  for (const [k, { had, was }] of hadGlobals) {
    if (had) g[k] = was;
    else delete g[k];
  }
});

afterEach(() => {
  animations = [];
  reducedMotion = false;
  // A failed assertion skips the unmount at the end of its test, and the root
  // is portaled to the body — so the next test would find the last one's
  // corpse and fail for the wrong reason.
  document.body.innerHTML = "";
});

// ── the surface under test ──────────────────────────────────────────────────

const STRIP = { left: 844, top: 590, width: 420, height: 130 };
const DOCK = { left: 944, top: 470, width: 320, height: 250 };
Object.assign(rects, { walkie: STRIP, window: DOCK, pill: DOCK, stage: DOCK });

async function mountRoot() {
  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { CallSurfaceRoot } = await import("../calls/CallSurfaceRoot");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);

  const draw = async (shape: string, child: string | null) => {
    await act(async () => {
      reactRoot.render(
        React.createElement(
          CallSurfaceRoot as any,
          { shape },
          child ? React.createElement("div", { id: child }, child) : null,
        ),
      );
    });
  };

  return {
    draw,
    act,
    root: () => document.querySelector(".call-surface-root") as HTMLElement | null,
    roots: () => document.querySelectorAll(".call-surface-root").length,
    leaving: () => document.querySelector(".call-surface-leaving"),
    async unmount() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
}

describe("the upgrade is one node changing shape", () => {
  test("the element the strip drew is the element the dock draws", async () => {
    const h = await mountRoot();
    await h.draw("walkie", "strip");
    const before = h.root();
    expect(before).not.toBeNull();
    expect(h.roots()).toBe(1);

    await h.draw("window", "dock");
    expect(h.root()).toBe(before);
    expect(h.roots()).toBe(1);
    expect(before!.getAttribute("data-shape")).toBe("window");
    await h.unmount();
  });

  test("the invert puts the new box back on the strip's rectangle, and plays out of it", async () => {
    const h = await mountRoot();
    await h.draw("walkie", "strip");
    await h.draw("window", "dock");

    const root = animations.find((a) => (a.target as HTMLElement).classList.contains("call-surface-root"));
    expect(root).toBeDefined();
    const [first, last] = root!.keyframes as any[];
    // First: the strip's own size, offset by the distance between the two
    // corners. Last: the dock, exactly where the layout already put it.
    expect(first.width).toBe(`${STRIP.width}px`);
    expect(first.height).toBe(`${STRIP.height}px`);
    expect(last.width).toBe(`${DOCK.width}px`);
    expect(last.height).toBe(`${DOCK.height}px`);
    expect(last.transform).toBe("none");
    await h.unmount();
  });

  test("the outgoing surface lives exactly as long as the animation", async () => {
    const h = await mountRoot();
    await h.draw("walkie", "strip");
    await h.draw("window", "dock");
    expect(h.leaving()).not.toBeNull();
    expect(h.leaving()!.textContent).toBe("strip");

    const root = animations.find((a) => (a.target as HTMLElement).classList.contains("call-surface-root"))!;
    await h.act(async () => root.finish());
    expect(h.leaving()).toBeNull();
    expect(h.roots()).toBe(1);
    await h.unmount();
  });

  test("reduced motion is no animation, not a fast one", async () => {
    reducedMotion = true;
    const h = await mountRoot();
    await h.draw("walkie", "strip");
    await h.draw("window", "dock");
    expect(animations.length).toBe(0);
    expect(h.leaving()).toBeNull();
    // And the new surface is simply there.
    expect(h.root()!.getAttribute("data-shape")).toBe("window");
    expect(document.querySelector("#dock")).not.toBeNull();
    await h.unmount();
  });

  test("the stage grows out of the dock's rectangle rather than appearing over it", async () => {
    const h = await mountRoot();
    await h.draw("window", "dock");
    const before = h.root();
    // The stage draws its own full-screen surface, so the root goes empty —
    // and it is still the same node, so the collapse morphs back into it.
    await h.draw("stage", null);
    expect(h.root()).toBe(before);
    expect(animations.length).toBeGreaterThan(0);
    await h.unmount();
  });
});

describe("the geometry", () => {
  const strip = { right: 16, bottom: 80, width: 420, height: 130 };
  const dock = { right: 16, bottom: 80, width: 320, height: 250 };

  test("a shared corner means the box grows in place: no travel at all", () => {
    const { root } = morphKeyframes(strip, dock);
    expect((root[0] as any).transform).toBe("translate(0px, 0px)");
  });

  test("a dock the person dragged away travels back from where the strip was", () => {
    const dragged = { ...dock, right: 400, bottom: 300 };
    const { root } = morphKeyframes(strip, dragged);
    // The strip's corner is 384px to the right of the dragged dock's and 220px
    // below it, which is where the animation starts.
    expect((root[0] as any).transform).toBe("translate(384px, 220px)");
  });

  test("each layer carries the scale that makes it look like the other one's box", () => {
    const { incoming, leaving } = morphKeyframes(strip, dock);
    expect((incoming[0] as any).transform).toBe(`scale(${420 / 320}, ${130 / 250})`);
    expect((incoming[1] as any).opacity).toBe(1);
    expect((leaving[1] as any).transform).toBe(`scale(${320 / 420}, ${250 / 130})`);
    expect((leaving[1] as any).opacity).toBe(0);
  });

  test("a zero rectangle never divides by itself", () => {
    const { incoming } = morphKeyframes({ right: 0, bottom: 0, width: 0, height: 0 }, dock);
    expect((incoming[0] as any).transform).toBe("scale(1, 1)");
  });
});

describe("the pin is a shape, not a surface", () => {
  test("every surface and pin lands on exactly one box", () => {
    expect(surfaceShape("walkie", true)).toBe("walkie");
    expect(surfaceShape("walkie", false)).toBe("walkie");
    expect(surfaceShape("stage", true)).toBe("stage");
    expect(surfaceShape("dock", true)).toBe("window");
    expect(surfaceShape("dock", false)).toBe("pill");
  });
});
