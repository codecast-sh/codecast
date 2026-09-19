import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";

// A reader cannot choose from labels alone, so the compact card carries the
// asker's context inline, clipped, with the way to open it. Collapsed it is
// stripped text rather than parsed markdown, so a queue of ten cards parses
// nothing nobody opened.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncWorkflows", () => ({ useSyncWorkflowRun: () => {} }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true }));
const markdownRenders: string[] = [];
mock.module("../../tools/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => { markdownRenders.push(content); return <div data-md>{content}</div>; },
}));

import { DecisionCompactCard } from "../DecisionCompactCard";

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
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const decision: any = {
  _id: "d1",
  short_id: "sd-95",
  conversation_id: "c1",
  session_id: "s1",
  question: "Ship the address keyed bounce guard and run the backfill?",
  context_md: "## What happened\n\nA contact gave us a **new** address on a call.\n\nThe bounce on the old one still blocks them.",
  options: [
    { label: "Ship it and run the backfill", description: "clears the stale flag on 110 contacts" },
    { label: "Ship it, hold the backfill", description: "the code path is fixed from now on" },
  ],
  blocking: true,
  status: "pending",
  kind: "single",
  created_at: Date.now() - 60_000,
};

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}

test("the context renders inline, as stripped text while collapsed", async () => {
  markdownRenders.length = 0;
  const { container, unmount } = await mount(<DecisionCompactCard decision={decision} />);
  const body = container.querySelector("[data-decision-context]")!;
  expect(body).not.toBeNull();
  // The reasoning is on the card, not only on the document page.
  expect(body.textContent).toContain("A contact gave us a new address on a call");
  // Collapsed: the heading marks and the bold marks are gone, and the
  // markdown renderer never ran.
  expect(body.textContent).not.toContain("##");
  expect(body.textContent).not.toContain("**");
  expect(markdownRenders).toEqual([]);
  unmount();
});

test("the question is set in the document page's serif, and a blocking card is the call to action", async () => {
  const { container, unmount } = await mount(<DecisionCompactCard decision={decision} cta />);
  const card = container.querySelector("[data-decision-card]")!;
  expect(card.classList.contains("decision-card")).toBe(true);
  expect(card.getAttribute("data-cta")).toBe("true");
  expect(container.querySelector(".decision-question")!.textContent).toContain("bounce guard");
  unmount();
});

test("a card with no context renders no body at all", async () => {
  const { container, unmount } = await mount(<DecisionCompactCard decision={{ ...decision, context_md: undefined }} />);
  expect(container.querySelector("[data-decision-context]")).toBeNull();
  unmount();
});

test("the card's serif question and the call to action tint are defined in the stylesheet", () => {
  const css = readFileSync(join(import.meta.dir, "..", "decisions.css"), "utf8");
  expect(css).toMatch(/\.decision-card \.decision-question\s*\{[^}]*font-family:\s*var\(--font-serif\)/);
  expect(css).toMatch(/\.decision-card\[data-cta="true"\]/);
});
