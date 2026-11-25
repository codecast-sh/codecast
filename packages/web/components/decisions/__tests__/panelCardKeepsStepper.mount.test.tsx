import { replaceGlobals } from "../../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";

// ct-101356. On /decisions the person opens a decision from the side panel
// (/decisions?s=A&d=a1) and expands a card in the asking session's pane. Then
// they click that same session's card head in the panel. That is the session
// already on screen, so nothing should move: the stepper, its conversation pane
// and whatever the person had expanded stay where they are. The page and the
// panel are real and share one router; only the queue's data and the pane's
// body are stand-ins, the pane counting its mounts and holding a local
// "expanded" flag the way the real cards do.

import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/decisions", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MouseEvent: dom.window.MouseEvent,
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => null, mutation: async () => null }),
}));

const CONV_A = "convaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONV_B = "convbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const item = (key: string, conversationId: string, sessionTitle: string) => ({
  key,
  source: "decide" as const,
  conversationId,
  sessionTitle,
  question: `question ${key}`,
  options: [{ label: "yes" }, { label: "no" }],
  blocking: true,
  createdAt: 1,
});
const queue = [item("a1", CONV_A, "Alpha"), item("a2", CONV_A, "Alpha"), item("b1", CONV_B, "Beta")];

const realQueueModule = { ...(await import("../../../hooks/useDecisionQueue")) };
mock.module("../../../hooks/useDecisionQueue", () => ({ ...realQueueModule, useDecisionQueue: () => queue }));

const React = await import("react");
const paneMounts: string[] = [];
function Pane({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => { paneMounts.push(sessionId); }, []);
  return (
    <div data-conv={sessionId} data-expanded={expanded ? "true" : "false"}>
      <button type="button" data-expand onClick={() => setExpanded(true)}>Expand</button>
    </div>
  );
}
mock.module("../../../app/inbox/QueuePageClient", () => ({ InboxConversation: Pane }));

const { DecisionsPage } = await import("../DecisionsPage");
const { InboxDecisionQueue } = await import("../InboxDecisionQueue");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

let lastUrl = "";
function Where() {
  const loc = useLocation();
  lastUrl = loc.pathname + loc.search;
  return null;
}

const click = (el: Element) =>
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

test("clicking the panel card of the session already on screen keeps the stepper and the expanded card", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/decisions?s=${CONV_A}&d=a1`]}>
      <Where />
      <InboxDecisionQueue collapsed={false} onToggle={() => {}} activeSessionId={CONV_A} extraSessions={[]} onSelectSession={() => {}} />
      <DecisionsPage />
    </MemoryRouter>,
  ));

  const pane = () => host.querySelector(`[data-conv="${CONV_A}"]`) as HTMLElement | null;
  expect(pane()).not.toBeNull();
  expect(paneMounts).toEqual([CONV_A]);

  // The person expands a card in the asking session's pane.
  await act(async () => { click(pane()!.querySelector("[data-expand]")!); });
  expect(pane()!.getAttribute("data-expanded")).toBe("true");

  // Then clicks that same session's card head in the side panel.
  const head = host.querySelector(`[data-inbox-decision-queue] [data-session-id="${CONV_A}"] > a`) as HTMLElement;
  expect(head).not.toBeNull();
  await act(async () => { click(head); });

  // Still the same session on screen; nothing remounted, nothing collapsed.
  expect(lastUrl.startsWith(`/decisions?s=${CONV_A}`)).toBe(true);
  expect(paneMounts).toEqual([CONV_A]);
  expect(pane()!.getAttribute("data-expanded")).toBe("true");

  await act(async () => root.unmount());
  host.remove();
});

test("inside the session on screen, a named decision takes the stepper and the card head keeps it", async () => {
  paneMounts.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/decisions?s=${CONV_A}&d=a1`]}>
      <Where />
      <InboxDecisionQueue collapsed={false} onToggle={() => {}} activeSessionId={CONV_A} extraSessions={[]} onSelectSession={() => {}} />
      <DecisionsPage />
    </MemoryRouter>,
  ));
  const card = () => host.querySelector(`[data-inbox-decision-queue] [data-session-id="${CONV_A}"]`)!;
  const hereRow = () => card().querySelector("[data-here]")?.getAttribute("data-decision-queue-row");
  expect(hereRow()).toBe("1");

  // The person opens Alpha's second question from the panel.
  await act(async () => { click(card().querySelectorAll("[data-decision-queue-row]")[1]!); });
  expect(lastUrl).toBe(`/decisions?s=${CONV_A}&d=a2`);
  expect(hereRow()).toBe("2");

  // Then clicks Alpha's card head, which drops &d=: still on the second question.
  await act(async () => { click(card().querySelector(":scope > a")!); });
  expect(lastUrl).toBe(`/decisions?s=${CONV_A}`);
  expect(hereRow()).toBe("2");
  expect(paneMounts).toEqual([CONV_A]);

  await act(async () => root.unmount());
  host.remove();
});
