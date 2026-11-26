// Subagents on inbox cards, as the WHOLE panel draws them over a seeded store:
// which mode draws what under a card, in the grouped and the flat views, and
// that the open subagent is always somewhere on the list.
//
// The cases:
//   role       a role lead's card draws no line or rows, and its open session
//              keeps its card in Compact rows
//   hidden     Hidden draws nothing under a card but the open subagent
//   full       Full rows draw only the subagents the filter keeps, and the
//              section header counts only those
//   flat       Recent draws the Folded line and the Compact rows under each
//              card, and Full rows there follow the filter
//   scroll     opening a subagent in Compact rows scrolls to its row
//
// Run: bun test components/__tests__/cardSubagentsPanel.mount.test.tsx
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

// Only the transports are faked, and the scroll (jsdom lays nothing out), so
// the test can see which row the panel scrolled to.
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
const scrolledTo: Element[] = [];
const scrollModule = await import("../../lib/scrollRowIntoView");
mock.module("../../lib/scrollRowIntoView", () => ({
  ...scrollModule,
  scrollRowIntoView: (_container: HTMLElement, el: Element) => { scrolledTo.push(el); },
}));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const { useInboxStore, __resetInboxPlacementCacheForTests } = await import("../../store/inboxStore");
const { SessionListPanel } = await import("../GlobalSessionPanel");

const NOW = Date.now();
const id = (tag: string) => tag.padEnd(32, "0");

const PARENT = id("parent");
const BUSY = id("busy");
const FINISHED = id("finished");

