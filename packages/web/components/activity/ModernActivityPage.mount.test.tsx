// The Activity page mounted for real (jsdom, the real store, the real page
// file) on a feed of several people across three days. In Modern it is the
// new page: the Now strip, days grouped by person, one line a session, the
// outcome chips, a row that opens into its details, and the Needs someone
// group with its actions and its filter. In Classic the same page file still
// draws the old feed. A liveness heartbeat re-renders nothing.
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html class=\"modern-style\"><body></body></html>", { url: "https://app.test/team/activity", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
  SVGElement: dom.window.SVGElement, Element: dom.window.Element, Node: dom.window.Node, DocumentFragment: dom.window.DocumentFragment,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent, PointerEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent, FocusEvent: dom.window.FocusEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  indexedDB: new IDBFactory(), IDBKeyRange,
});
afterAll(() => { closeDomWindow(dom); restore(); });

const convexReact = { ...(await import("convex/react")) };
const client = { query: async () => ({ conversations: [], nextCursor: null }), mutation: async () => null };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useConvex: () => client, useMutation: () => async () => null }));
const shell = { ...(await import("../DashboardLayout")) };
mock.module("../DashboardLayout", () => ({ ...shell, DashboardLayout: ({ children }: { children: unknown }) => children }));

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const cache = await import("../../store/idbCache");
let hydrated!: () => void;
const hydration = new Promise<void>((resolve) => { hydrated = resolve; });
const setHydrating = cache.setHydrating;
const hydrationSpy = spyOn(cache, "setHydrating").mockImplementation((value) => {
  setHydrating(value);
  if (!value) hydrated();
});
const { useInboxStore } = await import("../../store/inboxStore");
await hydration;
hydrationSpy.mockRestore();
const { ThemeContext } = await import("../ThemeProvider");
const { settingsDataKey } = await import("../../lib/settingsData");
const { default: TeamActivityPage } = await import("../../app/team/activity/page");

const TEAM = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg";
const ME = "kd75bs3q5x39xnc7bsjv6wz8wd7z9zy7";
const SAM = "kd75bs3q5x39xnc7bsjv6wz8wd7zsam1";
const ANA = "kd75bs3q5x39xnc7bsjv6wz8wd7zana1";
const ROSTER = settingsDataKey("teamMembers", ME, TEAM)!;
const NOW = Date.now();
const startOfToday = new Date(NOW); startOfToday.setHours(0, 0, 0, 0);
const today = (minutesAgo: number) => Math.max(startOfToday.getTime() + 60_000, NOW - minutesAgo * 60_000);
const YESTERDAY = startOfToday.getTime() - 3 * 3_600_000;
const TWO_DAYS = startOfToday.getTime() - 27 * 3_600_000;

const id = (n: string) => `jx7${n.padEnd(29, "0")}`;
const S = { samLive: id("samlive"), samDone: id("samdone"), samOld: id("samold"), anaAsk: id("anaask"), anaDoc: id("anadoc"), meErr: id("meerr"), meLive: id("melive") };

