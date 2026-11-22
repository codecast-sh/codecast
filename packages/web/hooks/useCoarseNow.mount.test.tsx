import { afterAll, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useCoarseNow } = await import("./useCoarseNow");

afterAll(() => closeDomWindow(dom.window as any));

test("a re-rendering subscriber keeps one running timer", async () => {
  const intervals = spyOn(globalThis, "setInterval");
  const clears = spyOn(globalThis, "clearInterval");
  let bump: () => void = () => {};
  function Clock() {
    const [, setN] = React.useState(0);
    bump = () => setN((n) => n + 1);
    useCoarseNow(3_600_000);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Clock />));
  const started = intervals.mock.calls.filter((c) => c[1] === 3_600_000).length;
  for (let i = 0; i < 5; i++) await act(async () => bump());
  expect(started).toBe(1);
  expect(intervals.mock.calls.filter((c) => c[1] === 3_600_000).length).toBe(1);
  expect(clears.mock.calls.length).toBe(0);
  await act(async () => root.unmount());
  intervals.mockRestore();
  clears.mockRestore();
});
