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
  }, 30_000);

  test("moves every frame of a tall entry's opening by a fraction of a px, never standing still between two moving frames", async () => {
    const [at, dur, full] = [10, 0.5, 277];
    const film = await mount(<FilmGrow at={at} dur={dur}><div data-h={full}>entry</div></FilmGrow>, at - 0.05);
    const seen: number[] = [];
    for (let t = at; t <= at + dur; t += 1 / 60) {
      await film.seek(t);
      seen.push(heightOf(film.host.firstElementChild as HTMLElement | null, full)!);
    }
    await film.unmount();
    // To the hundredth of a px: whole px would hold the content above still on some frames of the slow tail and step it 1px on others.
    seen.forEach((h) => expect(Math.abs(h * 100 - Math.round(h * 100)), `${h}`).toBeLessThan(1e-6));
    expect(seen.some((h) => !Number.isInteger(h))).toBe(true);
    // Away from its eased ends, every frame moves, and no frame moves twice as far as the one before it (no stair-steps).
    const steps = seen.slice(1).map((h, i) => h - seen[i]);
    steps.slice(3, -3).forEach((d, i) => {
      expect(d, `frame ${i + 4}`).toBeGreaterThan(0);
      expect(d, `frame ${i + 4}: ${steps.slice(0, i + 5).join(",")}`).toBeLessThanOrEqual(Math.max(3, steps[i + 2] * 2));
    });
  }, 30_000);

  test("measures a box that holds its children's margins, so the height it opens to is the height it rests at", async () => {
    // jsdom lays nothing out, so this pins the structure: a block child's margin collapses through a plain div and escapes offsetHeight, then reappears the frame the clip lifts.
    const film = await mount(<FilmGrow at={0} dur={0.5}><p data-h={40} style={{ margin: "12px 0" }}>entry</p></FilmGrow>, 0.2);
    const measured = film.host.querySelector("[data-h]")!.parentElement!;
    expect(measured.className).toContain("flow-root");
    await film.unmount();
  }, 30_000);
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
  }, 30_000);

  // Back-to-back cues: each state's height is read in the tick that draws it, and a crossing is whole before the next starts,
  // so no frame collapses below the smaller of two neighbouring states or jumps between them.
  for (const gap of [0.4, 0.3]) {
    test(`cues ${gap}s apart cross without a frame below either state (${gap === 0.4 ? "exactly its duration" : "sooner than it"})`, async () => {
      const cues = [20, 20 + gap, 20 + 2 * gap];
      const hs = [307, 318, 338, 300];
      const film = await mount(<FilmSwap cues={cues} dur={0.4} render={(step) => <div data-h={hs[step]} data-step={step}>state</div>} />, 19.9);
      const seen: { t: number; h: number }[] = [];
      for (let t = 19.9; t <= 20 + 3 * gap + 0.5; t += 1 / 60) {
        await film.seek(t);
        seen.push({ t, h: heightOf(film.host.firstElementChild as HTMLElement, Number(film.host.querySelector("[data-step]")!.getAttribute("data-h"))) ?? 0 });
      }
      await film.unmount();
      seen.forEach(({ t, h }, i) => {
        expect(h, `${t.toFixed(3)}`).toBeGreaterThanOrEqual(Math.min(...hs) - 0.5);
        if (i) expect(Math.abs(h - seen[i - 1].h), `${t.toFixed(3)}: ${seen[i - 1].h} -> ${h}`).toBeLessThanOrEqual(10);
      });
      expect(seen[seen.length - 1].h).toBe(hs[3]);
    }, 30_000);
  }

  // Two layouts whose rows do not line up (a list replaced by another) cross out, then in: the old one is gone before the new one
  // shows, each fading every frame, so their text never overlaps and nothing appears or vanishes at once.
  test("crosses through nothing with `through`: the old state fades out wholly before the new one fades in", async () => {
    const cue = 30;
    const film = await mount(<FilmSwap cues={[cue]} dur={0.4} through render={(step) => <div data-h={step ? 200 : 120} data-step={step}>state</div>} />, cue - 0.05);
    const frames: { a: number; b: number }[] = [];
    for (let t = cue; t <= cue + 0.65; t += 1 / 60) {
      await film.seek(t);
      const slots = [...film.host.firstElementChild!.children] as HTMLElement[];
      const op = (el?: HTMLElement) => (el && el.style.opacity !== "" ? Number(el.style.opacity) : 1);
      frames.push({ a: slots.length > 1 ? op(slots[0]) : 0, b: slots.length > 1 ? op(slots[1]) : 1 });
    }
    await film.unmount();
    frames.forEach(({ a, b }, i) => {
      expect(Math.min(a, b), `frame ${i}: ${a} ${b}`).toBeLessThan(0.02);
      if (i) {
        expect(Math.abs(a - frames[i - 1].a), `frame ${i}`).toBeLessThanOrEqual(0.17);
        expect(Math.abs(b - frames[i - 1].b), `frame ${i}`).toBeLessThanOrEqual(0.17);
      }
    });
    expect(frames[frames.length - 1].b).toBe(1);
  }, 30_000);
});
