// ct-101409: the person opens a priority row, leaves for another page, and
// comes back through the sidebar's fixed href="/priorities". The row they had
// open should still be open; today the open row lives only in ?open= and the
// bare href drops it.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesPage.return.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { MemoryRouter, Routes, Route, Link } = await import("react-router");
const { default: PrioritiesPage } = await import("./PrioritiesPage");

const step = (key: string, title: string) => ({ key, title, tier: "critical", tier_set_by: "pass", refs: [], done: false });
const base = { summary: "", rank_set_by: "pass", serves: null, workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", mine: true, first_seen_at: 0, last_active_at: Date.UTC(2026, 10, 20), done_at: null, session_count: 0, sessions: [] as any[], status: "active" };
const ROWS = [
  { ...base, _id: "p1", short_id: "pri-1", title: "Trusted evals", rank: 1, summary: "Grader faults are the last blocker.", steps: [step("s1", "Nightly re-measure")], counts: { critical_done: 0, critical_total: 1 } },
  { ...base, _id: "p2", short_id: "pri-2", title: "Deploys simple and reliable", rank: 2, summary: "One button.", steps: [step("s1", "Single deploy path")], counts: { critical_done: 0, critical_total: 1 } },
];
answers["priorities:list"] = { priorities: ROWS, own_truncated: false, teammates_truncated: false, next_pass_at: null, behind_by_ms: null };
answers["priorities:history"] = { days: [], lanes: [] };
answers["priorities:show"] = { ...ROWS[1], steps: ROWS[1].steps.map((s) => ({ ...s, sessions: [] })), other_sessions: [] };

function Elsewhere() {
  // The sidebar's Priorities entry: a fixed href, no query (SidebarNav.tsx).
  return <div data-elsewhere><Link to="/priorities" data-sidebar-priorities>Priorities</Link></div>;
}

test("returning to Priorities from the sidebar keeps the row the person had open", async () => {
  const page = await mountSurface(
    <MemoryRouter initialEntries={["/priorities"]}>
      <Routes>
        <Route path="/priorities" element={<PrioritiesPage />} />
        <Route path="/goals" element={<Elsewhere />} />
      </Routes>
      <Link to="/goals" data-sidebar-goals>Goals</Link>
    </MemoryRouter>,
  );
  const { act } = React as any;
  const openBody = () => page.container.querySelector("[data-priority-body]");
  const openRow = () => openBody()?.closest("[data-priority]")?.getAttribute("data-priority") ?? null;
  try {
    expect(describeFailures(page)).toBe("");
    // The person opens pri-2.
    const toggle = page.container.querySelector('li[data-priority="pri-2"] button') as HTMLElement;
    await act(async () => { toggle.click(); });
    expect(openRow()).toBe("pri-2");
    // They go to another page...
    await act(async () => { (page.container.querySelector("[data-sidebar-goals]") as HTMLElement).click(); });
    expect(page.container.querySelector("[data-elsewhere]")).not.toBeNull();
    // ...and come back through the sidebar's bare /priorities.
    await act(async () => { (page.container.querySelector("[data-sidebar-priorities]") as HTMLElement).click(); });
    expect(page.container.querySelector("[data-priority]")).not.toBeNull();
    expect(openRow()).toBe("pri-2");
  } finally {
    await page.unmount();
  }
}, 60_000);

const { useInboxStore } = await import("../../store/inboxStore");
const remembered = () => (useInboxStore.getState().clientState.ui as any)?.priorities_open ?? {};

async function mountAt(url: string) {
  const page = await mountSurface(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/priorities" element={<PrioritiesPage />} />
        <Route path="/goals" element={<Elsewhere />} />
      </Routes>
      <Link to="/goals" data-sidebar-goals>Goals</Link>
    </MemoryRouter>,
  );
  const { act } = React as any;
  const click = async (sel: string) => { await act(async () => { (page.container.querySelector(sel) as HTMLElement).click(); }); };
  const openRow = () => page.container.querySelector("[data-priority-body]")?.closest("[data-priority]")?.getAttribute("data-priority") ?? null;
  const roundTrip = async () => { await click("[data-sidebar-goals]"); await click("[data-sidebar-priorities]"); };
  return { page, click, openRow, roundTrip };
}

test("a closed row stays closed, and the last row opened is the one restored", async () => {
  const { page, click, openRow, roundTrip } = await mountAt("/priorities");
  try {
    if (openRow()) await click(`li[data-priority="${openRow()}"] button`);
    await click('li[data-priority="pri-1"] button');
    await click('li[data-priority="pri-2"] button');
    expect(openRow()).toBe("pri-2");
    await roundTrip();
    expect(openRow()).toBe("pri-2");
    await click('li[data-priority="pri-2"] button');
    expect(openRow()).toBeNull();
    await roundTrip();
    expect(page.container.querySelector("[data-priority]")).not.toBeNull();
    expect(openRow()).toBeNull();
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a link that names a row wins, and stale memory opens nothing", async () => {
  const link = await mountAt("/priorities?open=pri-1");
  try {
    expect(link.openRow()).toBe("pri-1");
    await link.roundTrip();
    expect(link.openRow()).toBe("pri-1");
  } finally {
    await link.page.unmount();
  }
  expect(Object.keys(remembered())).toEqual([`team:${TEAM_ID}`]);
  useInboxStore.getState().updateClientUI({ priorities_open: { ...remembered(), [`team:${TEAM_ID}`]: "pri-gone" } } as any);
  const stale = await mountAt("/priorities");
  try {
    expect(describeFailures(stale.page)).toBe("");
    expect(stale.page.container.querySelector("[data-priority]")).not.toBeNull();
    expect(stale.openRow()).toBeNull();
  } finally {
    await stale.page.unmount();
  }
}, 60_000);
