// useRunWorkflow draws the graph a run pinned (ct-98653), and the run's row
// when there is no pinned graph to draw: a version that kept none, or a
// backend from before the pinned-graph query, whose refusal must not leave
// the card loading forever.
// Run: bun test hooks/useRunWorkflow.mount.test.tsx
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

// What each feeder answers: the pinned-graph query by the case under test, every other feeder ready.
let pinnedAnswer: { ready: boolean; error?: Error } = { ready: true };
const realSyncCollection = { ...(await import("./useSyncCollection")) };
mock.module("./useSyncCollection", () => ({
  ...realSyncCollection,
  useSyncCollection: (_key: string, query: any) => (getFunctionName(query) === "workflow_runs:pinnedGraphOfRun" ? pinnedAnswer : { ready: true }),
}));
afterAll(() => { mock.module("./useSyncCollection", () => realSyncCollection); });

const { useInboxStore } = await import("../store/inboxStore");
const { useRunWorkflow } = await import("./useSyncWorkflows");

const RUN = { _id: "r1", workflow_id: "wf1", graph_version_id: "v1" };
const ROW = { _id: "wf1", name: "change", slug: "change", nodes: [{ id: "fix" }], edges: [] };
const PINNED = { _id: "v1", workflow_id: "wf1", name: "change", slug: "change", nodes: [{ id: "decide__decide" }], edges: [] };

let seen: any = "unset";
function Probe() {
  seen = useRunWorkflow(RUN);
  return null;
}
async function draw() {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
}

beforeEach(() => {
  seen = "unset";
  useInboxStore.setState((s: any) => ({ workflows: { ...(s.workflows ?? {}), wf1: ROW }, runGraphs: {} }));
});

test("the pinned graph, keyed back to its row", async () => {
  pinnedAnswer = { ready: true };
  useInboxStore.setState({ runGraphs: { v1: PINNED } } as any);
  await draw();
  expect(seen).toMatchObject({ _id: "wf1", version_id: "v1", nodes: [{ id: "decide__decide" }] });
});

test("still loading while the pinned-graph query has not answered", async () => {
  pinnedAnswer = { ready: false };
  await draw();
  expect(seen).toBeUndefined();
});

test("a backend without the pinned-graph query draws the row instead of loading forever", async () => {
  pinnedAnswer = { ready: false, error: new Error("Could not find public function for 'workflow_runs:pinnedGraphOfRun'") };
  await draw();
  expect(seen).toMatchObject({ _id: "wf1", nodes: [{ id: "fix" }] });
});
