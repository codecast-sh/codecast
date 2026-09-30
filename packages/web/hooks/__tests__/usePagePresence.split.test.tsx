import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/threads" });
dom.window.document.hasFocus = () => true;
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const { usePagePresence, usePageReading } = await import("../usePagePresence");
const { TabParamsCtx } = await import("../../lib/tabParams");

// A split pane the reader scrolls without clicking is on screen but not
// focused: what it shows is being read, and its keys belong to the other pane.
// The Threads unread count never fell because reads followed focus.

function probe(ctx: { isActive: boolean; isVisible?: boolean }) {
  const seen: { present?: boolean; reading?: boolean } = {};
  function Probe() {
    seen.present = usePagePresence();
    seen.reading = usePageReading();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TabParamsCtx.Provider value={{ tabId: "t", pathname: "/threads", params: {}, searchParams: new URLSearchParams(), ...ctx }}>
        <Probe />
      </TabParamsCtx.Provider>,
    );
  });
  act(() => root.unmount());
  return seen;
}

test("an unfocused split sibling reads but does not own the keyboard", () => {
  expect(probe({ isActive: false, isVisible: true })).toEqual({ present: false, reading: true });
});

test("the focused pane reads and owns the keyboard", () => {
  expect(probe({ isActive: true, isVisible: true })).toEqual({ present: true, reading: true });
});

test("a pane in a hidden tab does neither", () => {
  expect(probe({ isActive: false, isVisible: false })).toEqual({ present: false, reading: false });
  expect(probe({ isActive: false })).toEqual({ present: false, reading: false });
});
