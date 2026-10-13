// Mounts the Problems page in jsdom (line-journeys.md LJ8.2) on a cause shaped
// like Union's real AgentWatch runs (a fix that shipped, merged and was
// deployed, the problem coming back, a third attempt live), a problem nobody
// started and one merged away. Three figures, the trend, status chips that
// partition the problems, the table under its groups, a failure cause that
// starts its problems again through a review, and every filter in the URL.
import { problemSources } from "../../../../../lib/line/stepRuns";
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { replaceGlobals } from "../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=problems", pretendToBeVisual: true });
class NoResize { observe() {} unobserve() {} disconnect() {} }
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  NodeFilter: dom.window.NodeFilter,
  HTMLInputElement: dom.window.HTMLInputElement,
  DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: NoResize,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
// No server: an open problem's decision paints its loading state. Keep the other exports real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const noThrow = await import("../../../../../hooks/useQueryNoThrow");
mock.module("../../../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));

const { useInboxStore } = await import("../../../../../store/inboxStore");
const { buildLineModel } = await import("../../../../../lib/line/lineModel");
const { agentwatchGraph } = await import("../../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run } = await import("../../../../../lib/line/__tests__/unionLineRuns.fixture");
const { ProblemsView } = await import("../ProblemsView");

const DAY = 86_400_000;
const T0 = union57382Run.created_at;
const NOW = T0 + 30 * DAY;
const SHA = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
const shippedAt = T0 + 5 * DAY;
const done = (node_id: string, at: number) => ({ node_id, status: "completed", outcome: "success", started_at: at, completed_at: at + 60_000 });
const base = { ...union57382Run, task_id: "t1", workflow_slug: "agentwatch", updated_at: union57382Run.updated_at ?? T0 } as any;
const second = {
  ...base, _id: "run-2", status: "completed", created_at: T0 + 4 * DAY, updated_at: shippedAt + DAY,
  node_statuses: [
    ...(base.node_statuses ?? []).filter((n: any) => n.node_id !== "prove" && n.node_id !== "refine").map((n: any) => ({ ...n, started_at: T0 + 4 * DAY, completed_at: T0 + 4 * DAY + 1 })),
    done(CARD_GATE_NODE_ID, shippedAt - DAY), done("ship", shippedAt), done("merge", shippedAt), done("watch", shippedAt + 1),
  ],
  merge: { sha: SHA, branch: "line/ct-57382", into: "main", at: shippedAt, pr_url: "https://github.com/unionmatching/union/pull/812" },
};
const third = { ...base, _id: "run-3", status: "running", current_node_id: "investigate", created_at: T0 + 20 * DAY, updated_at: T0 + 20 * DAY, node_statuses: [done("bind", T0 + 20 * DAY)] };
const card = {
  _id: "d-card", short_id: "sd-9", status: "answered", workflow_run_id: "run-2", task_id: "t1", gate_node_id: CARD_GATE_NODE_ID, created_at: shippedAt - 2 * DAY,
  options: [{ label: "[S] Ship" }, { label: "[R] Revise" }], answer_index: 0, resolved_at: shippedAt - DAY,
  card: { headline: "Keep the sender fixed per thread", change: "Pin the sender identity on the thread's first send", recommend: { verdict: "ship", why: "The eval holds" }, diff: { files: 3, added: 42, removed: 7, pr: "https://github.com/unionmatching/union/pull/812" } },
};
const tasks = [
  { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "in_progress", created_at: T0 - 5 * DAY, cause: { signal_count: 5, first_seen: T0 - 3 * DAY, last_seen: shippedAt + 4 * DAY, fingerprints: [] } },
  { _id: "t9", short_id: "ct-9", title: "Nobody took this yet", status: "open", readiness: "ready", goal_ref: "g-1", created_at: T0 + 25 * DAY, cause: { signal_count: 1, first_seen: T0 + 25 * DAY, last_seen: T0 + 25 * DAY, fingerprints: [] } },
  // Merged away before any run took it: it waits for nothing, so the waiting group leaves it out.
  { _id: "t8", short_id: "ct-8", title: "Merged before it ran", status: "dropped", created_at: T0 + 24 * DAY, cause: { signal_count: 1, first_seen: T0 + 24 * DAY, last_seen: T0 + 24 * DAY, fingerprints: [] } },
];
const modelInput = {
  runs: [third, second, base], tasks: tasks as any, signals: [], decisions: [card as any], graph: agentwatchGraph, watchDays: 7, now: NOW,
  occurrences: [
    { _id: "t1", task_id: "t1", project_id: "p1", sources: ["agentwatch"], since: T0 - 60 * DAY, capped: false, observed: [T0 - 3 * DAY, T0 - DAY, T0 + 2 * DAY, shippedAt + 3 * DAY, shippedAt + 4 * DAY], reopened: [shippedAt + 3 * DAY] },
    { _id: "t9", task_id: "t9", project_id: "p1", sources: ["agentwatch"], since: T0 - 60 * DAY, capped: false, observed: [T0 + 25 * DAY], reopened: [] },
  ],
  deploys: [{ _id: "dep-1", project_id: "p1", at: shippedAt + DAY, sha: SHA.slice(0, 12), repository: "unionmatching/union", surface: "backend", environment: null, version: null, source: "codecast", via: "repository", title: "Deployed backend", url: null }],
};
const model = buildLineModel(modelInput as any, "agentwatch");

const signals = [
  { _id: "s1", source: "agentwatch", kind: "finding", title: "Sender changed mid-thread", observed_at: shippedAt + 3 * DAY, created_at: shippedAt + 3 * DAY, task_id: "t1", judge: "sender", severity: 4 },
  { _id: "s2", source: "agentwatch", kind: "finding", title: "Sender changed again", observed_at: shippedAt + 4 * DAY, created_at: shippedAt + 4 * DAY, task_id: "t1" },
  { _id: "s3", source: "person", kind: "finding", title: "Nobody took this yet", observed_at: T0 + 25 * DAY, created_at: T0 + 25 * DAY, task_id: "t9" },
];
const picks: Array<Record<string, unknown>> = [];
const failRow = { key: "failed:r7", kind: "failed", at: NOW - DAY, projectId: "p1", title: "Analyze dies", ref: "ct-7", detail: null, caseId: "t7", runId: "r7", cardId: null, cardRef: null, fail: { key: "check:analyze", step: "analyze", label: "Analyze gave no result", raw: "" } };
const failTask = { _id: "t7", short_id: "ct-7", title: "Not met: Analyze dies before it reads the call", status: "open", created_at: T0 + 26 * DAY, project_id: "p1", cause: { signal_count: 1, first_seen: T0 + 26 * DAY, last_seen: T0 + 26 * DAY, fingerprints: [] } };
const failModel = buildLineModel({ ...modelInput, tasks: [...tasks, failTask] } as any, "agentwatch");
const props = (sel: Record<string, unknown> = {}, m = model) => ({
  model: m,
  workspace: {
    model: m, project: null, projects: [{ _id: "p1", title: "Union" }], graphKey: "agentwatch", unread: false, now: NOW, rollup: null, allRollups: [],
    rows: { signals, tasks: [...tasks, failTask].map((t) => ({ ...t, project_id: "p1" })), runs: [], decisions: [] },
    sources: problemSources(signals as never), admissions: new Map(), trialProjects: new Set(), trialRuns: new Set(), overlaps: new Map(), names: new Map(),
    inbox: m === failModel ? [{ kind: "failed", label: "Failed", rows: [failRow] }] : [], needs: [], forYou: 0,
    allInbox: m === failModel ? [{ kind: "failed", label: "Failed", rows: [failRow] }] : [],
    problems: m.issues.map((i) => ({ ...i, process: "agentwatch" })), processes: [],
  } as any,
  selection: { view: "problems" as const, mode: "table" as const, project: null, graph: null, step: null, tab: null, run: null, case: null, source: null, finding: null, ask: false, card: null, decision: null, need: null, status: null, quiet: false, q: null, sort: null, win: null, ...sel } as any,
  select: (p: Record<string, unknown>) => { picks.push(p); },
  href: (p: Record<string, unknown>) => `/line?view=problems${Object.entries(p).filter(([, v]) => v != null).map(([k, v]) => `&${k}=${v}`).join("")}`,
});

async function mount(el: React.ReactElement) {
  picks.length = 0;
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, signals: {}, sessionDecisions: {}, lineCards: {}, trialCards: {}, workflowRuns: {}, tasks: {} } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, root };
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); }); };
const ids = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".lwp-row")].map((r) => r.dataset.lineIssue);
const chips = (host: HTMLElement) => Object.fromEntries([...host.querySelectorAll<HTMLElement>("[data-line-status]")].map((b) => [b.dataset.lineStatus, Number(b.querySelector(".lw-num")?.textContent)]));

