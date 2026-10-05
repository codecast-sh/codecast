// Mounts the Line page in jsdom and reads its ways into line settings (plan
// pl-838, ct-56914): the header link names the selected project, every empty
// station links to the settings section that would fill it, and a build row
// running the project's customized line wears the customized chip while a
// shipped run does not.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line?project=p1", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// Same mocks as LinePage.senseEvals.mount.test.tsx: bun shares mock.module
// across the files of one run, so the two must agree.
mock.module("../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {} }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams("project=p1"),
}));

const { useInboxStore } = await import("../../../store/inboxStore");
const { LinePage } = await import("../LinePage");

const ME = "u1";
const WS = `user:${ME}`;
const now = Date.now();
const project = { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: WS, line_profile: { finders: [], root: "/repo", default: false, changed_at: now - 1000 } };
const cause = (id: string, short: string) => ({
  _id: id, short_id: short, title: `cause ${short}`, status: "in_progress", workspace: WS, project_id: "p1", created_at: now - 9e6, updated_at: now - 1000,
  cause: { signal_count: 1, first_seen: now - 9e6, last_seen: now - 1000 },
});
const run = (id: string, task: string, slug: string) => ({
  _id: id, status: "running", task_id: task, workflow_slug: slug, workflow_name: slug, workspace: WS, created_at: now - 60_000, updated_at: now - 1000,
  current_node_id: "ground", current_node_label: "Ground",
});

async function mount(state: Record<string, unknown>): Promise<{ host: HTMLElement; done: () => Promise<void> }> {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    teams: [],
    teamMembers: [],
    projects: { p1: project },
    tasks: {},
    signals: {},
    workflowRuns: {},
    ...state,
  } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(LinePage)); });
  return { host, done: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test("the header links to the selected project's settings, and every empty station to the section that fills it", async () => {
  const { host, done } = await mount({});
  expect(host.querySelector("a[data-line-settings-link]")?.getAttribute("href")).toBe("/line/settings?project=pr-1");
  const links = Object.fromEntries([...host.querySelectorAll<HTMLAnchorElement>("a[data-line-station-settings]")].map((a) => [a.dataset.lineStationSettings, a.getAttribute("href")]));
  expect(links.sense).toBe("/line/settings?project=pr-1&section=listens");
  expect(links.build).toBe("/line/settings?project=pr-1&section=stations");
  expect(links.awaiting).toBe("/line/settings?project=pr-1&section=checks");
  expect(links.watching).toBe("/line/settings?project=pr-1&section=limits");
  await done();
});

test("a build row on the project's customized line wears the chip; a shipped run does not", async () => {
  const { host, done } = await mount({
    tasks: { t1: cause("t1", "ct-1"), t2: cause("t2", "ct-2") },
    workflowRuns: { r1: run("r1", "t1", "line-pr-1"), r2: run("r2", "t2", "line") },
  });
  const rows = [...host.querySelectorAll<HTMLElement>("[data-line-row]")].filter((r) => /cause ct-/.test(r.textContent ?? "") && r.querySelector(".line-title"));
  const chipOf = (short: string) => !!rows.find((r) => r.textContent?.includes(`cause ${short}`))?.querySelector("[data-line-customized]");
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(chipOf("ct-1")).toBe(true);
  expect(chipOf("ct-2")).toBe(false);
  // The Build station has rows, so it carries no "set up" link.
  expect(host.querySelector("a[data-line-station-settings='build']")).toBeNull();
  await done();
});
