// ct-102148: the Activity page's Mine view counts "Needs someone" over the
// viewer's own sessions. That count has to be the inbox's own verdict (the
// rows the inbox files under Questions or Needs input), not every row the rail
// would place on its own: a worker whose lead orchestrator is still working
// rides its lead and waits on nobody, and a session that finished is done.
// When each own row is placed alone (railRowPlacement), every settled row
// reads as waiting, and Needs someone can equal the total session count.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/activity", pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
  indexedDB: new IDBFactory(), IDBKeyRange,
});
afterAll(() => { closeDomWindow(dom); restore(); });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const cache = await import("../../store/idbCache");
let hydrated!: () => void;
const hydration = new Promise<void>((resolve) => { hydrated = resolve; });
const setHydrating = cache.setHydrating;
const hydrationSpy = spyOn(cache, "setHydrating").mockImplementation((value) => {
  setHydrating(value);
  if (!value) hydrated();
});
const store = await import("../../store/inboxStore");
const { useInboxStore, placeInboxRows } = store;
await hydration;
hydrationSpy.mockRestore();
const { useActivityItems } = await import("./useActivityItems");
const { needsList } = await import("./activityModel");
type ActivityItem = import("./activityModel").ActivityItem;
type InboxSession = import("../../store/inboxStore").InboxSession;

const NOW = Date.now();
const ME = "kd75bs3q5x39xnc7bsjv6wz8wd7z9zy7";
const id = (n: string) => `jx7${n.padEnd(29, "0")}`;
const LEAD = id("lead");
const WORKER = id("worker");
const DONE = id("done");
const ASKING = id("asking");

const own = (_id: string, extra: Partial<InboxSession> & Record<string, unknown> = {}) => ({
  _id, session_id: `s-${_id}`, user_id: ME, agent_type: "claude_code", status: "active", message_count: 8,
  updated_at: NOW - 10 * 60_000, started_at: NOW - 60 * 60_000, agent_status_updated_at: NOW - 10 * 60_000,
  last_heartbeat: NOW - 1_000, is_connected: true, has_pending: false, is_idle: true, agent_status: "idle",
  title: `t-${_id.slice(3, 9)}`, project_path: "/Users/x/src/web", git_root: "/Users/x/src/web", ...extra,
}) as unknown as InboxSession;

const SESSIONS: Record<string, InboxSession> = {
  // An orchestrator still at work, and a worker it spawned in a worktree that
  // settled its turn: the worker rides its lead, nothing waits on the person.
  [LEAD]: own(LEAD, { title: "Orchestrate the billing plan", agent_status: "working", is_idle: false, updated_at: NOW - 30_000 }),
  [WORKER]: own(WORKER, { title: "Worker: migrate invoices", is_subagent: true, parent_conversation_id: LEAD, project_path: "/Users/x/src/web/.codecast/worktrees/w1" }),
  // A session that delivered and said so.
  [DONE]: own(DONE, { title: "Fix flaky checkout test", agent_status: "done", thread_state: "Shipped: checkout test fixed", thread_state_status: "done", thread_state_at: NOW - 10 * 60_000 }),
  // One that really asks the person something.
  [ASKING]: own(ASKING, { title: "Choose cache backend", awaiting_input: true, agent_status: "permission_blocked" }),
};

const feedRow = (s: InboxSession) => ({
  _id: s._id, user_id: ME, title: s.title, updated_at: s.updated_at, started_at: s.started_at, message_count: s.message_count,
  is_active: s.agent_status === "working", is_own: true, visibility_mode: "full", project_path: s.project_path, git_root: s.git_root, agent_type: "claude_code",
});
const ROWS = Object.values(SESSIONS).map(feedRow) as any[];

let items: ActivityItem[] = [];
function Probe() {
  items = useActivityItems(ROWS, { teamId: null, teamMode: false }).items;
  return null;
}

async function mount() {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Alex Green" }, clientStateInitialized: true, clientState: { ui: {} },
    sessions: SESSIONS, externalEvents: {}, tasks: {}, sessionDecisions: {}, tabs: [], activeTabId: null,
  } as any);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<Probe />));
  return async () => { await act(async () => root.unmount()); el.remove(); };
}

// What the inbox itself files as waiting on the person, over the same rows.
function inboxNeeds(): Set<string> {
  const st = useInboxStore.getState() as any;
  const placed = placeInboxRows({ ...st, clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } } }, { scope: "mine", now: NOW });
  return new Set([...placed.questions, ...placed.needsInput].map((s) => String(s._id)));
}

describe("Activity Mine: Needs someone over the viewer's own sessions", () => {
  test("counts only what the inbox files as waiting on the person", async () => {
    const unmount = await mount();
    try {
      const byId = new Map(items.map((i) => [i.id, i]));
      const statuses = Object.fromEntries(items.map((i) => [i.title, `${i.status}${i.needs ? " (needs)" : ""}`]));
      const needs = new Set(needsList(items).map((i) => i.id));

      // The inbox's own verdict over these rows: the ask waits, the worker rides its working lead.
      const inbox = inboxNeeds();
      expect(inbox.has(ASKING)).toBe(true);
      expect(inbox.has(WORKER)).toBe(false);
      // The real ask still counts.
      expect(byId.get(ASKING)?.needs, JSON.stringify(statuses)).toBe(true);
      // A worker under a working lead, the working lead, and a delivered session wait on nobody.
      expect(byId.get(WORKER)?.needs, JSON.stringify(statuses)).toBe(false);
      expect(byId.get(LEAD)?.needs, JSON.stringify(statuses)).toBe(false);
      expect(byId.get(DONE)?.needs, JSON.stringify(statuses)).toBe(false);
      // The count is the inbox's Needs you rows, and below the total.
      expect([...needs].sort()).toEqual([...inboxNeeds()].filter((x) => byId.has(x)).sort());
      expect(needs.size).toBeLessThan(items.length);
    } finally { await unmount(); }
  }, 30_000);
});
