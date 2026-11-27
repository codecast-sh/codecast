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
//   snoozed   a snoozed row sleeps in Sleeping, whatever its work, saying until when
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

const WAITED_SESSION = "jx7abc1def2ghi3jkl4mno5pqr6stu7v";
const LIVE_AGENT = id("liveagent");
const HELD = id("heldforyou");

function seed(extra: { rows?: Record<string, unknown>[]; ui?: Record<string, unknown> } = {}) {
  __resetInboxPlacementCacheForTests();
  const rows = [
    // A row whose agent is producing: the Working bucket's own, ahead of the split's.
    { ...parked(LIVE_AGENT, "Live agent"), agent_status: "working", is_idle: false, updated_at: NOW - 5_000, agent_status_updated_at: NOW - 5_000 },
    // Its change run waits at a gate the viewer answers: Shipping, but the viewer's move.
    parked(HELD, "Ship gate for you"),
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
    // A session wait keys on the conversation id; its short id is the label (contracts/waitingOn).
    parked(ON_SESSION, "Mobile nav redesign", { waiting_on: { kind: "session", ref: WAITED_SESSION, label: "jx7abc1", at: NOW - 25 * 60_000 } }),
    parked(ON_TASK, "Session ownership display bug", { waiting_on: { kind: "task", ref: "ct-102274", at: NOW - HOUR } }),
    parked(ON_PR, "Union App git auth", { waiting_on: { kind: "pr", ref: "acme/app#259", at: NOW - 3 * HOUR } }),
    parked(SCHEDULED, "Strategy Advisor", { armed_trigger_kind: "standing" }),
    parked(STALLED, "Icon legend build"),
    parked(SNOOZED, "Snoozed reviewer", {
      inbox_snoozed_until: NOW + 3 * HOUR,
      open_tasks: [{ kind: "agent", description: "Review the diff" }],
      open_tasks_at: NOW - 60_000,
    }),
    ...(extra.rows ?? []),
  ];
  const sessions: Record<string, unknown> = {};
  for (const r of rows) sessions[(r as { _id: string })._id] = r;
  useInboxStore.setState({
    sessions,
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {
      gate: { _id: "gate", conversation_id: "elsewhere", question: "Ship it?", status: "answered", user_id: "me", created_at: NOW - HOUR },
    },
    collapsedSections: {},
    workflowRuns: {
      r1: run("r1", SHIPPER, { current_node_id: "ci", current_node_label: "CI" }),
      r2: run("r2", FAILED, { current_node_id: "ci_conflict", waiting_on_session: { node_id: "ci_conflict", conversation_id: FAILED } }),
      r3: run("r3", HELD, { status: "paused", current_node_id: "decide", gate_decision_id: "gate", gate_decision_status: "pending" }),
    },
    agentTasks: {
      t1: { _id: "t1", title: "Distill new huddles", status: "scheduled", run_at: NOW + 44 * 60_000, schedule_type: "recurring", originating_conversation_id: SCHEDULED, created_at: NOW - HOUR },
    },
    currentUser: { _id: "me", name: "Jason" },
    clientState: { ui: { inbox_scope: "mine", show_old: true, ...extra.ui } },
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
  expect(sectionIds(host, "working")).toEqual([LIVE_AGENT, REVIEWERS]);
  const card = host.querySelector(`[data-session-id="${REVIEWERS}"]`)!;
  expect(card.getAttribute("data-mc-status")).toBe("working");
  expect(card.closest("[data-dormant-section]")).toBeNull();
  const line = lineOf(host, REVIEWERS)!;
  expect(line.getAttribute("data-activity-line")).toBe("working");
  expect(line.querySelector("[data-al-arrow]")!.getAttribute("aria-label")).toBe("What is running");
  // The ↳ is the registered "Inside this session" mark; the words sit right after it.
  const arrowMark = line.querySelector("[data-al-arrow]")!.closest("[data-mark]")!;
  expect(arrowMark.getAttribute("data-mark")).toBe("inbox.inside");
  expect(arrowMark.nextElementSibling!.textContent).toBe("3 subagents · reviewing");
  await unmount();
});

test("a row whose change is in CI draws in Shipping, compact, with the rocket, neutral words and the bar", async () => {
  const { host, unmount } = await mountInbox();
  expect(sectionIds(host, "shipping").sort()).toEqual([SHIPPER, FAILED, HELD].sort());
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
  expect(sectionIds(host, "dormant").sort()).toEqual([ON_PERSON, ON_SESSION, ON_TASK, ON_PR, SCHEDULED, STALLED, SNOOZED].sort());

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
  // The session pill names the waited-on session by its short id, never the raw conversation id.
  const sessionLine = lineOf(host, ON_SESSION)!;
  expect(sessionLine.querySelector('[data-ref-kind="session"]')!.textContent).toContain("jx7abc1");
  expect(sessionLine.textContent).not.toContain(WAITED_SESSION);
  expect(sessionLine.textContent).toContain("since 25m");
  expect(lineOf(host, ON_PR)!.querySelector('[data-ref-kind="pr"]')!.textContent).toContain("#259");
  expect(lineOf(host, ON_TASK)!.querySelector('[data-ref-kind="task"]')!.textContent).toContain("ct-102274");

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

test("a snoozed row sleeps in Sleeping, whatever its work, saying until when", async () => {
  const { host, unmount } = await mountInbox();
  for (const key of ["working", "shipping"]) expect(sectionIds(host, key)).not.toContain(SNOOZED);
  expect(sectionIds(host, "dormant")).toContain(SNOOZED);
  expect(useInboxStore.getState().dormantSplitNav?.working.has(SNOOZED)).toBeFalsy();
  expect(lineOf(host, SNOOZED)!.textContent).toContain("snoozed until");
  await unmount();
});

test("a subagent snoozed with its parent is drawn in Sleeping too, and walked", async () => {
  const CHILD = id("snoozedchild");
  seed({ rows: [parked(CHILD, "Snoozed helper", { is_subagent: true, parent_conversation_id: SNOOZED, inbox_snoozed_until: NOW + 3 * HOUR })] });
  const { host, unmount } = await mountInbox();
  expect(sectionIds(host, "dormant")).toEqual(expect.arrayContaining([SNOOZED, CHILD]));
  expect(computeVisualOrder(useInboxStore.getState() as any).map((s) => s._id)).toEqual(expect.arrayContaining([SNOOZED, CHILD]));
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
  // A row the rail draws in Working on its own (or under Needs You) carries no chip.
  expect((await chipText(LIVE_AGENT)).kind).toBeNull();
});

test("the header says a row's state once: the chip, not the agent's raw status beside it", async () => {
  const { DormantWakeChip } = await import("../conversation/DormantWakeChip");
  const { SessionStatusSlot } = await import("../conversation/SessionStatusSlot");
  const header = async (conversationId: string, agentStatus: string) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <MemoryRouter>
        <SessionStatusSlot conversationId={conversationId} agentStatus={agentStatus} disconnected={false} live={false} onRestart={() => {}} />
        <DormantWakeChip conversationId={conversationId} />
      </MemoryRouter>,
    ));
    const text = host.textContent ?? "";
    const pill = host.querySelector("[data-cc-conv-status]");
    await act(async () => root.unmount());
    host.remove();
    return { text, pill: !!pill };
  };
  // Its workers run while the agent sleeps: the header says Working, never Sleeping too.
  const working = await header(REVIEWERS, "dormant");
  expect(working.pill).toBe(false);
  expect(working.text).toContain("Working");
  expect(working.text).not.toContain("Sleeping");
  const ship = await header(SHIPPER, "dormant");
  expect(ship.pill).toBe(false);
  expect(ship.text).toContain("Shipping");
  // A row outside the split keeps the agent's own status.
  const live = await header(LIVE_AGENT, "working");
  expect(live.pill).toBe(true);
  expect(live.text).toContain("Working");
});

