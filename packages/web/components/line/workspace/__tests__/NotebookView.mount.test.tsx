// Mounts the Notebook view (line-workspace.md LW1) on the real AgentWatch
// graph in jsdom: the outline down the spine, one step as a page with its
// job and where it sends work, its decisions as rows labeled right or wrong
// in one click through the store, j walking the steps, the traced run, and
// the Changes list naming each step's prompt texts.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line/pr-1?view=notebook", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { NotebookView } = await import("../views/NotebookView");
const { buildLineModel } = await import("../../../../lib/line/lineModel");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");
const { agentwatchGraph } = await import("../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run, union57467Run } = await import("../../../../lib/line/__tests__/unionLineRuns.fixture");

const aw = (run: any, task: string, h: string) => ({ ...run, task_id: task, workflow_slug: "agentwatch", updated_at: run.updated_at ?? run.created_at, graph_nodes: [{ id: "dissolve", h }, { id: "investigate", h: "i1" }] });
const runs = [aw(union57382Run, "t1", "h2"), aw(union57467Run, "t2", "h1")];
const tasks = [
  { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1 },
  { _id: "t2", short_id: "ct-57467", title: "A message leads with the result", status: "open", created_at: 1 },
];

useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, lineLabels: {}, workflowRuns: Object.fromEntries(runs.map((r) => [r._id, r])) } as any);

const selects: any[] = [];
let root: ReturnType<typeof createRoot>;
const host = document.createElement("div");
document.body.appendChild(host);

async function render(search: string) {
  const labels = Object.values((useInboxStore.getState() as any).lineLabels ?? {}) as any[];
  const model = buildLineModel({ runs: runs as any, tasks: tasks as any, graph: agentwatchGraph, labels, viewerId: "u1", now: 1_791_500_000_000 }, "agentwatch");
  const selection = readLineSelection(new URLSearchParams(search));
  const el = React.createElement(NotebookView, { model, workspace: {} as any, selection, select: (p: any, c?: any) => selects.push({ ...p, runCase: c }), href: () => "#" });
  await act(async () => { (root ??= createRoot(host)).render(el); });
  return model;
}
const q = (s: string) => host.querySelector(s) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };

test("the outline reads the line, the page opens on the first step", async () => {
  const model = await render("view=notebook");
  const steps = [...host.querySelectorAll(".nb-node")].map((b) => b.getAttribute("data-line-outline-step"));
  expect(steps[0]).toBe("dissolve");
  expect(steps).toContain("proposal_gate");
  expect([...host.querySelectorAll(".nb-half")].map((h) => h.textContent)).toEqual(["Diagnose", "Fix"]);
  expect(q("[data-line-notebook-step]")?.getAttribute("data-line-notebook-step")).toBe("dissolve");
  expect(q(".nb-job")?.textContent).toBe(model.steps.dissolve.purpose);
  expect(q(".nb-flows")?.textContent).toContain("Investigate");
  // Scripts sit folded between steps, and open in place.
  const seg = q(".nb-seg");
  expect(seg).not.toBeNull();
  await click(seg);
  expect(host.querySelectorAll(".nb-script").length).toBeGreaterThan(0);
});

test("a decision is labeled wrong in one click, through the store", async () => {
  await render("view=notebook&step=dissolve");
  const row = q("[data-line-decision]")!;
  const runId = row.getAttribute("data-line-decision")!.split(":")[0];
  await click(row.querySelector("[data-line-label='wrong']"));
  const labels = Object.values((useInboxStore.getState() as any).lineLabels) as any[];
  expect(labels).toEqual([expect.objectContaining({ run_id: runId, node_id: "dissolve", verdict: "wrong", by: "u1" })]);
  await render("view=notebook&step=dissolve");
  expect(q("[data-line-decision]")?.getAttribute("data-verdict")).toBe("wrong");
  expect(q("[data-line-label='wrong']")?.getAttribute("aria-pressed")).toBe("true");
  expect(q(".nb-hint")?.textContent).toContain("1 marked");
  // A second press takes it back.
  await click(q("[data-line-label='wrong']"));
  expect(Object.values((useInboxStore.getState() as any).lineLabels)).toHaveLength(0);
});

test("j walks to the next step; a traced run lights its path", async () => {
  await render(`view=notebook&step=dissolve&run=${union57382Run._id}&case=t1`);
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j" })); });
  expect(selects.at(-1)).toMatchObject({ step: "investigate" });
  expect(q("[data-line-tracing]")?.textContent).toContain("Sender identity");
  expect(q(".nb-node[data-line-outline-step='dissolve']")?.hasAttribute("data-walked")).toBe(true);
  expect(q(".nb-inrun")).not.toBeNull();
});

test("Changes lists the prompt texts the runs read", async () => {
  await render("view=notebook&step=dissolve");
  await click(q("[data-line-changes]"));
  const tray = q(".nb-changes")!;
  expect(tray.textContent).toContain("Dissolve");
  expect(tray.textContent).toContain("2 texts");
  await click(tray.querySelector(".nb-chg-btn"));
  expect(selects.at(-1)).toMatchObject({ step: "dissolve" });
  expect(q("[data-line-notebook-prompt]")).not.toBeNull();
});
