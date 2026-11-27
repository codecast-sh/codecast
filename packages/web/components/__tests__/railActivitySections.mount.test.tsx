// The rail's Working, Shipping and Sleeping sections (plan pl-1138), as the
// whole panel draws them over a seeded store. Every row here is placed in the
// Dormant bucket; the shared sessionActivity, read over the store
// (lib/railActivity), decides where it draws and what its under-line says.
//
//   working   a row whose background subagents run draws in Working, as a
//             full card with the solid dot, its line naming the work
//   shipping  a row whose change run is in CI draws in Shipping, compact,
//             with the rocket, neutral words and the five-segment bar
//   sleeping  each flavor's line: waiting on a person (coloured pill), a
//             session, a task ("landing") or a PR ("to merge") with neutral
//             pills, a trigger's countdown, and the stalled warning line
//   snoozed   a snoozed row stays in Snoozed, whatever its work
//   walk      the keyboard walk visits the rows in the order they draw
//
// Run: bun test components/__tests__/railActivitySections.mount.test.tsx
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

const { useInboxStore, computeVisualOrder, __resetInboxPlacementCacheForTests } = await import("../../store/inboxStore");
const { SessionListPanel } = await import("../GlobalSessionPanel");
const { ThemeContext } = await import("../ThemeProvider");
const MODERN = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any;

const NOW = Date.now();
const HOUR = 3_600_000;
const id = (tag: string) => tag.padEnd(32, "0");

// Settled past the idle grace with the agent parked on a declared wake: the
// classifier files every one of these under Dormant.
function parked(_id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    _id,
    session_id: `s-${_id.slice(0, 8)}`,
    agent_type: "claude_code",
    title,
    user_id: "me",
    owned_by_me: true,
    status: "active",
    message_count: 6,
    updated_at: NOW - 5 * 60_000,
    agent_status_updated_at: NOW - 5 * 60_000,
    started_at: NOW - 30 * 60_000,
    last_heartbeat: NOW - 5_000,
    is_idle: true,
    has_pending: false,
    is_connected: true,
    agent_status: "dormant",
    project_path: "/src/project",
    ...extra,
  };
}

const REVIEWERS = id("reviewers");
const SHIPPER = id("shipper");
const FAILED = id("failedci");
const ON_PERSON = id("onperson");
const ON_SESSION = id("onsession");
const ON_TASK = id("ontask");
const ON_PR = id("onpr");
const SCHEDULED = id("scheduled");
const STALLED = id("stalled");
const SNOOZED = id("snoozed");

const run = (_id: string, spawner: string, extra: Record<string, unknown>) => ({
  _id, spawner_conversation_id: spawner, takes_change: true, status: "running", created_at: NOW - HOUR, updated_at: NOW - 60_000, ...extra,
});

function seed() {
  __resetInboxPlacementCacheForTests();
  const rows = [
    parked(REVIEWERS, "Priorities redesign", {
      open_tasks: [
        { kind: "agent", description: "Review the list rewrite" },
        { kind: "agent", description: "Review the store change" },
        { kind: "agent", description: "Verify the mobile build" },
      ],
      open_tasks_at: NOW - 60_000,
    }),
    parked(SHIPPER, "GitHub App auth migration", { pr_status: { pr_id: "p1", repository: "acme/app", number: 263, state: "ci_pending" } }),
    parked(FAILED, "Decision card flow design"),
    parked(ON_PERSON, "Attention repo migration", { waiting_on: { kind: "person", ref: "@ashot", at: NOW - 2 * HOUR } }),
    parked(ON_SESSION, "Mobile nav redesign", { waiting_on: { kind: "session", ref: "jx7abc1" } }),
    parked(ON_TASK, "Session ownership display bug", { waiting_on: { kind: "task", ref: "ct-102274", at: NOW - HOUR } }),
    parked(ON_PR, "Union App git auth", { waiting_on: { kind: "pr", ref: "#259" } }),
    parked(SCHEDULED, "Strategy Advisor", { armed_trigger_kind: "standing" }),
    parked(STALLED, "Icon legend build"),
    parked(SNOOZED, "Snoozed reviewer", {
      inbox_snoozed_until: NOW + 3 * HOUR,
      open_tasks: [{ kind: "agent", description: "Review the diff" }],
    }),
  ];
  const sessions: Record<string, unknown> = {};
  for (const r of rows) sessions[r._id] = r;
  useInboxStore.setState({
    sessions,
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {},
    collapsedSections: {},
    workflowRuns: {
      r1: run("r1", SHIPPER, { current_node_id: "ci", current_node_label: "CI" }),
      r2: run("r2", FAILED, { current_node_id: "ci_conflict", waiting_on_session: { node_id: "ci_conflict", conversation_id: FAILED } }),
    },
    agentTasks: {
      t1: { _id: "t1", title: "Distill new huddles", status: "scheduled", run_at: NOW + 44 * 60_000, schedule_type: "recurring", originating_conversation_id: SCHEDULED, created_at: NOW - HOUR },
    },
    currentUser: { _id: "me", name: "Jason" },
    clientState: { ui: { inbox_scope: "mine", show_old: true } },
  } as any);
}

