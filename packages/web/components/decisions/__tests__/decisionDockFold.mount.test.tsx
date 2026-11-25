import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// ct-101304: folding one decision in the Modern dock must not fold the next
// one. A new decision arrives expanded, its options showing, with no presses;
// a decision the person folded stays folded when its card comes back.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncPendingPermissions", () => ({ usePendingPermissions: () => undefined }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true, locateDecisionAsk: async () => null }));
mock.module("../../PublishedPageEmbed", () => ({ PublishedPageEmbed: () => null }));

import { SessionDecisionCard } from "../../SessionDecisionCard";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ThemeContext } = await import("../../ThemeProvider");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const item = (id: string, question: string): any => ({
  key: `decide:${id}`,
  source: "decide",
  conversationId: `c-${id}`,
  decisionId: id,
  question,
  options: [{ label: "Yes" }, { label: "No" }],
  blocking: false,
  defaultOption: 1,
  createdAt: Date.now() - 60_000,
});

async function mount(ui: React.ReactNode) {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(
    <MemoryRouter>
      <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any}>{ui}</ThemeContext.Provider>
    </MemoryRouter>,
  ));
  return { pane, unmount: () => act(() => root.unmount()) };
}

const folded = (pane: HTMLElement) => pane.querySelector("[data-decision-collapsed]") !== null;

test("folding one decision leaves the next decision expanded, and the folded one stays folded", async () => {
  const first = item("d1", "Ship the renderer behind a flag?");
  const a = await mount(<SessionDecisionCard item={first} stepper={null} />);
  expect(folded(a.pane)).toBe(false);
  const collapse = a.pane.querySelector<HTMLButtonElement>("[data-decision-collapse]");
  expect(collapse?.getAttribute("aria-label")).toBe("Collapse the decision");
  await act(() => { collapse!.click(); });
  expect(folded(a.pane)).toBe(true);
  await a.unmount();

  // A different decision arrives: it must open expanded, options showing.
  const b = await mount(<SessionDecisionCard item={item("d2", "Run the migration now?")} stepper={null} />);
  expect(folded(b.pane)).toBe(false);
  expect(b.pane.querySelector("[data-decision-collapse]")?.getAttribute("aria-label")).toBe("Collapse the decision");
  await b.unmount();

  // The decision the person folded comes back folded, one press from open.
  const again = await mount(<SessionDecisionCard item={first} stepper={null} />);
  expect(folded(again.pane)).toBe(true);
  await again.unmount();
});
