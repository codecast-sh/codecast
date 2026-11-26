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
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage, PrioritiesView, NoPrioritiesYet } = await import("./PrioritiesPage");
const { default: PrioritiesRoute } = await import("../../app/priorities/page");
const { lastDays, layoutForWidth, readFilters, filtersHref } = await import("../../lib/priorityList");

// The milestone line's row measures itself (PriorityBlock LineChips). jsdom lays nothing out and the shared
// stub gives every element 800px, so the row gets a layout of its own, the way a browser lays it out: the
// action button 65px, "+N" 24px, each kind's count chip 36px, 6px between parts and 12px of left padding,
// in a chips cell of `lineCell` px (600 unless a test narrows it).
let lineCell = 600;
/** A closed line's parts, first to last, as it shows them. */
const partsOf = (line: Element) => [...line.children].filter((c) => (c as HTMLElement).dataset.fit).map((c) => {
  const fit = (c as HTMLElement).dataset.fit;
  if (fit === "fixed") return "action";
  if (fit === "kind") return `${c.querySelector("[data-chip-count]")!.getAttribute("data-chip-count")} ${c.textContent}`;
  if (fit === "plan") return "plan";
  return c.textContent;
});
{
  const proto = (window as any).HTMLElement.prototype;
  const offset = Object.getOwnPropertyDescriptor(proto, "offsetWidth")!;
  const client = Object.getOwnPropertyDescriptor(proto, "clientWidth")!;
  const FIT: Record<string, number> = { fixed: 65, more: 24, kind: 36 };
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { const f = this.dataset?.fit; return f ? FIT[f] ?? 0 : offset.get!.call(this); } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.hasAttribute?.("data-line-chips") ? lineCell : client.get!.call(this); } });
  for (const host of [window as any, globalThis as any]) {
    const real = host.getComputedStyle.bind(host);
    host.getComputedStyle = (el: Element, pseudo?: string) => (el.hasAttribute?.("data-line-chips") ? { paddingLeft: "12px", paddingRight: "0px", columnGap: "6px" } : real(el, pseudo));
  }
}
const { withLiveRanks } = await import("../../lib/priorities");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const days = lastDays(10, NOW);