const teamRow = (_id: string, user_id: string, author_name: string, at: number, extra: Record<string, unknown> = {}) => ({
  _id, user_id, author_name, author_avatar: null, title: "", updated_at: at, started_at: at - 40 * 60_000, duration_ms: 40 * 60_000,
  message_count: 12, is_active: false, is_own: false, visibility_mode: "full", project_path: "/Users/x/src/web", git_root: "/Users/x/src/web", agent_type: "claude_code", ...extra,
});
const FEED = [
  teamRow(S.samLive, SAM, "Sam Park", today(2), { title: "Migrate billing tables", subtitle: "Backfilling invoices in batches", is_active: true }),
  teamRow(S.samDone, SAM, "Sam Park", today(120), { title: "Fix flaky checkout test", subtitle: "- Pinned the clock in checkout specs\n- Removed the retry wrapper" }),
  teamRow(S.anaAsk, ANA, "Ana Ruiz", today(30), { title: "Choose cache backend", subtitle: "Compared Redis and Memcached" }),
  teamRow(S.anaDoc, ANA, "Ana Ruiz", YESTERDAY, { title: "Write onboarding doc", subtitle: "Drafted the first-day guide", project_path: "/Users/x/src/docs", git_root: "/Users/x/src/docs" }),
  teamRow(S.samOld, SAM, "Sam Park", TWO_DAYS, {
    title: "Tune search ranking", subtitle: "Boosted exact title matches",
    first_user_message: "Make search results better for short queries",
    message_alternates: [{ role: "assistant", content: "Short queries now weigh titles twice" }],
  }),
];
const own = (_id: string, at: number, extra: Record<string, unknown>) => ({
  _id, session_id: `s-${_id}`, user_id: ME, team_id: TEAM, is_private: false, agent_type: "claude_code", message_count: 6,
  updated_at: at, started_at: at - 20 * 60_000, agent_status_updated_at: at, last_heartbeat: NOW - 1_000, is_connected: true,
  has_pending: false, is_idle: true, agent_status: "idle", project_path: "/Users/x/src/web", git_root: "/Users/x/src/web", ...extra,
});
const SESSIONS = {
  [S.meErr]: own(S.meErr, today(10), { title: "Deploy preview env", idle_summary: "Preview deploy for the billing branch", session_error: "Build failed: exit 1" }),
  [S.meLive]: own(S.meLive, today(1), { title: "Refactor auth middleware", idle_summary: "Splitting the session check", agent_status: "working", is_idle: false }),
};
const EVENTS = {
  e1: { _id: "e1", team_id: TEAM, repository: "acme/web", kind: "pr_opened", pr_number: 42, title: "Fix flaky checkout test", conversation_id: S.samDone, actor_user_id: SAM, created_at: today(110) },
  e2: { _id: "e2", team_id: TEAM, repository: "acme/web", kind: "pr_merged", pr_number: 42, title: "Fix flaky checkout test", conversation_id: S.samDone, actor_user_id: SAM, created_at: today(100) },
  e3: { _id: "e3", team_id: TEAM, repository: "acme/web", kind: "commit", sha: "abc1234", conversation_id: S.samDone, actor_user_id: SAM, created_at: today(115) },
  e4: { _id: "e4", team_id: TEAM, repository: "acme/web", kind: "commit", sha: "def5678", conversation_id: S.samDone, actor_user_id: SAM, created_at: today(114) },
  // A PR Ana merged with no session in the feed: it files under her.
  e5: { _id: "e5", team_id: TEAM, repository: "acme/api", kind: "pr_merged", pr_number: 77, title: "Rate limit the export endpoint", actor_user_id: ANA, actor_login: "ana", created_at: today(45) },
};
const TASKS = {
  t1: { _id: "t1", short_id: "ct-101", title: "Onboarding doc", status: "done", closed_at: YESTERDAY, updated_at: YESTERDAY, created_at: YESTERDAY - 1, conversation_ids: [S.anaDoc], team_id: TEAM, workspace: `team:${TEAM}`, task_type: "task", priority: "medium", source: "human" },
};
const DECISIONS = {
  d1: { _id: "d1", short_id: "sd-7", conversation_id: S.anaAsk, session_id: "s-ana", question: "Redis or Memcached?", options: [], blocking: true, status: "pending", asked_user_ids: [ME], created_at: today(25) },
};

function seed() {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Alex Green" }, clientStateInitialized: true,
    clientState: { ui: { active_team_id: TEAM } }, teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    settingsData: { [ROSTER]: { _id: ROSTER, value: [{ _id: ME }, { _id: SAM }, { _id: ANA }] } },
    feedConversations: { [`${TEAM}|`]: FEED }, feedHasMore: { [`${TEAM}|`]: false }, feedCursors: { [`${TEAM}|`]: null },
    sessions: SESSIONS, externalEvents: EVENTS, tasks: TASKS, sessionDecisions: DECISIONS, tabs: [], activeTabId: null,
  } as any);
}

const style = (visualStyle: "modern" | "classic") => ({ theme: "light", toggleTheme: () => {}, visualStyle, setVisualStyle: () => {} }) as any;
const where = { url: "" };
function Probe() {
  const loc = useLocation();
  where.url = loc.pathname + loc.search;
  return null;
}

