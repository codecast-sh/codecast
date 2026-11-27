// /priorities mounted in jsdom over a convex transport that answers by name
// (test-helpers/missingBackend.tsx), with rows shaped like priorities.list's
// contract (each step's linked sessions and plans). Proves: one primary
// action per priority by the shared next-action rule (Answer outranks
// Resume, Open and Start; every other ask is an outlined Answer), and Waiting
// on you agrees with each primary; the inbox's live verdict for a session the
// store holds wins over the server's; the today bar names its unit, its
// shares add to 100 and No priority opens its sessions; the bracket rail; the
// plan attribution as drawn (priority plan on the meta line, a milestone's on
// its line, a big plan only inside an open milestone); the compact view kept
// per viewer; phone, Daylight and desktop layouts; rows from a server that
// predates the links still paint; and the page's empty, error, behind and
// feature-off states.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesPage.mount.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage, NoPrioritiesYet } = await import("./PrioritiesPage");
const { layoutForWidth, readFilters, filtersHref } = await import("../../lib/priorityList");
const { withLiveRanks } = await import("../../lib/priorities");
const { DAY, HISTORY, HOUR, NOW, PL_1075, ROWS, at, block, days, links, listOf, mount, order, primaries, row, sess, step, view } = await import("../../test-helpers/prioritiesList");

