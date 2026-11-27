// /priorities mounted in jsdom over a convex transport that answers by name
// (test-helpers/missingBackend.tsx), with rows shaped like priorities.list's
// contract (each step's linked sessions and plans). Proves: each open
// milestone shows one state in the session language, and only Needs you and
// New session are actions; a milestone needs you exactly when the sidebar's
// Needs You holds one of its sessions (the inbox's live verdict wins over the
// server's); DONE and POLISH sections; only the viewer's own priorities, the
// past ones folded; the ten-day strip and its hover card; the legend; a
// double-click renames a milestone; phone and desktop layouts; and the page's
// empty, error, behind and feature-off states. The priority's title is in
// PriorityTitle.mount.test.tsx, the strips' loading and tap and the breakdown
// in PriorityStrips.mount.test.tsx.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesPage.mount.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage, NoPrioritiesYet } = await import("./PrioritiesPage");
const { layoutForWidth } = await import("../../lib/priorityList");
const { withLiveRanks } = await import("../../lib/priorities");
const { DAY, HISTORY, HOUR, NOW, PL_1075, ROWS, block, days, links, listOf, mount, order, row, seedNeedsYou, sess, step, states, view } = await import("../../test-helpers/prioritiesList");

test("each open milestone shows one state in the session language; only Needs you and New session are actions", async () => {
  const unseed = seedNeedsYou("crflow", "calib1");
  const page = await mount(view());
  try {
    expect(describeFailures(page)).toBe("");
    const b = (id: string) => block(page.container, id);
    expect(states(b("pri-1"))).toEqual({ s1: "dormant", s2: "needs_you" });
    expect(states(b("pri-2"))).toEqual({ s1: "dormant", s2: "dormant", s3: "start", s4: "dormant" });
    expect(states(b("pri-3"))).toEqual({ s1: "working" });
    // The server says "Session mapping" asks too, but the sidebar does not hold it: it sleeps.
    expect(states(b("pri-4"))).toEqual({ s1: "needs_you", s2: "idle" });
    expect(states(b("pri-5"))).toEqual({ s1: "start" });
    // Needs you opens the session to answer; New session the composer. Nothing else in the box column is a link.
    const ask = b("pri-1").querySelector('[data-milestone="s2"] [data-state-action="needs_you"]')!;
    expect(ask.getAttribute("href")).toBe(`/conversation/${fixtureId("crflow")}`);
    expect(b("pri-2").querySelector('[data-milestone="s3"] [data-state-action="start"]')!.getAttribute("href")).toMatch(/^\/inbox\?|compose|draft/);
    expect(page.container.querySelectorAll("[data-state-action]")).toHaveLength(4);
    for (const k of ["working", "dormant"]) expect(page.container.querySelector(`li[data-state="${k}"] [data-state="${k}"] [data-status-mark="${k}"]`)).not.toBeNull();
    // No Start, Open, Resume or Answer buttons, no "in ‹session›", no session column.
    expect(page.container.querySelector("[data-action], [data-in-session], [data-line-chips]")).toBeNull();
    expect(page.text()).not.toMatch(/\b(Resume|Answer)\b/);
  } finally {
    await page.unmount();
    unseed();
  }
}, 60_000);

