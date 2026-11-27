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
//   reveal     opening a subagent its session owns opens the collapsed
//              section that holds its session's card
//   nested     a finished subagent reads Done under a Working parent in A
//              card each, grouped and in Recent (the panel passes underParent)
//   all count  Recent's All header leaves out the children their session owns
//   cap        Recent's 50-card cap counts cards, not the subagents under them
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
const { ThemeContext } = await import("../ThemeProvider");
const MODERN = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any;

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
const finished = () => row(FINISHED, { title: "Finished subagent", is_subagent: true, parent_conversation_id: PARENT, agent_status: null, status: "completed", updated_at: NOW - 120_000 });

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

async function mountInbox(activeSessionId: string | null = null, opts: { modern?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const panel = <MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={activeSessionId} /></MemoryRouter>;
  await act(async () => root.render(opts.modern ? <ThemeContext.Provider value={MODERN}>{panel}</ThemeContext.Provider> : panel));
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

test("opening a subagent its session owns peeks its session's card out of the collapsed section", async () => {
  const OWNED = id("owned");
  seed([
    row(PARENT, { title: "Parent session", owners_model: true, agent_status: "working", is_idle: false, updated_at: NOW - 5_000 }),
    row(OWNED, { title: "Owned subagent", owners_model: true, owned_by_me: false, owner_session_id: PARENT, is_subagent: true, parent_conversation_id: PARENT, agent_status: "working", is_idle: false, updated_at: NOW - 4_000 }),
  ], { subagent_rows: "folded", subagent_filter: "all" });
  useInboxStore.setState({ collapsedSections: { working: true } } as any);
  const m = await mountInbox(OWNED);
  expect(useInboxStore.getState().collapsedSections.working).toBe(true);
  expect(cardOf(m.host, PARENT)?.closest(".inbox-peek")).not.toBeNull();
  await m.unmount();
});

// The card's nested state rule applies only where the panel says the card is
// drawn under its parent: dropped, the finished subagent reads its parent's
// section (Working) in the grouped view and its own placement in Recent.
test("a finished subagent reads Done under its Working parent in A card each, grouped and in Recent", async () => {
  const wordOf = (host: HTMLElement, sessionId: string) => cardOf(host, sessionId)?.querySelector("[data-status-word]")?.textContent ?? null;
  for (const view of ["grouped", "recent"]) {
    seed([parent(), busy(), finished()], { inbox_view_mode: view, subagent_rows: "full", subagent_filter: "all" });
    const m = await mountInbox(null, { modern: true });
    expect(wordOf(m.host, PARENT)).toBe("Working");
    expect(wordOf(m.host, FINISHED)).toBe("Done");
    await m.unmount();
  }
});

test("Recent's All header leaves out the children their session owns", async () => {
  const OWNED = id("owned");
  seed([
    row(PARENT, { title: "Parent session", owners_model: true, agent_status: "working", is_idle: false, updated_at: NOW - 5_000 }),
    busy(),
    row(OWNED, { title: "Owned subagent", owners_model: true, owned_by_me: false, owner_session_id: PARENT, is_subagent: true, parent_conversation_id: PARENT, agent_status: "working", is_idle: false, updated_at: NOW - 4_000 }),
  ], { inbox_view_mode: "recent", subagent_rows: "full", subagent_filter: "all" });
  const m = await mountInbox();
  expect(cardOf(m.host, OWNED)).not.toBeNull();
  expect(cardOf(m.host, BUSY)).not.toBeNull();
  expect(headerCount(m.host, "all")).toBe("2");
  await m.unmount();
});

test("Recent's 50-card cap counts cards: the subagents under a card ride its slot", async () => {
  const subs = Array.from({ length: 10 }, (_, i) =>
    row(id(`sub${i}`), { title: `Subagent ${i}`, is_subagent: true, parent_conversation_id: PARENT, agent_status: "working", is_idle: false, updated_at: NOW - 4_000 - i }));
  const others = Array.from({ length: 54 }, (_, i) => row(id(`other${String(i).padStart(2, "0")}`), { title: `Other ${i}`, updated_at: NOW - 10_000 - i * 1_000 }));
  seed([parent(), ...subs, ...others], { inbox_view_mode: "recent", subagent_rows: "full", subagent_filter: "all" });
  const m = await mountInbox();
  for (const sub of subs) expect(cardOf(m.host, sub._id as string)).not.toBeNull();
  // The parent and the first 49 others are the 50 cards; the last 5 wait.
  expect(cardOf(m.host, others[48]._id as string)).not.toBeNull();
  expect(cardOf(m.host, others[49]._id as string)).toBeNull();
  expect(m.host.querySelector("[data-sv-show-more]")?.textContent).toBe("Show 5 more · 5 hidden");
  await m.unmount();
});

test("Recent keeps an open owned subagent and its card when the card sits past the cap, and counts only hidden cards", async () => {
  const OLD_PARENT = id("oldparent");
  const OPEN = id("openowned");
  const owned = Array.from({ length: 6 }, (_, i) =>
    row(id(`owned${i}`), { title: `Owned ${i}`, owners_model: true, owned_by_me: false, owner_session_id: OLD_PARENT, is_subagent: true, parent_conversation_id: OLD_PARENT, status: "completed", updated_at: NOW - 3_600_000 - i }));
  const others = Array.from({ length: 52 }, (_, i) => row(id(`newer${String(i).padStart(2, "0")}`), { title: `Newer ${i}`, updated_at: NOW - 10_000 - i * 1_000 }));
  seed([
    row(OLD_PARENT, { title: "Old parent", owners_model: true, updated_at: NOW - 3_000_000 }),
    row(OPEN, { title: "Open owned subagent", owners_model: true, owned_by_me: false, owner_session_id: OLD_PARENT, is_subagent: true, parent_conversation_id: OLD_PARENT, status: "completed", updated_at: NOW - 3_500_000 }),
    ...owned,
    ...others,
  ], { inbox_view_mode: "recent", subagent_rows: "full", subagent_filter: "all" });
  const m = await mountInbox(OPEN);
  expect(cardOf(m.host, OLD_PARENT)).not.toBeNull();
  expect(cardOf(m.host, OPEN)).not.toBeNull();
  // 53 cards (52 newer + the old parent); 50 drawn, the parent force-kept: 2 cards hidden, whatever rides under them.
  expect(m.host.querySelector("[data-sv-show-more]")?.textContent).toBe("Show 2 more · 2 hidden");
  await m.unmount();
});

// Its parent not loaded, a subagent stands as a card of its own right below
// whatever card precedes it. Drawn nested it would read as that card's
// subagent, even in One line and Hidden, where nothing is drawn under a card;
// drawn under its parent it keeps the nested look.
test("a subagent whose parent is not loaded draws as a full card; under its parent it stays nested", async () => {
  const ORPHAN = id("orphan");
  const OTHER = id("other");
  const look = (host: HTMLElement, sessionId: string) => cardOf(host, sessionId)?.getAttribute("data-mc") ?? null;
  for (const view of ["grouped", "recent"]) {
    for (const mode of ["folded", "hidden", "full"]) {
      seed([
        row(OTHER, { title: "Unrelated session", agent_status: "working", is_idle: false, updated_at: NOW - 3_000 }),
        row(ORPHAN, { title: "Orphan subagent", is_subagent: true, parent_conversation_id: id("unloaded"), agent_status: "working", is_idle: false, updated_at: NOW - 4_000 }),
      ], { inbox_view_mode: view, subagent_rows: mode, subagent_filter: "all" });
      const m = await mountInbox(ORPHAN, { modern: true });
      expect(look(m.host, OTHER)).toBe("card");
      expect(look(m.host, ORPHAN)).toBe("card");
      expect(cardOf(m.host, ORPHAN)?.querySelector('[aria-label="Subagent"]')).toBeNull();
      await m.unmount();
    }
    seed([parent(), busy(), finished()], { inbox_view_mode: view, subagent_rows: "full", subagent_filter: "all" });
    const under = await mountInbox(null, { modern: true });
    expect(look(under.host, PARENT)).toBe("card");
    expect(look(under.host, BUSY)).toBe("nested");
    expect(cardOf(under.host, BUSY)?.querySelector('[aria-label="Subagent"]')).not.toBeNull();
    await under.unmount();
  }
});
