// The Activity page mounted for real (jsdom, the real store, the real page
// file) on a feed of several people across three days: the Now strip, days
// grouped by person, one line a session, the outcome chips, a row that opens
// into its details, and the Needs someone group with its actions and its
// filter. Every style draws this page (the old feed, components/ActivityFeed,
// is gone from it): Modern in its page bar, Classic and Minimal with their own
// header at the top of the column and their own shapes on every piece. A
// liveness heartbeat re-renders nothing.
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
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
const { ActivityPage } = await import("./ActivityPage");

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

type Style = "modern" | "classic" | "minimal";
const style = (visualStyle: Style) => ({ theme: "light", toggleTheme: () => {}, visualStyle, setVisualStyle: () => {} }) as any;
const where = { url: "" };
function Probe() {
  const loc = useLocation();
  where.url = loc.pathname + loc.search;
  return null;
}

async function mount(visualStyle: Style, onCommit?: () => void, at: { path: string; node: ReactNode } = { path: "/team/activity", node: <TeamActivityPage /> }) {
  seed();
  // The root class the ThemeProvider sets, for the code that reads it outside React.
  const html = document.documentElement.classList;
  html.toggle("modern-style", visualStyle === "modern");
  html.toggle("minimal-style", visualStyle === "minimal");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const page = (
    <ThemeContext.Provider value={style(visualStyle)}>
      <MemoryRouter initialEntries={[at.path]}>
        <Probe />
        {at.node}
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

// Classes that only resolve under .modern-style (the primitive tokens): one
// left un-prefixed would draw nothing outside Modern (a square corner, no
// height, no motion).
const MODERN_ONLY = /^(?:rounded(?:-[trbl]{1,2})?-(?:control|card|dialog)|(?:h|w|size|min-h|min-w|max-h)-control-(?:sm|md|lg)|shadow-(?:popover|dialog|toast)|duration-(?:press|pop)|ease-ui)$/;
function unprefixedModernTokens(root: Element): string[] {
  const out = new Set<string>();
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const cls of (node.getAttribute("class") ?? "").split(/\s+/)) {
      if (!cls || cls.startsWith("modern:")) continue;
      const base = cls.split(":").pop()!;
      if (MODERN_ONLY.test(base)) out.add(`${node.tagName.toLowerCase()} ${cls}`);
    }
  }
  return [...out];
}