test("a ship step held for the viewer keeps Shipping's place but asks for them, and opens where they act", async () => {
  const { host, unmount } = await mountInbox();
  const line = lineOf(host, HELD)!;
  expect(line.getAttribute("data-activity-line")).toBe("shipping");
  const action = line.querySelector("[data-ship-action]")!;
  expect(action.textContent).toBe("Your call");
  expect(action.getAttribute("href")).toBe("/workflows/runs/r3");
  // The attention colour, unlike a plain shipping line.
  expect(line.innerHTML).toContain("text-sol-yellow");
  expect(lineOf(host, SHIPPER)!.querySelector("[data-ship-action]")).toBeNull();
  await unmount();
});

test("a worker counts only while it is alive: a dead one leaves its spawner Sleeping", async () => {
  const LEAD = id("lead");
  const worker = (alive: boolean) => ({
    ...parked(id("worker"), "Implement the rail", { spawned_by_conversation_id: LEAD }),
    agent_status: "working", is_idle: false, updated_at: NOW - 10_000, agent_status_updated_at: NOW - 10_000,
    last_heartbeat: alive ? NOW - 5_000 : NOW - 3 * HOUR,
  });
  seed({ rows: [parked(LEAD, "Lead of one worker"), worker(true)] });
  let m = await mountInbox();
  expect(sectionIds(m.host, "working")).toContain(LEAD);
  expect(lineOf(m.host, LEAD)!.textContent).toContain("building · 1 worker");
  await m.unmount();

  seed({ rows: [parked(LEAD, "Lead of one worker"), worker(false)] });
  m = await mountInbox();
  expect(sectionIds(m.host, "working")).not.toContain(LEAD);
  expect(sectionIds(m.host, "dormant")).toContain(LEAD);
  await m.unmount();
});

