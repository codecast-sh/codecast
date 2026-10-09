// The task page's relation rows (task-graph.md TG12), mounted over fixture
// rows: one Blocked by row holding task blockers and waits with their state,
// a missing blocker named and removable, the link rows only when they have
// something (one line offering the adds that have no row), removal through
// the store actions, and the superseded banner.
// Pills are stubbed to their reference: their own resolution is EntityIdPill's.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const realPill = await import("../EntityIdPill");
mock.module("../EntityIdPill", () => ({
  ...realPill,
  EntityIdPill: ({ shortId, id, type }: any) => <span data-pill={type}>{shortId ?? id}</span>,
}));
// The server has answered for every reference: one the store lacks is gone,
// a PR answers with its checks, and two finished tasks answer, one in this
// workspace and one in another.
const served: Record<string, any> = {
  "o/r#44": { checks_state: "failure" },
  "o/r#45": { checks_state: "pending" },
  "ct-50": { short_id: "ct-50", status: "done", workspace: "team:t1" },
  "ct-51": { short_id: "ct-51", status: "done", workspace: "user:u2" },
};
const realDisplay = await import("../../lib/entityDisplay");
mock.module("../../lib/entityDisplay", () => ({
  ...realDisplay,
  useEntityResolution: (ref: string) => ({ entity: served[ref] ?? null, served: true }),
}));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { SupersededBanner, TaskRelations } = await import("./TaskRelations");

const before = useInboxStore.getState();
afterAll(() => {
  useInboxStore.setState(before, true);
  closeDomWindow(dom);
  restoreGlobals();
});

const WS = "team:t1";
const task = (n: number, over: Record<string, any> = {}) => ({
  _id: `id${n}`, short_id: `ct-${n}`, title: `Task ${n}`, status: "open", priority: "medium", task_type: "task", source: "human",
  workspace: WS, created_at: n, updated_at: n, ...over,
}) as any;
const HOUR = 3_600_000;

const page = task(1, {
  blocked_by: ["ct-2", "ct-3", "ct-404"],
  blocks: ["ct-5"],
  related: ["ct-6"],
  found_during: "ct-7",
  waits: [
    { id: "w1", kind: "pr_merged", repository: "o/r", pr_number: 42, state: "waiting", created_at: 0 },
    { id: "w2", kind: "pr_checks_green", repository: "o/r", pr_number: 43, state: "failed", created_at: 0, note: "closed without merging" },
    { id: "w3", kind: "decision", decision: "sd-4", state: "met", created_at: 0, note: "answered: Ship it" },
    // 1h59m out: the countdown rounds up, so the pill reads the span asked for.
    { id: "w4", kind: "time", at: Date.now() + 2 * HOUR - 60_000, state: "waiting", created_at: 0 },
    { id: "w5", kind: "pr_checks_green", repository: "o/r", pr_number: 44, state: "waiting", created_at: 0 },
    { id: "w6", kind: "pr_checks_green", repository: "o/r", pr_number: 45, state: "waiting", created_at: 0 },
  ],
});
const tasks = Object.fromEntries(
  [page, task(2, { status: "in_progress" }), task(3, { status: "done" }), task(5), task(6), task(7), task(8, { found_during: "ct-1" })].map((t) => [t._id, t]),
);

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, root };
}

const rowOf = (c: HTMLElement, label: string) => c.querySelector(`[data-relation="${label}"]`) as HTMLElement | null;

