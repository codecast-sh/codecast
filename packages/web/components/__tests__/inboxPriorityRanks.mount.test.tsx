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
const { getFunctionName } = await import("convex/server");
const asked: string[] = [];
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  // Records each query the panel subscribes to, by name.
  useQueries: (reqs: Record<string, { query: unknown }>) => {
    for (const r of Object.values(reqs ?? {})) {
      try { asked.push(getFunctionName(r.query as never)); } catch {}
    }
    return {};
  },
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

function seed(mode: "priorities" | "grouped", prioritiesOn = true) {
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
    teams: [{ _id: "t1", name: "Team", role: "admin", features: { priorities: prioritiesOn } }],
    clientState: { ui: { inbox_scope: "mine", show_old: true, inbox_view_mode: mode, active_team_id: "t1" } },
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
  // "—" on a mouse, where its tooltip says the rest; "other ws" in words on a touch screen, where nothing hovers.
  const elsewhere = m.host.querySelector(`[data-session-id="${ELSEWHERE}"] [data-priority-rank]`)!;
  expect([...elsewhere.children].map((c) => [c.textContent, c.className])).toEqual([
    ["—", "[@media(pointer:coarse)]:hidden"],
    ["other ws", "hidden [@media(pointer:coarse)]:inline"],
  ]);
  expect(m.host.querySelector(`[data-session-id="${ELSEWHERE}"] [data-priority-rank]`)?.getAttribute("title")).toBe("In another workspace");
  const order = cardOrder(m.host);
  expect(order.indexOf(FIRST)).toBeLessThan(order.indexOf(SECOND));
  expect(order.indexOf(SECOND)).toBeLessThan(order.indexOf(UNLINKED));
  expect(order.indexOf(SECOND)).toBeLessThan(order.indexOf(TEAMMATES));
  expect(order.indexOf(SECOND)).toBeLessThan(order.indexOf(ELSEWHERE));
  await m.unmount();
});

test("a stored Priorities view in a workspace with Priorities off falls back to Status: no ranks, no rank order, no feed", async () => {
  seed("priorities", false);
  asked.length = 0;
  const m = await mountInbox();
  expect(m.host.querySelectorAll("[data-session-id]").length).toBeGreaterThan(0);
  expect(m.host.querySelector("[data-priority-rank]")).toBeNull();
  expect(asked).not.toContain("priorities:list");
  const fallback = cardOrder(m.host);
  await m.unmount();
  seed("grouped");
  const grouped = await mountInbox();
  expect(cardOrder(grouped.host)).toEqual(fallback);
  await grouped.unmount();
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
  // Asking sessions file under Decisions; the queue's longest-waiting-first order there is not the rank order.
  const asks = [
    row(ASK_FIRST, "Asks for the first priority", { awaiting_input: true, priority_id: "p1", priority_step_key: "s1", updated_at: NOW - 10 * 60_000 }),
    row(ASK_SECOND, "Asks for the second", { awaiting_input: true, priority_id: "p2", priority_step_key: "s1", updated_at: NOW - 20 * 60_000 }),
    row(ASK_NONE, "Asks for nothing ranked", { awaiting_input: true, updated_at: NOW - 30 * 60_000 }),
  ];
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries(asks.map((r) => [r._id, r])) } }));
  const m = await mountInbox();
  const queue = m.host.querySelector("[data-inbox-decision-queue]")!;
  expect(queue).not.toBeNull();
  const order = [...queue.querySelectorAll("[data-session-id]")].map((el) => el.getAttribute("data-session-id"));
  expect(order).toEqual([ASK_FIRST, ASK_SECOND, ASK_NONE]);
  const rankIn = (sid: string) => queue.querySelector(`[data-session-id="${sid}"] [data-priority-rank]`)?.textContent ?? null;
  expect([rankIn(ASK_FIRST), rankIn(ASK_SECOND), rankIn(ASK_NONE)]).toEqual(["#1", "#7", "None"]);
  // Numbered in the order they show, rank order, not the queue's.
  expect([...queue.querySelectorAll("[data-decision-queue-row]")].map((r) => r.getAttribute("data-decision-queue-row"))).toEqual(["1", "2", "3"]);
  await m.unmount();
  // Outside the Priorities view the Decisions rows carry no rank.
  seed("grouped");
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries(asks.map((r) => [r._id, r])) } }));
  const g = await mountInbox();
  expect(g.host.querySelector("[data-inbox-decision-queue] [data-priority-rank]")).toBeNull();
  await g.unmount();
});

