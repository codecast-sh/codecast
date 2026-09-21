import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// A reader cannot decide from a question and its option labels; the context
// the asker wrote is what the answer rests on. Every size of the session
// card that offers the options shows it: full reads it whole, the dock
// clips it to the room the half pane leaves and opens the rest in full.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncPendingPermissions", () => ({ usePendingPermissions: () => undefined }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true }));
mock.module("../../PublishedPageEmbed", () => ({ PublishedPageEmbed: () => null }));
mock.module("../../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div data-md>{content}</div> }));

import { SessionDecisionCard } from "../../SessionDecisionCard";
import { CollapsibleBody } from "../../CollapsibleBody";

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

test("an advisory card docks and still shows the reasoning above the options", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(false)} stepper={null} />);
  const body = pane.querySelector("[data-decision-context]")!;
  expect(body).not.toBeNull();
  expect(body.textContent).toContain("seats four workspaces and bills one turn each");
  // The reasoning sits between the question and the option rows.
  const question = pane.querySelector(".decision-question")!;
  const firstOption = pane.querySelector("[data-option]")!;
  expect(question.compareDocumentPosition(body) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(body.compareDocumentPosition(firstOption) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The dock wears the list card's look; the question is in its serif class.
  expect(pane.firstElementChild!.classList.contains("decision-card")).toBe(true);
  unmount();
});

test("a blocking card owns the pane and reads the reasoning whole, in the document page's type", async () => {
  const { pane, unmount } = await mount(<SessionDecisionCard item={item(true)} stepper={null} />);
  const root = pane.firstElementChild!;
  expect(root.classList.contains("decision-doc")).toBe(true);
  const body = pane.querySelector("[data-decision-context]")!;
  expect(body.textContent).toContain("bills one turn each");
  expect(pane.querySelector("h1.decision-question")!.textContent).toContain("root seat");
  unmount();
});

test("a fill body hands its toggle to the caller instead of opening in place", async () => {
  const opened: string[] = [];
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root2 = createRoot(pane);
  // jsdom lays nothing out: fake a box shorter than its content.
  const Faked = () => (
    <CollapsibleBody collapsedHeight="fill" onExpand={() => opened.push("grow")} expandLabel="Read the whole thing">
      <div data-inner ref={(el) => {
        if (!el) return;
        Object.defineProperty(el.parentElement!, "scrollHeight", { value: 400, configurable: true });
        Object.defineProperty(el.parentElement!.parentElement!, "clientHeight", { value: 100, configurable: true });
      }}>long</div>
    </CollapsibleBody>
  );
  await act(() => root2.render(<Faked />));
  const toggle = pane.querySelector("button")!;
  expect(toggle).not.toBeNull();
  expect(toggle.textContent).toContain("Read the whole thing");
  // The box stays clipped by its flex parent: no inline max-height. Its
  // floor is the default, since the content (400px) is taller than it.
  const box = toggle.previousElementSibling as HTMLElement;
  expect(box.style.maxHeight).toBe("");
  expect(box.style.minHeight).toBe("88px");
  await act(() => { toggle.click(); });
  expect(opened).toEqual(["grow"]);
  // Still clipped: the toggle did not open it in place, so it still offers to.
  expect(pane.querySelector("button")!.textContent).toContain("Read the whole thing");
  await act(() => root2.unmount());
});

test("a fill body shorter than the floor keeps no empty room under itself", async () => {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  const Short = () => (
    <CollapsibleBody collapsedHeight="fill" onExpand={() => {}}>
      <div data-inner ref={(el) => {
        if (!el) return;
        Object.defineProperty(el.parentElement!, "scrollHeight", { value: 30, configurable: true });
        Object.defineProperty(el.parentElement!.parentElement!, "clientHeight", { value: 30, configurable: true });
      }}>two lines</div>
    </CollapsibleBody>
  );
  await act(() => root.render(<Short />));
  const box = pane.querySelector("[data-inner]")!.parentElement!.parentElement as HTMLElement;
  expect(box.style.minHeight).toBe("30px");
  expect(pane.querySelector("button")).toBeNull();
  await act(() => root.unmount());
});
