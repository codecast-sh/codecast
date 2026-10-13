// Mounts a run's page (line-journeys.md LJ8.4) in jsdom on runs shaped like the
// real ones on Codecast's line: a run that failed first at Ground opens there,
// says so once, and its one act opens a review that starts nothing until
// confirmed; a run that waits on a person opens on that step with the thing
// that waits (WaitingItem) and no inert answer chips; a step in the trace opens
// on a click and is a history entry.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=problems", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver,
  FocusEvent: dom.window.FocusEvent,
  CustomEvent: dom.window.CustomEvent,
  NodeFilter: dom.window.NodeFilter,
  DocumentFragment: dom.window.DocumentFragment,
  HTMLInputElement: dom.window.HTMLInputElement,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const realSync = await import("../../../../../../hooks/useSyncCollection");
mock.module("../../../../../../hooks/useSyncCollection", () => ({ ...realSync, useSyncCollection: () => ({ ready: true }) }));
const realMessages = await import("../../../../../../hooks/useConversationMessages");
mock.module("../../../../../../hooks/useConversationMessages", () => ({ ...realMessages, useConversationMessages: () => ({ conversation: null }) }));
// The readers are their own components with their own tests: here a stub names what was mounted.
const realWaiting = await import("../../../../widgets/WaitingItem");
mock.module("../../../../widgets/WaitingItem", () => ({ ...realWaiting, WaitingItem: ({ need }: any) => React.createElement("div", { "data-stub-waiting": need.ref }) }));
const realDecision = await import("../../../../widgets/LineDecision");
mock.module("../../../../widgets/LineDecision", () => ({ ...realDecision, LineDecision: ({ id }: any) => React.createElement("div", { "data-stub-decision": id }) }));

const { useInboxStore } = await import("../../../../../../store/inboxStore");
const { RunPage } = await import("../RunPage");
const { buildLineModel } = await import("../../../../../../lib/line/lineModel");
const { readLineSelection } = await import("../../../../../../lib/line/lineWorkspaceUrl");
const { n, NOW, MIN, HOUR } = await import("../../../../../../lib/line/__tests__/lineFixtures");

const T0 = NOW - 2 * HOUR;
const failedRun: any = {
  _id: "r_fail", status: "failed", task_id: "t1", workflow_name: "line", current_node_id: "prove", created_at: T0, updated_at: T0 + 5 * MIN,
  fail_reason: "no outgoing edge from prove (outcome failure, review_verdict none)",
  node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 7 / 60, "failed", { outcome: "failure" }), n("analyze", T0 + 2 * MIN, 8 / 60, "failed", { outcome: "failure" }), n("prove", T0 + 3 * MIN, 26 / 60, "failed")],
};
const waitingRun: any = {
  _id: "r_wait", status: "paused", task_id: "t2", workflow_name: "line", current_node_id: "decide", gate_node_id: "decide", gate_decision_short_id: "sd-615", created_at: T0, updated_at: T0 + HOUR,
  node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 2), n("analyze", T0 + 4 * MIN, 3), n("prove", T0 + 8 * MIN, 6), n("implement", T0 + 17 * MIN, 20), n("review", T0 + 40 * MIN, 6), n("decide", T0 + HOUR, 0, "running")],
};
const tasks: any[] = [
  { _id: "t1", short_id: "ct-58680", title: "Contact asked for a callback time", status: "open", project_id: "proj", created_at: T0, cause: { signal_count: 1, first_seen: T0, last_seen: T0, fingerprints: ["x"] } },
  { _id: "t2", short_id: "ct-59561", title: "A call a person answered is filed as voicemail", status: "in_progress", project_id: "proj", created_at: T0, cause: { signal_count: 9, first_seen: T0, last_seen: T0, fingerprints: ["y"] } },
];
const model = buildLineModel({ runs: [failedRun, waitingRun], tasks, now: NOW }, "line");
const need = { key: "decide:t2", ref: "sd-615", kind: "decision", counted: true, ask: "Ship this?", title: tasks[1].title, problemRef: "ct-59561", caseId: "t2", projectId: "proj", process: "line", since: T0, runId: "r_wait", decisionRef: "sd-615", cardRef: null, trial: false, note: null, fail: null, why: null, findings: 9 };

useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, workflowRuns: { r_fail: failedRun, r_wait: waitingRun }, tasks: Object.fromEntries(tasks.map((t) => [t._id, t])), projects: { proj: { _id: "proj", title: "Callers" } } } as any);

