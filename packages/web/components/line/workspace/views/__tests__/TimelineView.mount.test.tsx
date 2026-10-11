// Mounts the Timeline view in jsdom (line-workspace.md LW1 Timeline) on a
// cause shaped like Union's real AgentWatch runs: a first attempt that stopped
// at Prove, a second that shipped, merged and was deployed, the problem coming
// back after the deploy, and a third attempt live on it. The list puts the
// regressed problem first; its page draws every lane on one axis, opens on
// what came back, explains a mark on hover, opens an attempt from its bar and
// lists the fix that did not hold.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { replaceGlobals } from "../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line/pr-1?view=timeline", pretendToBeVisual: true });
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

const picks: Array<Record<string, unknown>> = [];
const props = (caseId: string | null) => ({
  model,
  workspace: { model, project: { _id: "p1", workspace: "user:u1" }, graphKey: "agentwatch", unread: false, now: NOW, rollup: null } as any,
  selection: { view: "timeline" as const, graph: null, step: null, tab: null, run: null, case: caseId },
  select: (p: Record<string, unknown>) => { picks.push(p); },
  href: (p: Record<string, unknown>) => `/line/pr-1?view=timeline&case=${p.case ?? ""}`,
});

async function mount(el: React.ReactElement) {
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, signals: {} } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, root };
}

test("the list puts the regressed problem first, with its sparkline, total and attempts; causes no run took wait in their own group", async () => {
  const { host, root } = await mount(React.createElement(TimelineView, props(null)));
  const rows = [...host.querySelectorAll<HTMLElement>("[data-line-issue]")];
  expect(rows.map((r) => [r.dataset.lineIssue, r.dataset.state])).toEqual([["t1", "regressed"]]);
  // The cause no run has taken is folded under "Not run on any line yet" until opened.
  const unrun = host.querySelector<HTMLButtonElement>(".lwt-unrun-h")!;
  expect(unrun.textContent).toContain("Not run on any line yet");
  expect(unrun.textContent).toMatch(/1$/);
  await act(async () => { unrun.click(); });
  expect([...host.querySelectorAll<HTMLElement>("[data-line-issue]")].map((r) => r.dataset.lineIssue)).toEqual(["t1", "t9"]);
  await act(async () => { unrun.click(); });
  expect(rows[0].querySelector(".lwt-num")?.textContent).toBe("5");
  expect(rows[0].querySelectorAll(".lwt-dots i")).toHaveLength(3);
  expect(rows[0].querySelector(".lwt-spark")).not.toBeNull();
  // The filter narrows to a state.
  const regressed = [...host.querySelectorAll<HTMLButtonElement>(".lw-filter")].find((b) => b.dataset.state === "regressed")!;
  await act(async () => { regressed.click(); });
  expect(host.querySelectorAll("[data-line-issue]")).toHaveLength(1);
  // A plain click opens the problem through the shared selection.
  await act(async () => { host.querySelector<HTMLElement>("[data-line-issue='t1']")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
  expect(picks.at(-1)).toEqual({ case: "t1", run: null });
  await act(async () => { root.unmount(); });
}, 30_000);

test("a problem's page draws every lane on one axis and opens on what came back", async () => {
  const { host, root } = await mount(React.createElement(TimelineView, props("t1")));
  const page = host.querySelector<HTMLElement>("[data-line-problem='t1']")!;
  expect(page.dataset.state).toBe("regressed");
  const chart = page.querySelector("[data-line-timeline-chart]")!;
  expect(chart.querySelectorAll(".lwt-att")).toHaveLength(3);
  expect(chart.querySelectorAll(".lwt-att[data-live]")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-merge")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-deploy")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-regress")).toHaveLength(1);
  expect(chart.querySelectorAll(".lwt-watch")).toHaveLength(1);
  expect(chart.querySelector(".lwt-bar[data-back]")).not.toBeNull();

  // It lists every occurrence, with the fix going live as a divider where it fell: what came back after it is tinted
  // under it, and the divider is the one place that says so.
  const occ = page.querySelector("[data-line-occurrences]")!;
  expect(occ.querySelector(".lwt-sec-scope")?.textContent).toMatch(/^All · \d+$/);
  const live = occ.querySelector<HTMLElement>("li.lwt-occ-close[data-tone='bad']")!;
  expect(live.textContent).toMatch(/^attempt #2's fix went live, .*came back 2x after it$/);
  expect(live.hasAttribute("data-picked")).toBe(true);
  expect(occ.querySelectorAll("li[data-back]:not(.lwt-occ-close)")).toHaveLength(2);
  expect([...occ.querySelectorAll(".lwt-occ .lwt-tag")].map((t) => t.textContent).filter((t) => /after attempt/.test(t ?? ""))).toEqual([]);

  // Hovering a mark explains it.
  await act(async () => { chart.querySelector(".lwt-deploy")!.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true })); });
  const tip = chart.querySelector<HTMLElement>(".lwt-tip")!;
  expect(tip.hasAttribute("data-open")).toBe(true);
  expect(tip.textContent).toContain("Carried attempt 2's fix (same commit)");

  // A bar opens its attempt: the card, the diff, the merge and the regression after it.
  await act(async () => { chart.querySelector<SVGGElement>(".lwt-att:nth-of-type(2)")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const row = page.querySelector<HTMLElement>("[data-attempt='run-2']")!;
  expect(row.hasAttribute("data-open")).toBe(true);
  expect(row.textContent).toContain("Answered Ship");
  expect(row.textContent).toContain("3 files");
  expect(row.textContent).toContain("9f1c2ab");
  expect(row.querySelector(".lwt-callout")?.textContent).toMatch(/^Came back 2x after the deploy of .*This fix did not hold/);

  // What the next attempt must not repeat.
  const memory = page.querySelector("[data-line-memory]")!;
  expect(memory.textContent).toContain("Pin the sender identity on the thread's first send");
  expect(memory.querySelector("li[data-back]")).not.toBeNull();
  await act(async () => { root.unmount(); });
}, 30_000);

test("Esc goes back to the list and j walks to the next problem", async () => {
  picks.length = 0;
  const { root } = await mount(React.createElement(TimelineView, props("t1")));
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true })); });
  expect(picks.at(-1)).toEqual({ case: "t9", run: null });
  await act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(picks.at(-1)).toEqual({ case: null, run: null });
  await act(async () => { root.unmount(); });
}, 30_000);
