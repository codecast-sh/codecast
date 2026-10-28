// Mounts the line app in jsdom (line-journeys.md LJ4, LJ5, LJ8.1): three
// pages in the nav, For you the landing page with the one count, pages on G
// then F / P / L and never on a digit, For you's rows opening the need in the
// reader as a history entry, a step named in the URL opening the shared
// drawer, and a `line` fence drawing a live step card, or saying plainly that
// the viewer cannot open the project it names.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line?project=pr-1", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
// For you's list is the Decisions page's (a virtualized GenericListView): rows need a height to be drawn.
Object.defineProperties(dom.window.HTMLElement.prototype, {
  offsetHeight: { get() { return this.hasAttribute("data-index") ? 40 : 4000; } },
  offsetWidth: { get: () => 1200 },
});
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

let search = "";
const moves: string[] = [];
/** The moves that were history entries (router.push), the rest rewrote the current one. */
const pushed: string[] = [];
mock.module("../../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => { moves.push(to); pushed.push(to); }, replace: (to: string) => moves.push(to) }),
  usePathname: () => "/flows",
  useSearchParams: () => new URLSearchParams(search),
}));
mock.module("../../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));
// An open decision paints from its row at once, and its parts (the change's code, its page) ask the server for more.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useAction: () => async () => ({ ok: false }), useConvex: () => ({ query: async () => null, mutation: async () => null, action: async () => null }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { LineWorkspace } = await import("../LineWorkspace");
const { default: LineFence } = await import("../../widgets/LineFence");

const ME = "u1";
const WS = `user:${ME}`;
const now = Date.now();
const DAY = 86_400_000;
const project = { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: WS, line_profile: { finders: [], root: "/repo", default: false, changed_at: now - 1000 } };
const n = (node_id: string, i: number, status = "completed") => ({ node_id, status, started_at: now - 2 * DAY + i * 60_000, completed_at: now - 2 * DAY + i * 60_000 + 30_000 });
const nodes = [{ id: "ground", h: "aaaa1111" }, { id: "prove", h: "bbbb2222" }, { id: "decide", h: "cccc3333" }];
const run = (id: string, at: number, statuses: ReturnType<typeof n>[], status = "completed") => ({
  _id: id, status, task_id: "t1", workflow_slug: "line", workflow_name: "line", workspace: WS, project_id: "p1", graph_hash: "1111", graph_nodes: nodes,
  node_statuses: [n("start", 0), ...statuses], created_at: at, updated_at: at + 1000,
});

function seed() {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    // One team with Flows on: the personal workspace borrows it, and a line fence draws only where Flows is on.
    teams: [{ _id: "team1", name: "Team", features: { line: true } }], teamMembers: [], signals: {},
    projects: { p1: project },
    tasks: { t1: { _id: "t1", short_id: "ct-1", title: "Sidebar freezes on resume", status: "in_progress", workspace: WS, project_id: "p1", created_at: now - 3 * DAY, updated_at: now, cause: { signal_count: 2, first_seen: now - 3 * DAY, last_seen: now - DAY } } },
    workflowRuns: { a: run("a", now - 2 * DAY, [n("ground", 1), n("prove", 2), n("decide", 3)]) },
  } as any);
}

async function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, root };
}

beforeEach(() => { moves.length = 0; pushed.length = 0; seed(); });

const key = (k: string) => act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })); });

test("with no live flow the Flows stage is the library, and a flow the address names opens on its map", async () => {
  search = "";
  const lib = await mount(React.createElement(LineWorkspace));
  expect(lib.host.querySelector("[data-pipeline-stage='flows']")?.getAttribute("aria-current")).toBe("page");
  expect(lib.host.querySelector("[data-flows-home]")).not.toBeNull();
  await act(async () => { lib.root.unmount(); });
  search = "graph=line";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-pipeline-stage='flows']")?.getAttribute("aria-current")).toBe("page");
  expect(host.querySelector("[data-line-view='graph']")).not.toBeNull();
  expect(host.querySelector("[data-line-mode='map']")?.getAttribute("aria-selected")).toBe("true");
  await act(async () => { root.unmount(); });
}, 30_000);

