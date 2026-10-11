// Mounts the Problems view and a problem's timeline in jsdom (line-workspace.md
// LW1 Problems) on a cause shaped like Union's real AgentWatch runs: a first
// attempt that stopped at Prove, a second that shipped, merged and was
// deployed, the problem coming back after the deploy, and a third attempt live
// on it. The table shows it running with its came-back count and source; the
// filters narrow it; its page draws every lane on one axis, opens on what came
// back, explains a mark on hover and opens an attempt from its bar.
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

const { useInboxStore } = await import("../../../../../store/inboxStore");
const { buildLineModel } = await import("../../../../../lib/line/lineModel");
const { agentwatchGraph } = await import("../../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run } = await import("../../../../../lib/line/__tests__/unionLineRuns.fixture");
const { TimelineView } = await import("../TimelineView");
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
  { _id: "t9", short_id: "ct-9", title: "Nobody took this yet", status: "open", created_at: T0 + 25 * DAY, cause: { signal_count: 1, first_seen: T0 + 25 * DAY, last_seen: T0 + 25 * DAY, fingerprints: [] } },
  // Merged away before any run took it: it waits for nothing, so the waiting group leaves it out.
  { _id: "t8", short_id: "ct-8", title: "Merged before it ran", status: "dropped", created_at: T0 + 24 * DAY, cause: { signal_count: 1, first_seen: T0 + 24 * DAY, last_seen: T0 + 24 * DAY, fingerprints: [] } },
];
const model = buildLineModel({
  runs: [third, second, base], tasks: tasks as any, signals: [], decisions: [card as any], graph: agentwatchGraph, watchDays: 7, now: NOW,
  occurrences: [
    { _id: "t1", task_id: "t1", project_id: "p1", sources: ["agentwatch"], since: T0 - 60 * DAY, capped: false, observed: [T0 - 3 * DAY, T0 - DAY, T0 + 2 * DAY, shippedAt + 3 * DAY, shippedAt + 4 * DAY], reopened: [shippedAt + 3 * DAY] },
    { _id: "t9", task_id: "t9", project_id: "p1", sources: ["agentwatch"], since: T0 - 60 * DAY, capped: false, observed: [T0 + 25 * DAY], reopened: [] },
  ],
  deploys: [{ _id: "dep-1", project_id: "p1", at: shippedAt + DAY, sha: SHA.slice(0, 12), repository: "unionmatching/union", surface: "backend", environment: null, version: null, source: "codecast", via: "repository", title: "Deployed backend", url: null }],
}, "agentwatch");

const signals = [
  { _id: "s1", source: "agentwatch", kind: "finding", title: "Sender changed mid-thread", observed_at: shippedAt + 3 * DAY, created_at: shippedAt + 3 * DAY, task_id: "t1", judge: "sender", severity: 4 },
  { _id: "s2", source: "agentwatch", kind: "finding", title: "Sender changed again", observed_at: shippedAt + 4 * DAY, created_at: shippedAt + 4 * DAY, task_id: "t1" },
  { _id: "s3", source: "person", kind: "finding", title: "Nobody took this yet", observed_at: T0 + 25 * DAY, created_at: T0 + 25 * DAY, task_id: "t9" },
];
const picks: Array<Record<string, unknown>> = [];
const props = (caseId: string | null, source: string | null = null) => ({
  model,
  workspace: {
    model, project: null, projects: [{ _id: "p1", title: "Union" }], graphKey: "agentwatch", unread: false, now: NOW, rollup: null,
    rows: { signals, tasks: tasks.map((t) => ({ ...t, project_id: "p1" })), runs: [], decisions: [] },
  } as any,
  selection: { view: "problems" as const, mode: "graph" as const, project: null, graph: null, step: null, tab: null, run: null, case: caseId, source, finding: null },
  select: (p: Record<string, unknown>) => { picks.push(p); },
  href: (p: Record<string, unknown>) => `/line?view=problems&case=${p.case ?? ""}`,
});

