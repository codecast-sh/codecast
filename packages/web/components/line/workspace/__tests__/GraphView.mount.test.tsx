// Mounts the Graph view in the workspace (line-workspace.md LW1): the line drawn
// by kind in its lanes, M between Essence and All steps, ? for the keys, a
// click opening a step through the selection, and a run in the URL lit with its
// steps numbered until Esc clears it.
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
const key = (k: string, init: KeyboardEventInit = {}) => act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });

test("the Graph view draws the line's steps by kind, switches Essence and All steps by M, and lists its keys on ?", async () => {
  search = "";
  const { host, root } = await mount(React.createElement(LineWorkspace, { projectId: "p1" }));
  const view = host.querySelector<HTMLElement>(".lwg")!;
  expect(view).not.toBeNull();
  expect(view.dataset.mode).toBe("essence");
  const kinds = new Map([...host.querySelectorAll<SVGGElement>("[data-lwg-node]")].map((g) => [g.dataset.lwgNode, g.dataset.kind]));
  expect(kinds.get("prove")).toBe("agent");
  expect([...kinds.values()]).toContain("person");
  expect([...kinds.values()]).not.toContain("end");
  expect(host.querySelector(".lwg-lane-title")?.textContent).toBe("Diagnose");
  await key("m");
  expect(host.querySelector<HTMLElement>(".lwg")!.dataset.mode).toBe("all");
  expect(host.querySelector("[data-lwg-mode='all']")?.getAttribute("aria-selected")).toBe("true");
  await key("?");
  expect(host.querySelector("[data-lwg-keys]")).not.toBeNull();
  await key("Escape");
  expect(host.querySelector("[data-lwg-keys]")).toBeNull();
  // A click on a step opens it through the selection.
  await act(async () => { host.querySelector("[data-lwg-node='prove']")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  expect(moves.at(-1)).toContain("step=prove");
  await act(async () => { root.unmount(); });
}, 30_000);

test("a run in the URL is lit on the graph with its steps numbered, and Esc clears it", async () => {
  search = "run=a";
  const { host, root } = await mount(React.createElement(LineWorkspace, { projectId: "p1" }));
  expect(host.querySelector("[data-lwg-runbar='a']")?.textContent).toContain("Sidebar freezes on resume");
  const prove = host.querySelector<SVGGElement>("[data-lwg-node='prove']")!;
  expect(prove.hasAttribute("data-on-run")).toBe(true);
  expect(prove.querySelector(".lwg-order text")?.textContent).toMatch(/^\d+$/);
  await key("Escape");
  expect(moves.at(-1)).not.toContain("run=");
  await act(async () => { root.unmount(); });
}, 30_000);