test("the nav: For you first with its count, then the stages on a rail, the open one marked; G then a letter opens a stage, a digit never does", async () => {
  search = "view=flows";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000, question: "Ship it?", options: [{ label: "Ship" }, { label: "Drop" }] } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect([...host.querySelectorAll<HTMLElement>("[data-pipeline-stage]")].map((b) => b.dataset.pipelineStage)).toEqual(["decisions", "signals", "problems", "flows", "shipped"]);
  expect([...host.querySelectorAll<HTMLElement>("[data-pipeline-rail] [data-pipeline-stage]")].map((b) => b.dataset.pipelineStage)).toEqual(["signals", "problems", "flows", "shipped"]);
  // The library sits under Flows.
  expect(host.querySelector("[data-pipeline-stage='flows']")?.getAttribute("aria-current")).toBe("page");
  expect(host.querySelector("[data-flows-home]")).not.toBeNull();
  // For you counts what the viewer can answer now; no process picker, and the project filter only on Problems.
  expect(host.querySelector("[data-pipeline-stage='decisions'] .pn-label")?.textContent).toBe("For you");
  expect(host.querySelector("[data-pipeline-stage='decisions'] .pn-n")?.textContent).toBe("1");
  expect(host.querySelector("[data-line-view-tab]")).toBeNull();
  expect(host.querySelector("[data-line-graph-pick]")).toBeNull();
  expect(host.querySelector("[data-line-project-filter]")).toBeNull();
  // Digits belong to an open decision's answers: the shell moves on none of them.
  await key("2"); await key("3");
  expect(moves.filter((m) => m.includes("view="))).toEqual([]);
  await key("g"); await key("p");
  expect(pushed.at(-1)).toBe("/flows?view=problems");
  await key("g"); await key("s");
  expect(pushed.at(-1)).toBe("/flows?view=signals");
  // With no live flow, Flows' home is the library this page already shows: nowhere new to go.
  const before = pushed.length;
  await key("g"); await key("f");
  expect(pushed.length).toBe(before);
  await act(async () => { root.unmount(); });
}, 30_000);

test("keys pressed inside an open decision are the decision's: G then P moves nothing", async () => {
  search = "need=sd-9";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000, question: "Ship it?", options: [{ label: "Ship" }, { label: "Drop" }] } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  const inside = host.querySelector<HTMLElement>("[data-line-foryou-reader] [data-line-decision]")!;
  expect(inside).not.toBeNull();
  const press = (k: string) => act(async () => { inside.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })); });
  await press("g"); await press("p"); await press("j"); await press("k");
  expect(pushed).toEqual([]);
  expect((useInboxStore.getState() as any).sessionDecisions.d1.status).toBe("pending");
  await act(async () => { root.unmount(); });
}, 30_000);

test("Problems carries the project filter, and only Problems", async () => {
  search = "project=pr-1&view=problems";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-project-filter]")?.textContent).toBe("Codecast");
  expect(host.querySelector("[data-pipeline-stage='problems']")?.getAttribute("aria-current")).toBe("page");
  await act(async () => { root.unmount(); });
  search = "view=foryou";
  const other = await mount(React.createElement(LineWorkspace));
  expect(other.host.querySelector("[data-line-project-filter]")).toBeNull();
  await act(async () => { other.root.unmount(); });
}, 30_000);

test("Decisions lists the fix decision by what it asks, opens nothing by itself, and a row click is a history entry", async () => {
  search = "view=foryou";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000, question: "Ship the resume fix?", options: [{ label: "Ship" }, { label: "Drop" }] } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  const row = host.querySelector<HTMLElement>("[data-decision-row='sd-9']");
  expect(row?.textContent).toContain("Ship the resume fix?");
  expect(host.querySelector("[data-line-foryou-reader]")).toBeNull();
  expect(moves).toEqual([]);
  await act(async () => { (row!.closest("[data-list-row-state], [data-index] > div") as HTMLElement).click(); });
  expect(pushed).toEqual(["/flows?need=sd-9"]);
  await act(async () => { root.unmount(); });
  pushed.length = 0;
  search = "need=sd-9";
  const named = await mount(React.createElement(LineWorkspace));
  // Opened, the list sits beside the reader, the open row marked, and the reader is the decision itself.
  expect(named.host.querySelector("[data-decision-row='sd-9']")?.closest("[data-list-row-state]")?.getAttribute("data-list-row-state")).toBe("active");
  expect(named.host.querySelector("[data-line-foryou-reader] [data-line-decision]")).not.toBeNull();
  expect(pushed).toEqual([]);
  await act(async () => { named.root.unmount(); });
  moves.length = 0;
  search = "view=inbox&decision=sd-9";
  const again = await mount(React.createElement(LineWorkspace));
  expect(moves).toContain("/flows?need=sd-9");
  expect(pushed).toEqual([]);
  await act(async () => { again.root.unmount(); });
}, 30_000);

