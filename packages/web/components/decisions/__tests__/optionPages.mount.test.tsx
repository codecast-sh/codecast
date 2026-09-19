import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGlobals } from "../../../test-helpers/globals";

// Option pages (the-line.md L6): one card per option that carries a page,
// in one row; the card's number answers that option.
const opened: string[] = [];
mock.module("../../../lib/stage", () => ({ openBrowserPane: (src: { url: string }) => { opened.push(src.url); return true; } }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));

import { useInboxStore } from "../../../store/inboxStore";
import { OptionPages } from "../OptionPages";

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
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

beforeEach(() => {
  opened.length = 0;
  useInboxStore.setState({ artifacts: { "page-a": { slug: "page-a", title: "Plan A", version: 3 } } } as any);
});

const decision = {
  status: "pending" as const,
  options: [
    { label: "Plan A (Recommended)", page_slug: "page-a" },
    { label: "No page" },
    { label: "Plan B", page_slug: "page-b" },
  ],
};

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}

test("two option pages render in one row and the number answers that option", async () => {
  const answers: number[] = [];
  const { container, unmount } = await mount(<OptionPages decision={decision} answerable onAnswer={(i) => answers.push(i)} />);
  const row = container.querySelector("[data-option-pages]")!;
  expect(row.classList.contains("decision-option-pages")).toBe(true);
  const cards = Array.from(row.querySelectorAll("[data-option-page]")).map((c) => c.getAttribute("data-option-page"));
  expect(cards).toEqual(["0", "2"]);
  // The store row names the page; the third option's page is not in the
  // store and shows the plain fallback title.
  expect(row.textContent).toContain("Plan A");
  expect(row.textContent).toContain("Published page");
  // The recommendation suffix stays off the card's label.
  expect(row.textContent).not.toContain("(Recommended)");
  // Numbers answer with the OPTION index, not the card's position.
  await act(() => { (row.querySelector('[data-option-answer="2"]') as HTMLElement).click(); });
  expect(answers).toEqual([2]);
  // The thumbnail opens the serving origin in a pane; full opens the share page.
  await act(() => { (row.querySelector('[data-option-page="0"] .decision-option-page-thumb') as HTMLElement).click(); });
  expect(opened).toEqual(["https://convex.test/cli/a/page-a"]);
  expect((row.querySelector('[data-option-page="0"] a[target="_blank"]') as HTMLAnchorElement).href).toBe("https://codecast.sh/a/page-a");
  expect((row.querySelector('[data-option-page="0"] img') as HTMLImageElement).getAttribute("src")).toBe("https://convex.test/cli/a/page-a?thumb=1&r=v3");
  unmount();
});

test("not answerable: the number is a marker and a chosen option shows a check", async () => {
  const { container, unmount } = await mount(<OptionPages decision={{ ...decision, status: "answered" }} chosen={new Set([2])} onAnswer={() => { throw new Error("must not answer"); }} answerable />);
  expect(container.querySelector("[data-option-answer]")).toBeNull();
  expect(container.querySelector('[data-option-page="2"]')!.getAttribute("data-picked")).toBe("true");
  expect(container.querySelector('[data-option-page="0"]')!.getAttribute("data-picked")).toBe("false");
  unmount();
});

test("no option carries a page: nothing renders", async () => {
  const { container, unmount } = await mount(<OptionPages decision={{ status: "pending", options: [{ label: "A" }, { label: "B" }] }} />);
  expect(container.querySelector("[data-option-pages]")).toBeNull();
  unmount();
});

test("the row is a grid that stacks on a phone (auto fit columns)", () => {
  const css = readFileSync(join(import.meta.dir, "..", "decisions.css"), "utf8");
  expect(css).toMatch(/\.decision-option-pages\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(13rem, 1fr\)\)/);
});