test("a session the server says asks, but the sidebar does not hold, reads idle, never Needs you and never Sleeping", async () => {
  // No store rows: the sidebar's Needs You is empty, whatever the server reads off the conversations.
  const page = await mount(view());
  try {
    expect(states(block(page.container, "pri-1")).s2).toBe("idle");
    expect(states(block(page.container, "pri-4"))).toEqual({ s1: "idle", s2: "idle" });
    expect(page.container.querySelector('[data-state-action="needs_you"]')).toBeNull();
    expect(block(page.container, "pri-4").querySelector('[data-milestone="s1"] [data-status-mark="idle"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
  // Once the sidebar files it under Needs You, the milestone says so.
  const unseed = seedNeedsYou("mapping");
  const again = await mount(view());
  try {
    expect(states(block(again.container, "pri-4"))).toEqual({ s1: "idle", s2: "needs_you" });
  } finally {
    await again.unmount();
    unseed();
  }
}, 60_000);

test("Start's brief names the milestone's open tasks from the store, never a finished one, and its plan", async () => {
  const { parseComposeLink } = await import("../../lib/composeLink");
  const task = (k: string, short_id: string, title: string, status: string) => ({ _id: k, short_id, title, status });
  const setTasks = (rows: ReturnType<typeof task>[]) => useInboxStore.setState({ tasks: Object.fromEntries(rows.map((t) => [t._id, t])) } as any);
  setTasks([task("tk1", "ct-7001", "Old grader", "done"), task("tk2", "ct-7002", "Write the grader", "open")]);
  const start = row(7, "Graders", 1, [step("s1", "Grader v2", "critical", false, { refs: [{ kind: "task", id: "ct-7001" }, { kind: "task", id: "ct-7002" }] })], {
    plan: null,
    links: [links("s1", [], { plan: PL_1075 })],
  });
  const page = await mount(view({ rows: [start] }));
  const link = () => parseComposeLink(new URLSearchParams(block(page.container, "pri-7").querySelector('[data-state-action="start"]')!.getAttribute("href")!.split("?")[1]));
  try {
    expect(link()).toEqual({
      draft: "pri-7, milestone: Grader v2\nOpen tasks:\n- ct-7002 Write the grader\nPlan: pl-1075\nRun `cast priorities show pri-7` for current detail.",
      task: "ct-7002", priority: "pri-7", step: "s1", plan: "pl-1075",
    });
    // The task closing in the store takes it out of the next Start.
    await (React as any).act(async () => setTasks([task("tk1", "ct-7001", "Old grader", "done"), task("tk2", "ct-7002", "Write the grader", "done")]));
    expect(link()).toEqual({
      draft: "pri-7, milestone: Grader v2\nPlan: pl-1075\nRun `cast priorities show pri-7` for current detail.",
      priority: "pri-7", step: "s1", plan: "pl-1075",
    });
  } finally {
    await page.unmount();
    useInboxStore.setState({ tasks: {} } as any);
  }
}, 60_000);

test("the sidebar's verdict is final: a teammate's session it holds under Needs You makes the milestone Needs you, and its row agrees", async () => {
  // A teammate's session on the viewer's milestone, asking the viewer (a decision addressed to them): the sidebar holds it.
  const r = row(30, "Shared work", 1, [step("s1", "Pair on the grader", "critical")], { links: [links("s1", [sess("mate1", "Sam's grader session", "needs_you", 1, { mine: false }), sess("own1", "My grader work", "working", 0)])] });
  const unseed = seedNeedsYou("mate1");
  const { act } = React as any;
  try {
    const page = await mount(view({ rows: [r] }));
    const b = block(page.container, "pri-30");
    expect(states(b)).toEqual({ s1: "needs_you" });
    expect(b.querySelector('[data-state-action="needs_you"]')!.getAttribute("href")).toBe(`/conversation/${fixtureId("mate1")}`);
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    expect(b.querySelector(`[data-session-row="${fixtureId("mate1")}"]`)!.getAttribute("data-state")).toBe("needs_you");
    await page.unmount();
  } finally {
    unseed();
  }
  // Not in the store: the server's needs_you alone is someone else's to answer, so the milestone reads idle and so does the row.
  const page = await mount(view({ rows: [r] }));
  try {
    const b = block(page.container, "pri-30");
    expect(states(b)).toEqual({ s1: "working" });
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    expect(b.querySelector(`[data-session-row="${fixtureId("mate1")}"]`)!.getAttribute("data-state")).toBe("idle");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Needs you follows the sidebar's inbox scope: under Team scope a session outside the team inbox does not need you here either", async () => {
  const unseed = seedNeedsYou("crflow");
  const setScope = (scope: "mine" | "team") => useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, inbox_scope: scope } } }));
  try {
    setScope("mine");
    let page = await mount(view());
    expect(states(block(page.container, "pri-1")).s2).toBe("needs_you");
    await page.unmount();
    // Team scope, whose inbox (the server's team set) holds another session: the sidebar's Needs You lacks this one, and the milestone says so.
    setScope("team");
    useInboxStore.setState({ teamInboxIds: new Set([fixtureId("someoneelse")]), teamInboxIdSnapshot: { team_id: TEAM_ID } } as any);
    page = await mount(view());
    expect(states(block(page.container, "pri-1")).s2).toBe("idle");
    await page.unmount();
  } finally {
    setScope("mine");
    useInboxStore.setState({ teamInboxIds: new Set(), teamInboxIdSnapshot: null } as any);
    unseed();
  }
}, 60_000);