async function mount(visualStyle: "modern" | "classic", onCommit?: () => void) {
  seed();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const page = (
    <ThemeContext.Provider value={style(visualStyle)}>
      <MemoryRouter initialEntries={["/team/activity"]}>
        <Probe />
        <TeamActivityPage />
      </MemoryRouter>
    </ThemeContext.Provider>
  );
  await act(async () => root.render(onCommit ? <Profiler id="page" onRender={onCommit}>{page}</Profiler> : page));
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

const q = (el: Element, sel: string) => [...el.querySelectorAll(sel)];
const click = async (node: Element | undefined | null) => {
  expect(node).toBeTruthy();
  await act(async () => { (node as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
};

describe("Activity in Modern", () => {
  test("Now: each live person with what their live sessions are doing", async () => {
    const { el, unmount } = await mount("modern");
    try {
      expect(el.querySelector("[data-activity-page='activity']")).toBeTruthy();
      const people = q(el, "[data-activity-now] [data-now-person]").map((n) => n.getAttribute("data-now-person"));
      expect(people.sort()).toEqual([ME, SAM].sort());
      const now = el.querySelector("[data-activity-now]")!;
      expect(now.textContent).toContain("Backfilling invoices in batches");
      expect(now.querySelector(`[data-now-session='${S.meLive}']`)?.getAttribute("href")).toBe(`/conversation/${S.meLive}`);
      expect(now.textContent).not.toContain("Choose cache backend");
    } finally { await unmount(); }
  }, 30_000);

  test("days, then people; one line a session; outcome chips lead each group", async () => {
    const { el, unmount } = await mount("modern");
    try {
      const days = q(el, "[data-activity-day]");
      expect(days).toHaveLength(3);
      const todayGroups = q(days[0], "[data-activity-group]").map((g) => g.getAttribute("data-activity-group"));
      expect(todayGroups.sort()).toEqual([`p:${ANA}`, `p:${ME}`, `p:${SAM}`].sort());

      // One line each: no details open, and the summary's second bullet and the
      // first prompt are not on the page until a row opens.
      const rows = q(el, "[data-activity-days] [data-activity-row]");
      expect(rows.length).toBe(7);
      for (const r of rows) {
        expect(r.querySelectorAll(":scope > div")).toHaveLength(1);
        expect(r.querySelector(":scope > div")!.className).toContain("h-9");
      }
      expect(el.querySelector("[data-activity-detail]")).toBeNull();
      expect(el.textContent).toContain("Pinned the clock in checkout specs");
      expect(el.textContent).not.toContain("Removed the retry wrapper");
      expect(el.textContent).not.toContain("Make search results better for short queries");

      // Sam's merged PR, in its state's colour, opening the PR; his commits counted on the row.
      const samGroup = days[0].querySelector(`[data-activity-group='p:${SAM}']`)!;
      const pr = samGroup.querySelector("[data-activity-outcomes] [data-activity-outcome='pr']")!;
      expect(pr.getAttribute("data-pr-state")).toBe("merged");
      expect(pr.getAttribute("href")).toBe("/pr/acme/web/42");
      expect(pr.className).toContain("text-sol-violet");
      const samDone = samGroup.querySelector(`[data-activity-row='${S.samDone}']`)!;
      expect(samDone.querySelector("[data-activity-count='commits']")?.textContent).toBe("2");
      // Ana's merge with no session files under her, and her done task under yesterday.
      const anaGroup = days[0].querySelector(`[data-activity-group='p:${ANA}']`)!;
      expect(q(anaGroup, "[data-activity-outcome='pr']").map((n) => n.getAttribute("href"))).toContain("/pr/acme/api/77");
      const task = days[1].querySelector("[data-activity-outcome='task']")!;
      expect(task.getAttribute("href")).toBe("/tasks/ct-101");
      expect(task.getAttribute("data-task-done")).toBe("true");

      // The summary counts the period.
      expect(el.querySelector("[data-activity-summary] [data-stat='prs']")?.textContent).toContain("2");
      expect(el.querySelector("[data-activity-summary] [data-stat='tasks']")?.textContent).toContain("1");
    } finally { await unmount(); }
  }, 30_000);

  test("a row opens into its prompts and details, and closes again", async () => {
    const { el, unmount } = await mount("modern");
    try {
      const row = el.querySelector(`[data-activity-days] [data-activity-row='${S.samOld}']`)!;
      const chevron = row.querySelector("button[aria-expanded]")!;
      expect(chevron.getAttribute("aria-expanded")).toBe("false");
      await click(chevron);
      const detail = row.querySelector("[data-activity-detail]")!;
      expect(detail).toBeTruthy();
      expect(chevron.getAttribute("aria-expanded")).toBe("true");
      expect(detail.textContent).toContain("Make search results better for short queries");
      expect(detail.textContent).toContain("Short queries now weigh titles twice");
      expect(detail.querySelector("[data-activity-action='open']")?.getAttribute("href")).toBe(`/conversation/${S.samOld}`);
      await click(chevron);
      expect(row.querySelector("[data-activity-detail]")).toBeNull();
    } finally { await unmount(); }
  }, 30_000);

  test("Needs someone: pinned with its actions, and a filter in the address", async () => {
    const restarts: string[] = [];
    const { el, unmount } = await mount("modern");
    useInboxStore.setState({ restartSession: async (_rid: string, convId: string) => { restarts.push(convId); return {}; } } as any);
    try {
      const needs = el.querySelector("[data-activity-needs]")!;
      const ids = q(needs, "[data-activity-row]").map((r) => r.getAttribute("data-activity-row"));
      expect(ids).toEqual([S.meErr, S.anaAsk]);
      const mine = needs.querySelector(`[data-activity-row='${S.meErr}']`)!;
      expect(mine.getAttribute("data-status")).toBe("error");
      await click(mine.querySelector("[data-activity-action='restart']"));
      expect(restarts).toEqual([S.meErr]);
      const ask = needs.querySelector(`[data-activity-row='${S.anaAsk}']`)!;
      expect(ask.querySelector("[data-activity-action='answer']")?.getAttribute("href")).toBe("/decisions/sd-7");

      const toggle = el.querySelector("[data-activity-needs-toggle]")!;
      expect(toggle.textContent).toContain("2");
      await click(toggle);
      expect(where.url).toBe("/team/activity?needs=1");
      expect(el.querySelector("[data-activity-days]")).toBeNull();
      expect(el.querySelector("[data-activity-now]")).toBeNull();
      expect(q(el, "[data-activity-needs] [data-activity-row]")).toHaveLength(2);
    } finally { await unmount(); }
  }, 30_000);

  test("a face filters to that person, in the address", async () => {
    const { el, unmount } = await mount("modern");
    try {
      await click(el.querySelector(`[data-activity-face='${SAM}']`));
      expect(where.url).toBe(`/team/activity?people=${SAM}`);
      const actors = new Set(q(el, "[data-activity-days] [data-activity-group]").map((g) => g.getAttribute("data-activity-group")));
      expect([...actors]).toEqual([`p:${SAM}`]);
      expect(el.querySelector(`[data-activity-face='${SAM}']`)?.getAttribute("aria-pressed")).toBe("true");
    } finally { await unmount(); }
  }, 30_000);

  test("grouping by project is remembered for the person and named in the address", async () => {
    const { el, unmount } = await mount("modern");
    try {
      const projects = [...el.querySelectorAll("[data-activity-filters] button[aria-pressed]")].find((b) => b.textContent === "Projects");
      await click(projects);
      expect(where.url).toBe("/team/activity?group=project");
      expect((useInboxStore.getState().clientState.ui as any)?.activity_view?.group).toBe("project");
      const groups = q(el.querySelector("[data-activity-day]")!, "[data-activity-group]").map((g) => g.getAttribute("data-activity-group"));
      expect(groups.sort()).toEqual(["r:api", "r:web"]);
      // Grouped by project, each row names whose it is.
      expect(el.querySelector(`[data-activity-row='${S.samDone}'] [title='Sam Park']`)).toBeTruthy();
    } finally { await unmount(); }
  }, 30_000);

  test("a liveness heartbeat on a session re-renders nothing", async () => {
    let commits = 0;
    const { el, unmount } = await mount("modern", () => { commits += 1; });
    try {
      let mutations = 0;
      const mo = new dom.window.MutationObserver((records) => { mutations += records.length; });
      mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
      commits = 0;
      await act(async () => {
        const cur = useInboxStore.getState().sessions[S.meLive] as any;
        useInboxStore.getState().syncTable("sessions", [{ ...cur, last_heartbeat: Date.now() + 5 }] as any, { isDelta: true } as any);
      });
      mutations += mo.takeRecords().length;
      mo.disconnect();
      expect(commits).toBe(0);
      expect(mutations).toBe(0);
    } finally { await unmount(); }
  }, 30_000);
});

describe("Activity in Classic", () => {
  test("the same page file still draws the old feed", async () => {
    const { el, unmount } = await mount("classic");
    try {
      expect(el.querySelector("[data-activity-page]")).toBeNull();
      expect(el.querySelector("[data-activity-row]")).toBeNull();
      // FeedCard rows and the rollup's Charts link.
      expect(el.querySelector(`[data-flip-key='${S.samDone}']`)).toBeTruthy();
      expect(el.textContent).toContain("Fix flaky checkout test");
      expect(q(el, "a").some((a) => a.getAttribute("href") === "/team/charts")).toBe(true);
    } finally { await unmount(); }
  }, 30_000);
});
