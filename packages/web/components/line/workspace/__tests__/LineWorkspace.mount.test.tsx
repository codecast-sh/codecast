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
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams(search),
}));
mock.module("../../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));

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
    teams: [], teamMembers: [], signals: {},
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

test("the app: three pages, For you the home and the only count; G then a letter switches page, a digit never does", async () => {
  search = "";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000 } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect([...host.querySelectorAll<HTMLElement>("[data-line-view-tab]")].map((b) => b.dataset.lineViewTab)).toEqual(["foryou", "problems", "line"]);
  expect(host.querySelector("[data-line-view-tab='foryou']")?.getAttribute("aria-current")).toBe("page");
  // One number, on the For you entry; no header chip, no auto-start switch, no picker or filter over every process.
  expect([...host.querySelectorAll("[data-line-waits]")].map((e) => e.getAttribute("data-line-waits"))).toEqual(["1"]);
  expect(host.querySelector("[data-line-start-chip]")).toBeNull();
  expect(host.querySelector("[data-line-graph-pick]")).toBeNull();
  expect(host.querySelector("[data-line-project-filter]")).toBeNull();
  // Digits belong to an open decision's answers: the shell moves on none of them.
  await key("2"); await key("3");
  expect(moves.filter((m) => m.includes("view="))).toEqual([]);
  await key("g"); await key("p");
  expect(pushed.at(-1)).toBe("/line?view=problems");
  await key("g"); await key("l");
  expect(pushed.at(-1)).toBe("/line?view=line");
  await act(async () => { root.unmount(); });
}, 30_000);

test("keys pressed inside an open decision are the decision's: G then P moves nothing", async () => {
  search = "need=sd-9";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000 } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  const inside = host.querySelector<HTMLElement>("[data-line-decision='sd-9']")!;
  expect(inside).not.toBeNull();
  const press = (k: string) => act(async () => { inside.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })); });
  await press("g"); await press("p"); await press("j"); await press("k");
  expect(pushed).toEqual([]);
  expect((useInboxStore.getState() as any).sessionDecisions.d1.status).toBe("pending");
  await act(async () => { root.unmount(); });
}, 30_000);

test("Problems carries the process picker and the project filter, with no for-you numbers on them", async () => {
  search = "project=pr-1&view=problems";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-project-filter]")?.textContent).toBe("Codecast");
  expect(host.querySelector("[data-line-graph-pick='line']")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector(".lw-pick-you")).toBeNull();
  await act(async () => { root.unmount(); });
}, 30_000);

test("For you lists the fix decision by what it asks, opens it in the reader on arrival, and a row click is a history entry", async () => {
  search = "";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000, question: "Ship the resume fix?" } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  const row = host.querySelector<HTMLElement>("[data-line-need-row='decision']");
  expect(row?.dataset.lineNeedRef).toBe("sd-9");
  // No chips, buttons or ids on a row: what is asked, then where and how long.
  expect(row?.querySelector("button, [data-line-inbox-decide]")).toBeNull();
  expect(row?.getAttribute("aria-current")).toBe("true");
  expect(host.querySelector("[data-line-foryou-reader]")?.getAttribute("data-line-foryou-reader")).toBe("decision");
  expect(host.querySelector("[data-line-decision='sd-9']")).not.toBeNull();
  // The address names what is drawn, in place: Back is not spent on it, and a click on the open row moves nothing.
  expect(moves).toEqual(["/line?need=sd-9"]);
  await act(async () => { root.unmount(); });
  search = "need=sd-9";
  const named = await mount(React.createElement(LineWorkspace));
  await act(async () => { named.host.querySelector<HTMLElement>("[data-line-need-row='decision']")!.click(); });
  expect(pushed).toEqual([]);
  await act(async () => { named.root.unmount(); });
  moves.length = 0;
  search = "view=inbox&decision=sd-9";
  const again = await mount(React.createElement(LineWorkspace));
  expect(moves).toContain("/line?need=sd-9");
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
  expect(open?.getAttribute("href")).toBe("/line?project=pr-1&view=line&graph=line&step=prove");
  await act(async () => { root.unmount(); });

  const other = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-404", step: "prove" }) }));
  expect(other.host.querySelector("[data-line-fence-fallback]")?.textContent).toContain("not one you can open");
  await act(async () => { other.root.unmount(); });

  const bad = await mount(React.createElement(LineFence, { code: "{ not json" }));
  expect(bad.host.querySelector("[data-line-widget]")).toBeNull();
  expect(bad.host.textContent).toContain("not json");
  await act(async () => { bad.root.unmount(); });
}, 30_000);
