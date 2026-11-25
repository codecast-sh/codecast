// /priorities mounted in jsdom over a convex transport that answers by name
// (test-helpers/missingBackend.tsx). Proves: active priorities read in rank
// order with their critical-path counts, finished and past ones after them
// (done won, quiet and set aside greyed), fed into the store and painted
// from it; ?open=pri-N opens that row on its
// steps, chips and "+ new session" on each open step no session works; dragging a row onto another ranks it, and
// dragging a step across the line changes its tier; a backend without the
// functions reads as an error state, an empty list as the empty state, and the
// route shows the feature-off landing while the workspace has Priorities off.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesPage.mount.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage } = await import("./PrioritiesPage");
const { PrioritiesView } = await import("./PrioritiesPage");
const { default: PrioritiesRoute } = await import("../../app/priorities/page");

const DAY = 86_400_000;
const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10));
const step = (key: string, title: string, tier: "critical" | "polish", done: boolean, refs: Array<{ kind: string; id: string }> = []) => ({ key, title, tier, tier_set_by: "pass", refs, done });
const base = { summary: "", rank_set_by: "pass", serves: null, workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", mine: true, first_seen_at: 0, last_active_at: Date.UTC(2026, 10, 20), done_at: null, session_count: 0, sessions: [] as any[] };
const ROWS = [
  {
    ...base, _id: "p1", short_id: "pri-1", title: "Trusted evals", status: "active", rank: 1, summary: "Grader faults are the last blocker.", serves: "in-5",
    steps: [step("s1", "Grader faults under 10%", "critical", true, [{ kind: "task", id: "ct-12" }]), step("s2", "Nightly re-measure", "critical", false), step("s3", "Judge dashboard", "polish", false)],
    counts: { critical_done: 1, critical_total: 2 },
  },
  { ...base, _id: "p2", short_id: "pri-2", title: "Deploys simple and reliable", status: "active", rank: 2, steps: [], counts: { critical_done: 0, critical_total: 0 } },
  { ...base, _id: "p3", short_id: "pri-3", title: "Sidebar truth and ownership", status: "active", rank: 3, steps: [step("s1", "Owner chips", "critical", false)], counts: { critical_done: 0, critical_total: 1 } },
  { ...base, _id: "p4", short_id: "pri-4", title: "Cam changes the broker himself", status: "done", rank: null, done_at: Date.UTC(2026, 10, 19, 18), steps: [], counts: { critical_done: 0, critical_total: 0 } },
  { ...base, _id: "p5", short_id: "pri-5", title: "Market agents learn from Cam", status: "quiet", rank: null, steps: [], counts: { critical_done: 0, critical_total: 0 } },
  { ...base, _id: "p6", short_id: "pri-6", title: "A meta prompt optimizer", status: "set_aside", rank: null, steps: [], counts: { critical_done: 0, critical_total: 0 } },
];
const HISTORY = { days, lanes: [
  { key: "pri-1", short_id: "pri-1", title: "Trusted evals", status: "active", counts: days.map((_, i) => i), total: 105 },
  // A lane whose owner hid their activity: its days show, none shaded.
  { key: "pri-2", short_id: "pri-2", title: "Deploys", status: "active", counts: days.map(() => 0), total: 0, counts_hidden: true },
] };
// What the open row's show answers: s2 is worked by a session older than the list's newest three.
const DETAIL = { ...ROWS[0], steps: ROWS[0].steps.map((st) => ({ ...st, sessions: st.key === "s2" ? [{ short_id: "jx7deep", title: "Re-measure run", step_key: "s2", updated_at: 1 }] : [] })), other_sessions: [] };

const mount = (node: React.ReactNode, path = "/priorities") => mountSurface(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const order = (el: HTMLElement) => [...el.querySelectorAll("[data-priority]")].map((n) => n.getAttribute("data-priority"));

/** A native drag event carrying a stand-in for dataTransfer (jsdom has none). */
function drag(el: Element, type: string) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { effectAllowed: "", dropEffect: "", setData() {}, getData: () => "" } });
  el.dispatchEvent(e);
}

