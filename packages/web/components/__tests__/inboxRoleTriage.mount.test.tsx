// A role's sessions in the inbox (docs/architecture/org-roles-run-work.md R1),
// as the person sees them. The WHOLE panel is mounted over a seeded store,
// because the contract is about where a row ends up on screen: which section
// holds it, whether it is a card or a small row under the role's card, and
// what the header number says.
//
// The cases, one mount each:
//   count      a session that reports to a role is never a row in the inbox
//              (org-staffing.md S23.3): the role's card carries a count that
//              opens the role's page, and Needs Input does not count it
//   raised     a role that needs the person says so in its OWN thread: its
//              standing session declares blocked, and the ROLE's card is the
//              one in Needs Input, like any session that needs input; its
//              sessions stay rows under it with no gesture of their own
//   quiet      a role that is quietly dormant files in Dormant, however many
//              of its sessions wait on it
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
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
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
const hand = (_id: string, title: string, extra: Record<string, unknown> = {}) => row(_id, { title, org_role_id: ROLE_ID, role: ROLE, ...extra });

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
    clientState: { ui: { inbox_scope: "mine", show_old: true } },
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

test("a role's sessions are subagent rows under the role's card, with a count on the card, and Needs Input does not count them", async () => {
  seed([standing(), hand(WAITING, "Pricing page copy"), hand(WORKING, "Cold email rewrite", { agent_status: "working", is_idle: false }), row(MINE, { title: "My own session" })]);
  const m = await mountInbox();

  // The person's own settled session is the one thing waiting on them.
  expect(sectionOf(m.host, MINE)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");

  // The role's card surfaced (a standing session with nothing under it stays
  // out of the inbox) and files by the role's own state.
  expect(sectionOf(m.host, STANDING)).toBe("dormant");
  // Its sessions are subagent rows under it, with no gesture of their own,
  // and the card carries the count, which opens the role's page.
  for (const sid of [WAITING, WORKING]) {
    const sub = cardOf(m.host, sid)!;
    expect(sub).not.toBeNull();
    expect(sub.querySelector("[data-role-gesture]")).toBeNull();
  }
  const pill = cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]") as HTMLAnchorElement;
  expect(pill.textContent).toBe("2 sessions");
  expect(pill.getAttribute("href")).toBe("/org/or-7");
  // The role's card is one thing in its section, however many ride it.
  expect(headerCount(m.host, "dormant")).toBe("1");
  await m.unmount();

  // The subagent toggle hides them like any other subagent row.
  useInboxStore.setState({ clientState: { ui: { inbox_scope: "mine", show_old: true, show_subagents: false } } } as any);
  const hidden = await mountInbox();
  for (const sid of [WAITING, WORKING]) expect(cardOf(hidden.host, sid)).toBeNull();
  expect(cardOf(hidden.host, STANDING)).not.toBeNull();
  await hidden.unmount();
});

test("a role that needs the person raises it in its own thread: the role's card files in Needs Input, its sessions ride it with no gesture", async () => {
  seed([
    standing({ agent_status: "idle", thread_state_status: "blocked", thread_state: "Which lawyer signs the third market: ours is slow, theirs is dear" }),
    hand(WAITING, "Pricing page copy"),
    hand(WORKING, "Cold email rewrite", { agent_status: "working", is_idle: false }),
  ]);
  const m = await mountInbox();

  // The role's own declaration puts its card in Needs Input, and it is the
  // ONE card counted there.
  expect(sectionOf(m.host, STANDING)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  // Its sessions are rows under the card with no gesture of their own; the
  // card counts them.
  for (const sid of [WAITING, WORKING]) {
    const sub = cardOf(m.host, sid)!;
    expect(sub).not.toBeNull();
    expect(sub.querySelector("[data-role-gesture]")).toBeNull();
  }
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("2 sessions");
  await m.unmount();
});

test("a quietly dormant role files in Dormant, however many of its sessions wait on it", async () => {
  seed([
    standing(),
    hand(WAITING, "Pricing page copy"),
    hand(SETTLED, "Launch date", { agent_status: "done", thread_state_status: "done" }),
  ]);
  const m = await mountInbox();

  expect(sectionOf(m.host, STANDING)).toBe("dormant");
  expect(headerCount(m.host, "dormant")).toBe("1");
  expect(headerCount(m.host, "needs_input")).toBeNull();
  for (const sid of [WAITING, SETTLED]) expect(cardOf(m.host, sid)!.querySelector("[data-role-gesture]")).toBeNull();
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("2 sessions");
  await m.unmount();
});

// A sub-lead's standing session carries its parent role in org_role_id
// (org-staffing.md S28): blocked, it is a sub row under the parent lead's
// card, never a card of its own; the parent is the card that needs input.
test("a blocked sub-lead is a sub row under its parent lead, which is the card in Needs Input", async () => {
  const SUB_ROLE_ID = id("orgrolescalling");
  const SUB_ROLE = { _id: SUB_ROLE_ID, short_id: "or-9", name: "Calling lead", handle: "calling", avatar: "fox", status: "active", tenure_kind: "standing" as const };
  const SUB = id("substanding");
  seed([
    standing({ agent_status: "idle", thread_state_status: "blocked", thread_state: "Texas seed is yours to call\nBlocked: your call on the seed" }),
    row(SUB, { title: "Calling lead", is_anchor: true, anchor_id: id("anchorsub"), standing_role_id: SUB_ROLE_ID, role: SUB_ROLE, org_role_id: ROLE_ID, agent_status: "idle", thread_state_status: "blocked", thread_state: "Which tool cuts come next?\nBlocked: your pick" }),
    hand(WAITING, "Pricing page copy"),
  ]);
  const m = await mountInbox();
  expect(sectionOf(m.host, STANDING)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  const sub = cardOf(m.host, SUB)!;
  expect(sub).not.toBeNull();
  // A sub row: no gesture of its own, listed under the parent's card.
  expect(sub.querySelector("[data-role-gesture]")).toBeNull();
  expect(cardOf(m.host, STANDING)!.compareDocumentPosition(sub) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("2 sessions");
  await m.unmount();
});
