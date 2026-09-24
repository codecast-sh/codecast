// A role's sessions in the inbox (docs/architecture/org-roles-run-work.md R1),
// as the person sees them. The WHOLE panel is mounted over a seeded store,
// because the contract is about where a row ends up on screen: which section
// holds it, whether it is a card or a small row under the role's card, what
// the header number says, and what the two gestures do in the same tick.
//
// The cases, one mount each (R1, revised):
//   count      a session that reports to a role is never a row in the inbox
//              (org-staffing.md S23.3): the role's card carries a count that
//              opens the role's page, and Needs Input does not count it
//   through    a session the role escalated stays nested; the ROLE's card is
//              the one in Needs Input, carrying the line, the session pill and
//              Hand back per line; two escalations are one card with two lines
//   direct     a session the role put in front of the person directly is a
//              card of its own in Needs Input, with the role's face and line
//   the count  the person's own Put in my inbox is direct: the role's card
//              counts it, and Hand back moves it back in the same tick
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
const ESCALATED = id("escalated");
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
const standing = () => row(STANDING, { title: "Growth lead", is_anchor: true, anchor_id: id("anchor"), standing_role_id: ROLE_ID, role: ROLE, agent_status: "dormant", thread_state_status: "dormant" });
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

test("by default the role's card is the one in Needs Input, carrying the lines; the sessions stay off the list; Hand back per line", async () => {
  const OLDER = id("older");
  seed([
    standing(),
    hand(WAITING, "Pricing page copy"),
    hand(ESCALATED, "Launch date", { updated_at: NOW - 10_000, agent_status: "done", thread_state_status: "done", escalated_by_role: { role_id: ROLE_ID, line: "the pricing copy is ready and needs your eye\n\nTwo options are in the thread.", at: NOW - 120_000 } }),
    hand(OLDER, "Cold email rewrite", { updated_at: NOW - 20_000, agent_status: "done", thread_state_status: "done", escalated_by_role: { role_id: ROLE_ID, line: "the launch date is yours to call", at: NOW - 600_000 } }),
  ]);
  const m = await mountInbox();

  // The role's own facts say dormant; the escalations under it put its card
  // in Needs Input, and it is the ONE card counted there.
  expect(sectionOf(m.host, STANDING)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  // The three sessions nest under the card as subagent rows, under the same
  // two row fold every subagent list has; the card counts them, and the two
  // escalated ones reach the person as its lines.
  for (const sid of [ESCALATED, OLDER]) expect(cardOf(m.host, sid)!.querySelector("[data-role-handed]")).not.toBeNull();
  expect(cardOf(m.host, WAITING)).toBeNull();
  expect(m.host.textContent).toContain("+1 more");
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("3 sessions");

  // One card, two lines, newest first, each with the session pill, the first
  // line of the reason, the whole reason on hover, and Hand back.
  const card = cardOf(m.host, STANDING)!;
  const lines = [...card.querySelectorAll("[data-role-escalation]")];
  expect(lines.map((l) => l.getAttribute("data-role-escalation"))).toEqual([ESCALATED, OLDER]);
  // The pill resolves the session from the store by its id, so the person reads its title, never a sliced Convex id.
  expect(lines[0].textContent).toContain("Launch date");
  expect(lines[0].textContent).toContain("the pricing copy is ready and needs your eye");
  expect(lines[0].textContent).not.toContain("Two options are in the thread.");
  expect(lines[0].querySelector("button[title]")!.getAttribute("title")).toContain("Two options are in the thread.");
  expect(lines[0].querySelector('[data-role-gesture="hand-back"]')!.textContent).toBe("Hand back");
  // The card carries no direct count: nothing is in the person's inbox on its own.
  expect(card.querySelector("[data-role-escalated-count]")).toBeNull();

  // Unfold shows the whole reason.
  await act(async () => { (lines[0].querySelector("button[title]") as HTMLElement).click(); });
  expect(cardOf(m.host, STANDING)!.querySelector(`[data-role-escalation="${ESCALATED}"]`)!.textContent).toContain("Two options are in the thread.");

  // Hand back on one line: that session is quietly the role's again, the
  // other line stays, and the role's card stays in Needs Input for it.
  await act(async () => {
    (lines[0].querySelector('[data-role-gesture="hand-back"]') as HTMLElement).click();
  });
  const after = [...cardOf(m.host, STANDING)!.querySelectorAll("[data-role-escalation]")];
  expect(after.map((l) => l.getAttribute("data-role-escalation"))).toEqual([OLDER]);
  // The row stays under the card; only its "with you" tag is gone.
  expect(cardOf(m.host, ESCALATED)!.querySelector("[data-role-handed]")).toBeNull();
  expect(sectionOf(m.host, STANDING)).toBe("needs_input");

  // Hand back the last one: the role's card goes back to its own state.
  await act(async () => {
    (after[0].querySelector('[data-role-gesture="hand-back"]') as HTMLElement).click();
  });
  expect(sectionOf(m.host, STANDING)).toBe("dormant");
  expect(headerCount(m.host, "needs_input")).toBeNull();
  await m.unmount();
});

test("a direct escalation is the session's own card in Needs Input, with the role's face and line", async () => {
  seed([
    standing(),
    hand(WAITING, "Pricing page copy"),
    hand(ESCALATED, "Launch date", { agent_status: "done", thread_state_status: "done", escalated_by_role: { role_id: ROLE_ID, line: "a permission prompt is open in here", at: NOW - 120_000, direct: true } }),
  ]);
  const m = await mountInbox();

  expect(sectionOf(m.host, ESCALATED)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  const el = cardOf(m.host, ESCALATED)!;
  // A full card, not the small row.
  expect(el.querySelector('[aria-label="Reports to @growth"]')).toBeNull();
  const strip = el.querySelector("[data-escalation]")!;
  expect(strip.textContent).toContain("@growth:");
  expect(strip.textContent).toContain("a permission prompt is open in here");
  // The role's face, and the one gesture that sends it back.
  expect(strip.querySelector("img, svg, [role=img]")).not.toBeNull();
  expect(strip.querySelector('[data-role-gesture="hand-back"]')!.textContent).toBe("Hand back to @growth");
  // The role's card is untouched: dormant, the other session nested under it,
  // counting the one it put in the person's inbox.
  expect(sectionOf(m.host, STANDING)).toBe("dormant");
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("1 session");
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-escalated-count]")!.textContent).toBe("1 in your inbox");
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-escalations]")).toBeNull();
  await m.unmount();
});