test("priorities read in rank order, finished and past after them, and ?open opens a row on its steps", async () => {
  answers["priorities:list"] = ROWS;
  answers["priorities:history"] = HISTORY;
  answers["priorities:show"] = DETAIL;
  const page = await mount(<PrioritiesPage />, "/priorities?open=pri-1");
  try {
    expect(describeFailures(page)).toBe("");
    expect(order(page.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5", "pri-6"]);
    const text = page.text();
    expect(text).toContain("1/2");
    expect(text).toContain("✓ Done Nov 19");
    expect(text).toContain("Quiet since");
    expect(text).toContain("Set aside");
    expect(page.container.querySelector('[data-status="set_aside"]')!.className).not.toContain("sol-green");
    // The open row: its summary, both groups, and a compose link on the steps no session works.
    const body = page.container.querySelector("[data-priority-body]")!;
    expect(body.textContent).toContain("Grader faults are the last blocker.");
    expect(body.textContent).toContain("Critical path");
    expect(body.textContent).toContain("Polish and follow-ups");
    const compose = [...body.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((h) => h?.startsWith("/inbox?"));
    // A done step (s1) needs no new session, nor does s2, which show says a session works; s3 gets one.
    expect(compose).toEqual([`/inbox?${new URLSearchParams({ compose: "Trusted evals: Judge dashboard" })}`]);
    expect(body.querySelector('[data-step="s2"]')!.textContent).toContain("Re-measure run");
    // A hidden lane draws its days unshaded.
    expect(page.container.querySelector('[data-priority="pri-2"] [data-history-strip]')!.getAttribute("data-hidden")).toBe("true");
    // 15 day cells on the row's strip, titled with the day's count.
    const strip = page.container.querySelector('[data-priority="pri-1"] [data-history-strip]')!;
    expect(strip.querySelectorAll("i").length).toBe(15);
    expect(strip.querySelector("i:last-child")!.getAttribute("title")).toBe("Nov 24: 14 typed");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("dragging a row onto another ranks it there; a step across the line changes its tier", async () => {
  const calls: string[] = [];
  const writes = {
    rank: async (id: string, rank: number) => { calls.push(`rank ${id} ${rank}`); },
    setStepTier: async (id: string, key: string, tier: string) => { calls.push(`tier ${id} ${key} ${tier}`); },
    setAside: async (id: string) => { calls.push(`aside ${id}`); },
    restore: async (id: string) => { calls.push(`restore ${id}`); },
  };
  const page = await mount(<PrioritiesView rows={ROWS as any} history={HISTORY as any} openId="pri-1" onToggleOpen={() => {}} writes={writes} />);
  const { act } = React as any;
  try {
    const row = (id: string) => page.container.querySelector(`li[data-priority="${id}"]`)!;
    await act(async () => { drag(row("pri-3").querySelector("[draggable=true]")!, "dragstart"); });
    await act(async () => { drag(row("pri-1"), "dragover"); });
    await act(async () => { drag(row("pri-1"), "drop"); });
    const s2 = page.container.querySelector('[data-step="s2"]')!;
    await act(async () => { drag(s2, "dragstart"); });
    const polish = page.container.querySelector('[data-tier="polish"]')!;
    await act(async () => { drag(polish, "dragover"); });
    await act(async () => { drag(polish, "drop"); });
    // A step dropped back on its own side changes nothing.
    const s1 = page.container.querySelector('[data-step="s1"]')!;
    await act(async () => { drag(s1, "dragstart"); });
    const critical = page.container.querySelector('[data-tier="critical"]')!;
    await act(async () => { drag(critical, "dragover"); });
    await act(async () => { drag(critical, "drop"); });
    expect(calls).toEqual(["rank pri-3 1", "tier pri-1 s2 polish"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a teammate's open priority offers no new session on its empty steps", async () => {
  answers["priorities:show"] = DETAIL;
  const theirs = ROWS.map((r) => ({ ...r, mine: false, user_id: "teammate", owner: "Bea" }));
  const page = await mount(<PrioritiesView rows={theirs as any} history={HISTORY as any} openId="pri-1" onToggleOpen={() => {}} writes={{} as any} />);
  try {
    const body = page.container.querySelector("[data-priority-body]")!;
    expect(body.textContent).toContain("Judge dashboard");
    expect([...body.querySelectorAll("a")].filter((a) => a.getAttribute("href")?.startsWith("/inbox?"))).toEqual([]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Move to ranks a priority from the row menu, without a drag", async () => {
  const calls: string[] = [];
  const writes = { rank: (id: string, n: number) => calls.push(`rank ${id} ${n}`), setStepTier: () => {}, setAside: () => {}, restore: () => {} };
  const page = await mount(<PrioritiesView rows={ROWS as any} history={HISTORY as any} openId={null} onToggleOpen={() => {}} writes={writes as any} />);
  const { act } = React as any;
  try {
    const trigger = page.container.querySelector('li[data-priority="pri-3"] button[aria-label^="More for"]') as HTMLElement;
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const items = [...document.querySelectorAll("[data-move-to]")] as HTMLElement[];
    expect(items.map((i) => i.getAttribute("data-move-to"))).toEqual(["1", "2"]);
    await act(async () => { items[0].click(); });
    expect(calls).toEqual(["rank pri-3 1"]);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the store's priority actions paint the rows at once", async () => {
  const st = useInboxStore.getState();
  st.syncTable("priorities", ROWS as any);
  const rank = (id: string) => (Object.values(useInboxStore.getState().priorities) as any[]).find((r) => r.short_id === id);
  st.rankPriority("pri-3", 1).catch(() => {}); // no dispatch is wired here: the write parks
  expect([rank("pri-3").rank, rank("pri-1").rank, rank("pri-2").rank]).toEqual([1, 2, 3]);
  st.setPriorityStepTier("pri-1", "s2", "polish").catch(() => {}); // no dispatch is wired here: the write parks
  expect(rank("pri-1").counts).toEqual({ critical_done: 1, critical_total: 1 });
  st.setPriorityAside("pri-2").catch(() => {}); // no dispatch is wired here: the write parks
  expect(rank("pri-2").status).toBe("set_aside");
  st.restorePriority("pri-2").catch(() => {}); // no dispatch is wired here: the write parks
  expect(rank("pri-2").status).toBe("active");
  st.syncTable("priorities", ROWS as any);
});

test("a missing backend paints the cached rows, or reads as an error on a cold cache; an empty list is the empty state", async () => {
  delete answers["priorities:list"];
  delete answers["priorities:history"];
  // The rows the first test's feed left in the store still paint (local-first).
  const cached = await mount(<PrioritiesPage />);
  try {
    expect(describeFailures(cached)).toBe("");
    expect(order(cached.container)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4", "pri-5", "pri-6"]);
  } finally {
    await cached.unmount();
  }
  useInboxStore.getState().syncTable("priorities", [] as any);
  const missing = await mount(<PrioritiesPage />);
  try {
    expect(describeFailures(missing)).toBe("");
    expect(missing.text()).toContain("Priorities didn't load");
  } finally {
    await missing.unmount();
  }
  answers["priorities:list"] = [];
  const empty = await mount(<PrioritiesPage />);
  try {
    expect(empty.text()).toContain("No priorities yet");
  } finally {
    await empty.unmount();
  }
}, 60_000);

test("the route shows the feature-off landing while the workspace has Priorities off", async () => {
  const s = useInboxStore.getState();
  s.syncTable("teams", [{ _id: TEAM_ID, name: "Degrade Co", role: "admin", features: { priorities: false } }] as any);
  const page = await mount(<PrioritiesRoute />);
  try {
    expect(page.container.querySelector("[data-priorities]")).toBeNull();
    expect(page.text()).toMatch(/Priorities/);
    expect(page.text()).not.toContain("No priorities yet");
  } finally {
    await page.unmount();
  }
}, 60_000);
