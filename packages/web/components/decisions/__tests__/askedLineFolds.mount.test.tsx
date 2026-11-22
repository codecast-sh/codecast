import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// ct-98091: pressing a decision sheet's "asked … ago" line folds the sheet so
// the thread shows where the question was asked. The fold must not wait on the
// server's lookup of the ask (findAskMessage): while that lookup is slow or
// never answers, the press did nothing visible and people pressed it 27 times.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncPendingPermissions", () => ({ usePendingPermissions: () => undefined }));
// The jump opens the session at once; locating the ask waits on the server, which has not answered.
let jumps = 0;
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({
  useJumpToDecisionAsk: () => () => { jumps++; return new Promise<boolean>(() => {}); },
  locateDecisionAsk: async () => null,
}));
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
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const item: any = {
  key: "decide:d1", source: "decide", conversationId: "c1", decisionId: "d1",
  question: "Should every landing go through green CI?",
  options: [{ label: "Yes" }, { label: "No" }],
  blocking: true,
  createdAt: Date.now() - 13 * 3600_000,
};

test("pressing the sheet's \"asked … ago\" line folds the sheet at once, before the server has located the ask", async () => {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter><SessionDecisionCard item={item} stepper={null} /></MemoryRouter>));
  expect(pane.firstElementChild!.classList.contains("decision-sheet")).toBe(true);

  const line = [...pane.querySelectorAll("button")].find((b) => /^asked /.test(b.textContent ?? "")) as HTMLButtonElement;
  expect(line).toBeDefined();
  await act(async () => { line.click(); });
  expect(jumps).toBe(1);
  // The thread is handed back now; the scroll may follow when the server answers.
  expect(pane.firstElementChild!.classList.contains("decision-fold")).toBe(true);
  await act(() => root.unmount());
});
