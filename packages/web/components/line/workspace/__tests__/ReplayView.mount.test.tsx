// Mounts a run's detail (line-workspace.md LW1) on the real AgentWatch graph
// and Union's ct-57382 run in jsdom: the source band from the problem's
// findings, the numbered trace, and the open step's In (the prompt its
// session was handed), Ran (its last message) and Out (the next step, which
// a click opens).
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line?view=runs", pretendToBeVisual: true });
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
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
const realSync = await import("../../../../hooks/useSyncCollection");
mock.module("../../../../hooks/useSyncCollection", () => ({ ...realSync, useSyncCollection: () => ({ ready: true }) }));
const realMessages = await import("../../../../hooks/useConversationMessages");
mock.module("../../../../hooks/useConversationMessages", () => ({
  ...realMessages,
  useConversationMessages: (id: string) => ({
    conversation: { _id: id, message_count: 3, messages: [
      { _id: "m1", role: "user", content: "brief" },
      { _id: "m2", role: "assistant", content: "", tool_calls: [{}, {}] },
      { _id: "m3", role: "assistant", content: "Absorbed 174 of 175 findings into C1.", timestamp: 5 },
    ] },
  }),
}));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { ReplayView } = await import("../views/ReplayView");
const { buildLineModel } = await import("../../../../lib/line/lineModel");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");
const { agentwatchGraph } = await import("../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run } = await import("../../../../lib/line/__tests__/unionLineRuns.fixture");

const run = { ...union57382Run, task_id: "t1", workflow_slug: "agentwatch", updated_at: union57382Run.updated_at ?? union57382Run.created_at } as any;
const tasks = [{ _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1 }];
const model = buildLineModel({ runs: [run], tasks: tasks as any, graph: agentwatchGraph, now: 1_791_500_000_000 }, "agentwatch");
const signals = [{
  _id: "s1", short_id: "sg-684", source: "agentwatch", judge: "comms", title: "Per-send sender identity re-rolls the persona",
  detail_md: "**Contact met two personas** (severity 9/10)\n\n> From now I'll start to classify all your emails as spam\n",
  evidence_url: "https://admin.example/agent-watch?cluster=1", observed_at: 10, created_at: 10, task_id: "t1",
}, { _id: "s2", source: "agentwatch", title: "Another", observed_at: 9, created_at: 9, task_id: "t1" }];
const brief = "# Task: Dissolve\nYou are the first look at one AgentWatch cluster.";

useInboxStore.setState({
  currentUser: { _id: "u1", name: "Me" },
  lineLabels: {},
  workflowRuns: { [run._id]: run },
  stationInputs: { conv_jx71v45: { _id: "conv_jx71v45", conversation_id: "conv_jx71v45", text: brief, truncated: false, at: 1, found: true } },
} as any);

const selects: any[] = [];
let root: ReturnType<typeof createRoot>;
const host = document.createElement("div");
document.body.appendChild(host);
async function render(search: string) {
  const selection = readLineSelection(new URLSearchParams(search));
  const el = React.createElement(ReplayView, { model, workspace: { rows: { signals, runs: [run], tasks, decisions: [] }, now: 1 } as any, selection, select: (p: any, c?: any) => selects.push({ ...p, runCase: c }), href: () => "#" });
  await act(async () => { (root ??= createRoot(host)).render(el); });
}
const q = (s: string) => host.querySelector(s) as HTMLElement | null;

test("the source band names the source, judge, severity, count, quote and evidence", async () => {
  await render(`view=runs&run=${run._id}&step=dissolve`);
  const src = q("[data-run-source]")!;
  expect(src.dataset.runSource).toBe("agentwatch");
  expect(src.textContent).toContain("comms");
  expect(src.textContent).toContain("sev9");
  expect(src.textContent).toContain("2 findings");
  expect(src.textContent).toContain("classify all your emails as spam");
  expect(src.querySelector("a[href^='https://admin.example']")).not.toBeNull();
});

test("the trace numbers every visit, and the open step shows In, Ran and Out", async () => {
  await render(`view=runs&run=${run._id}&step=dissolve`);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-run-step]")];
  expect(rows.length).toBe(model.runs[0].visits.length);
  expect(rows[0].querySelector(".rd-n")?.textContent).toBe("01");
  expect(q('[data-run-step="dissolve"]')?.getAttribute("aria-selected")).toBe("true");
  expect(q('[data-io="in"]')?.textContent).toContain("You are the first look at one AgentWatch cluster.");
  const ran = q('[data-io="ran"]')!.textContent!;
  expect(ran).toContain("Absorbed 174 of 175 findings into C1.");
  expect(ran).toContain("2 tools");
  expect(q('[data-io="out"] [data-replay-next]')?.textContent).toContain(model.runs[0].visits[model.runs[0].visits.findIndex((v) => v.node === "dissolve") + 1].label);
});

test("Out's next step and a trace row open that step", async () => {
  await render(`view=runs&run=${run._id}&step=dissolve`);
  await act(async () => { q('[data-io="out"] [data-replay-next]')!.click(); });
  const next = model.runs[0].visits[model.runs[0].visits.findIndex((v) => v.node === "dissolve") + 1].node;
  expect(selects.at(-1)).toMatchObject({ step: next });
  await act(async () => { q('[data-run-step="bind"]')!.click(); });
  expect(selects.at(-1)).toMatchObject({ step: "bind" });
});

test("a run the drawn process does not hold opens nothing in its place", async () => {
  await render(`view=runs&run=run_of_another_graph&case=t1`);
  expect(q("[data-replay-step]")).toBeNull();
  expect(q("[data-line-run-missing]")?.dataset.lineRunMissing).toBe("run_of_another_graph");
});

test("a script step's command shows the values it ran with, its names on hover", async () => {
  const { runVars, varValue } = await import("../../../../lib/line/runTrace");
  const vars = runVars(model.runs[0], { node_statuses: [{ node_id: "bind", status: "completed", result_preview: '{"attempt_id":"att_9"}' }] });
  expect(varValue("bind.json.attempt_id", vars)).toBe("att_9");
  expect(varValue("bind.output", vars)).toBe('{"attempt_id":"att_9"}');
  expect(varValue("task_id", vars)).toBe("t1");
  expect(varValue("nobody.json.x", vars)).toBeNull();
});