async function mountInbox() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ThemeContext.Provider value={MODERN}>
      <MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={null} /></MemoryRouter>
    </ThemeContext.Provider>,
  ));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

/** The ids drawn in one rail section, in order. */
function sectionIds(host: HTMLElement, key: string): string[] {
  const head = host.querySelector(`[data-inbox-section="${key}"]`);
  const section = head?.closest("[data-mc-sec]")?.parentElement;
  if (!section) return [];
  return [...section.querySelectorAll("[data-session-id]")].map((el) => el.getAttribute("data-session-id")!);
}
const lineOf = (host: HTMLElement, sessionId: string) =>
  host.querySelector(`[data-session-id="${sessionId}"]`)?.closest(".relative.border-b")?.querySelector("[data-activity-line]") as HTMLElement | null;

beforeEach(() => {
  document.body.innerHTML = "";
  seed();
});

test("a row whose subagents run draws in Working, a full card with the dot, its line naming the work", async () => {
  const { host, unmount } = await mountInbox();
  expect(sectionIds(host, "working")).toEqual([REVIEWERS]);
  const card = host.querySelector(`[data-session-id="${REVIEWERS}"]`)!;
  expect(card.getAttribute("data-mc-status")).toBe("working");
  expect(card.closest("[data-dormant-section]")).toBeNull();
  const line = lineOf(host, REVIEWERS)!;
  expect(line.getAttribute("data-activity-line")).toBe("working");
  expect(line.querySelector("[data-al-arrow]")!.getAttribute("aria-label")).toBe("What is running");
  expect(line.querySelector("[data-al-arrow]")!.nextElementSibling!.textContent).toBe("3 subagents · reviewing");
  await unmount();
});

test("a row whose change is in CI draws in Shipping, compact, with the rocket, neutral words and the bar", async () => {
  const { host, unmount } = await mountInbox();
  expect(sectionIds(host, "shipping").sort()).toEqual([SHIPPER, FAILED].sort());
  const head = host.querySelector(`[data-inbox-section="shipping"]`)!;
  expect(head.closest("[data-dormant-section]")).not.toBeNull();
  expect(head.closest("[data-mc-sec]")!.querySelector("[data-status-mark]")!.getAttribute("data-status-mark")).toBe("shipping");
  const card = host.querySelector(`[data-session-id="${SHIPPER}"]`)!;
  expect(card.getAttribute("data-mc-status")).toBe("shipping");
  const line = lineOf(host, SHIPPER)!;
  expect(line.getAttribute("data-activity-line")).toBe("shipping");
  expect(line.textContent).toContain("CI running · #263");
  const bar = line.querySelector("[data-ship-bar]")!;
  expect(bar.getAttribute("data-ship-bar")).toBe("ci");
  expect(bar.getAttribute("data-tone")).toBe("muted");
  expect(bar.querySelectorAll(".chg-pip")).toHaveLength(5);
  // No trailing glyph unless a step failed.
  expect(bar.querySelector(".chg-now")).toBeNull();
  const failed = lineOf(host, FAILED)!;
  expect(failed.textContent).toContain("CI failed · fixing");
  expect(failed.querySelector("[data-ship-bar] .chg-now")).not.toBeNull();
  // Neutral words: no warning tone on a shipping line.
  expect(line.innerHTML).not.toContain("text-sol-yellow");
  await unmount();
});