async function mount(el: React.ReactElement) {
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, signals: {} } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, root };
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); }); };
const ids = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".lwp-row")].map((r) => r.dataset.lineIssue);

test("the table lists every problem with its source, project, findings, runs, status and came-back count", async () => {
  const { host, root } = await mount(React.createElement(ProblemsView, props(null)));
  // Active by default: the closed problem waits under Closed and All.
  expect(ids(host)).toEqual(["t1", "t9"]);
  expect(host.querySelector("[data-line-status='active']")?.textContent).toBe("Active2");
  const t1 = host.querySelector<HTMLElement>(".lwp-row[data-line-issue='t1']")!;
  expect(t1.dataset.status).toBe("running");
  expect(t1.querySelector(".lwp-c-ref")?.textContent).toBe("ct-57382");
  expect(t1.querySelector(".lwp-c-src")?.textContent).toBe("AgentWatch");
  expect(t1.querySelector(".lwp-c-proj")?.textContent).toBe("Union");
  expect(t1.querySelector(".lwp-c-find .lw-num")?.textContent).toBe("5");
  expect(t1.querySelectorAll(".lwp-marks i")).toHaveLength(3);
  expect(t1.querySelector(".lwp-c-status")?.textContent).toBe("Running");
  expect(t1.querySelector(".lwp-back")?.textContent).toBe("2");
  await click(host.querySelector("[data-line-status='closed']")!);
  expect(ids(host)).toEqual(["t8"]);
  await click(host.querySelector("[data-line-status='all']")!);
  expect(ids(host)).toEqual(["t1", "t9", "t8"]);

  // Status narrows, with counts on each segment.
  const open = host.querySelector<HTMLButtonElement>("[data-line-status='open']")!;
  expect(open.textContent).toBe("Open1");
  await click(open);
  expect(ids(host)).toEqual(["t9"]);
  await click(host.querySelector("[data-line-status='open']")!);
  expect(ids(host)).toEqual(["t1", "t9"]);
  // Came back narrows to the problem that came back.
  await click(host.querySelector("[data-line-filter-back]")!);
  expect(ids(host)).toEqual(["t1"]);
  await click(host.querySelector("[data-line-filter-back]")!);
  // A header sorts; a second click flips it.
  await click([...host.querySelectorAll(".lwp-th button")].find((b) => b.textContent === "Problem")!);
  expect(ids(host)).toEqual(["t9", "t1"]);
  // A row opens the problem through the shared selection.
  await click(host.querySelector(".lwp-row[data-line-issue='t1']")!);
  expect(picks.at(-1)).toEqual({ case: "t1", run: null });
  await act(async () => { root.unmount(); });
}, 30_000);

test("with no problem open, j and k move a cursor over the rows and Enter opens it", async () => {
  picks.length = 0;
  const { host, root } = await mount(React.createElement(ProblemsView, props(null)));
  const key = async (k: string) => { await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })); }); };
  await key("j");
  expect(host.querySelector(".lwp-row[data-cursor]")?.getAttribute("data-line-issue")).toBe("t1");
  await key("j");
  await key("j");
  expect(host.querySelector(".lwp-row[data-cursor]")?.getAttribute("data-line-issue")).toBe("t9");
  await key("k");
  await key("Enter");
  expect(picks.at(-1)).toEqual({ case: "t1", run: null });
  await act(async () => { root.unmount(); });
}, 30_000);

test("the source filter is the shared source key: the list narrows to it and the picker writes it", async () => {
  picks.length = 0;
  const { host, root } = await mount(React.createElement(ProblemsView, props(null, "person")));
  expect(ids(host)).toEqual(["t9"]);
  expect(host.querySelector("[data-line-source-filter]")?.textContent).toBe("People");
  await click(host.querySelector(".lwp-clear")!);
  expect(picks.at(-1)).toEqual({ source: null });
  await act(async () => { root.unmount(); });
}, 30_000);