const step = (key: string, title: string, tier: "critical" | "polish", done = false, extra: Record<string, unknown> = {}) => ({ key, title, tier, tier_set_by: "pass", refs: [], done, ...extra });
const sess = (tag: string, title: string, state: string, ageHours: number, extra: Record<string, unknown> = {}) => ({
  short_id: `jx7${tag}`.slice(0, 7), conversation_id: fixtureId(tag), title, state, mine: true, workflow: false, why: ["mapped"], last_active_at: NOW - ageHours * HOUR, ...extra,
});
const links = (key: string, sessions: unknown[], extra: Record<string, unknown> = {}) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false, ...extra });
const PL_1075 = { short_id: "pl-1075", title: "Every change merges green through one flow", done: 24, total: 37, size: 37 };
const PL_619 = { short_id: "pl-619", title: "The whole platform program", done: 80, total: 140, size: 140 };
const base = { summary: "", person_pos: null, rank_source: "ai", serves: null, workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", mine: true, first_seen_at: NOW - 3 * DAY, last_active_at: NOW, done_at: null, session_count: 0, session_count_more: false, sessions: [] as any[], status: "active", status_set_by: "pass", correction_pending: false };
const counts = (steps: any[]) => ({ critical_done: steps.filter((s) => s.tier === "critical" && s.done).length, critical_total: steps.filter((s) => s.tier === "critical").length });
const row = (id: number, title: string, rank: number | null, steps: any[], extra: Record<string, unknown> = {}) => ({ ...base, _id: `p${id}`, short_id: `pri-${id}`, title, rank, ai_rank: rank, steps, counts: counts(steps), ...extra });

const DRIVER = sess("drive1", "Deploy redesign", "dormant", 1);
const ROWS = [
  row(1, "Cam's eval requests flow", 1, [step("s1", "Work the open eval requests", "critical"), step("s2", "Change request flow design", "critical"), step("p1", "Old polish", "polish", true, { done_at: NOW - DAY })], {
    links: [links("s1", [sess("evalrq", "Eval Requests", "dormant", 5)], { sessions_more: 3 }), links("s2", [sess("crflow", "Change requests flow design", "needs_you", 1)]), links("p1", [])],
    plan: null,
  }),
  row(2, "One simple ship flow", 2, [step("s1", "Auto-deploy from main", "critical"), step("s2", "Red main reaches the Release Captain", "critical"), step("s3", "Direct pushes move onto change flow", "critical"), step("s4", "Web app deploys with the backend", "critical")], {
    plan: PL_1075,
    links: [
      links("s1", [DRIVER]),
      links("s2", [DRIVER, sess("review1", "Review · ct-9001 red main", "killed", 21, { workflow: true }), sess("review2", "Review · ct-9002 red main", "idle", 30, { workflow: true })]),
      links("s3", []),
      links("s4", [DRIVER, sess("review3", "Review · ct-9003 web deploys", "idle", 2, { workflow: true })]),
    ],
  }),
  row(3, "Cut eval spend", 3, [step("s1", "Deploy drops the eval job", "critical"), step("s2", "Grader budget", "polish")], {
    plan: null,
    links: [links("s1", [sess("evalcost", "Eval cost reduction", "working", 0)], { plan: PL_1075 }), links("s2", [], { part_of: [PL_619] })],
  }),
  row(4, "Priorities for Union", 4, [step("s1", "Calibrate goal finding", "critical"), step("s2", "Session mapping reaches 0.75", "critical")], {
    plan: null,
    links: [links("s1", [sess("calib1", "Priorities feature build", "needs_you", 3)]), links("s2", [sess("mapping", "Session mapping", "needs_you", 7)])],
  }),
  // A row from a server that predates the links: no links, no plan.
  row(5, "Trustworthy eval suite", 5, [step("s1", "Get grader faults under 10%", "critical"), step("s2", "Re-measure grader faults", "critical", true, { done_at: NOW - 2 * DAY })], { first_seen_at: NOW - 20 * DAY }),
  row(6, "An old finished thing", null, [step("s1", "Done long ago", "critical", true)], { status: "done", done_at: NOW - 3 * DAY }),
];
const at = (n: number) => days.map((_, i) => (i === days.length - 1 ? n : 0));
const HISTORY = {
  days,
  lanes: [
    { key: "pri-1", short_id: "pri-1", title: "Cam's eval requests flow", status: "active", counts: at(4), total: 4 },
    { key: "pri-2", short_id: "pri-2", title: "One simple ship flow", status: "active", counts: at(1), total: 1 },
    { key: "pri-4", short_id: "pri-4", title: "Priorities for Union", status: "active", counts: at(1), total: 1 },
    { key: "unassigned", short_id: null, title: "Unassigned", status: null, counts: at(4), total: 4 },
  ],
  sessions: { jx7crflo: at(4) },
  unassigned_today: [
    { short_id: "jx7jamie", conversation_id: fixtureId("jamie"), title: "Jamie's workflow review", last_active_at: NOW - 60_000, count: 3 },
    { short_id: "jx7ship", conversation_id: fixtureId("shiprules"), title: "Shipping rules design", last_active_at: NOW - 2 * 60_000, count: 1 },
  ],
};

const listOf = (priorities: unknown[], timing: { next_pass_at?: number | null; behind_by_ms?: number | null } = {}) =>
  ({ priorities, own_truncated: false, teammates_truncated: false, next_pass_at: null, behind_by_ms: null, ...timing });
const mount = (node: React.ReactNode, path = "/priorities") => mountSurface(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const order = (el: HTMLElement) => [...el.querySelectorAll("li[data-priority]")].map((n) => n.getAttribute("data-priority"));
const FILTERS = readFilters(new URLSearchParams());
const view = (over: Record<string, unknown> = {}) => (
  <PrioritiesView rows={ROWS as any} history={HISTORY as any} now={NOW} layout="wide" filters={FILTERS} onFilters={() => {}} compact={false} onCompact={() => {}} {...over} />
);
const block = (el: HTMLElement, id: string) => el.querySelector(`li[data-priority="${id}"]`) as HTMLElement;
const primaries = (b: HTMLElement) => [...b.querySelectorAll("[data-action]")];

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

test("a teammate's priority offers no action, and a teammate's ask on the viewer's milestone is not the viewer's to answer", async () => {
  const theirs = ROWS.map((r) => ({ ...r, mine: false, user_id: "teammate", owner: "Bea" }));
  const team = await mount(view({ rows: theirs, filters: readFilters(new URLSearchParams("mine=0")) }));
  try {
    expect(order(team.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5"]);
    expect(team.container.querySelectorAll("[data-action]")).toHaveLength(0);
  } finally {
    await team.unmount();
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
const KINDS = row(9, "Every kind of link", 1, [
  step("s1", "Wire every link", "critical", false, { refs: [{ kind: "task", id: "ct-8001" }, { kind: "pr", id: "codecast-sh/codecast#4580" }] }),
  step("s2", "Second milestone", "critical"),
], {
  links: [links("s1", [sess("kinds1", "Kinds driver", "dormant", 2), sess("kinds2", "Kinds helper", "dormant", 3)], { plan: PL_1075 }), links("s2", [sess("kinds3", "Second milestone work", "working", 0)])],
});
function seedKinds() {
  useInboxStore.setState({ tasks: { tk8001: { _id: "tk8001", short_id: "ct-8001", title: "Write the wiring", status: "open" } } } as any);
  useInboxStore.getState().syncTable("sessions", [{ _id: fixtureId("kinds2"), title: "Kinds helper", worktree_branch: "feat/every-link", updated_at: NOW - 3 * HOUR }] as any, { isDelta: true });
  useInboxStore.getState().syncTable("teamDeploys", [{ _id: "dep8001", workspace: `team:${TEAM_ID}`, target: "web", status: "live", live_at: NOW - HOUR, created_at: NOW - 2 * HOUR, sessions: [], tasks: [{ short_id: "ct-8001" }] }] as any, { isDelta: true });
}
const ALL_KINDS = readFilters(new URLSearchParams("show=sessions,plans,tasks,prs,branches,deploys"));
const CHIP_KINDS = ["session", "plan", "task", "pr", "branch", "deploy"];

test("with every kind shown, each link is a chip of its own shape, labelled by its title and never a short id", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS], filters: ALL_KINDS }));
  const { act } = React as any;
  try {
    expect(describeFailures(page)).toBe("");
    const b = block(page.container, "pri-9");
    // The closed line, first to last (with room for all of it): the action and its session, "+N", one glyph and
    // count per other kind (its words in the tooltip), the plan.
    const s1 = b.querySelector('[data-milestone="s1"]')!;
    expect(partsOf(s1.querySelector("[data-line-chips]")!)).toEqual(["action", "in Kinds driver", "+1", "task 1", "pr 1", "branch 1", "deploy 1", "plan"]);
    expect(s1.querySelector('[data-chip-count="pr"]')!.getAttribute("title")).toBe("1 pull request");
    // Open, the line lists each one as its own chip.
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    for (const kind of CHIP_KINDS) expect(b.querySelector(`[data-chip="${kind}"]`)).not.toBeNull();
    expect(b.querySelector('[data-chip="task"]')!.textContent).toBe("Write the wiring");
    expect(b.querySelector('[data-chip="branch"]')!.textContent).toBe("feat/every-link");
    expect(page.text()).not.toMatch(/jx7|ct-|pl-/);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("on a phone, Looks done? and correction pending sit on a line under the title, which keeps its width", async () => {
  const marked = row(8, "Marked", 1, [step("s1", "A milestone title long enough to need its two lines", "critical"), step("s2", "Corrected", "critical")], {
    links: [links("s1", [sess("mk1", "Marked session", "needs_you", 1)], { looks_done: true, correction_pending: true }), links("s2", [])],
  });
  const page = await mount(view({ rows: [marked], layout: "phone" }));
  try {
    const line = block(page.container, "pri-8").querySelector('[data-milestone="s1"]')!;
    const marks = line.querySelector("[data-milestone-marks]")!;
    expect(marks.querySelector("[data-looks-done]")).not.toBeNull();
    expect(marks.querySelector("[data-correction-pending]")).not.toBeNull();
    // The title's own line holds the title alone, above the marks.
    const title = line.querySelector("[data-milestone-title]")!;
    expect(title.parentElement).toBe(marks.parentElement);
    expect(title.nextElementSibling).toBe(marks);
    // Whatever trails the line (here the Answer) leaves the title at least 8rem.
    expect(title.closest(".grid")!.className).toContain("grid-cols-[minmax(8rem,1fr)_auto]");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("\"+N older sessions\" in an open milestone opens the priority's page at that milestone", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-1");
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    const older = b.querySelector("[data-older-sessions]")!;
    expect(older.textContent).toBe("+3 older sessions");
    expect(older.getAttribute("href")).toBe("/priorities/pri-1?milestone=s1");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("one other kind asked for counts after \"+N sessions\", which stays; none asked for keeps it too", async () => {
  seedKinds();
  const prs = await mount(view({ rows: [KINDS], filters: readFilters(new URLSearchParams("show=sessions,plans,prs")) }));
  try {
    const s1 = block(prs.container, "pri-9").querySelector('[data-milestone="s1"]')!;
    expect(partsOf(s1.querySelector("[data-line-chips]")!)).toEqual(["action", "in Kinds driver", "+1", "pr 1", "plan"]);
    expect(s1.querySelector("[data-more-sessions]")!.getAttribute("aria-label")).toBe("1 more session");
  } finally {
    await prs.unmount();
  }
  const plain = await mount(view({ rows: [KINDS] }));
  try {
    expect(block(plain.container, "pri-9").querySelector('[data-milestone="s1"] [data-more-sessions]')!.textContent).toBe("+1");
  } finally {
    await plain.unmount();
  }
}, 60_000);

test("an open milestone shows every kind of link whatever Show says, and its whole title", async () => {
  seedKinds();
  const long = { ...KINDS, steps: [{ ...KINDS.steps[0], title: "Wire every link a milestone can have, so the open line shows the whole of this long title" }, KINDS.steps[1]] };
  const page = await mount(view({ rows: [long], filters: readFilters(new URLSearchParams("show=none")) }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-9");
    // Show off: a closed line has no chips.
    expect(b.querySelector('[data-milestone="s1"] [data-chip]')).toBeNull();
    const title = () => b.querySelector('[data-milestone="s1"] [data-milestone-title]')!;
    expect(title().className).toContain("truncate");
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    const detail = b.querySelector("[data-milestone-detail]")!;
    expect([...detail.querySelectorAll("[data-type-row]")].map((r) => r.getAttribute("data-type-row"))).toEqual(["Plan", "Tasks", "PRs", "Branches", "Deploys"]);
    for (const kind of CHIP_KINDS) expect(detail.querySelector(`[data-chip="${kind}"]`)).not.toBeNull();
    expect(title().className).not.toContain("truncate");
    expect(title().className).toContain("whitespace-normal");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the progress button shows the done critical milestones, and hides them again", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-5");
    expect(b.querySelector('[data-milestone="s2"]')).toBeNull();
    await act(async () => { (b.querySelector("[data-progress-toggle]") as HTMLElement).click(); });
    expect(b.querySelector('[data-milestone="s2"]')!.textContent).toContain("Re-measure grader faults");
    await act(async () => { (b.querySelector("[data-progress-toggle]") as HTMLElement).click(); });
    expect(b.querySelector('[data-milestone="s2"]')).toBeNull();
  } finally {
    await page.unmount();
  }
}, 60_000);

test("every priority says how many landed and how long since, on every layout; a phone's compact line is one line, its today and its sparkline in the row", async () => {
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ layout }));
    try {
      expect(block(page.container, "pri-5").querySelector("[data-momentum-words]")!.textContent).toBe("1 landed · last 2d");
      for (const id of ["pri-1", "pri-2", "pri-3", "pri-4"]) expect(block(page.container, id).querySelector("[data-momentum-words]")!.textContent).toBe("0 landed · none yet");
    } finally {
      await page.unmount();
    }
  }
  const compact = await mount(view({ layout: "phone", compact: true }));
  try {
    const head = block(compact.container, "pri-1").querySelector("[data-priority-head]")!;
    expect(head.textContent).toContain("4 today");
    // One line a priority: the mini sparkline stays in the row, and no meta line of words under it.
    expect(head.querySelector("[data-day-strip]")).not.toBeNull();
    expect(head.querySelector("[data-meta]")).toBeNull();
    expect(head.querySelector("[data-momentum-words]")).toBeNull();
    expect(head.querySelector("[data-action]")).not.toBeNull();
  } finally {
    await compact.unmount();
  }
  // A wide compact view stays one line per row: no meta-line words, and at Daylight's narrow grid the polish slot
  // leaves too; a wide one keeps the words beside its strip.
  const wideCompact = await mount(view({ compact: true }));
  try {
    const head = block(wideCompact.container, "pri-5").querySelector("[data-priority-head]")!;
    expect(head.querySelector("[data-momentum-words]")).toBeNull();
    expect(head.querySelector("[data-momentum]")!.textContent).toContain("1 landed");
    expect(head.querySelector("[data-polish-slot]")!.className).toContain("[@container(max-width:44rem)]:invisible");
  } finally {
    await wideCompact.unmount();
  }
  const full = await mount(view());
  try {
    expect(block(full.container, "pri-5").querySelector("[data-polish-slot]")!.className).not.toContain("invisible");
  } finally {
    await full.unmount();
  }
}, 60_000);

test("under a coarse pointer every control on the list is a 44px target, at every layout", async () => {
  seedKinds();
  // A size of 44px (h-11, size-11, min-h-11) at every pointer, or one a coarse pointer gets: its own, or a 44px ::after press area.
  const sized = /(?:^|\s)(?:size-11|h-11|min-h-11)(?:\s|$)|\[@media\(pointer:coarse\)\]:(?:h-11|h-12|min-h-11|size-11|after:)/;
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [...ROWS, KINDS], layout, filters: ALL_KINDS }));
    const { act } = React as any;
    try {
      // Open a milestone, so its sessions, runs and links are in the count.
      await act(async () => { (block(page.container, "pri-2").querySelector('[data-milestone="s2"] [role=button]') as HTMLElement).click(); });
      const controls = [...page.container.querySelectorAll("a[href], button, [role=button]")];
      expect(controls.length).toBeGreaterThan(40);
      const small = controls.filter((el) => !sized.test(el.className)).map((el) => el.outerHTML.slice(0, 120));
      expect(small).toEqual([]);
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("a narrow window takes the desktop grid on a touch screen at least 900px wide (Daylight), and the phone layout otherwise", async () => {
  answers["priorities:list"] = listOf(ROWS);
  answers["priorities:history"] = HISTORY;
  const realMatch = window.matchMedia;
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
  const layoutWith = async (tablet: boolean) => {
    (window as any).matchMedia = (q: string) => ({ ...realMatch(q), matches: tablet && q === "(pointer: coarse) and (min-width: 900px)" });
    const page = await mount(<PrioritiesPage />);
    try {
      return page.container.querySelector("[data-priorities]")?.getAttribute("data-layout");
    } finally {
      await page.unmount();
    }
  };
  try {
    expect(await layoutWith(true)).toBe("wide");
    expect(await layoutWith(false)).toBe("phone");
  } finally {
    (window as any).matchMedia = realMatch;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: realWidth });
  }
}, 60_000);

test("a milestone line's chips use the today and momentum columns, its today count sits in the line, and the action keeps its session while the plan gives way", async () => {
  const history = { ...HISTORY, sessions: { jx7crfl: at(3) } };
  const page = await mount(view({ history }));
  try {
    const grid = block(page.container, "pri-1").querySelector('[data-milestone="s2"] [role=button] > div')!;
    expect(grid.className).toContain("col-end-6");
    // The line's today count is inside the line, not a column of its own.
    expect(block(page.container, "pri-1").querySelector('[data-milestone="s2"] [data-line-today]')!.textContent).toBe("3 today");
    // pri-3: the Open action with "in ‹session›" right after the button, ellipsizing inside the chips cell (the
    // group and the words both shrink); the plan last, the chip a narrow line clips (the open line lists it).
    const line = block(page.container, "pri-3").querySelector('[data-milestone="s1"] [data-line-chips]')!;
    expect(partsOf(line)).toEqual(["action", "in Eval cost reduction", "plan"]);
    // One row that never wraps; the button never shrinks, the session's words ellipsize down to 5rem.
    expect(line.className.split(" ")).toContain("flex-nowrap");
    expect(line.querySelector('[data-fit="fixed"]')!.className.split(" ")).toContain("shrink-0");
    const words = line.querySelector('[data-fit="label"]')!;
    for (const c of ["min-w-[5rem]", "shrink"]) expect(words.className.split(" ")).toContain(c);
    expect(words.querySelector("[data-in-session]")!.className.split(" ")).toContain("truncate");
  } finally {
    await page.unmount();
  }
  // "+N sessions" comes after the session's name, before the plan.
  const two = row(11, "Two sessions", 1, [step("s1", "One milestone", "critical"), step("s2", "Another", "critical")], {
    links: [links("s1", [sess("twoa", "First session", "dormant", 1), sess("twob", "Second session", "dormant", 2)], { plan: PL_1075 }), links("s2", [])],
  });
  const both = await mount(view({ rows: [two] }));
  try {
    expect(partsOf(block(both.container, "pri-11").querySelector('[data-milestone="s1"] [data-line-chips]')!)).toEqual(["action", "in First session", "+1", "plan"]);
  } finally {
    await both.unmount();
  }
}, 60_000);

test("Daylight's coarse pointer puts a line's marks under its title; compact moves the row's pending mark to the meta line", async () => {
  const marked = row(8, "Marked", 1, [step("s1", "A milestone", "critical"), step("s2", "Another", "critical")], {
    correction_pending: true,
    links: [links("s1", [], { looks_done: true }), links("s2", [])],
  });
  const page = await mount(view({ rows: [marked] }));
  try {
    const marks = block(page.container, "pri-8").querySelector('[data-milestone="s1"] [data-milestone-marks]')!;
    expect(marks.querySelector("[data-looks-done]")).not.toBeNull();
    // The title and the marks share one box that stacks them under a coarse pointer and sits them side by side on a mouse.
    expect(marks.parentElement!.className).toContain("[@media(pointer:coarse)]:flex-col");
    // The expand chevron shows wherever nothing hovers.
    expect(block(page.container, "pri-8").querySelector('[data-milestone="s1"] [data-line-chevron]')!.getAttribute("class")).toContain("[@media(hover:none)]:opacity-100");
    // The row's own pending correction sits by the title in the full view.
    expect(block(page.container, "pri-8").querySelector("[data-priority-head] [data-correction-pending]")!.closest("[data-meta]")).toBeNull();
  } finally {
    await page.unmount();
  }
  const compact = await mount(view({ rows: [marked], compact: true }));
  try {
    expect(block(compact.container, "pri-8").querySelector("[data-priority-head] [data-correction-pending]")!.closest("[data-meta]")).not.toBeNull();
  } finally {
    await compact.unmount();
  }
}, 60_000);

test("\"Part of ‹plan› (140 tasks)\" is one chip; No priority is a real button", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const pri3 = block(page.container, "pri-3");
    await act(async () => { (pri3.querySelector("[data-polish]") as HTMLElement).click(); });
    await act(async () => { (pri3.querySelector('[data-milestone="s2"] [role=button]') as HTMLElement).click(); });
    const chip = [...pri3.querySelectorAll('[data-milestone-detail] [data-chip="plan"]')].find((c) => c.textContent?.includes("Part of"))!;
    expect(chip.querySelector("[data-plan-size]")!.textContent).toBe("(140 tasks)");
    // In a narrow row (a phone) the title keeps 6rem: the bar leaves first, then the size (container queries on the row).
    expect(chip.closest("[data-type-row]")!.querySelector(":scope > div")!.className).toContain("[container-type:inline-size]");
    expect([...chip.children].find((c) => c.textContent === "The whole platform program")!.className).toContain("min-w-[6rem]");
    expect(chip.querySelector("[data-plan-bar]")!.getAttribute("class")).toContain("[@container(max-width:24rem)]:hidden");
    expect(chip.querySelector("[data-plan-size]")!.className).toContain("[@container(max-width:17rem)]:hidden");
    expect(pri3.querySelector("[data-milestone-detail]")!.textContent).not.toMatch(/\)\s*140 tasks/);
    expect(page.container.querySelector('[data-today-seg="none"]')!.tagName).toBe("BUTTON");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a linked session's branch and a PR's state repaint their chips when they change", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS], filters: ALL_KINDS }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-9");
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    expect(b.querySelector('[data-chip="branch"]')!.textContent).toBe("feat/every-link");
    await act(async () => {
      useInboxStore.getState().syncTable("sessions", [{ _id: fixtureId("kinds2"), title: "Kinds helper", worktree_branch: "feat/renamed", updated_at: NOW }] as any, { isDelta: true });
      useInboxStore.setState((s: any) => ({ pullRequests: { ...s.pullRequests, pr4580: { _id: "pr4580", repository: "codecast-sh/codecast", number: 4580, state: "merged" } } }));
    });
    await page.waitFor(() => b.querySelector('[data-chip="branch"]')?.textContent === "feat/renamed");
    await page.waitFor(() => !!b.querySelector('[data-chip="pr"]')?.textContent?.includes("merged"));
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Waiting on you tells two sessions on one milestone apart: \"milestone · session\", in the box, the popover and on a phone", async () => {
  const twice = row(12, "Two asks", 1, [step("s1", "Ship it", "critical"), step("s2", "Tidy it", "critical")], {
    links: [links("s1", [sess("aska", "Copy review", "needs_you", 1), sess("askb", "Review · ct-9001 the copy", "needs_you", 2)]), links("s2", [sess("askc", "Tidy session", "needs_you", 3)])],
  });
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [twice], layout }));
    try {
      const labels = [...page.container.querySelectorAll("[data-waiting-item] [data-waiting-label]")].map((a) => [...a.children].map((c) => c.textContent).join(" ") || a.textContent);
      expect(labels[0]).toBe("Ship it · Copy review");
      expect(labels[1]).toBe("Ship it · Review: the copy");
      // Each part ellipsizes by width, not by a count of characters.
      for (const part of page.container.querySelectorAll("[data-waiting-label] > span:not(:nth-child(2))")) expect(part.className).toContain("truncate");
      // A milestone only one session waits on reads as the milestone alone.
      expect(labels[2]).toContain("Tidy it");
      expect(labels[2]).not.toContain("·");
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("at the desktop width the box never takes a third line: it shows fewer items until \"+N more\" fits the second", async () => {
  const many = row(13, "Many asks", 1, Array.from({ length: 7 }, (_, i) => step(`s${i}`, `Milestone ${i}`, "critical")), {
    links: Array.from({ length: 7 }, (_, i) => links(`s${i}`, [sess(`many${i}`, `Session ${i}`, "needs_you", i + 1)])),
  });
  // Lay the box out as a browser would: three slots a line (the heading, the items, "+N more"), 28px each.
  const proto = (window as any).HTMLElement.prototype;
  const realTop = Object.getOwnPropertyDescriptor(proto, "offsetTop");
  const realHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const realWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) { const box = this.closest('[data-waiting="wide"]'); return box ? Math.floor([...box.children].indexOf(this) / 3) * 28 : 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 28; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 800; } });
  try {
    const page = await mount(view({ rows: [many] }));
    try {
      await page.waitFor(() => page.container.querySelectorAll('[data-waiting="wide"] [data-waiting-item]').length === 4);
      expect(page.container.querySelector('[data-waiting="wide"] [data-waiting-more]')!.textContent).toBe("+3 more");
    } finally {
      await page.unmount();
    }
  } finally {
    for (const [k, d] of [["offsetTop", realTop], ["offsetHeight", realHeight], ["offsetWidth", realWidth]] as const) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
  }
}, 60_000);

