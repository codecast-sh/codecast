import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// A decision's team thread on its card (ct-74449, convex decisionThread.ts),
// drawn by the shared comment components: a pass as an event line, people's
// comments, the session's answer, the reader's "New" line and the unread
// count on the card; edit and remove only on your own; resolve; asking the
// session is a plain button. Opening the thread reads it.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
const realWorkflows = await import("../../../hooks/useSyncWorkflows");
mock.module("../../../hooks/useSyncWorkflows", () => ({ ...realWorkflows, useSyncWorkflowRun: () => ({ ready: true }) }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true, locateDecisionAsk: async () => null }));

import { useInboxStore } from "../../../store/inboxStore";
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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { void convex.close(); closeDomWindow(dom); restoreGlobals(); });

const T = 1_800_000_000_000;
const decision: any = {
  _id: "d1", short_id: "sd-9", conversation_id: "c1", session_id: "s1", question: "Ship the cart fix?",
  options: [{ label: "Ship" }, { label: "Revise" }], blocking: true, status: "pending", kind: "single", created_at: T,
};
const comments = {
  k1: { _id: "k1", decision_id: "d1", client_id: "x1", content: "You own the parser now.", created_at: T + 1, author_kind: "user", author_user_id: "u1", author_name: "Ashot", decision_event: "passed", event_to_names: ["Samvit"] },
  k2: { _id: "k2", decision_id: "d1", client_id: "x2", content: "Does this touch checkout?", created_at: T + 2, author_kind: "user", author_user_id: "u2", author_name: "Samvit" },
  k3: { _id: "k3", decision_id: "d1", client_id: "x3", content: "No: only the cart total.", created_at: T + 3, author_kind: "agent", agent_status: "done", author_name: "Fix the cart", parent_id: "k2", decision_session_id: "c1" },
  k4: { _id: "k4", decision_id: "d1", client_id: "x4", content: "Thanks.", created_at: T - 5, author_kind: "user", author_user_id: "u1", author_name: "Ashot" },
};
const sent: any[] = [];
const marked: any[] = [];

beforeEach(() => {
  sent.length = 0;
  marked.length = 0;
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Ashot" },
    decisionComments: { ...comments },
    decisionThreads: { d1: { _id: "d1", decision_short_id: "sd-9", owner: { conversation_id: "c1", name: "Fix the cart", via: "asker" } } },
    threadInbox: { "decision:decision:d1": { _id: "decision:decision:d1", kind: "decision", root_key: "decision:d1", decision_id: "d1", last_activity_at: T + 3, last_read_at: T, updated_at: T, unread: 2 } },
    commentOnDecision: async (...args: any[]) => { sent.push(["comment", ...args]); return { ok: true }; },
    resolveDecisionThread: (...args: any[]) => { sent.push(["resolve", ...args]); },
    markThreadRead: (...args: any[]) => { marked.push(args); },
  } as any);
});

const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const convex = offlineConvexClient("https://example.convex.cloud");
async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConvexProvider client={convex}><MemoryRouter>{ui}</MemoryRouter></ConvexProvider>));
  return { container, unmount: () => act(() => root.unmount()) };
}
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}

test("the card draws the thread: the pass, the comment, the session's answer and where the news starts", async () => {
  const { container, unmount } = await mount(<DecisionCompactCard decision={decision} />);
  const thread = container.querySelector("[data-decision-thread]")!;
  expect(thread).not.toBeNull();
  const event = thread.querySelector("[data-comment-event]")!;
  expect(event.textContent).toContain("Ashot");
  expect(event.textContent).toContain("passed to Samvit");
  expect(event.textContent).toContain("You own the parser now.");
  expect(thread.textContent).toContain("No: only the cart total.");
  expect(thread.textContent).toContain("Fix the cart");
  // The news starts at the pass (the reader's own pass is not news, so at Samvit's comment), and the card counts it.
  const line = thread.querySelector("[data-comment-new-line]")!;
  expect(line).not.toBeNull();
  expect(thread.querySelectorAll("[data-comment-fresh]").length).toBe(2);
  expect(container.querySelector("[data-decision-thread-unread-chip]")!.textContent).toContain("2 new");
  // Asking the session is a plain button, not an icon.
  expect(thread.querySelector("[data-decision-ask]")!.textContent).toContain("Discuss with");
  // A card leaves it unread until the person opens it.
  expect(marked).toEqual([]);
  await unmount();
});

test("edit and remove sit only on your own comment, and resolve stamps the thread", async () => {
  const { container, unmount } = await mount(<DecisionCompactCard decision={decision} />);
  const cards = [...container.querySelectorAll(".cc-cmt-user")];
  const own = cards.find((c) => c.textContent?.includes("Thanks."))!;
  const theirs = cards.find((c) => c.textContent?.includes("Does this touch checkout?"))!;
  expect(own.textContent).toContain("Edit");
  expect(own.textContent).toContain("Remove");
  expect(theirs.textContent).not.toContain("Edit");
  await click(container.querySelector("[data-comment-resolve=resolve]"));
  expect(sent).toEqual([["resolve", "d1", true]]);
  await unmount();
});

test("opening the thread reads it", async () => {
  const { container, unmount } = await mount(<DecisionCompactCard decision={decision} />);
  await click(container.querySelector("[data-discuss-button]"));
  expect(marked).toEqual([["decision", "decision:d1"]]);
  await unmount();
});