test("figures, trend and chips: the chips partition the problems and sum to All", async () => {
  const { host, root } = await mount(React.createElement(ProblemsView, props({}, failModel)));
  const c = chips(host);
  expect(c.all).toBe(4);
  expect(Object.entries(c).filter(([k]) => k !== "all").reduce((n, [, v]) => n + v, 0)).toBe(c.all);
  expect(c).toEqual({ all: 4, failed: 1, running: 1, notstarted: 1, closed: 1 });
  // The lead is problems found in the window; the findings are its small print.
  expect(host.querySelector("[data-line-figure=problems] b")?.textContent).toBe("1");
  expect(host.querySelector("[data-line-figure-findings]")?.getAttribute("data-line-figure-findings")).toBe("1");
  expect(host.querySelector("[data-line-overview]")).not.toBeNull();
  // The trend has no legend (the table is the list); a bar is the control that lists that day's problems.
  expect(host.querySelector(".lwo-legend")).toBeNull();
  const bar = [...host.querySelectorAll<SVGAElement>("[data-line-overview-bar]")].find((b) => b.querySelector(".lwo-seg"))!;
  const from = bar.getAttribute("data-line-overview-bar")!;
  expect(bar.getAttribute("href")).toContain(`found=${from}`);
  await click(bar);
  expect(picks.at(-1)).toEqual({ found: from });
  // Not started and Closed fold to their headings under All; the rest are open, Failed under its cause.
  expect([...host.querySelectorAll<HTMLElement>(".lwp-section")].map((s) => [s.dataset.lineProblemSection, s.hasAttribute("data-folded")])).toEqual([["failed", false], ["running", false], ["notstarted", true], ["closed", true]]);
  expect(ids(host)).toEqual(["t7", "t1"]);
  // Four columns, the title whole with the judge's "Not met:" (it is what says this is a miss), its ref and project
  // beneath, one status phrase.
  const row = host.querySelector<HTMLElement>('.lwp-row[data-line-issue="t7"]')!;
  expect(row.querySelector(".lwp-title")?.textContent).toBe("Not met: Analyze dies before it reads the call");
  expect(row.querySelector(".lwp-under")?.textContent).toBe("ct-7 · Union");
  expect(row.querySelector(".lwp-c-status")?.textContent).toBe("Failed at Analyze");
  expect(host.querySelectorAll(".lwp-th [role=columnheader]")).toHaveLength(4);
  // What the old page drew and the spec removes is gone.
  for (const gone of [".lwp-waiting", ".lwp-off", ".lwp-c-src", ".lwp-c-fix", ".lwp-spark", ".lwp-c-ref", "[data-line-source-filter]", "[data-line-filter-back]"]) expect(host.querySelector(gone)).toBeNull();
  act(() => root.unmount());
});

