// The panel above the composer follows the sidebar when it places again. The
// sidebar places while it renders, after the store has published, so a
// section move with no store write reaches the panel only through its
// subscription to the placement (placedInboxVersion).
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => null, mutation: async () => null }),
}));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;
const { useInboxStore, placeInboxRows, __resetInboxPlacementCacheForTests } = await import("../../store/inboxStore");
const { ThreadStatePanel } = await import("../ThreadStatePanel");

const NOW = Date.now();
const ID = "asker".padEnd(32, "0");
const PIN = { thread_state: "Asked which flow to ship through", thread_state_status: "dormant", thread_state_at: NOW - 60_000, thread_state_msg_count: 8 };

beforeEach(() => {
  document.body.innerHTML = "";
  __resetInboxPlacementCacheForTests();
  useInboxStore.setState({
    sessions: {
      [ID]: {
        _id: ID, session_id: "s-asker", agent_type: "claude_code", title: "Asker", user_id: "me", owned_by_me: true, status: "active",
        started_at: NOW - 3_600_000, updated_at: NOW - 60_000, last_heartbeat: NOW - 1_000, message_count: 8,
        is_idle: true, agent_status: "dormant", project_path: "/src/project", ...PIN,
      },
    },
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {
      d1: { _id: "d1", conversation_id: ID, session_id: "s-asker", question: "Which flow?", options: [{ label: "Ship" }, { label: "Wait" }], blocking: true, status: "pending", created_at: NOW - 30_000 },
    },
    currentUser: { _id: "me", name: "Jason" },
    currentSessionId: null,
    clientState: { ui: { inbox_scope: "mine", show_old: true } },
  } as any);
});

test("a section move the sidebar makes, with no store write, reaches the panel's chip", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ThreadStatePanel conversationId={ID} threadState={PIN.thread_state} threadStateAt={PIN.thread_state_at} threadStateMsgCount={PIN.thread_state_msg_count} threadStateStatus={PIN.thread_state_status} messageCount={8} />,
  ));
  // No placement yet: the row's own verdict agrees with its dormant pin.
  expect(host.textContent).toContain("Sleeping");

  // The sidebar places: the open decision files the session under Questions. Nothing writes the store.
  await act(async () => {
    expect(placeInboxRows(useInboxStore.getState() as any, { now: NOW }).questions.map((r) => r._id)).toEqual([ID]);
    await Promise.resolve();
  });
  expect(host.textContent).toContain("Needs you");
  expect(host.textContent).not.toContain("Sleeping");
  await act(async () => root.unmount());
  host.remove();
});
