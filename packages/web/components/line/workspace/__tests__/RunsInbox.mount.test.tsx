// Mounts the Runs list and the Inbox (line-workspace.md LW1) in jsdom on
// Union's ct-57382 run shape. Runs: one row a problem, its attempts as dots,
// a failed attempt's end reason as a chip from its red check
// ("killed: typecheck (not in diff) red ×3"), the attempts under it when opened.
// The Inbox it also mounted is For you now (ForYou.mount.test.tsx).
import { problemSources } from "../../../../lib/line/stepRuns";
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=runs", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/line" }));
// No server: the Inbox feeds its decisions ahead of a click, and every query is still loading. Keep the other exports real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { RunsView } = await import("../views/RunsView");
const { buildLineModel } = await import("../../../../lib/line/lineModel");
const { failCause } = await import("../../../../lib/line/runReport");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");
const { agentwatchGraph } = await import("../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run } = await import("../../../../lib/line/__tests__/unionLineRuns.fixture");

const T = union57382Run.created_at;
const verify = '{"ok":false,"steps":[{"name":"typecheck","ok":false,"detail":"exit 1"}]}\n../backend/src/lib/apollo.ts(54,13): error TS7006: x';
const first = { ...union57382Run, task_id: "t1", workflow_slug: "agentwatch", updated_at: T } as any;
const second = {
  ...first, _id: "run-2", created_at: T + 1000, updated_at: T + 2000, current_node_id: "verify", fail_reason: "max_visits=3 exceeded on build",
  node_statuses: [...first.node_statuses, { node_id: "build", status: "failed", session: { _id: "s9", result: '{"outcome":"built","files":["backend/src/routes/calls.ts"]}' } }, { node_id: "verify", status: "failed", outcome: "failure", result_preview: verify }],
} as any;
const other = { ...first, _id: "run-3", task_id: "t2", created_at: T + 500, updated_at: T + 600 } as any;
const tasks = [
  { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1, project_id: "p1" },
  { _id: "t2", short_id: "ct-57388", title: "Agent told contact the first introductions were free", status: "open", created_at: 1, project_id: "p1" },
];
const model = buildLineModel({ runs: [first, second, other], tasks: tasks as any, graph: agentwatchGraph, now: T + 10_000 }, "agentwatch");
const runs = [first, second, other];
const workspace = { rows: { signals: [], runs, tasks, decisions: [] }, projects: [{ _id: "p1", title: "Agent Quality" }], project: null, now: T + 10_000, sources: problemSources([] as never), admissions: new Map(), overlaps: new Map(), names: new Map() } as any;

useInboxStore.setState({ currentUser: { _id: "u1" }, workflowRuns: Object.fromEntries(runs.map((r) => [r._id, r])) } as any);

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const selects: any[] = [];
async function render(el: React.ReactElement) { await act(async () => { root.render(el); }); }
const q = (s: string) => host.querySelector(s) as HTMLElement | null;

test("Runs: one row a problem, its attempts as dots, the failed attempt's reason from its red check", async () => {
  await render(React.createElement(RunsView, { model, workspace, selection: readLineSelection(new URLSearchParams("view=runs")), select: (p: any) => selects.push(p), href: () => "#" }));
  expect(host.querySelectorAll("[data-line-run-group]").length).toBe(2);
  const row = q('[data-line-run-group="t1"]')!;
  expect(row.querySelectorAll("[data-line-attempt]").length).toBe(2);
  // Red only outside the change: the fix was killed by someone else's check, said by name.
  expect(row.querySelector(".lw-why")?.textContent).toBe("killed: typecheck (not in diff) red ×3");
  await act(async () => { (row.querySelector(".lw-run-caret") as HTMLElement).click(); });
  expect(host.querySelectorAll(".lw-run-attempt").length).toBe(2);
});

