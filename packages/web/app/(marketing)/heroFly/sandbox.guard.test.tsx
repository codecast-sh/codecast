import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { replaceGlobals } from "../../../test-helpers/globals";

// The proof that the hero is isolated from the visitor's app (ARCHITECTURE.md
// section 1, item 7). It mounts every chapter the registry holds inside the
// real HeroSandbox, with the real store module loaded, steps the film clock
// across the whole timeline, fires every `data-hero-live` interaction at each
// chapter's hold, and then checks that nothing reached the app:
//   (a) every top-level store key is the same reference as before
//   (b) no IndexedDB write, outbox entry or server dispatch was made
//   (c) window/document listeners were added only for allowlisted types
//   (d) the real Convex client was never asked to watch a query
//   (e) <html>'s classes are untouched
//   (f) nothing was written to localStorage
// and that no part failed into its boundary. New chapters and parts are
// picked up through the registry (chapters/contract.test.ts keeps the
// registry equal to the files), so a builder never edits this test.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test/", pretendToBeVisual: true });
const w = dom.window as unknown as Window & typeof globalThis;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
w.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof w.matchMedia;
(w as any).IntersectionObserver ??= NoopObserver;
(w as any).ResizeObserver ??= NoopObserver;
w.HTMLElement.prototype.scrollIntoView ??= () => {};

const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  location: w.location,
  localStorage: w.localStorage,
  sessionStorage: w.sessionStorage,
  Element: w.Element,
  HTMLElement: w.HTMLElement,
  HTMLInputElement: w.HTMLInputElement,
  HTMLTextAreaElement: w.HTMLTextAreaElement,
  SVGElement: w.SVGElement,
  Node: w.Node,
  Text: w.Text,
  DocumentFragment: w.DocumentFragment,
  Event: w.Event,
  MouseEvent: w.MouseEvent,
  KeyboardEvent: w.KeyboardEvent,
  PointerEvent: (w as any).PointerEvent ?? w.MouseEvent,
  MutationObserver: w.MutationObserver,
  IntersectionObserver: (w as any).IntersectionObserver,
  ResizeObserver: (w as any).ResizeObserver,
  getComputedStyle: w.getComputedStyle.bind(w),
  matchMedia: w.matchMedia.bind(w),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Imported after the DOM exists, the way the app loads them.
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConvexReactClient } = await import("convex/react");
const { useInboxStore } = await import("../../../store/inboxStore");
const { HeroSandbox } = await import("./sandbox");
const { World } = await import("./surfaces");
const { createFilmClock, FilmClockContext } = await import("./filmClock");
const { loadAllChapters } = await import("./chapters");
const { DURATION, SCENES, SURFACES } = await import("./world");
const { MemoryRouter } = await import("react-router");
const act: <T>(fn: () => T | Promise<T>) => Promise<T> = (React as any).act;

/**
 * Listener types the hero may add to window or document. Every addition needs
 * a reason here; key listeners never qualify (the hero takes no page keys).
 *   resize, scroll       layout reads
 *   visibilitychange     pausing while the tab is hidden
 *   selectionchange      React DOM's own root listener (createRoot adds it)
 *   beforeunload,        module-level teardown in lib/calls/callManager.ts,
 *   pagehide             lib/calls/walkie.ts and lib/terminal/termSessions.ts,
 *                        loaded through real views; they act only during a
 *                        live call or terminal session, which the hero never starts
 */
const LISTENER_ALLOWLIST = new Set<string>(["resize", "scroll", "visibilitychange", "selectionchange", "beforeunload", "pagehide"]);

const STEP = 0.25;
const store = useInboxStore as any;

describe("hero sandbox isolation", () => {
  test("the whole film, every live interaction, touches nothing of the app's", async () => {
    // Let module boot settle before taking the baseline.
    await act(async () => new Promise((r) => setTimeout(r, 50)));

    const idbWrites: unknown[] = [];
    const enqueued: unknown[] = [];
    const dispatched: unknown[] = [];
    store.getState()._setIDBWrite((...args: unknown[]) => void idbWrites.push(args));
    store.getState()._setOutbox(async (e: unknown) => void enqueued.push(e), async () => {}, async () => []);
    store.getState()._setDispatch(async (...args: unknown[]) => void dispatched.push(args));
    const before = { ...store.getState() };

    const listeners: string[] = [];
    const winAdd = spyOn(w, "addEventListener").mockImplementation(function (this: unknown, type: string) {
      listeners.push(`window:${type}`);
    } as any);
    const docAdd = spyOn(w.document, "addEventListener").mockImplementation(function (this: unknown, type: string) {
      listeners.push(`document:${type}`);
    } as any);
    const watch = spyOn(ConvexReactClient.prototype, "watchQuery");
    const setItem = spyOn(w.Storage.prototype, "setItem");
    const errors: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    w.document.documentElement.className = "dark minimal-style";
    const chapters = await loadAllChapters();
    const clock = createFilmClock(0);
    const host = w.document.createElement("div");
    w.document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        // The page always has a router around the hero (the app's, or the
        // prerender's); a second one inside HeroSandbox would throw.
        <MemoryRouter>
          <HeroSandbox>
            <FilmClockContext.Provider value={clock}>
              <World chapters={chapters} now={Date.UTC(2026, 8, 30, 12)} />
            </FilmClockContext.Provider>
          </HeroSandbox>
        </MemoryRouter>,
      );
    });

    const holds = SCENES.map((s) => s.hold + 1);
    for (let t = 0; t < DURATION; t += STEP) {
      await act(async () => clock.set(t));
      if (holds.some((h) => h >= t && h < t + STEP)) {
        for (const el of host.querySelectorAll<HTMLElement>("[data-hero-live]")) {
          await act(async () => {
            if (el instanceof w.HTMLInputElement || el instanceof w.HTMLTextAreaElement) {
              el.focus();
              el.value = "webhook retry";
              el.dispatchEvent(new w.Event("input", { bubbles: true }));
            } else {
              el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
            }
          });
        }
      }
    }

    // Every surface and region rendered, and no part fell into its boundary.
    for (const s of SURFACES) for (const name of Object.keys(s.regions)) expect(host.querySelector(`[data-region="${s.id}.${name}"]`), `${s.id}.${name}`).not.toBeNull();
    expect(errors.filter((e) => e.includes("ErrorBoundary:HeroFlythrough")), "no part failed").toEqual([]);

    await act(async () => root.unmount());
    host.remove();

    const after = store.getState();
    const changed = Object.keys(before).filter((k) => !Object.is(before[k], after[k]));
    expect(changed, "(a) store keys changed").toEqual([]);
    expect(idbWrites.length, "(b) IndexedDB writes").toBe(0);
    expect(enqueued.length, "(b) outbox entries").toBe(0);
    expect(dispatched.length, "(b) dispatches").toBe(0);
    expect(listeners.filter((l) => !LISTENER_ALLOWLIST.has(l.split(":")[1])), "(c) listeners outside the allowlist").toEqual([]);
    expect(watch).not.toHaveBeenCalled();
    expect(w.document.documentElement.className, "(e) html classes").toBe("dark minimal-style");
    expect(setItem).not.toHaveBeenCalled();

    for (const spy of [winAdd, docAdd, watch, setItem, consoleError]) spy.mockRestore();
  }, 120_000);
});