test("the host's feeders feed the priorities the view sorts by, with no inbox panel of their own; a follower's panel reads the replicated rows", async () => {
  const { useSyncInboxPriorities } = await import("../../hooks/usePriorities");
  // The host's feeder, mounted as HostFeeders mounts it (asserted from the source below).
  const HostFeeders = () => { useSyncInboxPriorities(); return null; };
  const fs = await import("node:fs");
  const source = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const feeders = source("../DashboardLayout.tsx").split("function HostFeeders()")[1].split("\n}\n")[0];
  expect(feeders).toContain("useSyncInboxPriorities();");
  // The panel feeds nothing itself: a host with no panel would leave the view unfed.
  expect(source("../GlobalSessionPanel.tsx")).not.toMatch(/useSyncPriorities\(|useSyncInboxPriorities\(/);
  const as = (role: "host" | "follower") => {
    useInboxStore.setState((s: any) => ({
      syncRole: role,
      teams: [{ _id: "t1", name: "Team", role: "admin", features: { priorities: true } }],
      clientState: { ...s.clientState, ui: { ...s.clientState.ui, active_team_id: "t1" } },
    }));
  };
  seed("priorities");
  // The host window shows no inbox panel (another page, the panel closed): its feeders still subscribe.
  as("host");
  asked.length = 0;
  const hostEl = document.createElement("div");
  const hostRoot = createRoot(hostEl);
  await act(async () => hostRoot.render(<MemoryRouter initialEntries={["/priorities"]}><HostFeeders /></MemoryRouter>));
  expect(asked).toContain("priorities:list");
  await act(async () => hostRoot.unmount());
  // Not while another view is up.
  seed("grouped");
  asked.length = 0;
  const idleRoot = createRoot(document.createElement("div"));
  await act(async () => idleRoot.render(<MemoryRouter initialEntries={["/inbox"]}><HostFeeders /></MemoryRouter>));
  expect(asked).not.toContain("priorities:list");
  await act(async () => idleRoot.unmount());
  // The follower's panel subscribes to nothing of its own, and its ranks follow the rows the host replicates.
  seed("priorities");
  as("follower");
  asked.length = 0;
  const m = await mountInbox();
  expect(asked).not.toContain("priorities:list");
  expect(rankOf(m.host, FIRST)).toBe("#1");
  expect(rankOf(m.host, SECOND)).toBe("#7");
  // The host's pass swaps p1 and p2; the replicated rows reach the follower's store through syncTable.
  await act(async () => {
    const st = useInboxStore.getState() as any;
    st.syncTable("priorities", Object.values(st.priorities).map((p: any) => (p._id === "p2" ? { ...p, ai_rank: 1 } : p._id === "p1" ? { ...p, ai_rank: 7 } : p)));
  });
  // The store's sync wakes subscribers on its own beat, not inside this act.
  for (let i = 0; i < 40 && rankOf(m.host, SECOND) !== "#1"; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(rankOf(m.host, SECOND)).toBe("#1");
  expect(rankOf(m.host, FIRST)).toBe("#7");
  expect(cardOrder(m.host).indexOf(SECOND)).toBeLessThan(cardOrder(m.host).indexOf(FIRST));
  await m.unmount();
  useInboxStore.setState({ syncRole: "host" } as any);
});

test("the view re-sorts when a session's priority changes after it mounted", async () => {
  seed("priorities");
  const m = await mountInbox();
  const order = () => cardOrder(m.host);
  expect(order().indexOf(FIRST)).toBeLessThan(order().indexOf(UNLINKED));
  expect(rankOf(m.host, UNLINKED)).toBe("None");
  // The pass links the unlinked session to #1 and moves the first one to #7.
  await act(async () => {
    useInboxStore.setState((s: any) => ({
      sessions: {
        ...s.sessions,
        [UNLINKED]: { ...s.sessions[UNLINKED], priority_id: "p1", priority_step_key: "s1" },
        [FIRST]: { ...s.sessions[FIRST], priority_id: "p2", priority_step_key: "s1" },
      },
    }));
  });
  expect(rankOf(m.host, UNLINKED)).toBe("#1");
  expect(rankOf(m.host, FIRST)).toBe("#7");
  expect(order().indexOf(UNLINKED)).toBeLessThan(order().indexOf(FIRST));
  await m.unmount();
});