describe.each(["classic", "minimal"] as const)("Activity in %s", (visualStyle) => {
  test("the new page, under the style's own header: title, tabs, Charts, then the filters", async () => {
    const { el, unmount } = await mount(visualStyle);
    try {
      // Not the old feed, and not Modern's page bar.
      expect(el.querySelector("[data-flip-key]")).toBeNull();
      expect(el.querySelector("[data-cc-page-head]")).toBeNull();
      expect(el.querySelector("[data-activity-page='activity']")).toBeTruthy();

      const head = el.querySelector("[data-activity-head]")!;
      expect(head).toBeTruthy();
      // Named as the sidebar names the page in these styles.
      expect(head.querySelector("h1")?.textContent).toBe("Feed");
      const tabs = q(head, "button[aria-pressed]").filter((b) => b.textContent === "Activity" || b.textContent === "Messages");
      expect(tabs.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Activity", "true"], ["Messages", "false"]]);
      // The boxed toggle Classic pages use, not Modern's tray.
      expect(tabs[0].parentElement!.className).toContain("rounded-md border");
      expect(head.querySelector("[data-activity-charts]")?.getAttribute("href")).toBe("/team/charts");
      expect(head.querySelector("[data-activity-filters]")).toBeTruthy();
      expect(head.querySelector("[data-activity-needs-toggle]")?.className).toContain("h-7");

      // The page's pieces are all here.
      expect(el.querySelector("[data-activity-now]")).toBeTruthy();
      expect(el.querySelector("[data-activity-summary]")).toBeTruthy();
      expect(q(el, "[data-activity-needs] [data-activity-row]")).toHaveLength(2);
      expect(q(el, "[data-activity-day]")).toHaveLength(3);

      // Nothing on the page leans on a token only Modern defines.
      expect(unprefixedModernTokens(el)).toEqual([]);

      // The Messages tab is the message feed's address.
      await click(tabs[1]);
      expect(where.url).toBe("/feed");
    } finally { await unmount(); }
  }, 30_000);

  test("a session is one 36px line on Classic's corners, with room for the status word and the clock in mono", async () => {
    const { el, unmount } = await mount(visualStyle);
    try {
      const row = el.querySelector(`[data-activity-days] [data-activity-row='${S.samDone}']`)!;
      const line = row.querySelector(":scope > div")!;
      expect(row.querySelectorAll(":scope > div")).toHaveLength(1);
      const cls = line.className.split(/\s+/);
      expect(cls).toContain("h-9");
      expect(cls).toContain("rounded-md");
      expect(cls).toContain("modern:rounded-control");
      expect(cls).not.toContain("rounded-control");
      // "Needs you" in mono needs 96px; Modern keeps its 88.
      const status = row.querySelector("[data-status-word]")!.parentElement!;
      expect(status.className).toContain("sm:w-24");
      expect(status.className).toContain("modern:sm:w-[5.5rem]");
      // "12:45 PM" in mono needs 64px.
      expect(row.querySelector("time")?.className).toContain("w-16");
      // The PR is a 20px chip on a 4px corner, its number in mono.
      const pr = row.querySelector("[data-activity-outcome='pr']")!;
      expect(pr.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-5", "gap-1", "rounded", "px-1.5", "text-meta", "font-medium"]));
      expect(pr.className.split(/\s+/)).not.toContain("px-2.5");
      expect(pr.querySelector(".font-mono")?.textContent).toBe("#42");

      // It opens into its details, on a Classic card.
      await click(row.querySelector("button[aria-expanded]"));
      const detail = row.querySelector("[data-activity-detail]")!;
      expect(detail.className).toContain("rounded-lg");
      expect(detail.textContent).toContain("Removed the retry wrapper");
    } finally { await unmount(); }
  }, 30_000);

  test("nothing to show, and a cold cache: the empty states and the skeleton on the style's own corners", async () => {
    let { el, unmount } = await mount(visualStyle, undefined, { path: "/team/activity?people=nobody", node: <TeamActivityPage /> });
    try {
      const nothing = el.querySelector("[data-empty-state='panel']")!;
      expect(nothing.textContent).toContain("Nothing matches");
      expect(nothing.querySelector("span")!.className.split(/\s+/)).toEqual(expect.arrayContaining(["rounded-lg", "modern:rounded-card"]));
      const now = el.querySelector("[data-activity-now] [data-empty-state='inline']")!;
      expect(now.textContent).toContain("No one is working now");
      expect(now.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-8", "rounded-lg", "modern:rounded-card"]));
      expect(unprefixedModernTokens(el)).toEqual([]);
    } finally { await unmount(); }

    ({ el, unmount } = await mount(visualStyle));
    try {
      // The team's feed not loaded yet, and nothing cached.
      await act(async () => { useInboxStore.setState({ feedConversations: { [`${TEAM}|`]: [] }, sessions: {} } as any); });
      const bars = q(el, "[data-skeleton]");
      expect(bars.length).toBe(8);
      expect(bars[0].className.split(/\s+/)).toEqual(expect.arrayContaining(["h-7", "rounded", "modern:rounded-control"]));
      expect(unprefixedModernTokens(el)).toEqual([]);
    } finally { await unmount(); }
  }, 30_000);

  test("/feed is the Messages tab of the same page", async () => {
    const { el, unmount } = await mount(visualStyle, undefined, { path: "/feed", node: <ActivityPage tab="messages" /> });
    try {
      expect(el.querySelector("[data-activity-page='messages']")).toBeTruthy();
      const head = el.querySelector("[data-activity-head]")!;
      expect(head.querySelector("h1")?.textContent).toBe("Feed");
      const pressed = q(head, "button[aria-pressed='true']").map((b) => b.textContent);
      // The tab, and whose messages: the viewer's own by default.
      expect(pressed).toEqual(["Messages", "Mine"]);
      expect(unprefixedModernTokens(el)).toEqual([]);
    } finally { await unmount(); }
  }, 30_000);
});