test("a hosted conversation that ended on a stop is the sidebar's Couldn't finish, not Needs you", async () => {
  const unseed = seedNeedsYou("crflow");
  const hosted = (stop: string | null) => useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [fixtureId("crflow")]: { ...s.sessions[fixtureId("crflow")], agent_type: "codecast", hosted_stop: stop } } }));
  try {
    // Waiting on the person after an ordinary turn: Needs you.
    hosted(null);
    let page = await mount(view());
    expect(states(block(page.container, "pri-1")).s2).toBe("needs_you");
    await page.unmount();
    // The assistant's turn stopped on an error: the person owes no reply, and the milestone does not say they do.
    hosted("error");
    page = await mount(view());
    expect(states(block(page.container, "pri-1")).s2).not.toBe("needs_you");
    await page.unmount();
  } finally {
    unseed();
  }
}, 60_000);

test("the inbox's live verdict for a session the store holds wins over the server's", async () => {
  // The server reads pri-1's ask off the conversation; the inbox has since filed it away.
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [fixtureId("crflow")]: { _id: fixtureId("crflow"), title: "Change requests flow design", message_count: 4, updated_at: NOW, inbox_dismissed_at: NOW } } }));
  const page = await mount(view());
  try {
    // Its only session dismissed (done), the milestone has nobody on it: New session.
    expect(states(block(page.container, "pri-1"))).toEqual({ s1: "dormant", s2: "start" });
  } finally {
    await page.unmount();
    useInboxStore.setState((s: any) => {
      const { [fixtureId("crflow")]: _, ...rest } = s.sessions;
      return { sessions: rest };
    });
  }
}, 60_000);

test("a blocked session in someone else's inbox never needs you: a milestone's Needs you is your sidebar's Needs You", async () => {
  // The server reads pri-1's ask off its blocked pin; under the owners model the session is a teammate's (its card goes to them), so your inbox does not hold it.
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [fixtureId("crflow")]: { _id: fixtureId("crflow"), title: "Change requests flow design", message_count: 4, status: "completed", updated_at: NOW - 10 * 60_000, last_turn_at: NOW - 11 * 60_000, owners_model: true, owned_by_me: false, implicit_owner: "someone-else", thread_state_status: "blocked", thread_state_at: NOW - 10 * 60_000 } } }));
  const page = await mount(view());
  try {
    expect(states(block(page.container, "pri-1")).s2).not.toBe("needs_you");
  } finally {
    await page.unmount();
    useInboxStore.setState((s: any) => {
      const { [fixtureId("crflow")]: _, ...rest } = s.sessions;
      return { sessions: rest };
    });
  }
}, 60_000);