test("a new width re-fits the waiting box at once: a resize or a rotation starts over from five", async () => {
  const many = row(13, "Many asks", 1, Array.from({ length: 7 }, (_, i) => step(`s${i}`, `Milestone ${i}`, "critical")), {
    links: Array.from({ length: 7 }, (_, i) => links(`s${i}`, [sess(`many${i}`, `Session ${i}`, "needs_you", i + 1)])),
  });
  let perLine = 3;
  const observers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
  const realRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class { constructor(cb: any) { observers.push(cb); } observe() {} disconnect() {} };
  const proto = (window as any).HTMLElement.prototype;
  const realTop = Object.getOwnPropertyDescriptor(proto, "offsetTop");
  const realHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) { const box = this.closest('[data-waiting="wide"]'); return box ? Math.floor([...box.children].indexOf(this) / perLine) * 28 : 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 28; } });
  const { act } = React as any;
  try {
    const page = await mount(view({ rows: [many] }));
    const shown = () => page.container.querySelectorAll('[data-waiting="wide"] [data-waiting-item]').length;
    try {
      await page.waitFor(() => shown() === 4);
      // The box widens (four slots a line now): its observer starts it over from five, which fit.
      perLine = 4;
      await act(async () => { for (const cb of observers) { cb([{ contentRect: { width: 800 } }]); cb([{ contentRect: { width: 1100 } }]); } });
      await page.waitFor(() => shown() === 5);
      expect(page.container.querySelector('[data-waiting="wide"] [data-waiting-more]')!.textContent).toBe("+2 more");
      // It narrows again while five show: the new width alone re-runs the fit, which drops back to four.
      perLine = 3;
      await act(async () => { for (const cb of observers) cb([{ contentRect: { width: 700 } }]); });
      await page.waitFor(() => shown() === 4);
    } finally {
      await page.unmount();
    }
  } finally {
    (globalThis as any).ResizeObserver = realRO;
    for (const [k, d] of [["offsetTop", realTop], ["offsetHeight", realHeight]] as const) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
  }
}, 60_000);