test("each Sleeping flavor says what wakes it", async () => {
  const { host, unmount } = await mountInbox();
  expect(sectionIds(host, "dormant").sort()).toEqual([ON_PERSON, ON_SESSION, ON_TASK, ON_PR, SCHEDULED, STALLED].sort());

  const person = lineOf(host, ON_PERSON)!;
  expect(person.getAttribute("data-activity-line")).toBe("waiting");
  expect(person.textContent).toContain("waiting on");
  expect(person.textContent).toContain("since 2h");
  // The person keeps its colour; nothing else on these lines does.
  expect(person.querySelector("[data-ref-person]")).not.toBeNull();
  expect(person.querySelector("[data-ref-neutral]")).toBeNull();

  for (const [sid, after] of [[ON_SESSION, null], [ON_TASK, "landing"], [ON_PR, "to merge"]] as const) {
    const l = lineOf(host, sid)!;
    expect(l.textContent).toContain("waiting on");
    expect(l.querySelector("[data-ref-neutral]")).not.toBeNull();
    expect(l.querySelector("[data-ref-person]")).toBeNull();
    if (after) expect(l.textContent).toContain(after);
  }

  const scheduled = lineOf(host, SCHEDULED)!;
  expect(scheduled.getAttribute("data-activity-line")).toBe("scheduled");
  expect(scheduled.textContent).toContain("Distill new huddles");

  const stalled = lineOf(host, STALLED)!;
  expect(stalled.getAttribute("data-activity-line")).toBe("stalled");
  expect(stalled.textContent).toContain("nothing scheduled");
  expect(stalled.textContent).toMatch(/back to you in \d/);
  expect(stalled.innerHTML).toContain("text-sol-yellow");
  await unmount();
});

test("the under-line's arrow sits in the card's mark column and its words in the text column", async () => {
  const { host, unmount } = await mountInbox();
  const row = lineOf(host, STALLED)!.firstElementChild as HTMLElement;
  // The card's own geometry (ModernSessionCard): pl-3, a w-5 lead, gap-2.
  expect(row.className).toContain("pl-3");
  expect(row.className).toContain("gap-2");
  expect(row.className).toContain("items-center");
  expect(row.querySelector("[data-al-arrow]")!.className).toContain("w-5");
  await unmount();
});

test("a snoozed row stays in Snoozed, whatever its work", async () => {
  const { host, unmount } = await mountInbox();
  for (const key of ["working", "shipping", "dormant"]) expect(sectionIds(host, key)).not.toContain(SNOOZED);
  expect(useInboxStore.getState().dormantSplitNav?.working.has(SNOOZED)).toBeFalsy();
  await unmount();
});

test("the conversation header's chip says what the row says", async () => {
  const { DormantWakeChip } = await import("../conversation/DormantWakeChip");
  const chipText = async (conversationId: string) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter><DormantWakeChip conversationId={conversationId} /></MemoryRouter>));
    const chip = host.querySelector("[data-activity-line]");
    const out = { kind: chip?.getAttribute("data-activity-line") ?? null, text: chip?.textContent ?? "" };
    await act(async () => root.unmount());
    host.remove();
    return out;
  };
  expect(await chipText(REVIEWERS)).toEqual({ kind: "working", text: "Working·3 subagents · reviewing" });
  const ship = await chipText(SHIPPER);
  expect(ship.kind).toBe("shipping");
  expect(ship.text).toContain("Shipping·CI running · #263");
  const stalled = await chipText(STALLED);
  expect(stalled.kind).toBe("stalled");
  expect(stalled.text).toContain("Sleeping·nothing scheduled");
});

test("the keyboard walk visits Working, Shipping and Sleeping in the order they draw", async () => {
  const { host, unmount } = await mountInbox();
  const split = useInboxStore.getState().dormantSplitNav!;
  expect([...split.working]).toEqual([REVIEWERS]);
  expect([...split.shipping].sort()).toEqual([SHIPPER, FAILED].sort());
  const drawn = [...sectionIds(host, "working"), ...sectionIds(host, "shipping"), ...sectionIds(host, "dormant")];
  const walked = computeVisualOrder(useInboxStore.getState() as any).map((s) => s._id);
  expect(walked).toEqual(drawn);
  await unmount();
});