test("a session nested under a Needs You lead still waits on you, as the sidebar's Needs You counts it", async () => {
  const { VIEWER_ID } = await import("../../test-helpers/missingBackend");
  const { placeInboxRows } = await import("../../store/inboxStore");
  const lead = "leadhandoff00000000000000000000x";
  const blocked = { message_count: 4, status: "completed", updated_at: NOW - 10 * 60_000, last_turn_at: NOW - 11 * 60_000, user_id: VIEWER_ID, thread_state_status: "blocked", thread_state_at: NOW - 10 * 60_000 };
  // pri-1's ask is a plan handoff from a lead that waits on you too: the sidebar draws it under the lead's card, in Needs You.
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions,
    [lead]: { _id: lead, title: "Handoff lead", ...blocked },
    [fixtureId("crflow")]: { _id: fixtureId("crflow"), title: "Change requests flow design", ...blocked, parent_conversation_id: lead, parent_message_uuid: "m-handoff" },
  } }));
  const page = await mount(view());
  try {
    const placed = placeInboxRows(useInboxStore.getState() as any, { scope: "mine", now: Date.now() });
    expect(placed.needsInput.map((r) => r._id)).toContain(lead);
    expect(placed.needsInput.map((r) => r._id)).not.toContain(fixtureId("crflow"));
    expect(placed.subsByParent.get(lead)?.map((r) => r._id)).toContain(fixtureId("crflow"));
    expect(states(block(page.container, "pri-1")).s2).toBe("needs_you");
  } finally {
    await page.unmount();
    useInboxStore.setState((s: any) => {
      const { [fixtureId("crflow")]: _, [lead]: __, ...rest } = s.sessions;
      return { sessions: rest };
    });
  }
}, 60_000);

