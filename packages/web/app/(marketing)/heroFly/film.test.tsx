import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { replaceGlobals } from "../../../test-helpers/globals";

// FilmGrow and FilmSwap, stepped through their cues at 60fps the way the film
// plays: what they add opens its room from nothing and grows without a frame
// that pops, and the settled view is never remounted across a cue. jsdom lays
// nothing out, so an element's height is the `data-h` of the view inside it.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test/", pretendToBeVisual: true });
const w = dom.window as unknown as Window & typeof globalThis;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    const n = this.matches("[data-h]") ? this : this.querySelector("[data-h]");
    return n ? Number(n.getAttribute("data-h")) : 0;
  },
});

const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  localStorage: w.localStorage,
  sessionStorage: w.sessionStorage,
  Element: w.Element,
  HTMLElement: w.HTMLElement,
  Node: w.Node,
  MutationObserver: w.MutationObserver,
  ResizeObserver: NoopObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { createFilmClock, FilmClockContext } = await import("./filmClock");
const { FilmGrow, FilmSwap } = await import("./film");
const act: <T>(fn: () => T | Promise<T>) => Promise<T> = (React as any).act;

async function mount(node: React.ReactNode, t0: number) {
  const clock = createFilmClock(t0);
  const host = w.document.createElement("div");
  w.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<FilmClockContext.Provider value={clock}>{node}</FilmClockContext.Provider>));
  return {
    host,
    seek: (t: number) => act(async () => clock.set(t)),
    unmount: () => act(async () => root.unmount()),
  };
}

/** The wrapper's height at a frame: its inline height while it opens, the content's own once it is laid out as normal. */
const heightOf = (wrap: HTMLElement | null, full: number) => (!wrap ? null : wrap.style.height ? parseFloat(wrap.style.height) : full);

describe("FilmGrow", () => {
  test("opens from nothing at its cue and grows every frame, with no frame that pops", async () => {
    const [at, dur, full] = [10, 0.5, 100];
    const film = await mount(<FilmGrow at={at} dur={dur}><div data-h={full}>entry</div></FilmGrow>, at - 0.1);
    const seen: number[] = [];
    for (let t = at - 0.1; t <= at + dur + 0.1; t += 1 / 60) {
      await film.seek(t);
      const h = heightOf(film.host.firstElementChild as HTMLElement | null, full);
      if (h !== null) seen.push(h);
    }
    await film.unmount();
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(full);
    seen.forEach((h, i) => {
      if (i === 0) return;
      expect(h, `frame ${i}`).toBeGreaterThanOrEqual(seen[i - 1]);
      // Eased over 30 frames: no frame takes more than a fifth of the room.
      expect(h - seen[i - 1], `frame ${i}: ${seen[i - 1]} -> ${h}`).toBeLessThanOrEqual(full / 5);
    });
  });
});

describe("FilmSwap", () => {
  test("eases its height across a cue and keeps the settled view mounted", async () => {
    const [cue, from, to] = [20, 100, 160];
    const film = await mount(<FilmSwap cues={[cue]} render={(step) => <div data-h={step ? to : from} data-step={step}>state</div>} />, cue - 0.1);
    const first = film.host.querySelector("[data-step]");
    const seen: number[] = [];
    for (let t = cue - 0.1; t <= cue + 0.6; t += 1 / 60) {
      await film.seek(t);
      seen.push(heightOf(film.host.firstElementChild as HTMLElement, Number(film.host.querySelector("[data-step]")!.getAttribute("data-h"))) ?? 0);
    }
    // The settled slot's view is the same node, now showing the new state.
    expect(film.host.querySelector("[data-step]")).toBe(first);
    expect(first!.getAttribute("data-step")).toBe("1");
    await film.unmount();
    expect(seen[0]).toBe(from);
    expect(seen[seen.length - 1]).toBe(to);
    seen.forEach((h, i) => {
      if (i === 0) return;
      expect(h, `frame ${i}`).toBeGreaterThanOrEqual(seen[i - 1]);
      expect(h - seen[i - 1], `frame ${i}: ${seen[i - 1]} -> ${h}`).toBeLessThanOrEqual((to - from) / 5);
    });
  });
});
