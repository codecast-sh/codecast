// The inbox's Priorities view as the person sees it: the WHOLE panel mounted
// over a seeded store. Each card shows the rank of the viewer's priority it
// serves ("#1"), "—" for a priority in another workspace (the window loads
// only the active workspace's), or "None", while the view is up, and nothing of the kind in
// any other view; Needs You lists its cards in rank order.
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/inbox",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Only the transports are faked; the panel, the cards, the hooks and the
// store are real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => null, mutation: async () => null }),
}));

const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const { useInboxStore, __resetInboxPlacementCacheForTests } = await import("../../store/inboxStore");
const { SessionListPanel } = await import("../GlobalSessionPanel");

const NOW = Date.now();
const id = (tag: string) => tag.padEnd(32, "0");
const UNLINKED = id("unlinked");
const SECOND = id("second");
const FIRST = id("first");
const TEAMMATES = id("teammates");
const ELSEWHERE = id("elsewhere");

function row(_id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    _id,
    session_id: `s-${_id.slice(0, 6)}`,
    user_id: "me",
    owned_by_me: true,
    status: "active",
    title,
    started_at: NOW - 3_600_000,
    updated_at: NOW - 60_000,
    last_heartbeat: NOW - 1_000,
    message_count: 12,
    is_connected: true,
    is_idle: true,
    agent_status: "idle",
    project_path: "/src/project",
    session_error: null,
    ...extra,
  };
}

/** A priority the pass slotted at `ai_rank`; its rank is its position among its owner's (five fillers put p2 at #7). */
const priority = (_id: string, ai_rank: number, user_id = "me") => ({
  _id, short_id: _id, title: _id, ai_rank, person_pos: null, workspace: "team:t1", last_active_at: 0, user_id, status: "active", steps: [{ key: "s1", title: "One", tier: "critical", tier_set_by: "pass", refs: [], done: false }],
});

function seed(mode: "priorities" | "grouped") {
  __resetInboxPlacementCacheForTests();
  const rows = [
    row(UNLINKED, "No priority"),
    row(SECOND, "Second priority", { priority_id: "p2", priority_step_key: "s1" }),
    row(FIRST, "First priority", { priority_id: "p1", priority_step_key: "s1" }),
    row(TEAMMATES, "A teammate's priority", { priority_id: "pt", priority_step_key: "s1" }),
    row(ELSEWHERE, "Another workspace's priority", { priority_id: "pOther", priority_step_key: "s1" }),
  ];
  useInboxStore.setState({
    sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
    priorities: {
      p1: priority("p1", 1), p2: priority("p2", 7), pt: priority("pt", 1, "someone"),
      ...Object.fromEntries([2, 3, 4, 5, 6].map((n) => [`f${n}`, priority(`f${n}`, n)])),
    },
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {},
    currentUser: { _id: "me", name: "Jason" },
    clientState: { ui: { inbox_scope: "mine", show_old: true, inbox_view_mode: mode } },
  } as any);
}

async function mountInbox() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={null} /></MemoryRouter>));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const rankOf = (host: HTMLElement, sessionId: string) =>
  host.querySelector(`[data-session-id="${sessionId}"] [data-priority-rank]`)?.textContent ?? null;
const cardOrder = (host: HTMLElement) =>
  [...host.querySelectorAll("[data-session-id]")].map((el) => el.getAttribute("data-session-id"));

beforeEach(() => { document.body.innerHTML = ""; });

test("in the Priorities view every card shows its rank or None, in rank order", async () => {
  seed("priorities");
  const m = await mountInbox();
  expect(rankOf(m.host, FIRST)).toBe("#1");
  expect(rankOf(m.host, SECOND)).toBe("#7");
  expect(rankOf(m.host, UNLINKED)).toBe("None");
  // A teammate's priority is not the viewer's: no rank.
  expect(rankOf(m.host, TEAMMATES)).toBe("None");
  // A priority this window has not loaded is not "None": it is elsewhere.
  expect(rankOf(m.host, ELSEWHERE)).toBe("—");
  expect(m.host.querySelector(`[data-session-id="${ELSEWHERE}"] [data-priority-rank]`)?.getAttribute("title")).toBe("In another workspace");
  const order = cardOrder(m.host);
  expect(order.indexOf(FIRST)).toBeLessThan(order.indexOf(SECOND));
  expect(order.indexOf(SECOND)).toBeLessThan(order.indexOf(UNLINKED));
  expect(order.indexOf(SECOND)).toBeLessThan(order.indexOf(TEAMMATES));
  expect(order.indexOf(SECOND)).toBeLessThan(order.indexOf(ELSEWHERE));
  await m.unmount();
});

test("the Status view shows no rank on any card", async () => {
  seed("grouped");
  const m = await mountInbox();
  expect(m.host.querySelectorAll("[data-session-id]").length).toBeGreaterThan(0);
  expect(m.host.querySelector("[data-priority-rank]")).toBeNull();
  await m.unmount();
});

test("Decisions rows carry their rank or None too, sorted by it", async () => {
  seed("priorities");
  const ASK_NONE = id("asknone");
  const ASK_SECOND = id("asksecond");
  const ASK_FIRST = id("askfirst");
  // Asking sessions file under Decisions; the newest-first order there is not the rank order.
  const asks = [
    row(ASK_FIRST, "Asks for the first priority", { awaiting_input: true, priority_id: "p1", priority_step_key: "s1", updated_at: NOW - 30 * 60_000 }),
    row(ASK_SECOND, "Asks for the second", { awaiting_input: true, priority_id: "p2", priority_step_key: "s1", updated_at: NOW - 20 * 60_000 }),
    row(ASK_NONE, "Asks for nothing ranked", { awaiting_input: true, updated_at: NOW - 10 * 60_000 }),
  ];
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries(asks.map((r) => [r._id, r])) } }));
  const m = await mountInbox();
  const queue = m.host.querySelector("[data-inbox-decision-queue]")!;
  expect(queue).not.toBeNull();
  const order = [...queue.querySelectorAll("[data-session-id]")].map((el) => el.getAttribute("data-session-id"));
  expect(order).toEqual([ASK_FIRST, ASK_SECOND, ASK_NONE]);
  const rankIn = (sid: string) => queue.querySelector(`[data-session-id="${sid}"] [data-priority-rank]`)?.textContent ?? null;
  expect([rankIn(ASK_FIRST), rankIn(ASK_SECOND), rankIn(ASK_NONE)]).toEqual(["#1", "#7", "None"]);
  await m.unmount();
  // Outside the Priorities view the Decisions rows carry no rank.
  seed("grouped");
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries(asks.map((r) => [r._id, r])) } }));
  const g = await mountInbox();
  expect(g.host.querySelector("[data-inbox-decision-queue] [data-priority-rank]")).toBeNull();
  await g.unmount();
});
