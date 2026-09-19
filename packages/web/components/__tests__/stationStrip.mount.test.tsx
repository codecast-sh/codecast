import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";

import { closeDomWindow } from "../../test-helpers/domGlobals";
// The task page as the line (docs/architecture/the-line.md L3, L5, L10):
// the strip paints from the store alone. A held task shows the marker on its
// current station, linking the decision; a live run shows its node, its
// hand and the elapsed time under that station.

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={String(href)} {...props}>{children}</a>,
}));

const { useInboxStore } = await import("../../store/inboxStore");

// The strip's run comes from the workflowRuns collection; the feeder behind
// useWorkflowRun is a live query, so here the reader answers from the store
// alone. mock.module is process global: the real module is put back after.
const realWorkflows = { ...(await import("../../hooks/useSyncWorkflows")) };
mock.module("../../hooks/useSyncWorkflows", () => ({
  ...realWorkflows,
  useWorkflowRun: (id: string | null | undefined) => useInboxStore((s: any) => (id ? s.workflowRuns[id] ?? null : undefined)),
  useWorkflow: (id: string | null | undefined) => useInboxStore((s: any) => (id ? s.workflows[id] ?? null : undefined)),
}));
afterAll(() => { mock.module("../../hooks/useSyncWorkflows", () => realWorkflows); });
const { StationStrip, TaskLineChip } = await import("../tasks/StationStrip");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/tasks" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 390 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const TASK_ID = "k97abcdefabcdefabcdefabcdefabcde";
const RUN_ID = "kw1abcdefabcdefabcdefabcdefabcde";
const DEC_ID = "kd1abcdefabcdefabcdefabcdefabcde";
const CONV_ID = "kc1abcdefabcdefabcdefabcdefabcde";
const WF_ID = "kf1abcdefabcdefabcdefabcdefabcde";

const task = (over: Record<string, unknown> = {}) => ({
  _id: TASK_ID, short_id: "ct-1", title: "Ship the strip", task_type: "task", status: "in_review", priority: "medium",
  source: "agent", created_at: 1, updated_at: 1, ...over,
});

const decision = {
  _id: DEC_ID, short_id: "sd-211", conversation_id: CONV_ID, session_id: "s1", question: "Merge as is?",
  options: [{ label: "Yes" }, { label: "No" }], blocking: true, status: "pending", task_id: TASK_ID, station: "in_review", created_at: 5,
};

const run = {
  _id: RUN_ID, status: "running", task_id: TASK_ID, current_node_id: "review", workflow_name: "line", updated_at: 50,
  node_statuses: [
    { node_id: "implement", status: "completed", started_at: 1, completed_at: 10 },
    { node_id: "review", status: "running", started_at: 20, label: "Review", session_id: "sess-r", session: { _id: CONV_ID, title: "Review ct-1", is_active: true } },
  ],
};

beforeEach(() => {
  useInboxStore.setState({ sessionDecisions: {}, workflowRuns: {}, workflows: {}, sessions: {}, teams: [] } as any);
});

async function mount(el: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(el));
  return { container, root };
}