test("each section's header counts the rows it draws", async () => {
  const { host, unmount } = await mountInbox();
  const count = (key: string) => Number(host.querySelector(`[data-inbox-section="${key}"]`)!.getAttribute("data-inbox-section-count"));
  for (const key of ["working", "shipping", "dormant"]) expect([key, count(key)]).toEqual([key, sectionIds(host, key).length]);
  await unmount();
});

test("the flat Recent view says the same word for a split row", async () => {
  seed({ ui: { inbox_view_mode: "recent" } });
  const { host, unmount } = await mountInbox();
  const status = (sid: string) => host.querySelector(`[data-session-id="${sid}"]`)?.getAttribute("data-mc-status");
  expect(status(REVIEWERS)).toBe("working");
  expect(status(SHIPPER)).toBe("shipping");
  expect(status(STALLED)).toBe("dormant");
  await unmount();
});

test("the board and /sessions take the rail's split for the same rows", async () => {
  const { placeInboxRows } = await import("../../store/inboxStore");
  const { splitStatusBands } = await import("../../lib/statusBands");
  const { rowActivity, placedStatusOf } = await import("../../lib/railActivity");
  const { railRowPlacement } = await import("../../store/inboxStore");
  const st = useInboxStore.getState();
  const placed = placeInboxRows(st as any, { now: NOW });
  const bands = splitStatusBands(placed, { queued: new Set(), pendingSendIds: new Set(), now: NOW, activityOf: (row) => rowActivity(st, row, NOW).state });
  expect(bands.working.map((t) => t.session._id)).toContain(REVIEWERS);
  expect(bands.shipping.map((t) => t.session._id).sort()).toEqual([SHIPPER, FAILED, HELD].sort());
  expect(bands.dormant.map((t) => t.session._id)).toContain(STALLED);
  // /sessions, the window list and the activity feed read placedStatusOf.
  const row = st.sessions[SHIPPER];
  expect(placedStatusOf(st, { row, placement: railRowPlacement(row, NOW), now: NOW })).toBe("shipping");
});

test("a ship run reads off the LIVE run, and its Go live step is Shipping's Live", async () => {
  const { rowActivity } = await import("../../lib/railActivity");
  const ROW = id("goinglive");
  seed({ rows: [parked(ROW, "Going live", { parked_wake_kind: "run" })] });
  useInboxStore.setState((s: any) => ({
    workflowRuns: {
      ...s.workflowRuns,
      // A newer run that stopped at CI says nothing about the one in flight.
      stale: run("stale", ROW, { status: "failed", current_node_id: "ci", created_at: NOW - 10 * 60_000 }),
      live: run("live", ROW, { status: "running", current_node_id: "deploy__wait", current_node_label: "Go live", created_at: NOW - HOUR, pr: { repository: "acme/app", number: 267 } }),
    },
  }));
  const a = rowActivity(useInboxStore.getState(), useInboxStore.getState().sessions[ROW], NOW);
  expect(a).toMatchObject({ state: "shipping", stage: "live", words: "Checking it's live" });
});

test("the live run's pull request names the CI step when the row's own status lacks it", async () => {
  const { rowActivity } = await import("../../lib/railActivity");
  const ROW = id("runpr");
  seed({ rows: [parked(ROW, "Run PR", { parked_wake_kind: "run" })] });
  useInboxStore.setState((s: any) => ({ workflowRuns: { ...s.workflowRuns, rp: run("rp", ROW, { current_node_id: "ci", pr: { repository: "acme/app", number: 267 } }) } }));
  expect(rowActivity(useInboxStore.getState(), useInboxStore.getState().sessions[ROW], NOW)).toMatchObject({ state: "shipping", words: "CI running · #267" });
});

test("a live run that ships nothing reads Working with the flow's name", async () => {
  const { rowActivity } = await import("../../lib/railActivity");
  const ROW = id("builder");
  seed({ rows: [parked(ROW, "Builder", { parked_wake_kind: "run" })] });
  useInboxStore.setState((s: any) => ({ workflowRuns: { ...s.workflowRuns, b1: run("b1", ROW, { takes_change: false, workflow_name: "build", current_node_id: "implement" }) } }));
  expect(rowActivity(useInboxStore.getState(), useInboxStore.getState().sessions[ROW], NOW)).toMatchObject({ state: "working", words: "running build" });
});

