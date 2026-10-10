// Mounts the line workspace in jsdom (line-workspace.md LW1, LW3): the
// header names the project, the five views switch by their keys through the
// URL, a step named in the URL opens the shared drawer on its job, prompt and
// decisions, and a `line` fence draws a live step card, or says plainly that
// the viewer cannot open the project it names.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line/pr-1", pretendToBeVisual: true });
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
  usePathname: () => "/line/pr-1",
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

test("the header names the project and the five views switch by their keys", async () => {
  search = "";
  const { host, root } = await mount(React.createElement(LineWorkspace, { projectId: "p1" }));
  expect(host.querySelector(".lw-title")?.textContent).toBe("Codecast");
  expect([...host.querySelectorAll<HTMLElement>("[data-line-view-tab]")].map((b) => b.dataset.lineViewTab)).toEqual(["graph", "notebook", "replay", "chat", "timeline"]);
  expect(host.querySelector("[data-line-view-tab='graph']")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("[data-line-view='graph']")).not.toBeNull();
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "2", bubbles: true })); });
  expect(moves.at(-1)).toBe("/line/pr-1?view=notebook");
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "5", bubbles: true })); });
  expect(moves.at(-1)).toBe("/line/pr-1?view=timeline");
  await act(async () => { root.unmount(); });
});

test("a step in the URL opens the drawer: its job, where it sends work, its tabs; Esc closes it", async () => {
  search = "step=prove";
  const { host, root } = await mount(React.createElement(LineWorkspace, { projectId: "p1" }));
  const drawer = host.querySelector<HTMLElement>("[data-line-drawer]");
  expect(drawer?.dataset.lineDrawer).toBe("prove");
  expect(drawer?.hasAttribute("data-open")).toBe(true);
  expect(drawer?.querySelector("h2")?.textContent).toContain("Prove");
  expect(drawer?.querySelector(".lw-job")?.textContent?.length).toBeGreaterThan(5);
  expect([...drawer!.querySelectorAll("[role='tab']")].map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Prompt", "Decisions"]);
  expect(host.querySelector(".lw-body")?.hasAttribute("data-drawer-open")).toBe(true);
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(moves.at(-1)).toBe("/line/pr-1");
  await act(async () => { root.unmount(); });
});

test("a line fence draws the live step, and an unreadable project says so", async () => {
  search = "";
  const { host, root } = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-1", step: "prove" }) }));
  const card = host.querySelector<HTMLElement>("[data-line-widget='step']");
  expect(card?.dataset.lineStep).toBe("prove");
  expect(card?.querySelector(".lw-obj-title")?.textContent).toBe("Prove");
  const open = card?.querySelector<HTMLAnchorElement>(".lw-obj-foot a");
  expect(open?.getAttribute("href")).toBe("/line/pr-1?graph=line&step=prove");
  await act(async () => { root.unmount(); });

  const other = await mount(React.createElement(LineFence, { code: JSON.stringify({ widget: "step", project: "pr-404", step: "prove" }) }));
  expect(other.host.querySelector("[data-line-fence-fallback]")?.textContent).toContain("not one you can open");
  await act(async () => { other.root.unmount(); });

  const bad = await mount(React.createElement(LineFence, { code: "{ not json" }));
  expect(bad.host.querySelector("[data-line-widget]")).toBeNull();
  expect(bad.host.textContent).toContain("not json");
  await act(async () => { bad.root.unmount(); });
});