describe("StationStrip", () => {
  test("draws the default stations in order and highlights the current one", async () => {
    const { container, root } = await mount(<StationStrip task={task() as any} />);
    const ids = [...container.querySelectorAll("[data-station]")].map((el) => el.getAttribute("data-station"));
    expect(ids).toEqual(["backlog", "open", "in_progress", "in_review", "done", "dropped"]);
    expect(container.querySelector("[data-current]")?.getAttribute("data-station")).toBe("in_review");
    expect(container.querySelector("[data-station-strip]")?.getAttribute("data-station-strip")).toBe("in_review");
    // Nothing runs and nothing holds: no detail row, no marker.
    expect(container.querySelector("[data-held-by]")).toBeNull();
    expect(container.querySelector("[data-station-detail]")).toBeNull();
    await act(() => root.unmount());
  });

  test("a held task carries the marker on its current station, linking the decision", async () => {
    useInboxStore.setState({ sessionDecisions: { [DEC_ID]: decision } } as any);
    const { container, root } = await mount(<StationStrip task={task() as any} />);
    const marker = container.querySelector("[data-held-by]") as HTMLAnchorElement;
    expect(marker).not.toBeNull();
    expect(marker.getAttribute("data-held-by")).toBe("sd-211");
    expect(marker.getAttribute("href")).toBe("/decisions/sd-211");
    expect(marker.closest("[data-station]")?.getAttribute("data-station")).toBe("in_review");
    await act(() => root.unmount());
  });

  test("a decision bound at another station does not hold", async () => {
    useInboxStore.setState({ sessionDecisions: { [DEC_ID]: { ...decision, station: "in_progress" } } } as any);
    const { container, root } = await mount(<StationStrip task={task() as any} />);
    expect(container.querySelector("[data-held-by]")).toBeNull();
    await act(() => root.unmount());
  });

  test("a live run shows its node, the hand and the elapsed time under the current station", async () => {
    useInboxStore.setState({ workflowRuns: { [RUN_ID]: run } } as any);
    const { container, root } = await mount(<StationStrip task={task({ workflow_run_id: RUN_ID }) as any} />);
    const detail = container.querySelector("[data-station-detail]") as HTMLElement;
    expect(detail).not.toBeNull();
    expect(detail.querySelector("[data-live-node]")?.getAttribute("data-live-node")).toBe("review");
    expect(detail.textContent).toContain("Review");
    const hand = detail.querySelector("[data-hand-state]") as HTMLAnchorElement;
    expect(hand.getAttribute("href")).toBe(`/conversation/${CONV_ID}`);
    expect(hand.textContent).toContain("Review ct-1");
    // The run's own flag says the hand is active; the store holds no row.
    expect(hand.getAttribute("data-hand-state")).toBe("working");
    // Started at t=20ms, so the elapsed reads in days by now.
    expect(detail.textContent).toMatch(/\d+d \d+h/);
    await act(() => root.unmount());
  });

  test("names the live node by the workflow's label when the run row carries only ids", async () => {
    // workflow_runs.get returns the raw row: no current_node_label, no label
    // on node_statuses. The label comes from the workflow in the store.
    const rawRun = {
      _id: RUN_ID, status: "running", task_id: TASK_ID, workflow_id: WF_ID, current_node_id: "review", updated_at: 50,
      node_statuses: [{ node_id: "review", status: "running", started_at: 20 }],
    };
    const workflow = { _id: WF_ID, name: "line", nodes: [{ id: "implement", label: "Implement" }, { id: "review", label: "Review the change" }] };
    useInboxStore.setState({ workflowRuns: { [RUN_ID]: rawRun }, workflows: { [WF_ID]: workflow } } as any);
    const { container, root } = await mount(<StationStrip task={task({ workflow_run_id: RUN_ID }) as any} />);
    const node = container.querySelector("[data-live-node]") as HTMLElement;
    expect(node.getAttribute("data-live-node")).toBe("review");
    expect(node.textContent).toContain("Review the change");
    expect(node.textContent).not.toMatch(/\breview\b/);
    await act(() => root.unmount());
  });

  test("a review verdict renders as a chip even with no run", async () => {
    const { container, root } = await mount(<StationStrip task={task({ review_verdict: { verdict: "changes", at: 1, note: "tests" } }) as any} />);
    expect(container.querySelector("[data-review-verdict]")?.getAttribute("data-review-verdict")).toBe("changes");
    await act(() => root.unmount());
  });
});

describe("TaskLineChip", () => {
  test("says held at the station when a blocking decision holds the task", async () => {
    useInboxStore.setState({ sessionDecisions: { [DEC_ID]: decision }, workflowRuns: { [RUN_ID]: run } } as any);
    const { container, root } = await mount(<TaskLineChip task={task({ workflow_run_id: RUN_ID }) as any} />);
    const chip = container.querySelector("[data-task-line-chip]") as HTMLElement;
    expect(chip.getAttribute("data-task-line-chip")).toBe("held");
    expect(chip.textContent).toContain("held at In Review");
    await act(() => root.unmount());
  });

  test("names the station and the node for a live run, and nothing otherwise", async () => {
    useInboxStore.setState({ workflowRuns: { [RUN_ID]: run } } as any);
    const live = await mount(<TaskLineChip task={task({ workflow_run_id: RUN_ID }) as any} />);
    expect(live.container.querySelector("[data-task-line-chip]")?.textContent).toContain("at In Review · Review");
    await act(() => live.root.unmount());
    // A live run bound to the task by task_id counts even when the task does
    // not name it, so the idle case needs an empty runs collection.
    useInboxStore.setState({ workflowRuns: {} } as any);
    const idle = await mount(<TaskLineChip task={task() as any} />);
    expect(idle.container.querySelector("[data-task-line-chip]")).toBeNull();
    await act(() => idle.root.unmount());
  });
});