test("one primary per priority by the shared rule: Answer outranks Resume, Open and Start; other asks are outlined Answers", async () => {
  const page = await mount(view());
  try {
    expect(describeFailures(page)).toBe("");
    // Hide done is on: the finished priority is out.
    expect(order(page.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]);
    const kinds = Object.fromEntries(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"].map((id) => {
      const acts = primaries(block(page.container, id));
      expect(acts).toHaveLength(1);
      return [id, acts[0].getAttribute("data-action")];
    }));
    // pri-1's dormant first milestone loses to the ask on its second; pri-2 resumes its driver; pri-3's session works; pri-5 has nothing live.
    expect(kinds).toEqual({ "pri-1": "answer", "pri-2": "resume", "pri-3": "open", "pri-4": "answer", "pri-5": "start" });
    const answer = block(page.container, "pri-1").querySelector('[data-milestone="s2"] [data-action="answer"]')!;
    expect(answer.getAttribute("href")).toBe(`/conversation/${fixtureId("crflow")}`);
    expect(answer.className).toContain("bg-sol-text");
    // pri-4 answers the session that waited most recently; the older ask is a secondary outlined Answer.
    const pri4 = block(page.container, "pri-4");
    expect(pri4.querySelector('[data-milestone="s1"] [data-action="answer"]')).not.toBeNull();
    expect(pri4.querySelector('[data-milestone="s2"] [data-answer="secondary"]')).not.toBeNull();
    // Start opens a composer on the milestone.
    expect(block(page.container, "pri-5").querySelector('[data-action="start"]')!.getAttribute("href")).toStartWith("/inbox?");
    // No short id is a label anywhere.
    expect(page.text()).not.toMatch(/\bjx7\w+|\bct-\d+|\bpl-\d+/);
  } finally {
    await page.unmount();
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
  const link = () => parseComposeLink(new URLSearchParams(block(page.container, "pri-7").querySelector('[data-action="start"]')!.getAttribute("href")!.split("?")[1]));
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

test("Waiting on you lists every ask, and agrees with each priority's primary", async () => {
  const page = await mount(view());
  try {
    const waiting = [...page.container.querySelectorAll("[data-waiting-item]")].map((a) => a.getAttribute("data-waiting-item"));
    expect(waiting).toEqual([fixtureId("crflow"), fixtureId("calib1"), fixtureId("mapping")]);
    expect(page.container.querySelector('[data-waiting="wide"]')!.textContent).toContain("#1Change request flow design1h");
    for (const id of ["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]) {
      const b = block(page.container, id);
      const asks = [...b.querySelectorAll("a[href^='/conversation/']")].map((a) => a.getAttribute("href")!.split("/").pop()).filter((c) => waiting.includes(c!));
      const primary = primaries(b)[0];
      // A priority with a session waiting on you leads with Answer, and that Answer is one Waiting on you names.
      expect(primary.getAttribute("data-action") === "answer").toBe(asks.length > 0);
      if (asks.length) expect(waiting).toContain(primary.getAttribute("href")!.split("/").pop()!);
    }
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the bracket rail spans the lines one session covers; the plan sits on the meta line, a milestone's on its line, a big plan only inside an open milestone", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const pri2 = block(page.container, "pri-2");
    expect([...pri2.querySelectorAll("[data-rail]")].map((r) => [r.closest("[data-milestone]")!.getAttribute("data-milestone"), r.getAttribute("data-rail")]))
      .toEqual([["s1", "head"], ["s2", "mid"], ["s3", "mid"], ["s4", "end"]]);
    // Each segment hangs off a cell as tall as its line (so a line made taller by its title or "Looks done?" leaves no gap), never the fixed-height chips row.
    for (const r of pri2.querySelectorAll("[data-rail]")) {
      // Each segment is the registered bracket mark, so a hover names it.
      expect(r.querySelector("[data-mark]")!.getAttribute("data-mark")).toBe("priority.bracket");
      expect(r.closest("[data-line-chips]")).toBeNull();
      const cell = r.parentElement!;
      expect(cell.hasAttribute("data-line-chips-cell")).toBe(true);
      expect(cell.className).toContain("relative");
      expect(cell.className).toContain("self-stretch");
      expect(cell.className).not.toMatch(/(^| )h-/);
      expect(cell.parentElement!.className).toContain("self-stretch");
    }
    expect(pri2.querySelector("[data-meta] [data-chip='plan']")!.textContent).toContain("Every change merges green");
    // pri-3: pl-1075 on "Deploy drops the eval job"'s line, not its meta line.
    const pri3 = block(page.container, "pri-3");
    expect(pri3.querySelector("[data-meta]")).toBeNull();
    expect(pri3.querySelector('[data-milestone="s1"] [data-chip="plan"]')!.textContent).toContain("Every change merges green");
    expect(page.text()).not.toContain("The whole platform program");
    // Open the polish, then its milestone: the program shows only there, as "Part of".
    await act(async () => { (pri3.querySelector("[data-polish]") as HTMLElement).click(); });
    await act(async () => { (pri3.querySelector('[data-milestone="s2"] [role=button]') as HTMLElement).click(); });
    const detail = pri3.querySelector("[data-milestone-detail]")!;
    expect(detail.textContent).toContain("Part ofThe whole platform program");
    expect(detail.textContent).toContain("140 tasks");
    // pri-2's second milestone folds its workflow runs.
    await act(async () => { (pri2.querySelector('[data-milestone="s2"] [role=button]') as HTMLElement).click(); });
    expect(pri2.querySelector("[data-runs]")!.textContent).toBe("2 reviews");
    expect(pri2.querySelector("[data-milestone-detail]")!.textContent).toContain("Deploy redesign");
  } finally {
    await page.unmount();
  }
}, 60_000);

const zeroToday = (el: Element) => [...el.querySelectorAll("[data-today]")].map((n) => n.textContent).filter((t) => /^0( today)?$/.test(t ?? ""));

test("a teammate's priority offers no action, and a teammate's ask on the viewer's milestone is not the viewer's to answer", async () => {
  const theirs = withLiveRanks(ROWS.map((r) => ({ ...r, mine: false, user_id: "teammate", owner: "Bea" })) as any);
  for (const layout of ["wide", "phone"] as const) {
    const team = await mount(view({ rows: theirs, layout, filters: readFilters(new URLSearchParams("mine=0")) }));
    try {
      expect(order(team.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]);
      expect(team.container.querySelectorAll("[data-action]")).toHaveLength(0);
      // A teammate's rank is the owner's real one, shown with who placed it, but never a handle to drag; and no "0 today" nudge a top three gets.
      for (const [id, rank] of [["pri-1", "1"], ["pri-2", "2"], ["pri-3", "3"]]) {
        const mark = block(team.container, id).querySelector("[data-rank-source]")!;
        expect(mark.textContent).toBe(rank);
        expect(mark.getAttribute("title")).toBe(`#${rank} · ranked by AI`);
        expect(block(team.container, id).querySelector("[data-rank-handle]")).toBeNull();
      }
      expect(zeroToday(team.container)).toEqual([]);
    } finally {
      await team.unmount();
    }
    // The viewer's own untouched top three does say so.
    const mine = await mount(view({ rows: withLiveRanks(ROWS as any), layout }));
    try {
      expect(zeroToday(mine.container)).toEqual([layout === "wide" ? "0" : "0 today"]);
    } finally {
      await mine.unmount();
    }
  }
  // pri-1's ask belongs to a teammate's session: Resume the viewer's own, and nothing waits on them there.
  const rows = ROWS.map((r) => (r.short_id !== "pri-1" ? r : { ...r, links: r.links!.map((l: any) => ({ ...l, sessions: l.sessions.map((x: any) => ({ ...x, mine: x.title !== "Change requests flow design" })) })) }));
  const page = await mount(view({ rows }));
  try {
    expect(primaries(block(page.container, "pri-1")).map((a) => a.getAttribute("data-action"))).toEqual(["resume"]);
    expect([...page.container.querySelectorAll("[data-waiting-item]")].map((a) => a.getAttribute("data-waiting-item"))).not.toContain(fixtureId("crflow"));
  } finally {
    await page.unmount();
  }
}, 60_000);

test("an ask on a polish milestone shows its Answer with polish collapsed; the phone has its own 44px Polish toggle", async () => {
  const polishAsk = row(7, "Polish asks", 1, [step("s1", "Ship it", "critical"), step("p1", "Tidy the copy", "polish"), step("p2", "Other polish", "polish")], {
    links: [links("s1", [sess("polshp", "Ship session", "dormant", 2)]), links("p1", [sess("polask", "Copy review", "needs_you", 1)]), links("p2", [])],
  });
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [polishAsk], layout }));
    const { act } = React as any;
    try {
      const b = block(page.container, "pri-7");
      expect(primaries(b).map((a) => a.getAttribute("data-action"))).toEqual(["answer"]);
      expect(b.querySelector('[data-milestone="p1"] [data-action="answer"]')).not.toBeNull();
      // Only the asking polish line shows until Polish opens.
      expect(b.querySelector('[data-milestone="p2"]')).toBeNull();
      const toggle = b.querySelector("[data-polish]") as HTMLElement;
      if (layout === "phone") expect(toggle.className).toContain("h-11");
      await act(async () => { toggle.click(); });
      expect(b.querySelector('[data-milestone="p2"]')).not.toBeNull();
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("Looks done?, correction pending and Stalled read on every width", async () => {
  const marked = row(8, "Marked", 1, [step("s1", "All tasks closed", "critical"), step("s2", "Corrected", "critical")], {
    first_seen_at: NOW - 30 * DAY, correction_pending: true,
    links: [links("s1", [], { looks_done: true }), links("s2", [], { correction_pending: true })],
  });
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [marked], layout }));
    try {
      const b = block(page.container, "pri-8");
      expect(b.querySelector('[data-milestone="s1"] [data-looks-done]')).not.toBeNull();
      expect(b.querySelector('[data-milestone="s2"] [data-correction-pending]')).not.toBeNull();
      // The pending correction is on a milestone: the header does not repeat it.
      expect(b.querySelector("[data-priority-head] [data-correction-pending]")).toBeNull();
      expect(b.querySelector("[data-priority-head] [data-stalled]")!.textContent).toBe("Stalled 30d");
      if (layout === "phone") {
        // On a phone Stalled takes "last Nd"'s place on the meta line, so nothing beside the title reaches the progress.
        const head = b.querySelector("[data-priority-head]")!;
        expect(head.querySelector("[data-stalled]")!.closest("[data-meta]")).not.toBeNull();
        expect(head.querySelector("[data-momentum-words]")!.textContent).toBe("0 landed · Stalled 30d");
        expect([...head.querySelectorAll("span[title]")].find((n) => n.textContent === "Marked")!.parentElement!.querySelector("[data-stalled]")).toBeNull();
      }
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("compact at a phone's and Daylight's width: the title keeps 8rem and breaks between words; today and Stalled leave its cell", async () => {
  const stalled = row(8, "Trustworthy eval suite", 1, [step("s1", "Grader faults", "critical")], { first_seen_at: NOW - 30 * DAY });
  for (const layout of ["phone", "wide"] as const) {
    const page = await mount(view({ rows: [stalled], layout, compact: true }));
    try {
      const head = block(page.container, "pri-8").querySelector("[data-priority-head]")!;
      const title = [...head.querySelectorAll("span[title]")].find((n) => n.textContent === "Trustworthy eval suite")!;
      expect(title.className).toContain("min-w-[8rem]");
      expect(title.className).toContain("break-normal");
      const cell = title.parentElement!;
      // The action wraps under the title before the title gives way.
      expect(cell.className).toContain("flex-wrap");
      expect(cell.querySelector("[data-today]")).toBeNull();
      expect(cell.querySelector("[data-stalled]")).toBeNull();
      expect(cell.textContent).not.toContain("Stalled");
      // Stalled is its mark beside the strip, named for a screen reader and on hover.
      const mark = head.querySelector("[data-stalled]")!;
      expect(mark.getAttribute("role")).toBe("img");
      expect(mark.getAttribute("aria-label")).toBe("Stalled 30d");
      expect(mark.textContent).toBe("");
      if (layout === "phone") expect(mark.parentElement!.querySelector("[data-day-strip]")).not.toBeNull();
      else expect(mark.parentElement!.querySelector("[data-today]")).not.toBeNull();
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("the today bar names its unit, its shares add to 100, and No priority opens today's other sessions", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    expect(page.container.querySelector("[data-today-unit]")!.textContent).toBe("Today · 50% of messages on top 3");
    const parts = page.container.querySelector("[data-today-parts]")!.textContent!;
    expect(parts).toBe("#1 40% · #2 10% · rest 10% · none 40%");
    expect([...parts.matchAll(/(\d+)%/g)].reduce((n, m) => n + Number(m[1]), 0)).toBe(100);
    await act(async () => { (page.container.querySelector('[data-today-seg="none"]') as HTMLElement).click(); });
    const pop = document.querySelector("[data-no-priority]")!.parentElement!;
    expect(pop.textContent).toContain("No priority · 40% of today");
    expect(pop.textContent).toContain("Jamie's workflow review");
    expect(pop.querySelector("a")!.getAttribute("href")).toBe(`/conversation/${fixtureId("jamie")}`);
    // Momentum: landings in ten days, the stalled one says so.
    expect(block(page.container, "pri-5").querySelector("[data-momentum]")!.textContent).toContain("1 landed");
    expect(block(page.container, "pri-1").querySelector("[data-stalled]")).toBeNull();
  } finally {
    await page.unmount();
  }
}, 60_000);

test("compact: one line per priority with its one action; the page keeps it per viewer", async () => {
  const compact = await mount(view({ compact: true }));
  try {
    expect(compact.container.querySelectorAll("[data-milestone]")).toHaveLength(0);
    for (const id of ["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]) {
      const b = block(compact.container, id);
      expect(b.querySelectorAll("[data-priority-head]")).toHaveLength(1);
      expect(primaries(b)).toHaveLength(1);
      expect(b.querySelector("[data-compact-action]")).not.toBeNull();
      expect(b.querySelector("[data-momentum]")).not.toBeNull();
    }
  } finally {
    await compact.unmount();
  }
  answers["priorities:list"] = listOf(ROWS);
  answers["priorities:history"] = HISTORY;
  const page = await mount(<PrioritiesPage />);
  const { act } = React as any;
  try {
    expect(page.container.querySelectorAll("[data-milestone]").length).toBeGreaterThan(0);
    await act(async () => { (page.container.querySelector("[data-compact-toggle]") as HTMLElement).click(); });
    expect((useInboxStore.getState().clientState.ui as any).priorities_view).toEqual({ compact: true });
    expect(page.container.querySelectorAll("[data-milestone]")).toHaveLength(0);
    await act(async () => { (page.container.querySelector("[data-compact-toggle]") as HTMLElement).click(); });
    expect(page.container.querySelectorAll("[data-milestone]").length).toBeGreaterThan(0);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the inbox's live verdict for a session the store holds wins over the server's", async () => {
  // The server reads pri-1's ask off the conversation; the inbox has since filed it away.
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [fixtureId("crflow")]: { _id: fixtureId("crflow"), title: "Change requests flow design", message_count: 4, updated_at: NOW, inbox_dismissed_at: NOW } } }));
  const page = await mount(view());
  try {
    const b = block(page.container, "pri-1");
    expect(primaries(b).map((a) => a.getAttribute("data-action"))).toEqual(["resume"]);
    expect([...page.container.querySelectorAll("[data-waiting-item]")].map((a) => a.getAttribute("data-waiting-item"))).not.toContain(fixtureId("crflow"));
  } finally {
    await page.unmount();
    useInboxStore.setState((s: any) => {
      const { [fixtureId("crflow")]: _, ...rest } = s.sessions;
      return { sessions: rest };
    });
  }
}, 60_000);

test("a blocked session in someone else's inbox never waits on you: Waiting on you is your sidebar's Needs You", async () => {
  // The server reads pri-1's ask off its blocked pin; under the owners model the session is a teammate's (its card goes to them), so your inbox does not hold it.
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [fixtureId("crflow")]: { _id: fixtureId("crflow"), title: "Change requests flow design", message_count: 4, status: "completed", updated_at: NOW - 10 * 60_000, last_turn_at: NOW - 11 * 60_000, owners_model: true, owned_by_me: false, implicit_owner: "someone-else", thread_state_status: "blocked", thread_state_at: NOW - 10 * 60_000 } } }));
  const page = await mount(view());
  try {
    expect([...page.container.querySelectorAll("[data-waiting-item]")].map((a) => a.getAttribute("data-waiting-item"))).not.toContain(fixtureId("crflow"));
    expect(primaries(block(page.container, "pri-1")).map((a) => a.getAttribute("data-action"))).not.toContain("answer");
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
    expect([...page.container.querySelectorAll("[data-waiting-item]")].map((a) => a.getAttribute("data-waiting-item"))).toContain(fixtureId("crflow"));
  } finally {
    await page.unmount();
    useInboxStore.setState((s: any) => {
      const { [fixtureId("crflow")]: _, [lead]: __, ...rest } = s.sessions;
      return { sessions: rest };
    });
  }
}, 60_000);

