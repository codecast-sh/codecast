import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// ct-101303: stepping through decisions from many sessions, the docked card's
// kicker is the one label that says which session asks. When that session has
// no title in the store it must still name it (the decision's recorded
// session title, else the project), never the bare word "Session".
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true, locateDecisionAsk: async () => null }));

import { closeDomWindow } from "../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { SessionDecisionCard } = await import("../../SessionDecisionCard");
const { ThemeContext } = await import("../../ThemeProvider");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const base: any = {
  key: "decide:d1", source: "decide", conversationId: "c-untitled", decisionId: "d1",
  question: "Should the reader stop recording answers to our offers as wants?",
  options: [{ label: "Stop" }, { label: "Keep" }],
  blocking: false, defaultOption: 1, createdAt: Date.now() - 60_000,
};
const stepper: any = { position: 1, total: 23, onDone: () => {}, onSkip: () => {}, onExit: () => {} };

async function dockText(item: any) {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(
    <MemoryRouter>
      <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any}>
        <SessionDecisionCard item={item} stepper={stepper} startSize="line" />
      </ThemeContext.Provider>
    </MemoryRouter>,
  ));
  const dock = pane.querySelector("[data-decision-dock]");
  const text = dock?.textContent ?? "";
  await act(() => root.unmount());
  pane.remove();
  expect(dock).not.toBeNull();
  return text;
}

test("the docked stepper card names a session missing from the store by the decision's recorded title", async () => {
  const text = await dockText({ ...base, session: undefined, sessionTitle: "Reader offer parsing" });
  expect(text).toContain("Reader offer parsing");
  expect(text).not.toMatch(/\bSession\b/);
});

test("the docked stepper card names an untitled session by its project, not the bare word Session", async () => {
  const text = await dockText({ ...base, session: { _id: "c-untitled", project_path: "/home/me/src/union" } });
  expect(text).toContain("union");
  expect(text).not.toMatch(/\bSession\b/);
});

test("a titled session keeps its own title on the dock", async () => {
  const text = await dockText({ ...base, session: { _id: "c-untitled", title: "Growth pass", project_path: "/src/union" }, sessionTitle: "Older name" });
  expect(text).toContain("Growth pass");
});