test("a phone line's state word reads the person's session, not a workflow run; the priority's plan shows on its meta line", async () => {
  const page = await mount(view({ layout: "phone" }));
  try {
    // pri-2's second milestone: the driver (dormant) and two review runs (one idle). The driver is the action's
    // session on another line, which no longer hides it here.
    const line = block(page.container, "pri-2").querySelector('[data-milestone="s2"]')!;
    expect(line.textContent).toContain("Dormant");
    expect(line.textContent).not.toContain("Idle");
    expect(block(page.container, "pri-2").querySelector("[data-meta-plan] [data-chip=plan]")!.textContent).toContain("Every change merges green");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("an untouched top-three priority keeps its title's colour and says \"0\" in its today cell", async () => {
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ layout }));
    try {
      // pri-3 (#3) has nothing typed today.
      const head = block(page.container, "pri-3").querySelector("[data-priority-head]")!;
      expect(head.querySelector("[title]")!.className).toContain("text-sol-text");
      expect(head.innerHTML).not.toContain("text-sol-text-muted\">Cut eval spend");
      expect(head.querySelector("[data-today]")!.textContent).toBe(layout === "wide" ? "0" : "0 today");
      // A lower priority with nothing today leaves the cell empty.
      const five = block(page.container, "pri-5").querySelector("[data-priority-head] [data-today]");
      expect(five?.textContent ?? "").toBe("");
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

// The milestone line's one-row rule, locked across chips-cell widths. Layout is stubbed the way a browser lays
// the row out: the action button 65px, "+N" 24px, each kind's count chip 36px, 6px between parts, 12px of
// left padding; the session's words hold 80px (5rem) and the plan needs 128px (8rem) to show.
/** The chips cell's width at 1280 with the inbox open, measured in the browser on the fixture list. */
const DESK_INBOX_CELL = 359;
async function lineAt(cell: number, rows: unknown[], filters = readFilters(new URLSearchParams("show=sessions,plans,tasks,prs")), priority = "pri-14", milestone = "s1") {
  lineCell = cell;
  try {
    const page = await mount(view({ rows, filters }));
    try {
      const line = block(page.container, priority).querySelector(`[data-milestone="${milestone}"] [data-line-chips]`)!;
      return {
        action: !!line.querySelector("[data-action]"),
        label: line.querySelector("[data-in-session]")?.textContent ?? null,
        more: line.querySelector("[data-more-sessions]")?.textContent ?? null,
        moreLabel: line.querySelector("[data-more-sessions]")?.getAttribute("aria-label") ?? null,
        kinds: [...line.querySelectorAll("[data-chip-count]")].map((c) => `${c.getAttribute("data-chip-count")} ${c.textContent}`),
        plan: line.querySelector('[data-chip="plan"]')?.textContent ?? null,
      };
    } finally {
      await page.unmount();
    }
  } finally {
    lineCell = 600;
  }
}

test("the line's one row across chips-cell widths: action, its session and +N always; the counts from 300px; the plan from 420px", async () => {
  const title = "Rework the scorer calibration so session mapping clears 0.75";
  expect(title.length).toBe(60);
  const busy = row(14, "Busy line", 1, [step("s1", "Ship the scorer", "critical", false, { refs: [{ kind: "task", id: "ct-8101" }, { kind: "pr", id: "codecast-sh/codecast#4601" }, { kind: "pr", id: "codecast-sh/codecast#4602" }] }), step("s2", "Another", "critical")], {
    links: [links("s1", [sess("busy1", title, "dormant", 1), ...[2, 3, 4, 5].map((i) => sess(`busy${i}`, `Helper ${i}`, "dormant", i))], { plan: PL_1075 }), links("s2", [])],
  });
  const at = async (w: number) => lineAt(w, [busy]);
  const base = { action: true, label: `in ${title}`, more: "+4", moreLabel: "4 more sessions" };
  expect(await at(220)).toEqual({ ...base, kinds: [], plan: null });
  expect(await at(300)).toEqual({ ...base, kinds: ["task 1", "pr 2"], plan: null });
  for (const w of [420, 600]) {
    const line = await at(w);
    expect(line).toMatchObject({ ...base, kinds: ["task 1", "pr 2"] });
    expect(line.plan).toContain("Every change merges green");
  }
}, 60_000);

test("the Done-list case: at the 1280-with-inbox chips cell, \"Deploy drops the eval job\" shows its plan", async () => {
  const line = await lineAt(DESK_INBOX_CELL, ROWS, FILTERS, "pri-3", "s1");
  expect(line.action).toBe(true);
  expect(line.label).toBe("in Eval cost reduction");
  expect(line.plan).toContain("Every change merges green");
}, 60_000);

test("the route shows the feature-off landing while the workspace has Priorities off", async () => {
  useInboxStore.getState().syncTable("teams", [{ _id: TEAM_ID, name: "Degrade Co", role: "admin", features: { priorities: false } }] as any);
  const page = await mount(<PrioritiesRoute />);
  try {
    expect(page.container.querySelector("[data-priorities]")).toBeNull();
    expect(page.text()).not.toContain("No priorities yet");
  } finally {
    await page.unmount();
  }
}, 60_000);
