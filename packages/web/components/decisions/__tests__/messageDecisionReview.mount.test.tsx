// A message that names several open decisions gets one review under it. The
// bar counts what waits; Review walks the decisions one card at a time in the
// order the message names them; a digit answers the current card (the store
// action alone paints it, no server is wired), s skips, and when nothing is
// left the run lists how each went, with the skipped ones still answerable.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
  localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (s: string) => s }, MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(), usePathname: () => "/inbox", useParams: () => ({}),
}));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { MessageDecisionReview } = await import("../MessageDecisionReview");

const NOW = Date.now();
const dec = (n: number, over: Record<string, unknown> = {}) => ({
  _id: `d${n}`, short_id: `sd-${n}`, conversation_id: "c1", session_id: "s1", question: `Question ${n}?`,
  options: [{ label: `Yes ${n}` }, { label: `No ${n}` }], blocking: true, status: "pending", created_at: NOW - 60_000, ...over,
});
beforeEach(() => {
  const real = useInboxStore.getInitialState();
  useInboxStore.setState({
    answerDecision: real.answerDecision, adoptDecision: real.adoptDecision,
    currentUser: { _id: "u1", name: "Me" }, tasks: {}, decisionStacks: {},
    // d4 was asked of somebody else: the message names it, the review leaves it out.
    sessionDecisions: { d1: dec(1), d2: dec(2), d3: dec(3), d4: dec(4, { asked_user_ids: ["u2"] }) },
  } as any);
});

async function mount(content: string) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(<MessageDecisionReview content={content} messageId="m1" />); });
  return { host, unmount: () => act(async () => root.unmount()) };
}
const key = (k: string) => act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, code: /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`, bubbles: true })); });
const button = (host: Element, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const status = (id: string) => (useInboxStore.getState().sessionDecisions as any)[id].status;

test("walks the named decisions one at a time, skips, and summarizes", async () => {
  const { host, unmount } = await mount("Fix cards: @[Question 3 sd-3], sd-1, sd-4 and sd-2. Then sd-1 again; ct-9 is a task.");
  expect(host.textContent).toContain("3 decisions");
  await act(async () => { button(host, "Review")!.click(); });
  // The message's order, not the store's.
  expect(host.textContent).toContain("1 of 3");
  expect(host.textContent).toContain("Question 3?");
  await key("1");
  expect(status("d3")).toBe("answered");
  expect(host.textContent).toContain("Question 1?");
  await key("s");
  expect(status("d1")).toBe("pending");
  expect(host.textContent).toContain("Question 2?");
  await key("2");
  expect(status("d2")).toBe("answered");
  // Nothing left but the skipped one: the summary, with it answerable.
  expect(host.textContent).toContain("2 of 3 answered");
  expect(host.textContent).toContain("Yes 3");
  expect(host.textContent).not.toContain("Question 4?");
  await act(async () => { button(host, "Answer")!.click(); });
  expect(host.textContent).toContain("Question 1?");
  await key("Escape");
  expect(host.textContent).toContain("1 decision");
  expect(host.textContent).toContain("2 answered");
  await unmount();
});

test("one named decision gets no review", async () => {
  const { host, unmount } = await mount("Only sd-1 is open, and ct-4 is a task.");
  expect(host.textContent).toBe("");
  await unmount();
});