test("one Blocked by row: tasks then waits, each with its state and a word on where it stands", async () => {
  const removed: string[] = [];
  useInboxStore.setState({
    removeBlocker: (a: string, b: string, forms: string[]) => removed.push(`blocker ${a} ${b} [${forms}]`),
    removeBlocks: (a: string, b: string) => removed.push(`blocks ${a} ${b}`),
    removeWait: (a: string, w: string) => removed.push(`wait ${a} ${w}`),
    unrelateTasks: (a: string, b: string) => removed.push(`unrelate ${a} ${b}`),
  } as any);
  const asked: string[] = [];
  const { container, root } = await mount(<TaskRelations task={page} tasks={tasks} onAdd={(mode) => asked.push(mode)} />);

  const blocked = rowOf(container, "Blocked by")!;
  const lines = [...blocked.querySelectorAll("[data-blocker-state]")] as HTMLElement[];
  expect(lines.map((l) => l.dataset.blockerState)).toEqual(["waiting", "met", "missing", "waiting", "failed", "met", "waiting", "waiting", "waiting"]);
  expect(lines.map((l) => l.textContent)).toEqual([
    "ct-2",
    "ct-3",
    "ct-404not found",
    "o/r#42to merge",
    "o/r#43closed without merging",
    "sd-4answered: Ship it",
    expect.stringMatching(/in 2h$/),
    "o/r#44checks failing",
    "o/r#45checks running",
  ]);
  // Met reads as done; failed, and red checks on an open PR, as red.
  expect(lines[1]!.className).toContain("opacity-60");
  expect(lines[4]!.querySelector("span.text-sol-red")!.textContent).toBe("closed without merging");
  expect(lines[7]!.querySelector("span.text-sol-red")!.textContent).toBe("checks failing");

  // Remove: the missing task blocker, a wait, a Blocks edge (from this
  // task's side, so a drifted mirror still goes) and a related link, each through its store action.
  const remove = (scope: HTMLElement, label: string) => (scope.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click();
  await act(async () => {
    remove(lines[2]!, "Remove blocker ct-404");
    remove(lines[3]!, "Remove the wait on PR o/r#42");
    remove(rowOf(container, "Blocks")!, "ct-5 stops waiting on ct-1");
    remove(rowOf(container, "Related")!, "Unlink ct-6");
  });
  // One blocker write names the edge once and paints every form it is stored under.
  expect(removed).toEqual(["blocker ct-1 ct-404 [ct-404]", "wait ct-1 w1", "blocks ct-1 ct-5", "unrelate ct-1 ct-6"]);

  expect(rowOf(container, "Found during")!.textContent).toContain("ct-7");
  expect(rowOf(container, "Found here")!.textContent).toContain("ct-8");

  const addIn = (label: string, text: string) => [...rowOf(container, label)!.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
  await act(async () => { addIn("Blocked by", "Add blocker").click(); addIn("Related", "Link related").click(); });
  // No parent: its add sits on the closing line.
  expect(rowOf(container, "Parent")).toBeNull();
  await act(async () => { addIn("add", "Set parent").click(); });
  expect(asked).toEqual(["blocker", "related", "parent"]);
  root.unmount();
});

test("a task with no relations shows the blocker add and one line for the other adds", async () => {
  const lone = task(9);
  const { container, root } = await mount(<TaskRelations task={lone} tasks={{ id9: lone }} onAdd={() => {}} />);
  expect([...container.querySelectorAll("[data-relation]")].map((r) => (r as HTMLElement).dataset.relation)).toEqual(["Blocked by", "add"]);
  expect(rowOf(container, "Blocked by")!.textContent).toBe("Blocked byAdd blocker…b");
  expect(rowOf(container, "add")!.textContent).toBe("Link related…kSet parent…t");
  root.unmount();
});

test("a blocker the store lacks: met from the server in this workspace, status unknown from another", async () => {
  // Readiness never reads across workspaces, so the line agrees: still waiting.
  const held = task(11, { blocked_by: ["ct-50", "ct-51"] });
  const { container, root } = await mount(<TaskRelations task={held} tasks={{ id11: held }} onAdd={() => {}} />);
  const lines = [...container.querySelectorAll("[data-blocker-state]")] as HTMLElement[];
  expect(lines.map((l) => [l.dataset.blockerState, l.textContent])).toEqual([["met", "ct-50"], ["waiting", "ct-51status unknown"]]);
  root.unmount();
});

test("on a closed task a failed wait holds nothing, so it draws dim", async () => {
  const dropped = task(10, { status: "dropped", waits: [page.waits[1]] });
  const { container, root } = await mount(<TaskRelations task={dropped} tasks={{ id10: dropped }} onAdd={() => {}} />);
  const line = container.querySelector("[data-blocker-state=failed]") as HTMLElement;
  expect(line.className).toContain("opacity-60");
  expect(line.querySelector(".text-sol-red")).toBeNull();
  expect(line.textContent).toBe("o/r#43closed without merging");
  root.unmount();
});

test("a superseded task names its replacement at the top", async () => {
  const { container, root } = await mount(<><SupersededBanner task={{ superseded_by: "ct-12" }} /><SupersededBanner task={{}} /></>);
  expect(container.querySelectorAll("[data-superseded]")).toHaveLength(1);
  expect(container.textContent).toBe("Superseded byct-12");
  root.unmount();
});
