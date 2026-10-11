// Mounts the line app in jsdom (line-workspace.md LW1, LW3): the header's
// process picker and project filter, the nav's six views on their keys through
// the URL, the Inbox's rows, a step named in the URL opening the shared drawer,
// and a `line` fence drawing a live step card, or saying plainly that the
// viewer cannot open the project it names.
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
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

let search = "";
const moves: string[] = [];
mock.module("../../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => moves.push(to), replace: (to: string) => moves.push(to) }),
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

beforeEach(() => { moves.length = 0; seed(); });

test("the app: a process picker, the project filter, the nav's six views on keys 1 to 6, the Inbox first", async () => {
  search = "project=pr-1";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-project-filter]")?.textContent).toBe("Codecast");
  expect([...host.querySelectorAll<HTMLElement>("[data-line-view-tab]")].map((b) => b.dataset.lineViewTab)).toEqual(["inbox", "sources", "problems", "runs", "process", "chat"]);
  expect(host.querySelector("[data-line-view-tab='inbox']")?.getAttribute("aria-current")).toBe("page");
  expect(host.querySelector("[data-line-graph-pick='line']")?.getAttribute("aria-selected")).toBe("true");
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "2", bubbles: true })); });
  expect(moves.at(-1)).toBe("/line?project=pr-1&view=sources");
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "5", bubbles: true })); });
  expect(moves.at(-1)).toBe("/line?project=pr-1&view=process");
  await act(async () => { root.unmount(); });
}, 30_000);

test("the Inbox lists a card waiting on the viewer with its problem, and one action", async () => {
  search = "";
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, task_id: "t1", workflow_run_id: "a", created_at: now - 3_600_000 } } } as any);
  const { host, root } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-project-filter]")?.textContent).toBe("All projects");
  const row = host.querySelector<HTMLElement>("[data-line-inbox-row='decide']");
  expect(row?.querySelector(".lwi-title")?.textContent).toBe("Sidebar freezes on resume");
  expect(row?.querySelector(".lwi-ref")?.textContent).toBe("ct-1");
  expect(row?.querySelector("a.lw-act")?.getAttribute("href")).toBe("/decisions/sd-9");
  expect(host.querySelector("[data-line-waits]")?.getAttribute("data-line-waits")).toBe("1");
  await act(async () => { row!.querySelector<HTMLElement>(".lwi-main")!.click(); });
  expect(moves.at(-1)).toBe("/line?view=problems&case=t1");
  await act(async () => { root.unmount(); });
}, 30_000);

test("a step in the URL opens the drawer: its job, where it sends work, its tabs; Esc closes it", async () => {
  search = "project=pr-1&view=process&step=prove";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  const drawer = host.querySelector<HTMLElement>("[data-line-drawer]");
  expect(drawer?.dataset.lineDrawer).toBe("prove");
  expect(drawer?.hasAttribute("data-open")).toBe(true);
  expect(drawer?.querySelector("h2")?.textContent).toContain("Prove");
  expect(drawer?.querySelector(".lw-job")?.textContent?.length).toBeGreaterThan(5);
  expect([...drawer!.querySelectorAll("[role='tab']")].map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Prompt", "Runs", "Try", "Ask an agent"]);
  expect(host.querySelector(".lw-body")?.hasAttribute("data-drawer-open")).toBe(true);
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(moves.at(-1)).toBe("/line?project=pr-1&view=process");
  await act(async () => { root.unmount(); });
}, 30_000);

test("a step's Runs: one row per problem, with its source, what the step did and where it sent the run", async () => {
  useInboxStore.setState({ signals: { s1: { _id: "s1", short_id: "sg-1", source: "agentwatch", judge: "comms_judge", kind: "bug", title: "Rep skipped the fee talk", task_id: "t1", project_id: "p1", workspace: WS, observed_at: now - DAY, created_at: now - DAY } } } as any);
  search = "project=pr-1&view=process&step=prove&tab=decisions";
  const { host, root } = await mount(React.createElement(LineWorkspace));
  const drawer = host.querySelector<HTMLElement>("[data-line-drawer]")!;
  const group = drawer.querySelector<HTMLElement>(".sr-group");
  expect(group?.querySelector(".sr-title")?.textContent).toBe("Sidebar freezes on resume");
  expect(group?.querySelector(".sr-ref")?.textContent).toBe("ct-1");
  expect(group?.querySelector(".sr-src")?.textContent).toBe("AgentWatch · comms judge");
  expect(group?.querySelector(".sr-next")?.textContent).toBe("Decide");
  expect(drawer.textContent).not.toContain("Handed");
  expect([...group!.querySelectorAll(".lw-labeler-b")].map((b) => b.getAttribute("aria-label"))).toEqual(["Mark right", "Mark wrong"]);
  await act(async () => { group!.querySelector<HTMLElement>(".sr-line")!.click(); });
  expect(group!.querySelector(".sr-detail a.lw-act")?.textContent).toBe("Open the run");
  await act(async () => { root.unmount(); });
}, 30_000);

test("a line fence draws the live step, and an unreadable project says so", async () => {
  search = "";
  const { host, root } = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-1", step: "prove" }) }));
  const card = host.querySelector<HTMLElement>("[data-line-widget='step']");
  expect(card?.dataset.lineStep).toBe("prove");
  expect(card?.querySelector(".lw-obj-title")?.textContent).toBe("Prove");
  const open = card?.querySelector<HTMLAnchorElement>(".lw-obj-foot a");
  expect(open?.getAttribute("href")).toBe("/line?project=pr-1&graph=line&step=prove");
  await act(async () => { root.unmount(); });

  const other = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-404", step: "prove" }) }));
  expect(other.host.querySelector("[data-line-fence-fallback]")?.textContent).toContain("not one you can open");
  await act(async () => { other.root.unmount(); });

  const bad = await mount(React.createElement(LineFence, { code: "{ not json" }));
  expect(bad.host.querySelector("[data-line-widget]")).toBeNull();
  expect(bad.host.textContent).toContain("not json");
  await act(async () => { bad.root.unmount(); });
}, 30_000);