test("the role's card counts what it escalated, and both gestures move the row in the same tick", async () => {
  seed([standing(), hand(WAITING, "Pricing page copy"), hand(WORKING, "Cold email rewrite")]);
  const m = await mountInbox();
  const countOn = () => cardOf(m.host, STANDING)!.querySelector("[data-role-escalated-count]")?.textContent ?? null;

  // Nothing escalated: the card asks nothing, so it shows no number.
  expect(countOn()).toBeNull();
  expect(headerCount(m.host, "needs_input")).toBeNull();

  // The sessions nest under the card as subagent rows, and the card counts them.
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("2 sessions");
  expect(cardOf(m.host, WAITING)).not.toBeNull();

  // Put in my inbox (the person's gesture on the role's page): no await, no
  // server. The draft moves the row, and it becomes a card of its own.
  await act(async () => {
    useInboxStore.getState().putSessionInMyInbox(WAITING, "Ashot put this in their inbox", Date.now());
  });
  expect(sectionOf(m.host, WAITING)).toBe("needs_input");
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("1 session");
  expect(cardOf(m.host, WAITING)!.querySelector("[data-escalation]")!.textContent).toContain("Ashot put this in their inbox");
  expect(countOn()).toBe("1 in your inbox");
  expect(headerCount(m.host, "needs_input")).toBe("1");

  // Hand back: it is the role's again, and the number goes quiet.
  await act(async () => {
    (cardOf(m.host, WAITING)!.querySelector('[data-role-gesture="hand-back"]') as HTMLElement).click();
  });
  // It is a row under the role's card again, with no line of its own.
  expect(cardOf(m.host, WAITING)!.querySelector("[data-escalation]")).toBeNull();
  expect(cardOf(m.host, STANDING)!.querySelector("[data-role-sessions]")!.textContent).toBe("2 sessions");
  expect(countOn()).toBeNull();
  expect(headerCount(m.host, "needs_input")).toBeNull();
  await m.unmount();
});
