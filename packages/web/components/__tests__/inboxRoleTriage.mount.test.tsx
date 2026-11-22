// A role's sessions in the inbox (docs/architecture/org-roles-run-work.md R1),
// as the person sees them. The WHOLE panel is mounted over a seeded store,
// because the contract is about where a row ends up on screen: which section
// holds it, what its card says, and what the header number says.
//
// A role is one of a session's owners. Nothing rides the role's standing
// session; each session files by its own state. The cases, one mount each:
//   own state  each of the role's sessions is a card of its own; a waiting
//              one its role drives is in Working and says "With <role>";
//              Needs You counts only what waits on the person
//   paused     a person drives (the role paused): it files like any session
//   alone      a session a role started on its own, with no person owner,
//              is not in the inbox of the account that runs it
//   raised     a role that needs the person says so in its OWN thread: its
//              standing session declares blocked and is the card in Needs You
//   star       a card's favorite star flips in the same commit as the toggle,
//              though placement memoizes on a signature without is_favorite
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
// jsdom lays nothing out, so it has no element scrolling.
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
const { ThemeContext } = await import("../ThemeProvider");
// The Modern card: its line 2 is where "With <role>" is drawn.
const MODERN = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any;

const NOW = Date.now();
const id = (tag: string) => tag.padEnd(32, "0");
const ROLE_ID = id("orgrolesgrowth");
const ROLE = { _id: ROLE_ID, short_id: "or-7", name: "Growth lead", handle: "growth", avatar: "fox", status: "active", tenure_kind: "standing" as const };

const STANDING = id("standing");
const WAITING = id("waiting");
const WORKING = id("working");
const SETTLED = id("settled");
const MINE = id("mine");

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

// The role's standing session: an anchor, parked until its next wake.
const standing = (extra: Record<string, unknown> = {}) => row(STANDING, { title: "Growth lead", is_anchor: true, anchor_id: id("anchor"), standing_role_id: ROLE_ID, role: ROLE, agent_status: "dormant", thread_state_status: "dormant", ...extra });
// Settled with nothing declared: on its own facts this is a needs input card.
// The person owns it with the role, which drives it.
const hand = (_id: string, title: string, extra: Record<string, unknown> = {}) => row(_id, { title, org_role_id: ROLE_ID, role: ROLE, owner_user_id: "me", ...extra });

function seed(rows: Record<string, unknown>[]) {
  __resetInboxPlacementCacheForTests();
  const sessions: Record<string, unknown> = {};
  for (const r of rows) sessions[(r as any)._id] = r;
  useInboxStore.setState({
    sessions,
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {},
    currentUser: { _id: "me", name: "Ashot" },
    clientState: { ui: { inbox_scope: "mine", show_old: true, show_subagents: true } },
  } as any);
}

async function mountInbox(activeSessionId: string | null = null, style: "modern" | "classic" = "modern") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<ThemeContext.Provider value={style === "modern" ? MODERN : { ...MODERN, visualStyle: "classic" }}><MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={activeSessionId} /></MemoryRouter></ThemeContext.Provider>));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

// The section a row is rendered in, read off the DOM: the nearest section
// header above it.
function sectionOf(host: HTMLElement, sessionId: string): string | null {
  const el = host.querySelector(`[data-session-id="${sessionId}"]`);
  if (!el) return null;
  const headers = [...host.querySelectorAll("[data-inbox-section]")];
  let found: string | null = null;
  for (const h of headers) {
    if (h.compareDocumentPosition(el) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) found = h.getAttribute("data-inbox-section");
  }
  return found;
}
// The header's number, or null when the section is empty and so not rendered.
const headerCount = (host: HTMLElement, section: string) =>
  host.querySelector(`[data-inbox-section="${section}"]`)?.getAttribute("data-inbox-section-count") ?? null;
const cardOf = (host: HTMLElement, sessionId: string) => host.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement | null;

beforeEach(() => { document.body.innerHTML = ""; });

const wordOf = (host: HTMLElement, sessionId: string) => cardOf(host, sessionId)?.querySelector("[data-status-word]")?.textContent ?? null;

test("each of a role's sessions is its own card; a waiting one its role drives is in Working, With the role", async () => {
  seed([standing(), hand(WAITING, "Pricing page copy"), hand(WORKING, "Cold email rewrite", { agent_status: "working", is_idle: false }), hand(SETTLED, "Launch date", { agent_status: "done", thread_state_status: "done" }), row(MINE, { title: "My own session" })]);
  const m = await mountInbox();

  // The person's own settled session is the one thing waiting on them.
  expect(sectionOf(m.host, MINE)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  // The standing session stays out of the inbox on its own facts: nothing
  // under it lifts it.
  expect(cardOf(m.host, STANDING)).toBeNull();
  // The waiting session waits on the role that drives it.
  expect(sectionOf(m.host, WAITING)).toBe("working");
  expect(wordOf(m.host, WAITING)).toBe("With Growth lead");
  expect(sectionOf(m.host, WORKING)).toBe("working");
  expect(wordOf(m.host, WORKING)).toBe("Working");
  expect(headerCount(m.host, "working")).toBe("2");
  expect(sectionOf(m.host, SETTLED)).toBe("done");
  await m.unmount();
});

test("a paused role (a person drives) files its session like any other", async () => {
  seed([standing(), hand(WAITING, "Pricing page copy", { driver_user_id: "me" })]);
  const m = await mountInbox();
  expect(sectionOf(m.host, WAITING)).toBe("needs_input");
  expect(wordOf(m.host, WAITING)).not.toContain("With");
  await m.unmount();
});

test("a session a role started on its own is not in the runner's inbox", async () => {
  seed([hand(WAITING, "Pricing page copy", { owned_by_me: false, owner_user_id: null }), row(MINE, { title: "My own session" })]);
  const m = await mountInbox();
  expect(cardOf(m.host, WAITING)).toBeNull();
  expect(cardOf(m.host, MINE)).not.toBeNull();
  await m.unmount();
});

test("a role that needs the person raises it in its own thread: the role's card files in Needs You on its own", async () => {
  seed([
    standing({ agent_status: "idle", thread_state_status: "blocked", thread_state: "Which lawyer signs the third market: ours is slow, theirs is dear" }),
    hand(WAITING, "Pricing page copy"),
  ]);
  const m = await mountInbox();
  expect(sectionOf(m.host, STANDING)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  expect(sectionOf(m.host, WAITING)).toBe("working");
  await m.unmount();
});

test("a card's star flips in the same commit as the toggle, both ways", async () => {
  seed([row(MINE, { title: "My own session", is_favorite: false })]);
  useInboxStore.setState({ favorites: [] } as any);
  const m = await mountInbox(null, "classic");
  const star = () => cardOf(m.host, MINE)!.querySelector("[aria-label=Favorite],[aria-label=Unfavorite]")!.getAttribute("aria-label");
  expect(star()).toBe("Favorite");
  await act(async () => useInboxStore.getState().toggleFavorite(MINE));
  expect(star()).toBe("Unfavorite");
  await act(async () => useInboxStore.getState().toggleFavorite(MINE));
  expect(star()).toBe("Favorite");
  await m.unmount();
});