const selects: any[] = [];
let root: ReturnType<typeof createRoot>;
const host = document.createElement("div");
document.body.appendChild(host);
async function render(search: string) {
  const selection = readLineSelection(new URLSearchParams(search));
  const workspace = { rows: { signals: [], runs: [failedRun, waitingRun], tasks, decisions: [] }, needs: [need], now: NOW, names: new Map() } as any;
  const el = React.createElement(RunPage, { model, workspace, selection, select: (p: any, c?: any, o?: any) => selects.push({ ...p, runCase: c, ...o }), href: () => "#" });
  await act(async () => { (root ??= createRoot(host)).render(el); });
}
const q = (s: string) => host.querySelector(s) as HTMLElement | null;

test("a run that failed first at Ground opens on Ground and says so once, with the crumb under its problem", async () => {
  await render("view=problems&case=t1&run=r_fail");
  expect(q("[data-run-open-step]")?.dataset.runOpenStep).toBe("ground");
  expect(q("[data-line-state]")?.textContent).toBe(`Failed at ${model.steps.ground.label} after 7s`);
  expect(host.textContent).not.toContain("no outgoing edge");
  expect(q("[data-run-crumb-problem]")?.textContent).toBe("ct-58680");
  expect(q("[data-run-number]")?.textContent).toBe("Run 1");
});

test("its one act opens a review of what starts, and nothing starts until the review is confirmed", async () => {
  const started: string[] = [];
  const real = useInboxStore.getState().startLineCause;
  useInboxStore.setState({ startLineCause: (id: string) => { started.push(id); return Promise.resolve(); } } as any);
  await render("view=problems&case=t1&run=r_fail");
  const acts = host.querySelectorAll("[data-line-start-again]");
  expect(acts.length).toBe(1);
  await act(async () => { (acts[0] as HTMLElement).click(); });
  expect(document.body.textContent).toContain("Start a new run");
  expect(started).toEqual([]);
  useInboxStore.setState({ startLineCause: real } as any);
});

test("a run waiting on a person opens on that step with the thing that waits, never inert answer chips", async () => {
  await render("view=problems&case=t2&run=r_wait");
  expect(q("[data-run-open-step]")?.dataset.runOpenStep).toBe("decide");
  expect(q("[data-stub-waiting]")?.dataset.stubWaiting).toBe("sd-615");
  expect(q("[data-line-state]")?.textContent).toStartWith("Waiting on you since ");
  expect(host.querySelector(".rd-chip, [data-replay-question]")).toBeNull();
  expect(q("[data-line-start-again]")).toBeNull();
});

test("a step in the trace opens on a click, as a history entry", async () => {
  await render("view=problems&case=t2&run=r_wait");
  selects.length = 0;
  await act(async () => { q('[data-run-step="prove"]')!.click(); });
  expect(selects.at(-1)).toMatchObject({ step: "prove" });
  expect(selects.at(-1).replace).toBeFalsy();
});

test("a run the drawn process does not hold says so and leads back to its problem", async () => {
  await render("view=problems&case=t1&run=r_other");
  expect(q("[data-line-run-missing]")?.dataset.lineRunMissing).toBe("r_other");
  expect(host.textContent).toContain("Open its problem");
});

test("a run on a task no finding raised is not a run on a problem: it says so and opens the run itself, never 'Opening' forever", async () => {
  const plain: any = { _id: "r_plain", status: "running", task_id: "t_plain", workflow_name: "line", current_node_id: "implement", created_at: T0, updated_at: T0, node_statuses: [] };
  useInboxStore.setState({ workflowRuns: { ...useInboxStore.getState().workflowRuns, r_plain: plain } } as any);
  const selection = readLineSelection(new URLSearchParams("view=problems&case=t_plain&run=r_plain"));
  const workspace = { rows: { signals: [], runs: [failedRun, waitingRun], tasks, decisions: [] }, needs: [], now: NOW, names: new Map(), ready: true } as any;
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RunPage, { model, workspace, selection, select: () => {}, href: () => "#" }))); });
  expect(q("[data-line-run-off]")).not.toBeNull();
  expect(host.textContent).not.toContain("Opening the run");
  expect(q("a.lw-act")?.getAttribute("href")).toBe("/workflows/runs/r_plain");
});
