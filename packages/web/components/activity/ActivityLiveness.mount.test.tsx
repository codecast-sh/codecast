// ct-101387: a teammate's row carries is_active as the server computed it when
// the feed query last ran. Convex re-runs a query only when its data changes,
// and the client keeps the row, so a session that stopped hours ago still
// arrives with is_active: true. The Activity page must judge liveness against
// the clock it renders at, not trust that stored snapshot: a row whose last
// activity was 15 hours ago is not "working" and is not in the Now strip.
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
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
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
const { default: TeamActivityPage } = await import("../../app/team/activity/page");

const TEAM = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg";
const ME = "kd75bs3q5x39xnc7bsjv6wz8wd7z9zy7";
const SAM = "kd75bs3q5x39xnc7bsjv6wz8wd7zsam1";
const NOW = Date.now();
const id = (n: string) => `jx7${n.padEnd(29, "0")}`;
const LIVE = id("samlive");
const STALE = id("samstale");

const teamRow = (_id: string, at: number, extra: Record<string, unknown>) => ({
  _id, user_id: SAM, author_name: "Sam Park", author_avatar: null, updated_at: at, started_at: at - 40 * 60_000, duration_ms: 40 * 60_000,
  message_count: 12, is_own: false, visibility_mode: "full", project_path: "/Users/x/src/web", git_root: "/Users/x/src/web", agent_type: "claude_code", ...extra,
});
// Both rows carry the server's is_active: true. One was active two minutes
// ago; the other last moved 15 hours ago, the snapshot left from when the
// query ran while it was still running.
const FEED = [
  teamRow(LIVE, NOW - 2 * 60_000, { title: "Migrate billing tables", is_active: true }),
  teamRow(STALE, NOW - 15 * 3_600_000, { title: "Tune search ranking", is_active: true }),
];

async function mount() {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Alex Green" }, clientStateInitialized: true,
    clientState: { ui: { active_team_id: TEAM } }, teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    teamMembers: [ME, SAM].map((_id) => ({ _id, roster_team: TEAM })),
    feedConversations: { [`${TEAM}|`]: FEED }, feedHasMore: { [`${TEAM}|`]: false }, feedCursors: { [`${TEAM}|`]: null },
    sessions: {}, externalEvents: {}, tasks: {}, sessionDecisions: {}, tabs: [], activeTabId: null,
  } as any);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(
    <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as any}>
      <MemoryRouter initialEntries={["/team/activity"]}><TeamActivityPage /></MemoryRouter>
    </ThemeContext.Provider>,
  ));
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

describe("Activity liveness of a teammate's session (ct-101387)", () => {
  test("a row last active 15 hours ago is not working, whatever is_active it was stored with", async () => {
    const { el, unmount } = await mount();
    try {
      // Guard: the row active two minutes ago still reads as live.
      expect(el.querySelector(`[data-activity-row='${LIVE}']`)?.getAttribute("data-status")).toBe("working");
      expect(el.querySelector(`[data-activity-now] [data-now-session='${LIVE}']`)).toBeTruthy();
      // The miss: the stale snapshot is drawn as live.
      expect(el.querySelector(`[data-activity-row='${STALE}']`)?.getAttribute("data-status")).not.toBe("working");
      expect(el.querySelector(`[data-activity-now] [data-now-session='${STALE}']`)).toBeNull();
    } finally { await unmount(); }
  }, 30_000);
});