function row(_id: string, extra: Record<string, unknown>) {
  return {
    _id,
    session_id: `s-${_id.slice(0, 6)}`,
    user_id: "me",
    owned_by_me: true,
    status: "active",
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

// A working session with two Claude Code subagents: one working, one whose
// turn ended (Done under the state rule, so Working or waiting hides it).
const parent = () => row(PARENT, { title: "Parent session", agent_status: "working", is_idle: false, updated_at: NOW - 5_000 });
const busy = () => row(BUSY, { title: "Busy subagent", is_subagent: true, parent_conversation_id: PARENT, agent_status: "working", is_idle: false, updated_at: NOW - 4_000 });
const finished = () => row(FINISHED, { title: "Finished subagent", is_subagent: true, parent_conversation_id: PARENT, agent_status: null, updated_at: NOW - 120_000 });

function seed(rows: Record<string, unknown>[], ui: Record<string, unknown>) {
  __resetInboxPlacementCacheForTests();
  const sessions: Record<string, unknown> = {};
  for (const r of rows) sessions[(r as any)._id] = r;
  useInboxStore.setState({
    sessions,
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {},
    collapsedSections: {},
    currentUser: { _id: "me", name: "Ashot" },
    clientState: { ui: { inbox_scope: "mine", show_old: true, ...ui } },
  } as any);
}

async function mountInbox(activeSessionId: string | null = null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={activeSessionId} /></MemoryRouter>));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const cardOf = (host: HTMLElement, sessionId: string) => host.querySelector(`[data-session-id="${sessionId}"]`);
const compactRow = (host: HTMLElement, sessionId: string) => host.querySelector(`[data-sv-subagent-row="${sessionId}"]`);
const line = (host: HTMLElement) => host.querySelector("[data-sv-subagents-line]");
const rows = (host: HTMLElement) => host.querySelector("[data-sv-subagent-rows]");
const headerCount = (host: HTMLElement, section: string) =>
  host.querySelector(`[data-inbox-section="${section}"]`)?.getAttribute("data-inbox-section-count") ?? null;

beforeEach(() => {
  document.body.innerHTML = "";
  scrolledTo.length = 0;
});

test("a role lead's card draws no line or rows, and its open session keeps its card in Compact rows", async () => {
  const ROLE_ID = id("orgrolesgrowth");
  const ROLE = { _id: ROLE_ID, short_id: "or-7", name: "Growth lead", handle: "growth", avatar: "fox", status: "active", tenure_kind: "standing" as const };
  const STANDING = id("standing");
  const HAND = id("hand");
  seed([
    row(STANDING, { title: "Growth lead", is_anchor: true, anchor_id: id("anchor"), standing_role_id: ROLE_ID, role: ROLE, agent_status: "dormant", thread_state_status: "dormant" }),
    row(HAND, { title: "Pricing page copy", org_role_id: ROLE_ID, role: ROLE, agent_status: "working", is_idle: false }),
  ], { subagent_rows: "compact", subagent_filter: "all" });
  const closed = await mountInbox();
  expect(cardOf(closed.host, STANDING)).not.toBeNull();
  expect(rows(closed.host)).toBeNull();
  expect(line(closed.host)).toBeNull();
  await closed.unmount();

  const open = await mountInbox(HAND);
  expect(rows(open.host)).toBeNull();
  expect(cardOf(open.host, HAND)).not.toBeNull();
  await open.unmount();
});

test("Hidden draws nothing under a card but the open subagent", async () => {
  seed([parent(), busy(), finished()], { subagent_rows: "hidden", subagent_filter: "all" });
  const closed = await mountInbox();
  expect(cardOf(closed.host, PARENT)).not.toBeNull();
  for (const sid of [BUSY, FINISHED]) {
    expect(cardOf(closed.host, sid)).toBeNull();
    expect(compactRow(closed.host, sid)).toBeNull();
  }
  expect(line(closed.host)).toBeNull();
  await closed.unmount();

  const open = await mountInbox(FINISHED);
  expect(cardOf(open.host, FINISHED)).not.toBeNull();
  expect(cardOf(open.host, BUSY)).toBeNull();
  expect(line(open.host)).toBeNull();
  expect(rows(open.host)).toBeNull();
  await open.unmount();
});

test("Full rows draw only the subagents the filter keeps, and the header counts only those", async () => {
  seed([parent(), busy(), finished()], { subagent_rows: "full", subagent_filter: "all" });
  const all = await mountInbox();
  expect(cardOf(all.host, BUSY)).not.toBeNull();
  expect(cardOf(all.host, FINISHED)).not.toBeNull();
  await all.unmount();

  seed([parent(), busy(), finished()], { subagent_rows: "full", subagent_filter: "active" });
  const active = await mountInbox();
  expect(cardOf(active.host, BUSY)).not.toBeNull();
  expect(cardOf(active.host, FINISHED)).toBeNull();
  await active.unmount();

  // A teammate nested under a lead in the same section counts in its header
  // (placeInboxRows counts); hidden by the filter, it counts no longer.
  const LEAD = id("lead");
  const MATE = id("mate");
  const team = () => [
    row(LEAD, { title: "Team lead", agent_status: "done", thread_state_status: "done", agent_team_name: "crew", agent_name: "team-lead" }),
    row(MATE, { title: "Reviewer", agent_status: "done", thread_state_status: "done", agent_team_name: "crew", agent_name: "reviewer", spawned_by_conversation_id: LEAD }),
  ];
  seed(team(), { subagent_rows: "full", subagent_filter: "all" });
  const shown = await mountInbox();
  expect(cardOf(shown.host, MATE)).not.toBeNull();
  expect(headerCount(shown.host, "done")).toBe("2");
  await shown.unmount();

  seed(team(), { subagent_rows: "full", subagent_filter: "active" });
  const filtered = await mountInbox();
  expect(cardOf(filtered.host, LEAD)).not.toBeNull();
  expect(cardOf(filtered.host, MATE)).toBeNull();
  expect(headerCount(filtered.host, "done")).toBe("1");
  await filtered.unmount();
});

test("Recent draws the Folded line and the Compact rows under each card, and Full rows there follow the filter", async () => {
  seed([parent(), busy(), finished()], { inbox_view_mode: "recent", subagent_rows: "folded", subagent_filter: "all" });
  const folded = await mountInbox();
  expect(cardOf(folded.host, PARENT)).not.toBeNull();
  expect(line(folded.host)?.getAttribute("data-sv-subagents-line")).toBe("2");
  expect(cardOf(folded.host, BUSY)).toBeNull();
  await folded.unmount();

  seed([parent(), busy(), finished()], { inbox_view_mode: "recent", subagent_rows: "compact", subagent_filter: "all" });
  const compact = await mountInbox(FINISHED);
  expect(compactRow(compact.host, BUSY)).not.toBeNull();
  expect(compactRow(compact.host, FINISHED)?.getAttribute("data-active")).toBe("true");
  // Its Compact row stands in for the open subagent's own row.
  expect(cardOf(compact.host, FINISHED)).toBeNull();
  await compact.unmount();

  seed([parent(), busy(), finished()], { inbox_view_mode: "recent", subagent_rows: "full", subagent_filter: "active" });
  const full = await mountInbox();
  expect(cardOf(full.host, BUSY)).not.toBeNull();
  expect(cardOf(full.host, FINISHED)).toBeNull();
  await full.unmount();
});

test("opening a subagent in Compact rows scrolls to its row", async () => {
  seed([parent(), busy(), finished()], { subagent_rows: "compact", subagent_filter: "all" });
  const m = await mountInbox(FINISHED);
  const target = compactRow(m.host, FINISHED);
  expect(target).not.toBeNull();
  expect(target!.hasAttribute("data-session-id")).toBe(false);
  expect(cardOf(m.host, FINISHED)).toBeNull();
  expect(scrolledTo).toContain(target!);
  await m.unmount();
});