test("a chip, a folded heading, a sort and the search each write the URL; a row opens its problem", async () => {
  const { host, root } = await mount(React.createElement(ProblemsView, props({}, failModel)));
  await click(host.querySelector("[data-line-status=failed]")!);
  expect(picks.at(-1)).toEqual({ status: "failed", quiet: null });
  await click(host.querySelector("button.lwp-section[data-line-problem-section=closed]")!);
  expect(picks.at(-1)).toEqual({ status: "closed", quiet: null });
  await click(host.querySelector("[data-line-sort=last]")!);
  expect(picks.at(-1)).toEqual({ sort: "last" });
  const input = host.querySelector<HTMLInputElement>("[data-line-problem-search]")!;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "sender "); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  expect(picks.at(-1)).toEqual({ q: "sender" });
  const row = host.querySelector<HTMLAnchorElement>('.lwp-row[data-line-issue="t1"]')!;
  expect(row.getAttribute("href")).toContain("case=t1");
  await click(row);
  expect(picks.at(-1)).toEqual({ case: "t1", run: null });
  act(() => root.unmount());
});

test("the URL drives the list: a chip opens its group, the search narrows and opens folded groups", async () => {
  let { host, root } = await mount(React.createElement(ProblemsView, props({ status: "notstarted" }, failModel)));
  expect(ids(host)).toEqual(["t9"]);
  expect(host.querySelector(".lwp-sub-h")?.textContent).toContain("1 ready");
  expect(host.querySelector('.lwp-row[data-line-issue="t9"] .lwp-c-status')?.textContent).toBe("Ready: no line set up");
  act(() => root.unmount());
  ({ host, root } = await mount(React.createElement(ProblemsView, props({ q: "merged before" }, failModel))));
  expect(ids(host)).toEqual(["t8"]);
  expect(chips(host).all).toBe(1);
  act(() => root.unmount());
  ({ host, root } = await mount(React.createElement(ProblemsView, props({ q: "nothing like this" }, failModel))));
  expect(host.querySelector("[data-line-problems-none]")?.textContent).toContain("No problem matches");
  act(() => root.unmount());
});