test("phone, Daylight and desktop: the list's own width picks the layout", async () => {
  // A 402px phone's list is ~370px; Daylight's 947px window beside the inbox leaves ~550px; a 1280px desktop ~840px.
  expect([layoutForWidth(370), layoutForWidth(550), layoutForWidth(840)]).toEqual(["phone", "wide", "wide"]);
  // A touch screen at least 900px wide (Daylight) takes the desktop grid however narrow the list is.
  expect([layoutForWidth(370, true), layoutForWidth(550, true)]).toEqual(["wide", "wide"]);
  const wide = await mount(view({ layout: "wide" }));
  try {
    expect(wide.container.querySelector('[data-waiting="wide"]')).not.toBeNull();
    expect(wide.container.querySelector("[data-show-chips]")).not.toBeNull();
    expect(wide.container.querySelector("[data-show-menu]")).toBeNull();
    expect(wide.container.querySelector("[data-line-chips]")).not.toBeNull();
    // Daylight's filter bar wraps beside the inbox: under a coarse pointer the segments are 44px and wrapped rows sit
    // 16px apart, so no two press areas overlap.
    expect(wide.container.querySelector("[data-filters]")!.className).toContain("[@media(pointer:coarse)]:gap-y-4");
    for (const f of ["mine", "done"]) expect(wide.container.querySelector(`[data-filter="${f}"]`)!.className).toContain("[@media(pointer:coarse)]:h-11");
    // A Daylight line clips its box's press area to its own height too.
    expect(wide.container.querySelector("li[data-milestone] [role=button]")!.className).toContain("[@media(pointer:coarse)]:overflow-y-clip");
  } finally {
    await wide.unmount();
  }
  const phone = await mount(view({ layout: "phone" }));
  try {
    expect(describeFailures(phone)).toBe("");
    expect(phone.container.querySelector('[data-waiting="phone"]')).not.toBeNull();
    // 44px rows, at most three.
    expect(phone.container.querySelectorAll('[data-waiting="phone"] [data-waiting-item]')).toHaveLength(3);
        expect(phone.container.querySelector('[data-waiting-item]')!.className).toContain("h-11");
    expect(phone.container.querySelector("[data-show-chips]")).toBeNull();
    expect(phone.container.querySelector("[data-show-menu]")!.textContent).toMatch(/Show\s*2/);
    // Lines carry only their trail: the action (44px), an Answer, or the state in a word.
    expect(phone.container.querySelector("[data-line-chips]")).toBeNull();
    expect(block(phone.container, "pri-1").querySelector('[data-action="answer"]')!.className).toContain("h-11");
    expect(block(phone.container, "pri-1").querySelector('[data-milestone="s1"]')!.textContent).toContain("Dormant");
    expect(block(phone.container, "pri-1").querySelector("[data-priority-head]")!.textContent).toContain("4 today");
    // Each line clips its box's press area to its own height (52px from 8px above the title, drawn 15px down beside
    // the first line), so a tap never lands on a neighbour's box; measured in the browser at 402px.
    for (const li of phone.container.querySelectorAll("li[data-milestone]")) {
      const line = li.querySelector("[role=button]")!;
      expect(line.className).toContain("min-h-11");
      expect(line.className).toContain("overflow-y-clip");
      const toggle = li.querySelector("[data-milestone-toggle]");
      if (toggle) for (const c of ["-mt-2", "-mb-4", "h-[52px]", "items-start", "pt-[15px]"]) expect(toggle.className.split(" ")).toContain(c);
    }
    // Every ⋯ is a 44px target.
    for (const b of phone.container.querySelectorAll('button[aria-label^="More for"]')) expect(b.className).toContain("size-11");
  } finally {
    await phone.unmount();
  }
}, 60_000);

test("filters live in the address: Show toggles, Mine and Hide done", async () => {
  const seen: any[] = [];
  const page = await mount(view({ onFilters: (f: any) => seen.push(f) }));
  const { act } = React as any;
  try {
    await act(async () => { (page.container.querySelector('[data-show="tasks"]') as HTMLElement).click(); });
    expect(filtersHref(seen[0], new URLSearchParams())).toBe("/priorities?show=sessions%2Cplans%2Ctasks");
    await act(async () => { (page.container.querySelector('[data-filter="done"]') as HTMLElement).click(); });
    expect(filtersHref(seen[1], new URLSearchParams("x=1"))).toBe("/priorities?x=1&done=1");
    expect(readFilters(new URLSearchParams("mine=0&show=none"))).toMatchObject({ mine: false, hideDone: true, show: { sessions: false, plans: false } });
  } finally {
    await page.unmount();
  }
  const all = await mount(view({ filters: readFilters(new URLSearchParams("done=1&mine=0")) }));
  try {
    expect(order(all.container)).toContain("pri-6");
    expect(all.container.querySelector("h2")!.textContent).toBe("You");
    expect(block(all.container, "pri-6").querySelectorAll("[data-action]")).toHaveLength(0);
  } finally {
    await all.unmount();
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
