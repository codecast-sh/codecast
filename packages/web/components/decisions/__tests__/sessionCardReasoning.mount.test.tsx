import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// A reader cannot decide from a question and its option labels; the context
// the asker wrote is what the answer rests on. The sheet reads it whole, in
// one flow with the options after it; the fold shows the question and its
// status only, and opening it is the sheet.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncPendingPermissions", () => ({ usePendingPermissions: () => undefined }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true }));
mock.module("../../PublishedPageEmbed", () => ({ PublishedPageEmbed: () => null }));
mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div data-md>{content}</div> }));

import { SessionDecisionCard } from "../../SessionDecisionCard";

import { closeDomWindow } from "../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
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

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const context = "The migration is deployed and idempotent.\n\nRunning it now seats four workspaces and bills one turn each.";
const item = (blocking: boolean): any => ({
  key: "decide:d1",
  source: "decide",
  conversationId: "c1",
  decisionId: "d1",
  question: "Run the one time root seat on prod now, or wait?",
  contextMd: context,
  options: [
    { label: "Run it now", description: "seats 4 workspaces" },
    { label: "Wait", description: "nothing runs" },
  ],
  blocking,
  defaultOption: blocking ? undefined : 1,
  createdAt: Date.now() - 60_000,
});

async function mount(ui: React.ReactNode) {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(ui));
  return { pane, unmount: () => act(() => root.unmount()) };
}

function readingOrder(pane: HTMLElement) {
  const question = pane.querySelector("h1.decision-question")!;
  const body = pane.querySelector("[data-decision-context]")!;
  const firstOption = pane.querySelector("[data-option]")!;
  expect(question).not.toBeNull();
  expect(body).not.toBeNull();
  expect(firstOption).not.toBeNull();
  // The reasoning sits between the question and the option rows, all in one flow.
  expect(question.compareDocumentPosition(body) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(body.compareDocumentPosition(firstOption) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return body;
}

test("an advisory card in a session view starts folded to one badge: the question on its tooltip, no reasoning, one click to open", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(false)} stepper={null} />);
  const fold = pane.firstElementChild!;
  expect(fold.classList.contains("decision-card")).toBe(true);
  expect(fold.classList.contains("decision-fold")).toBe(true);
  const pill = fold.querySelector("button") as HTMLButtonElement;
  expect(fold.querySelectorAll("button")).toHaveLength(1);
  expect(pill.textContent).toContain("Asked for your steer");
  expect(pill.title).toContain("root seat");
  expect(pill.title).toContain("proceeding with Wait");
  expect(fold.textContent).not.toContain("root seat");
  expect(pane.querySelector("[data-decision-context]")).toBeNull();
  expect(pane.querySelector("[data-option]")).toBeNull();
  await act(() => { pill.click(); });
  expect(pane.firstElementChild!.classList.contains("decision-doc")).toBe(true);
  const body = readingOrder(pane);
  expect(body.textContent).toContain("seats four workspaces and bills one turn each");
  unmount();
});

test("a blocking card owns the pane and reads the reasoning whole, in the document page's type", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} />);
  const root = pane.firstElementChild!;
  expect(root.classList.contains("decision-doc")).toBe(true);
  expect(root.classList.contains("decision-sheet")).toBe(true);
  const body = readingOrder(pane);
  expect(body.textContent).toContain("bills one turn each");
  expect(pane.querySelector("h1.decision-question")!.textContent).toContain("root seat");
  // Nothing in the sheet scrolls on its own: one scroll box holds the
  // question, the reasoning and the options together.
  const scrollers = Array.from(pane.querySelectorAll<HTMLElement>("[class*='overflow-y-auto']"));
  expect(scrollers).toHaveLength(1);
  expect(scrollers[0].contains(pane.querySelector("h1.decision-question"))).toBe(true);
  expect(scrollers[0].contains(pane.querySelector("[data-option]"))).toBe(true);
  unmount();
});

test("in the queue an advisory card opens as the sheet, with its place in the queue on the chrome row", async () => {
  const stepper: any = { position: 2, total: 5, onDone: () => {}, onSkip: () => {}, onExit: () => {} };
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(false)} stepper={stepper} />);
  const root = pane.firstElementChild!;
  expect(root.classList.contains("decision-sheet")).toBe(true);
  expect(root.textContent).toContain("decision 2 of 5");
  readingOrder(pane);
  unmount();
});

test("the sheet seats the reasoning and the options as the two cells of one grid, so a wide pane can set them side by side", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} />);
  const grid = pane.querySelector(".decision-sheet-grid")!;
  expect(grid.getAttribute("data-split")).toBe("true");
  expect(grid.children).toHaveLength(2);
  expect(grid.children[0].classList.contains("decision-sheet-context")).toBe(true);
  expect(grid.children[1].classList.contains("decision-sheet-options")).toBe(true);
  unmount();
});

test("a question with no reasoning keeps one column", async () => {
  const bare = { ...item(true), contextMd: undefined };
  const { pane, unmount } = await mount(<SessionDecisionCard item={bare} stepper={null} />);
  const grid = pane.querySelector(".decision-sheet-grid")!;
  expect(grid.getAttribute("data-split")).toBe("false");
  expect(grid.children).toHaveLength(1);
  unmount();
});