test("a PR trigger ships only on the session's own open PR: anyone else's is a wait, an ended one a schedule", async () => {
  const OTHER = id("otherpr");
  const ENDED = id("endedpr");
  const trigger = (tid: string, conv: string, pr: number) => ({ _id: tid, title: "Wake on merge", status: "scheduled", schedule_type: "event", event_filter: { event_type: "pr_merged", pr_number: pr, repository: "union/mobile" }, originating_conversation_id: conv, created_at: NOW - HOUR });
  seed({ rows: [parked(OTHER, "Watching Ashot's PR", { armed_trigger_kind: "standing" }), parked(ENDED, "Watching a merged PR", { armed_trigger_kind: "standing" })] });
  useInboxStore.setState((s: any) => ({
    agentTasks: { ...s.agentTasks, ta: trigger("ta", OTHER, 4351), tb: trigger("tb", ENDED, 4352) },
    pullRequests: { p2: { _id: "p2", repository: "union/mobile", number: 4352, state: "merged" } },
  }));
  const { host, unmount } = await mountInbox();
  expect(sectionIds(host, "shipping")).not.toContain(OTHER);
  expect(sectionIds(host, "shipping")).not.toContain(ENDED);
  const other = lineOf(host, OTHER)!;
  expect(other.getAttribute("data-activity-line")).toBe("waiting");
  expect(other.querySelector('[data-ref-kind="pr"]')!.textContent).toContain("#4351");
  expect(lineOf(host, ENDED)!.getAttribute("data-activity-line")).toBe("scheduled");
  await unmount();
});

test("an upcoming countdown on a Sleeping line is the line's grey; only an overdue one is red", async () => {
  const { host, unmount } = await mountInbox();
  const badge = lineOf(host, SCHEDULED)!.querySelector("[data-sv-wake-badge]")!;
  expect(badge.getAttribute("data-sv-wake-badge")).toBe("");
  expect(badge.className).toContain("text-sol-text-dim");
  expect(badge.className).not.toContain("amber");
  await unmount();
  seed();
  useInboxStore.setState((s: any) => ({ agentTasks: { t1: { ...s.agentTasks.t1, run_at: NOW - 10 * 60_000 } } }));
  const m = await mountInbox();
  const late = lineOf(m.host, SCHEDULED)!.querySelector("[data-sv-wake-badge]")!;
  expect(late.getAttribute("data-sv-wake-badge")).toBe("alert");
  expect(late.className).toContain("text-sol-red");
  await m.unmount();
});

test("a row parked on a run outside the team feed gets its own run feed, and keeps it", async () => {
  const { rowsNeedingRunFeed } = await import("../../lib/railActivity");
  const A = id("feedmissing");
  const B = id("feedother");
  const C = id("feedcovered");
  seed({ rows: [parked(A, "No run here", { parked_wake_kind: "run" }), parked(B, "Other team's run", { parked_wake_kind: "run" }), parked(C, "Covered", { parked_wake_kind: "run" })] });
  useInboxStore.setState((s: any) => ({
    clientState: { ui: { ...s.clientState.ui, active_team_id: "team1" } },
    workflowRuns: { ...s.workflowRuns, rb: run("rb", B, { workspace: "team:team2", current_node_id: "ci" }), rc: run("rc", C, { workspace: "team:team1", current_node_id: "ci" }) },
  }));
  const ids = rowsNeedingRunFeed(useInboxStore.getState()).split(",");
  expect(ids).toContain(A);
  expect(ids).toContain(B);
  expect(ids).not.toContain(C);
  // Once its feed brings the run in, the row stays fed so the run keeps moving.
  useInboxStore.setState((s: any) => ({ workflowRuns: { ...s.workflowRuns, ra: run("ra", A, { workspace: "team:team1", current_node_id: "ci" }) } }));
  expect(rowsNeedingRunFeed(useInboxStore.getState()).split(",")).toContain(A);
});

test("the keyboard walk visits Working, Shipping and Sleeping in the order they draw", async () => {
  const { host, unmount } = await mountInbox();
  const split = useInboxStore.getState().dormantSplitNav!;
  expect([...split.working]).toEqual([REVIEWERS]);
  expect([...split.shipping].sort()).toEqual([SHIPPER, FAILED, HELD].sort());
  const drawn = [...sectionIds(host, "working"), ...sectionIds(host, "shipping"), ...sectionIds(host, "dormant")];
  const walked = computeVisualOrder(useInboxStore.getState() as any).map((s) => s._id);
  expect(walked).toEqual(drawn);
  await unmount();
});
