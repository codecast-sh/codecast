// Mounts a project's Line tab in jsdom and reads its Versions table
// (the-line-end-to-end.md LE14): every run is accounted for (a Stopped
// column beside shipped, revised and dropped), and each row leads with what
// that version changed, its graph hash only a secondary tag.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line", pretendToBeVisual: true });
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
  usePathname: () => "/projects/p1",
  useSearchParams: () => new URLSearchParams("tab=line"),
}));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: null }) }));

const { useInboxStore } = await import("../../../store/inboxStore");
const { ProjectLineTab } = await import("../ProjectLineTab");

const ME = "u1";
const WS = `user:${ME}`;
const now = Date.now();
const DAY = 86_400_000;
const project = { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: WS, line_profile: { finders: [], root: "/repo", default: false, changed_at: now - 1000 } };
const n = (node_id: string, i: number, status = "completed") => ({ node_id, status, started_at: now - 9 * DAY + i, completed_at: now - 9 * DAY + i + 1 });
const nodesV1 = [{ id: "prove", h: "aaaa1111" }, { id: "review", h: "bbbb2222" }];
const nodesV2 = [{ id: "prove", h: "cccc3333" }, { id: "review", h: "bbbb2222" }];
const line = (id: string, at: number, hash: string, nodes: typeof nodesV1, statuses: ReturnType<typeof n>[], status = "completed") => ({
  _id: id, status, task_id: "t1", workflow_slug: "line", workflow_name: "line", workspace: WS, project_id: "p1", graph_hash: hash, graph_nodes: nodes,
  node_statuses: [n("start", 0), ...statuses], created_at: at, updated_at: at + 1000,
});

test("versions say what changed and account for every run, stopped ones included", async () => {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    teams: [], teamMembers: [], signals: {},
    projects: { p1: project },
    tasks: { t1: { _id: "t1", short_id: "ct-1", title: "cause", status: "done", workspace: WS, project_id: "p1", created_at: now - 10 * DAY, updated_at: now, cause: { signal_count: 1, first_seen: now - 10 * DAY, last_seen: now - DAY } } },
    workflowRuns: {
      a: line("a", now - 8 * DAY, "1111111111111111", nodesV1, [n("ground", 1), n("prove", 2, "failed")], "failed"),
      b: line("b", now - 7 * DAY, "1111111111111111", nodesV1, [n("ground", 1), n("decide", 2), n("drop", 3)]),
      c: line("c", now - 2 * DAY, "2222222222222222", nodesV2, [n("ground", 1), n("decide", 2), n("ship", 3), n("watch", 4)]),
    },
  } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ProjectLineTab, { projectId: "p1" })); });
  const rows = Object.fromEntries([...host.querySelectorAll<HTMLElement>("[data-line-version]")].map((r) => [r.dataset.lineVersion, [...r.querySelectorAll("td")].map((td) => td.textContent?.trim())]));
  expect(Object.keys(rows)).toEqual(["2222222222222222", "1111111111111111"]);
  expect(rows["2222222222222222"][0]).toBe("Prove edited22222222latest");
  expect(rows["1111111111111111"][0]).toBe("First recorded version11111111");
  // Runs, Shipped, Revised, Dropped, Stopped: 2 runs = 1 dropped + 1 stopped.
  expect(rows["1111111111111111"].slice(2, 7)).toEqual(["2", "0 0%", "0 0%", "1", "1"]);
  expect(host.querySelector("[data-line-versions] thead")?.textContent).toContain("Stopped");
  await act(async () => { root.unmount(); });
  host.remove();
}, 30_000);
