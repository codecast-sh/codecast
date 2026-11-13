// A message that names several decisions gets one bar under it: every open
// one it names counts, whoever it is asked of, the bar says how many wait on
// the viewer, and its button opens the first one as a full page with the
// message's whole set to flip through, in the order the message names them.
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

const pushed: string[] = [];
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => { pushed.push(href); }, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(), usePathname: () => "/inbox", useParams: () => ({}),
}));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { MessageDecisionReview } = await import("../MessageDecisionReview");
const { MemoryRouter } = await import("react-router");

const NOW = Date.now();
const dec = (n: number, over: Record<string, unknown> = {}) => ({
  _id: `d${n}`, short_id: `sd-${n}`, conversation_id: "c1", session_id: "s1", question: `Question ${n}?`,
  options: [{ label: `Yes ${n}` }, { label: `No ${n}` }], blocking: true, status: "pending", created_at: NOW - 60_000, ...over,
});
beforeEach(() => {
  pushed.length = 0;
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Me" }, tasks: {}, decisionStacks: {}, decisionDetails: {},
    // d4 was asked of somebody else and d5 is answered: both still belong to the message's set.
    sessionDecisions: { d1: dec(1), d2: dec(2), d3: dec(3), d4: dec(4, { asked_user_ids: ["u2"], in_queue: false }), d5: dec(5, { status: "answered" }) },
  } as any);
});

async function mount(content: string) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><MessageDecisionReview content={content} messageId="m1" /></MemoryRouter>); });
  return { host, unmount: () => act(async () => root.unmount()) };
}
const button = (host: Element, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

test("counts every named open decision and opens the set full page, in the message's order", async () => {
  const { host, unmount } = await mount("Fix cards: sd-4, @[Question 3 sd-3], sd-5, sd-1 and sd-2. Then sd-1 again; ct-9 is a task.");
  expect(host.textContent).toContain("4 open decisions");
  expect(host.textContent).toContain("3 asked of you");
  expect(host.textContent).toContain("1 answered");
  await act(async () => { button(host, "Go through them")!.click(); });
  expect(pushed).toEqual(["/decisions/sd-3?set=sd-4,sd-3,sd-5,sd-1,sd-2"]);
  await unmount();
});

test("decisions all asked of someone else still get the bar", async () => {
  useInboxStore.setState({ sessionDecisions: { d6: dec(6, { asked_user_ids: ["u2"], in_queue: false }), d7: dec(7, { asked_user_ids: ["u2"], in_queue: false }) } } as any);
  const { host, unmount } = await mount("Waiting on Jason: sd-6 and sd-7.");
  expect(host.textContent).toContain("2 open decisions");
  expect(host.textContent).toContain("0 asked of you");
  await act(async () => { button(host, "Go through them")!.click(); });
  expect(pushed).toEqual(["/decisions/sd-6?set=sd-6,sd-7"]);
  await unmount();
});

test("one named decision gets no bar", async () => {
  const { host, unmount } = await mount("Only sd-1 is open, and ct-4 is a task.");
  expect(host.textContent).toBe("");
  await unmount();
});

test("a named decision outside the viewer's queue counts once its page row arrives", async () => {
  useInboxStore.setState({ sessionDecisions: { d8: dec(8) } } as any);
  const { host, unmount } = await mount("Waiting on you: sd-9: I recommend Ship. sd-8: I recommend Ship.");
  expect(host.textContent).toBe("");
  await act(async () => { useInboxStore.setState({ decisionDetails: { d9: { _id: "d9", decision: dec(9) } } } as any); });
  expect(host.textContent).toContain("2 open decisions");
  await act(async () => { button(host, "Go through them")!.click(); });
  expect(pushed).toEqual(["/decisions/sd-9?set=sd-9,sd-8"]);
  await unmount();
});