test("a line fence draws the live step, and an unreadable project says so", async () => {
  search = "";
  const { host, root } = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-1", step: "prove" }) }));
  const card = host.querySelector<HTMLElement>("[data-line-widget='step']");
  expect(card?.dataset.lineStep).toBe("prove");
  expect(card?.querySelector(".lw-obj-title")?.textContent).toBe("Prove");
  const open = card?.querySelector<HTMLAnchorElement>(".lw-obj-foot a");
  expect(open?.getAttribute("href")).toBe("/flows?project=pr-1&graph=line&step=prove");
  await act(async () => { root.unmount(); });

  const other = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-404", step: "prove" }) }));
  expect(other.host.querySelector("[data-line-fence-fallback]")?.textContent).toContain("not one you can open");
  await act(async () => { other.root.unmount(); });

  const bad = await mount(React.createElement(LineFence, { code: "{ not json" }));
  expect(bad.host.querySelector("[data-line-widget]")).toBeNull();
  expect(bad.host.textContent).toContain("not json");
  await act(async () => { bad.root.unmount(); });

  // With Flows off the block reads as its source.
  useInboxStore.setState({ teams: [{ _id: "team1", name: "Team", features: { line: false } }] } as any);
  const off = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-1", step: "prove" }) }));
  expect(off.host.querySelector("[data-line-widget]")).toBeNull();
  expect(off.host.textContent).toContain("\"widget\"");
  await act(async () => { off.root.unmount(); });
}, 30_000);

test("on the Map a station slides in as a drawer over the graph, Esc closes it; the Table's step stays a page", async () => {
  search = "project=pr-1&view=line&mode=map&graph=line&step=prove";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-drawer]")).not.toBeNull();
  // The graph stays drawn behind it.
  expect(host.querySelector("[data-line-view='graph']")).not.toBeNull();
  expect(host.querySelector(".lw-body")?.hasAttribute("data-drawer-open")).toBe(true);
  await key("Escape");
  expect(moves.at(-1)).toBe("/flows?project=pr-1&graph=line");
  await act(async () => { root.unmount(); });

  search = "project=pr-1&view=line&graph=line&step=prove";
  const table = await mount(React.createElement(LineWorkspace));
  expect(table.host.querySelector("[data-line-drawer]")).toBeNull();
  expect(table.host.querySelector("[data-line-view='graph']")).toBeNull();
  await act(async () => { table.root.unmount(); });
}, 30_000);

test("a review stage opens its drawer over Signals; nothing arriving is said plainly", async () => {
  useInboxStore.setState({ lineStages: { p1: {
    _id: "p1", project: "Codecast", sources: ["union-moments"], window: { moments: 3, capped: false }, days: 14, at: now,
    kinds: [{ kind: "call", source: "union-moments", extractor: null, counts: { waiting: 0, extracting: 0, ready: 3, failed: 0 }, total: 3, day: 0, week: 3, newest_at: now - 5 * DAY, newest_event_at: now - 8 * DAY, days: [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0], replayed: 3, gap_ms: null, versions: [], recent: [], failed: [] }],
    judges: [], retired: { week: 0, recent: [] }, grouping: { attach: 0.86, ask: 0.45, hits: 64, candidates: 5, cross_ask: 0.5, cross_candidates: 3, embedding_model: "e", attach_model: "m" },
  } } } as any);
  // An old link (view=line&mode=map&stage=…) reads as this address (lineWorkspaceUrl.test).
  search = "project=pr-1&view=signals&graph=line&stage=moments";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-drawer='Moments']")).not.toBeNull();
  expect(host.querySelector("[data-line-moments-quiet]")?.textContent).toContain("Nothing arriving");
  expect(host.querySelector("[data-pipeline-stage='signals']")?.getAttribute("aria-current")).toBe("page");
  // The drawer's head walks to another stage in place.
  await act(async () => { host.querySelector<HTMLElement>("[data-line-drawer-stage='grouping']")!.click(); });
  expect(moves.at(-1)).toBe("/flows?project=pr-1&view=signals&graph=line&stage=grouping");
  await key("Escape");
  expect(moves.at(-1)).toBe("/flows?project=pr-1&view=signals&graph=line");
  await act(async () => { root.unmount(); });
}, 30_000);