test("a failure cause starts its problems again only through a review that names the count", async () => {
  const { host, root } = await mount(React.createElement(ProblemsView, props({ status: "failed" }, failModel)));
  expect(host.querySelector(".lwp-sub-h b")?.textContent).toBe("Analyze gave no result");
  const started: string[] = [];
  useInboxStore.setState({ startLineCause: async (id: string) => { started.push(id); return null; } } as any);
  await click(host.querySelector("[data-line-start-again]")!);
  const review = document.querySelector<HTMLElement>("[data-switch-review]");
  expect(review?.textContent).toContain("1run starts now");
  expect(started).toEqual([]);
  act(() => root.unmount());
});

test("nothing filed: one line says so, with no zero figures, chart, chips or columns", async () => {
  const empty = buildLineModel({ ...modelInput, runs: [], tasks: [], decisions: [], occurrences: [], deploys: [] } as any, "agentwatch");
  const { host, root } = await mount(React.createElement(ProblemsView, props({}, empty)));
  expect(host.querySelector("[data-line-problems=empty] b")?.textContent).toBe("No problems");
  for (const gone of ["[data-line-figures]", "[data-line-overview]", "[data-line-status]", ".lwp-th"]) expect(host.querySelector(gone)).toBeNull();
  act(() => root.unmount());
});

test("problems but no findings in the window: one line in place of the figures, and no chart", async () => {
  const { host, root } = await mount(React.createElement(ProblemsView, props({ win: "24h" })));
  const none = host.querySelector<HTMLElement>("[data-line-figure=findings]")!;
  expect(none.hasAttribute("data-none")).toBe(true);
  expect(none.querySelector(".lwf-l")?.textContent).toBe("No findings in 24h");
  expect(none.textContent).not.toContain("%");
  expect(host.querySelector("[data-line-overview]")).toBeNull();
  expect(host.querySelectorAll(".lwp-row").length).toBeGreaterThan(0);
  act(() => root.unmount());
});
