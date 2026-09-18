// A role's sessions in the inbox (docs/architecture/org-roles-run-work.md R1),
// as the person sees them. The WHOLE panel is mounted over a seeded store,
// because the contract is about where a row ends up on screen: which section
// holds it, whether it is a card or a small row under the role's card, what
// the header number says, and what the two gestures do in the same tick.
//
// Three cases, one mount each:
//   nested     a session that reports to a role sits under the role's card as
//              the small row a subagent uses, and Needs Input does not count it
//   escalated  a session the role put in front of the person is a card of its
//              own in Needs Input, with the role's face and its one line
//   the count  the role's card says how many of its sessions it escalated
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

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
  dom.window.close();
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
  await act(async () => root.render(<SessionListPanel activeSessionId={null} />));
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

test("a role's session is a small row under the role's card, and Needs Input does not count it", async () => {
  seed([standing(), hand(WAITING, "Pricing page copy"), hand(WORKING, "Cold email rewrite", { agent_status: "working", is_idle: false }), row(MINE, { title: "My own session" })]);
  const m = await mountInbox();

  // The person's own settled session is the one thing waiting on them.
  expect(sectionOf(m.host, MINE)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");

  // The role's card surfaced (a standing session with nothing under it stays
  // out of the inbox) and files by the role's own state.
  expect(sectionOf(m.host, STANDING)).toBe("dormant");
  // Both of its sessions sit in that section, right under it, as small rows.
  for (const sid of [WAITING, WORKING]) {
    expect(sectionOf(m.host, sid)).toBe("dormant");
    const el = cardOf(m.host, sid)!;
    expect(el.querySelector('[aria-label="Reports to @growth"]')).not.toBeNull();
    expect(el.querySelector('[data-role-gesture="put-in-my-inbox"]')).not.toBeNull();
    // A small row carries no strip and no count.
    expect(el.querySelector("[data-escalation]")).toBeNull();
  }
  // The role's card is one thing in its section, however many sit under it.
  expect(headerCount(m.host, "dormant")).toBe("1");
  await m.unmount();
});

test("an escalated session is a card of its own in Needs Input, with the role's face and line", async () => {
  seed([
    standing(),
    hand(WAITING, "Pricing page copy"),
    hand(ESCALATED, "Launch date", { agent_status: "done", thread_state_status: "done", escalated_by_role: { role_id: ROLE_ID, line: "the pricing copy is ready and needs your eye", at: NOW - 120_000 } }),
  ]);
  const m = await mountInbox();

  expect(sectionOf(m.host, ESCALATED)).toBe("needs_input");
  expect(headerCount(m.host, "needs_input")).toBe("1");
  const el = cardOf(m.host, ESCALATED)!;
  // A full card, not the small row.
  expect(el.querySelector('[aria-label="Reports to @growth"]')).toBeNull();
  const strip = el.querySelector("[data-escalation]")!;
  expect(strip.textContent).toContain("@growth:");
  expect(strip.textContent).toContain("the pricing copy is ready and needs your eye");
  // The role's face, and the one gesture that sends it back.
  expect(strip.querySelector("img, svg, [role=img]")).not.toBeNull();
  expect(strip.querySelector('[data-role-gesture="hand-back"]')!.textContent).toBe("Hand back to @growth");
  // The other session is still the role's.
  expect(sectionOf(m.host, WAITING)).toBe("dormant");
  await m.unmount();
});

test("the role's card counts what it escalated, and both gestures move the row in the same tick", async () => {
  seed([standing(), hand(WAITING, "Pricing page copy"), hand(WORKING, "Cold email rewrite")]);
  const m = await mountInbox();
  const countOn = () => cardOf(m.host, STANDING)!.querySelector("[data-role-escalated-count]")?.textContent ?? null;

  // Nothing escalated: the card asks nothing, so it shows no number.
  expect(countOn()).toBeNull();
  expect(headerCount(m.host, "needs_input")).toBeNull();

  // Put in my inbox: no await, no server. The draft moves the row.
  await act(async () => {
    (cardOf(m.host, WAITING)!.querySelector('[data-role-gesture="put-in-my-inbox"]') as HTMLElement).click();
  });
  expect(sectionOf(m.host, WAITING)).toBe("needs_input");
  expect(cardOf(m.host, WAITING)!.querySelector("[data-escalation]")!.textContent).toContain("Ashot put this in their inbox");
  expect(countOn()).toBe("1 in your inbox");
  expect(headerCount(m.host, "needs_input")).toBe("1");

  // Hand back: it is the role's again, and the number goes quiet.
  await act(async () => {
    (cardOf(m.host, WAITING)!.querySelector('[data-role-gesture="hand-back"]') as HTMLElement).click();
  });
  expect(sectionOf(m.host, WAITING)).toBe("dormant");
  expect(countOn()).toBeNull();
  expect(headerCount(m.host, "needs_input")).toBeNull();
  await m.unmount();
});
