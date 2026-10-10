// Mounts the Chat view (line-workspace.md LW1, LW4) on the real AgentWatch
// graph in jsdom: the opening line and the graph, the line as a spine that
// opens a step, the thread from the store with a reply whose ```line block
// draws a live widget from this workspace's model, and a send that paints at
// once as an echo with what the person has open.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

// Generous: a loaded machine takes seconds to mount the real graph.
setDefaultTimeout(60_000);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line/pj-aq?view=chat", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
const realSync = await import("../../../../hooks/useSyncCollection");
mock.module("../../../../hooks/useSyncCollection", () => ({ ...realSync, useSyncCollection: () => ({ ready: true }) }));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { ChatView } = await import("../views/ChatView");
// The fence renderer loads its widget lazily; loaded here, the lazy import resolves at once.
await import("../../widgets/LineFence");
const { buildLineModel } = await import("../../../../lib/line/lineModel");
const { readLineSelection } = await import("../../../../lib/line/lineWorkspaceUrl");
const { agentwatchGraph } = await import("../../../../lib/line/__tests__/agentwatchGraph.fixture");
const { union57382Run, union57467Run } = await import("../../../../lib/line/__tests__/unionLineRuns.fixture");

const aw = (run: any, task: string) => ({ ...run, task_id: task, workflow_slug: "agentwatch", updated_at: run.updated_at ?? run.created_at });
const runs = [aw(union57382Run, "t1"), aw(union57467Run, "t2")];
const tasks = [
  { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1 },
  { _id: "t2", short_id: "ct-57467", title: "A message leads with the result", status: "open", created_at: 1 },
];
const model = buildLineModel({ runs: runs as any, tasks: tasks as any, graph: agentwatchGraph, now: 1_791_500_000_000 }, "agentwatch");
const project = { _id: "p1", short_id: "pj-aq", title: "Agent Quality" };
const reply = 'Dissolve hands most clusters to Investigate.\n\n```line\n{"widget":"step","project":"pj-aq","graph":"agentwatch","step":"dissolve"}\n```';

useInboxStore.setState({
  currentUser: { _id: "u1", name: "Me" },
  projects: { p1: project },
  lineChats: {
    p1: {
      _id: "p1", project_id: "p1",
      owner: { conversation_id: "c1", short_id: "jxlead1", name: "Agent Quality lead", via: "lead" },
      turns: [
        { client_id: "a", text: "What does Dissolve do?", at: 10, graph: "agentwatch", conversation_id: "c1", delivered: true, reply: { text: reply, at: 20 } },
        { client_id: "b", text: "And Refine?", at: 30, graph: "agentwatch", conversation_id: "c1", delivered: true, reply: null },
      ],
    },
  },
} as any);

const selects: any[] = [];
let root: ReturnType<typeof createRoot>;
const host = document.createElement("div");
document.body.appendChild(host);

async function render(search: string) {
  const selection = readLineSelection(new URLSearchParams(search));
  const el = React.createElement(ChatView, { model, workspace: { project } as any, selection, select: (p: any, c?: any) => selects.push({ ...p, runCase: c }), href: () => "#" });
  await act(async () => { (root ??= createRoot(host)).render(el); });

}
const q = (s: string) => host.querySelector(s) as HTMLElement | null;

test("it opens with the line in its own numbers, the graph and the spine", async () => {
  await render("view=chat");
  expect(q(".lwc-say")?.textContent).toContain("2 runs so far");
  expect(q("[data-line-chat-graph]")).not.toBeNull();
  const rail = [...host.querySelectorAll("[data-line-chat-step]")].map((b) => b.getAttribute("data-line-chat-step"));
  expect(rail).toContain("dissolve");
  expect(host.querySelectorAll("[data-line-chat-suggest] button").length).toBeGreaterThan(0);
  expect(q(".lwc-goes")?.textContent).toContain("Agent Quality lead");
});

test("the thread shows each ask, the reply with a live widget from this model, and who is answering", async () => {
  await render("view=chat");
  for (let i = 0; i < 20 && !host.querySelector("[data-line-fence]"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  const bubbles = [...host.querySelectorAll(".lwc-bubble")].map((b) => b.textContent);
  expect(bubbles).toEqual(["What does Dissolve do?", "And Refine?"]);
  expect(q("[data-line-chat-reply]")?.textContent).toContain("Dissolve hands most clusters");
  const fence = q('[data-line-chat-reply] [data-line-fence="step"]');
  expect(fence).not.toBeNull();
  expect(fence?.textContent).toContain(model.steps.dissolve.label);
  expect(q("[data-line-chat-waiting]")?.textContent).toContain("Agent Quality lead has it");
});

test("a step on the spine opens its drawer", async () => {
  await render("view=chat");
  await act(async () => { q('[data-line-chat-step="dissolve"]')!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  expect(selects.at(-1)).toMatchObject({ step: "dissolve" });
});

test("with a step open the composer says so, and a send paints at once", async () => {
  await render("view=chat&step=dissolve");
  expect(q(".lwc-focus")?.textContent).toBe(`Looking at ${model.steps.dissolve.label}`);
  const box = q("[data-line-chat-input]") as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(box, "Why so many dissolved?");
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  expect(box.value).toBe("Why so many dissolved?");
  await act(async () => { (q(".lwc-send") as HTMLButtonElement).click(); });
  const sends = (useInboxStore.getState() as any).lineChatSends.p1 ?? [];
  console.log("PROBE", JSON.stringify((useInboxStore.getState() as any).lineChatSends), typeof (useInboxStore.getState() as any).sendLineChat, host.querySelector(".lwc-send")?.hasAttribute("disabled"));
  expect(sends.map((s: any) => s.text)).toEqual(["Why so many dissolved?"]);
  expect([...host.querySelectorAll(".lwc-bubble")].map((b) => b.textContent)).toContain("Why so many dissolved?");
});