test("DONE n and POLISH x/y: closed they share one line, Done first; open, the caret's head sits over its milestones", async () => {
  const r = row(11, "Sections", 1, [
    step("s1", "Open one", "critical"),
    step("s2", "Landed one", "critical", true, { done_at: NOW - DAY }),
    step("s3", "Landed two", "critical", true, { done_at: NOW - 2 * DAY }),
    step("p1", "Polish done", "polish", true),
    step("p2", "Polish open", "polish"),
  ], { links: [] });
  const page = await mount(view({ rows: [r] }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-11");
    const heads = () => [...b.querySelectorAll("[data-section]")].map((h) => `${h.getAttribute("data-section")}:${h.textContent}:${h.getAttribute("aria-expanded")}`);
    expect(heads()).toEqual(["done:Done 2:false", "polish:Polish 1/2:false"]);
    // Closed, both heads sit on one line.
    expect(b.querySelector('[data-section="done"]')!.parentElement).toBe(b.querySelector('[data-section="polish"]')!.parentElement);
    expect(states(b)).toEqual({ s1: "start" });
    await act(async () => { (b.querySelector('[data-section="polish"]') as HTMLElement).click(); });
    // Polish open: its head on its own line over its milestones; Done stays before it, nothing repeated below.
    const polish = b.querySelector('[data-section-open="polish"]')!;
    expect(polish.querySelector('[data-section="polish"]')!.getAttribute("aria-expanded")).toBe("true");
    expect([...polish.querySelectorAll("li[data-milestone]")].map((li) => li.getAttribute("data-milestone"))).toEqual(["p1", "p2"]);
    expect(states(b)).toEqual({ s1: "start", p1: "done", p2: "start" });
    expect(heads()).toEqual(["done:Done 2:false", "polish:Polish 1/2:true"]);
    await act(async () => { (b.querySelector('[data-section="done"]') as HTMLElement).click(); });
    expect([...b.querySelectorAll("li[data-milestone]")].map((li) => li.getAttribute("data-milestone"))).toEqual(["s1", "s2", "s3", "p1", "p2"]);
    expect(b.querySelector('[data-milestone="s2"] [data-status-mark="done"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
}, 60_000);

test("only the viewer's own priorities; the past ones fold into one line at the bottom, offering no New session", async () => {
  const theirs = row(20, "A teammate's priority", 1, [step("s1", "Their milestone", "critical")], { mine: false, user_id: "someone-else", owner: "Sam Teammate", links: [] });
  const page = await mount(view({ rows: [...ROWS, theirs] }));
  const { act } = React as any;
  try {
    expect(order(page.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]);
    const past = page.container.querySelector("[data-past-toggle]") as HTMLElement;
    expect(past.textContent).toBe("Past 1");
    await act(async () => { past.click(); });
    expect(order(page.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5", "pri-6"]);
    expect(block(page.container, "pri-6").querySelector("[data-past]")!.textContent).toMatch(/^✓ Done/);
    // No filter bar, Waiting on you, stats line, column heads or Compact.
    expect(page.container.querySelector("[data-filters], [data-waiting], [data-stats], [data-compact-toggle], h2")).toBeNull();
    expect(page.text()).not.toMatch(/Critical|landed|Today|Compact/);
  } finally {
    await page.unmount();
  }
  // A past priority's open milestone with nobody on it is a quiet mark, not New session.
  const old = row(21, "Set aside", null, [step("s1", "Never started", "critical")], { status: "set_aside", links: [] });
  const page2 = await mount(view({ rows: [old] }));
  try {
    await act(async () => { (page2.container.querySelector("[data-past-toggle]") as HTMLElement).click(); });
    expect(states(block(page2.container, "pri-21"))).toEqual({ s1: "none" });
    // No mark at all: the box column stays, empty.
    const box = block(page2.container, "pri-21").querySelector('[data-milestone="s1"] [data-state="none"]')!;
    expect(box.childElementCount).toBe(0);
    expect(box.className).toContain("size-6");
  } finally {
    await page2.unmount();
  }
}, 60_000);

test("each priority's ten days are bars on one scale; a day's hover card says only its date and messages", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const bars = [...block(page.container, "pri-1").querySelectorAll("[data-priority-head] [data-day]")];
    expect(bars.map((d) => d.getAttribute("data-day"))).toEqual(days);
    expect(bars.map((d) => d.getAttribute("data-count"))).toEqual(["0", "0", "0", "0", "0", "0", "0", "0", "0", "4"]);
    const trigger = bars[8].parentElement!;
    await act(async () => {
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseenter", { bubbles: false }));
    });
    await page.waitFor(() => !!document.querySelector("[data-day-card]"), 2000);
    const date = (i: number) => new Date(`${days[i]}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    expect(document.querySelector("[data-day-card]")!.textContent).toBe(`${date(8)}0 messages`);
    // Today's card says its date too, never "Today".
    await act(async () => {
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseout", { bubbles: true }));
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseleave", { bubbles: false }));
      const today = bars[9].parentElement!;
      today.dispatchEvent(new (window as any).MouseEvent("mouseover", { bubbles: true }));
      today.dispatchEvent(new (window as any).MouseEvent("mouseenter", { bubbles: false }));
    });
    await page.waitFor(() => [...document.querySelectorAll("[data-day-card]")].some((c) => c.textContent === `${date(9)}4 messages`), 2000);
    expect([...document.querySelectorAll("[data-day-card]")].map((c) => c.textContent).join("|")).not.toContain("Today");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the legend behind the ⓘ in the page header names every mark", async () => {
  answers["priorities:list"] = listOf(ROWS);
  answers["priorities:history"] = HISTORY;
  const page = await mount(<PrioritiesPage />);
  const { act } = React as any;
  try {
    await page.waitFor(() => !!page.container.querySelector("li[data-priority]"));
    // In the header's actions, never a row of its own above the list.
    expect(page.container.querySelector("[data-priorities] [data-legend]")).toBeNull();
    const legend = page.container.querySelector("header [data-legend]") as HTMLElement;
    expect(legend).not.toBeNull();
    await act(async () => { legend.click(); });
    const words = [...document.querySelectorAll("[data-legend-row]")].map((r) => r.getAttribute("data-legend-row"));
    expect(words).toEqual([
      "Needs you", "New session", "Working", "Sleeping", "Idle", "Done", "Closed", "Starting", "Error", "Stashed", "Workflow run",
      "Backlog", "Open", "In Progress", "In Review", "Done", "Dropped", "Not loaded yet",
      "Pull request, open", "Pull request, merged", "Pull request, closed", "Branch", "Plan", "Deploy, live", "Deploy, failed", "Deploy, not live yet",
    ]);
    // Every head but the first has its gap above it; Tasks drops it only where it heads the second of two columns.
    const heads = [...document.querySelectorAll("[data-legend-head]")].map((h) => `${h.textContent}:${h.className.split(/\s+/).filter((c) => /(^|:)mt-/.test(c)).join(" ")}`);
    expect(heads).toEqual(["Milestones and sessions:mt-0", "Tasks:mt-4 sm:mt-0", "Other:mt-4"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a double-click on a milestone's title never changes whether its row is open; a single click, Space and Enter toggle it", async () => {
  useInboxStore.getState().syncTable("priorities", ROWS as any);
  const page = await mount(view());
  const { act } = React as any;
  const line = () => block(page.container, "pri-3").querySelector('[data-milestone="s1"]')!;
  const title = () => line().querySelector("[data-milestone-title]") as HTMLElement;
  const button = () => line().querySelector("[role=button]") as HTMLElement;
  const expanded = () => button().getAttribute("aria-expanded");
  const fire = async (type: string, detail: number) => act(async () => { title().dispatchEvent(new (window as any).MouseEvent(type, { bubbles: true, detail })); });
  /** The browser's sequence for a double-click: click (detail 1), click (detail 2), dblclick. */
  const doubleClick = async () => { await fire("click", 1); await fire("click", 2); await fire("dblclick", 2); };
  const escape = async () => act(async () => { line().querySelector("[data-rename-input]")!.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  try {
    // Starting closed: still closed, the rename showing.
    expect(expanded()).toBe("false");
    await doubleClick();
    expect(expanded()).toBe("false");
    expect(line().querySelector("[data-rename-input]")).not.toBeNull();
    await escape();
    // A plain single click toggles at once.
    await fire("click", 1);
    expect(expanded()).toBe("true");
    // Starting open: still open, the rename showing.
    await doubleClick();
    expect(expanded()).toBe("true");
    expect(line().querySelector("[data-rename-input]")).not.toBeNull();
    await escape();
    // From the keyboard the row is a button: Space toggles it as Enter does, and does not scroll the page.
    const press = async (key: string) => {
      const e = new (window as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { button().dispatchEvent(e); });
      return e.defaultPrevented;
    };
    expect(await press(" ")).toBe(true);
    expect(expanded()).toBe("false");
    expect(await press("Enter")).toBe(true);
    expect(expanded()).toBe("true");
  } finally {
    await page.unmount();
    useInboxStore.getState().syncTable("priorities", ROWS as any);
  }
}, 60_000);

test("a double-click on a milestone's title renames it in place: Enter saves, Escape takes it back", async () => {
  useInboxStore.getState().syncTable("priorities", ROWS as any);
  const page = await mount(view());
  const { act } = React as any;
  const title = () => block(page.container, "pri-3").querySelector('[data-milestone="s1"] [data-milestone-title]') as HTMLElement;
  const input = () => block(page.container, "pri-3").querySelector("[data-rename-input]") as HTMLInputElement;
  try {
    await act(async () => { title().dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true })); });
    await act(async () => {
      input().value = "Deploy drops the eval job for good";
      input().dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(input()).toBeNull();
    const renamed = (Object.values(useInboxStore.getState().priorities) as any[]).find((r) => r.short_id === "pri-3");
    expect(renamed.steps[0].title).toBe("Deploy drops the eval job for good");
    await act(async () => { title().dispatchEvent(new (window as any).MouseEvent("dblclick", { bubbles: true })); });
    await act(async () => {
      input().value = "Something else";
      input().dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input()).toBeNull();
  } finally {
    await page.unmount();
    useInboxStore.getState().syncTable("priorities", ROWS as any);
  }
}, 60_000);

test("phone, Daylight and desktop: the list's own width picks the layout", async () => {
  // A 402px phone's list is ~370px; Daylight's 947px window beside the inbox leaves ~550px; a 1280px desktop ~840px.
  expect([layoutForWidth(370), layoutForWidth(550), layoutForWidth(840)]).toEqual(["phone", "wide", "wide"]);
  // A touch screen at least 900px wide (Daylight) takes the desktop layout however narrow the list is.
  expect([layoutForWidth(370, true), layoutForWidth(550, true)]).toEqual(["wide", "wide"]);
  const phone = await mount(view({ layout: "phone" }));
  try {
    expect(describeFailures(phone)).toBe("");
    // Titles wrap to two lines; rows are 44px; the rank is no drag handle.
    expect(block(phone.container, "pri-1").querySelector("[data-priority-title]")!.className).toContain("line-clamp-2");
    for (const li of phone.container.querySelectorAll("li[data-milestone]")) {
      expect(li.querySelector("[role=button]")!.className).toContain("min-h-11");
      expect(li.querySelector("[data-milestone-title]")!.className).toContain("line-clamp-2");
    }
    expect(phone.container.querySelector("[data-rank-handle]")).toBeNull();
  } finally {
    await phone.unmount();
  }
  const wide = await mount(view({ layout: "wide" }));
  try {
    expect(wide.container.querySelector('[data-rank-handle="pri-1"]')).not.toBeNull();
  } finally {
    await wide.unmount();
  }
}, 60_000);

test("the page paints from the store over the list's answer, and says how far behind past six hours", async () => {
  answers["priorities:history"] = HISTORY;
  answers["priorities:list"] = listOf(ROWS, { behind_by_ms: 8 * HOUR });
  const late = await mount(<PrioritiesPage />);
  try {
    expect(describeFailures(late)).toBe("");
    expect(order(late.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]);
    expect(late.container.querySelector("[data-priorities-behind]")!.textContent).toBe("Behind by 8h");
  } finally {
    await late.unmount();
  }
  answers["priorities:list"] = listOf(ROWS, { behind_by_ms: 2 * HOUR });
  const onTime = await mount(<PrioritiesPage />);
  try {
    expect(onTime.container.querySelector("[data-priorities-behind]")).toBeNull();
  } finally {
    await onTime.unmount();
  }
  answers["priorities:list"] = listOf(ROWS);
}, 60_000);

test("no priorities yet: the next pass's time, Run now through its review, and the running state", async () => {
  const runs: string[] = [];
  const idle = await mount(<NoPrioritiesYet nextPass="Next pass 3:00 PM" running={false} onRun={() => runs.push("run")} />);
  const { act } = React as any;
  try {
    expect(idle.container.querySelector("[data-next-pass]")!.textContent).toBe("Next pass 3:00 PM");
    const press = [...idle.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Run now"))!;
    await act(async () => { press.click(); });
    expect(runs).toEqual([]);
    const confirm = document.querySelector("[data-switch-confirm]") as HTMLElement;
    await act(async () => { confirm.click(); });
    expect(runs).toEqual(["run"]);
  } finally {
    await idle.unmount();
  }
  const running = await mount(<NoPrioritiesYet nextPass="Next pass 3:00 PM" running onRun={() => {}} />);
  try {
    expect(running.container.querySelector("[data-priorities-running]")).not.toBeNull();
    expect(running.text()).not.toContain("Run now");
  } finally {
    await running.unmount();
  }
}, 60_000);

test("the pin line paints at once for a conversation seen before, and never shows one conversation's line on another", async () => {
  const { usePriorityPinLine } = await import("../../hooks/usePriorityPinLine");
  const { PriorityPinLineView } = await import("./PriorityPinLine");
  const A = fixtureId("pinconva");
  const B = fixtureId("pinconvb");
  const line = (title: string) => ({ short_id: "pri-1", title, rank: 1, critical_done: 1, critical_total: 2, step_title: null });
  let show: (id: string) => void = () => {};
  function Probe() {
    const [id, setId] = React.useState(A);
    show = setId;
    return <PriorityPinLineView line={usePriorityPinLine(id)} />;
  }
  answers["priorities:pinLine"] = line("Trusted evals");
  const page = await mount(<Probe />);
  const { act } = React as any;
  try {
    expect(page.text()).toContain("Trusted evals");
    answers["priorities:pinLine"] = undefined;
    await act(async () => { show(B); });
    expect(page.container.querySelector("[data-priority-pin-line]")).toBeNull();
    await act(async () => { show(A); });
    expect(page.text()).toContain("Trusted evals");
  } finally {
    await page.unmount();
    delete answers["priorities:pinLine"];
  }
}, 60_000);

test("the store's priority actions paint the rows at once", async () => {
  const st = useInboxStore.getState();
  st.syncTable("priorities", ROWS as any);
  const get = (id: string) => withLiveRanks(Object.values(useInboxStore.getState().priorities) as any[]).find((r) => r.short_id === id) as any;
  st.movePriority("pri-3", 1).catch(() => {}); // no dispatch is wired here: the write parks
  expect([get("pri-3").rank, get("pri-1").rank, get("pri-2").rank]).toEqual([1, 2, 3]);
  st.setPriorityAside("pri-2").catch(() => {});
  expect(get("pri-2").status).toBe("set_aside");
  st.syncTable("priorities", ROWS as any);
});

test("a missing backend paints the cached rows, or reads as an error on a cold cache; an empty list is the empty state", async () => {
  delete answers["priorities:list"];
  delete answers["priorities:history"];
  const cached = await mount(<PrioritiesPage />);
  try {
    expect(describeFailures(cached)).toBe("");
    expect(order(cached.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]);
  } finally {
    await cached.unmount();
  }
  useInboxStore.getState().syncTable("priorities", [] as any);
  const missing = await mount(<PrioritiesPage />);
  try {
    expect(describeFailures(missing)).toBe("");
    expect(missing.text()).toContain("Priorities didn't load");
    // Try again and the Details disclosure are 44px under a coarse pointer.
    const tryAgain = [...missing.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Try again"))!;
    expect(tryAgain.className).toContain("[@media(pointer:coarse)]:h-11");
    expect(tryAgain.className).toContain("[@media(pointer:coarse)]:modern:h-11");
    expect(missing.container.querySelector("details summary")!.className).toContain("[@media(pointer:coarse)]:min-h-11");
  } finally {
    await missing.unmount();
  }
  answers["priorities:list"] = listOf([], { next_pass_at: Date.now() + 3 * HOUR });
  const empty = await mount(<PrioritiesPage />);
  try {
    expect(empty.text()).toContain("No priorities yet");
    expect(empty.container.querySelector("[data-next-pass]")!.textContent).toMatch(/^Next pass /);
    const runNow = [...empty.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Run now"))!;
    expect(runNow.className).toContain("[@media(pointer:coarse)]:h-11");
  } finally {
    await empty.unmount();
  }
  // On a phone too: the same empty state, its next pass said.
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 402 });
  const phoneEmpty = await mount(<PrioritiesPage />);
  try {
    expect(phoneEmpty.text()).toContain("No priorities yet");
    expect(phoneEmpty.container.querySelector("[data-next-pass]")!.textContent).toMatch(/^Next pass /);
  } finally {
    await phoneEmpty.unmount();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: realWidth });
  }
  answers["priorities:list"] = listOf([], { next_pass_at: Date.now() - 1000 });
  const due = await mount(<PrioritiesPage />);
  try {
    expect(due.container.querySelector("[data-priorities-running]")).not.toBeNull();
  } finally {
    await due.unmount();
  }
}, 60_000);

// A priority with one of every kind of link: its milestone names a task and a
// pull request, its sessions sit on a branch, a deploy shipped its task, and
// its line carries a plan.