test("a problem's page shows its source and draws every lane on one axis, opening on what came back", async () => {
  picks.length = 0;
  const { host, root } = await mount(React.createElement(ProblemsView, props("t1")));
  // The list stays beside it, the open row marked.
  expect(host.querySelector(".lwp-row[data-line-issue='t1']")?.getAttribute("aria-selected")).toBe("true");
  const page = host.querySelector<HTMLElement>("[data-line-problem='t1']")!;
  expect(page.dataset.status).toBe("running");
  expect(page.querySelector("[data-line-came-back]")?.textContent).toBe("2");
  expect(page.querySelector("[data-line-problem-source='agentwatch']")?.textContent).toBe("AgentWatch2");
  await click(page.querySelector("[data-line-problem-source='agentwatch']")!);
  expect(picks.at(-1)).toEqual({ view: "sources", source: "agentwatch", finding: null });

  const chart = page.querySelector("[data-line-timeline-chart]")!;
  expect(chart.querySelectorAll(".lwt-att")).toHaveLength(3);
  expect(chart.querySelectorAll(".lwt-att[data-live]")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-merge")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-deploy")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-regress")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-watch")).toHaveLength(1);
  expect(chart.querySelector(".lwt-bar[data-back]")).not.toBeNull();

  // Findings list with the fix going live as a divider, marked with how often it came back after.
  const occ = page.querySelector("[data-line-occurrences]")!;
  const live = occ.querySelector<HTMLElement>("li.lwt-occ-close[data-tone='bad']")!;
  expect(live.querySelector("span")?.textContent).toBe("#2 fix live");
  expect(live.querySelector(".lwt-occ-close-back")?.textContent).toBe("back 2x");
  expect(live.hasAttribute("data-picked")).toBe(true);
  expect(occ.querySelectorAll("li[data-back]:not(.lwt-occ-close)")).toHaveLength(2);
  expect(occ.textContent).toContain("Sender changed mid-thread");
  expect(occ.querySelector(".lwt-sev")?.textContent).toBe("sev 4");

  // Hovering a mark explains it.
  await act(async () => { chart.querySelector(".lwt-deploy")!.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true })); });
  const tip = chart.querySelector<HTMLElement>(".lwt-tip")!;
  expect(tip.hasAttribute("data-open")).toBe(true);
  expect(tip.textContent).toContain("Carried attempt 2's fix (same commit)");

  // A bar opens its run: the card, the diff, the merge and the came-back mark, and a direct way to the run itself.
  await act(async () => { chart.querySelector<SVGGElement>(".lwt-att:nth-of-type(2)")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const row = page.querySelector<HTMLElement>("[data-attempt='run-2']")!;
  expect(row.hasAttribute("data-open")).toBe(true);
  expect(row.querySelector(".lwt-card-head .lwt-tag")?.textContent).toBe("Ship");
  expect(row.textContent).toContain("3 files");
  expect(row.textContent).toContain("9f1c2ab");
  expect(row.querySelector(".lwt-flags .lwt-tag")?.textContent).toBe("back 2x after it");
  expect(row.querySelector("[data-line-open-run='run-2']")).not.toBeNull();
  // No sentences explaining state on the page.
  expect(page.querySelector(".lwt-where, .lwt-callout, .lwt-facts")).toBeNull();
  await act(async () => { root.unmount(); });
}, 30_000);

test("on a problem, Esc goes back to the list and j walks to the next problem in the table's order", async () => {
  picks.length = 0;
  const { root } = await mount(React.createElement(TimelineView, { ...props("t1"), order: ["t1", "t9", "t8"] }));
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true })); });
  expect(picks.at(-1)).toEqual({ case: "t9", run: null });
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(picks.at(-1)).toEqual({ case: null, run: null });
  await act(async () => { root.unmount(); });
}, 30_000);
