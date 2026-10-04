import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/calls" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const { useMediaMoment, litLineSig } = await import("../useMediaMoment");

// A player reports its time about four times a second; the call page renders
// only when the line it lights moves. A turn is one speaker's run of lines,
// often minutes long, so the gate is the line: gated on the turn alone, the
// lit line froze on the turn's first and the thread never followed inside it.
const turns = [
  {
    t0: 0,
    segments: [
      { seq: 1, t0: 0, t1: 5_000 },
      { seq: 2, t0: 6_000, t1: 10_000 },
    ],
  },
  { t0: 20_000, segments: [{ seq: 3, t0: 20_000, t1: 24_000 }] },
];

function mount() {
  const seen: { renders: number; hook: ReturnType<typeof useMediaMoment> | null } = { renders: 0, hook: null };
  function Probe() {
    seen.renders += 1;
    seen.hook = useMediaMoment(turns);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  const report = (ms: number, playing: boolean) => act(() => seen.hook!.onTime(ms, playing));
  return { seen, report, unmount: () => act(() => root.unmount()) };
}

test("playing on renders when the lit line moves inside a turn, and not between", () => {
  const { seen, report, unmount } = mount();
  report(1_000, true);
  const first = seen.renders;
  expect(seen.hook!.at).toEqual({ ms: 1_000, playing: true });
  report(1_250, true);
  expect(seen.renders).toBe(first);
  // Line 2 of the same turn: the page must hear it.
  report(7_000, true);
  expect(seen.renders).toBe(first + 1);
  expect(seen.hook!.at?.ms).toBe(7_000);
  // Still line 2: no render.
  report(7_200, true);
  expect(seen.renders).toBe(first + 1);
  unmount();
});

test("paused, the last line said stays lit through the silence after it", () => {
  // Past line 2's end and before the next turn: playing lights nothing, a
  // paused page keeps the line just said.
  expect(litLineSig(turns, { ms: 15_000, playing: false })).toBe("0:2");
  expect(litLineSig(turns, { ms: 15_000, playing: true })).toBe("none");
  const { seen, report, unmount } = mount();
  report(8_000, false);
  const held = seen.renders;
  report(15_000, false);
  expect(seen.renders).toBe(held);
  // The next turn's line moves it.
  report(21_000, false);
  expect(seen.renders).toBe(held + 1);
  unmount();
});

test("play and pause render on their own", () => {
  const { seen, report, unmount } = mount();
  report(7_000, true);
  const playing = seen.renders;
  report(7_000, false);
  expect(seen.renders).toBe(playing + 1);
  expect(seen.hook!.at).toEqual({ ms: 7_000, playing: false });
  unmount();
});
