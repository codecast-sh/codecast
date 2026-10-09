// The task page's relation rows (task-graph.md TG12), mounted over fixture
// rows: one Blocked by row holding task blockers and waits with their state,
// a missing blocker named and offered for removal, the link rows only when
// they have something (one line offering the adds that have no row), a stale
// `blocks` mirror left out, removal through the store actions, and the
// superseded banner. The parent is the page's breadcrumb, so no row here.
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
  // `wide` is what gives a pill min-w-0/max-w-full/truncate, so the stub
  // records it: a row that forgets it overflows instead of shrinking.
  EntityIdPill: ({ shortId, id, type, wide }: any) => <span data-pill={type} data-wide={wide ? "1" : undefined}>{shortId ?? id}</span>,
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
const { SupersededBanner, TaskRelationAdds, TaskRelations } = await import("./TaskRelations");

// The card renders the rows and then, below its static facts, the adds that
// have no row of their own (TaskRelationAdds): one container here stands for
// that card, so the "add" row is asserted where a reader meets it.
const Card = (props: { task: any; tasks: Record<string, any>; onAdd: (mode: any) => void }) => (
  <>
    <TaskRelations {...props} />
    <TaskRelationAdds {...props} />
  </>
);

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
  // ct-5 still waits on this task; ct-12's row says it no longer does (a
  // stale mirror); ct-99 is not loaded, so its entry stands.
  blocks: ["ct-5", "ct-12", "ct-99"],
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
  [page, task(2, { status: "in_progress" }), task(3, { status: "done" }), task(5, { blocked_by: ["ct-1"] }), task(6), task(7), task(8, { found_during: "ct-1" }), task(12)].map((t) => [t._id, t]),
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
    updateTask: (a: string, fields: Record<string, unknown>) => removed.push(`update ${a} found_during=${JSON.stringify(fields.found_during)}`),
  } as any);
  const asked: string[] = [];
  const { container, root } = await mount(<Card task={page} tasks={tasks} onAdd={(mode) => asked.push(mode)} />);

  const blocked = rowOf(container, "Blocked by")!;
  const lines = [...blocked.querySelectorAll("[data-blocker-state]")] as HTMLElement[];
  // The reading order, not the storage order (`blockerBand`): the failed wait
  // that needs a re-plan, then everything still holding the task in the order
  // it is stored, then the history that holds nothing. Nine lines whose live
  // holds were interleaved with cleared ones left the glyph's colour as the
  // only thing separating "why am I stuck" from "what already happened".
  expect(lines.map((l) => l.dataset.blockerState)).toEqual(["failed", "waiting", "missing", "waiting", "waiting", "waiting", "waiting", "met", "met"]);
  expect(lines.map((l) => l.textContent)).toEqual([
    "o/r#43closed without merging",
    "ct-2",
    // ct-404 is not in the store and this row carries no server answer for
    // it, so the entry reads `unknown`, which blocks (TG1) and bands with the
    // live holds; the LINE then resolves it to "not found" from the entity
    // cache. A row whose server snapshot marks it missing (graph_status) bands
    // with the history instead, where it holds nothing.
    "ct-404not foundRemove",
    "o/r#42to merge",
    expect.stringMatching(/in 2h$/),
    "o/r#44checks failing",
    "o/r#45checks running",
    "ct-3",
    "sd-4answered: Ship it",
  ]);
  // Met reads as done; failed, and red checks on an open PR, as red.
  expect(lines[7]!.className).toContain("opacity-60");
  expect(lines[0]!.querySelector("span.text-sol-red")!.textContent).toBe("closed without merging");
  expect(lines[5]!.querySelector("span.text-sol-red")!.textContent).toBe("checks failing");
  // A glyph is all a met line carries, so its accessible name says what is
  // met rather than the bare state value. A missing line prints "not found"
  // itself, so its glyph is decoration and says nothing.
  const glyphLabel = (l: HTMLElement) => l.querySelector("[role=img]")?.getAttribute("aria-label") ?? null;
  expect([glyphLabel(lines[1]!), glyphLabel(lines[7]!), glyphLabel(lines[2]!), glyphLabel(lines[3]!), glyphLabel(lines[0]!)])
    .toEqual(["still waiting on this blocker", "blocker met", null, "still waiting on this wait", "wait failed, needs a re-plan"]);

  // The same words on hover as in the accessible name, on the glyph's gutter:
  // a failed wait's state is the one thing on this page carrying an
  // instruction, so a sighted reader gets it too.
  const titles = (l: HTMLElement) => [...l.querySelectorAll("span[title]")].map((s) => s.getAttribute("title"));
  expect(titles(lines[0]!)[0]).toBe("wait failed, needs a re-plan");
  // A line's detail truncates at 45% of the column, so its word carries the
  // whole text on hover the way the time pill carries its date.
  expect([titles(lines[2]!), titles(lines[8]!), titles(lines[5]!)])
    .toEqual([["not found"], ["wait met", "answered: Ship it"], ["still waiting on this wait", "checks failing"]]);

  // A failed wait never settles, so the row says what to do about it once,
  // under the lines and above the add that replaces it (TG2).
  expect(blocked.querySelector("[data-lost-wait-hint=failed]")!.textContent)
    .toBe("A failed wait never clears: remove it, or add a new blocker in its place.");
  // Nothing here is overdue, so the row says nothing about a lost settle job.
  expect(blocked.querySelector("[data-lost-wait-hint=stalled]")).toBeNull();

  // Every value in the grid starts at one left edge: each line opens with the
  // glyph's gutter, whether or not the line has a glyph.
  const valueLines = [...container.querySelectorAll("[data-relation] [class*='group/line']")] as HTMLElement[];
  // 9 blockers and waits, 2 of Blocks, and one each of Found during, Found during this and Related.
  expect(valueLines.length).toBe(14);
  for (const l of valueLines) expect((l.firstElementChild as HTMLElement).className).toContain("w-3");

  // Blocks lists what the server's reader lists: the live dependent and the
  // one no row answers for, never the entry ct-12's row has moved on from.
  expect(rowOf(container, "Blocks")!.textContent).toBe("Blocksct-5ct-99Add blocked task…");

  // Remove: the missing task blocker, a wait, a Blocks edge (from this
  // task's side, so a drifted mirror still goes) and a related link, each through its store action.
  const remove = (scope: HTMLElement, label: string) => (scope.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click();
  await act(async () => {
    remove(lines[2]!, "Remove blocker ct-404");
    remove(lines[3]!, "Remove the wait on PR o/r#42");
    remove(rowOf(container, "Blocks")!, "Stop ct-5 waiting on this");
    remove(rowOf(container, "Related")!, "Unlink ct-6");
    // The server GUESSES found_during from the filing session's bound task
    // (TG5), so the page that shows a wrong one can clear it: "" is the clear
    // the CLI's --found-during none writes.
    remove(rowOf(container, "Found during")!, "Clear ct-7 as where this was found");
  });
  // One blocker write names the edge once and paints every form it is stored under.
  expect(removed).toEqual([
    "blocker ct-1 ct-404 [ct-404]", "wait ct-1 w1", "blocks ct-1 ct-5", "unrelate ct-1 ct-6",
    'update ct-1 found_during=""',
  ]);

  expect(rowOf(container, "Found during")!.textContent).toContain("ct-7");
  // The mirror, derived from other rows: read-only, so it offers no remove.
  const mirror = rowOf(container, "Found during this")!;
  expect(mirror.textContent).toContain("ct-8");
  expect(mirror.querySelector("button")).toBeNull();

  const addIn = (label: string, text: string) => [...rowOf(container, label)!.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
  await act(async () => { addIn("Blocked by", "Add blocker").click(); addIn("Related", "Link related").click(); });
  // A link the server guessed is repointable from its own row, not only clearable.
  await act(async () => { addIn("Found during", "Change what this was found during").click(); });
  // No parent: its add sits on the closing line.
  expect(rowOf(container, "Parent")).toBeNull();
  await act(async () => { addIn("add", "Set parent").click(); });
  expect(asked).toEqual(["blocker", "related", "found_during", "parent"]);
  root.unmount();
});

test("a task with no relations shows the blocker add and one line for the other adds", async () => {
  const lone = task(9);
  const { container, root } = await mount(<Card task={lone} tasks={{ id9: lone }} onAdd={() => {}} />);
  expect([...container.querySelectorAll("[data-relation]")].map((r) => (r as HTMLElement).dataset.relation)).toEqual(["Blocked by", "add"]);
  expect(rowOf(container, "Blocked by")!.textContent).toBe("Blocked byAdd blocker…b");
  // Every add with no row of its own closes the card on one line, in the order
  // the rows themselves run (Blocks, Found during, Related), so an add never
  // changes place as rows appear.
  expect(rowOf(container, "add")!.textContent).toBe("Make a task wait on this…Set what this was found during…Link related task…kSet parent…t");
  root.unmount();
});

test("a subtask states its parent once, on the page's breadcrumb: no row and no offer here", async () => {
  const child = task(13, { parent_id: "id1" });
  const { container, root } = await mount(<Card task={child} tasks={{ id1: page, id13: child }} onAdd={() => {}} />);
  expect([...container.querySelectorAll("[data-relation]")].map((r) => (r as HTMLElement).dataset.relation)).toEqual(["Blocked by", "add"]);
  expect(rowOf(container, "add")!.textContent).toBe("Make a task wait on this…Set what this was found during…Link related task…k");
  root.unmount();
});

test("a blocker the store lacks: met from the server in this workspace, status unknown from another", async () => {
  // Readiness never reads across workspaces, so the line agrees: still waiting.
  const held = task(11, { blocked_by: ["ct-50", "ct-51"] });
  const { container, root } = await mount(<Card task={held} tasks={{ id11: held }} onAdd={() => {}} />);
  const lines = [...container.querySelectorAll("[data-blocker-state]")] as HTMLElement[];
  expect(lines.map((l) => [l.dataset.blockerState, l.textContent])).toEqual([["met", "ct-50"], ["waiting", "ct-51status unknown"]]);
  root.unmount();
});

test("two failed waits say so in the plural: the hint names what to remove", async () => {
  // A PR closing fails its merge wait and its checks wait together, so one
  // failed wait is not the ordinary case.
  const both = task(17, {
    waits: [
      { id: "f1", kind: "pr_merged", repository: "o/r", pr_number: 43, state: "failed", created_at: 0, note: "closed without merging" },
      { id: "f2", kind: "pr_checks_green", repository: "o/r", pr_number: 43, state: "failed", created_at: 0, note: "closed without merging" },
    ],
  });
  const { container, root } = await mount(<Card task={both} tasks={{ id17: both }} onAdd={() => {}} />);
  expect(container.querySelector("[data-lost-wait-hint=failed]")!.textContent)
    .toBe("Failed waits never clear: remove them, or add new blockers in their place.");
  root.unmount();
});

test("a time wait whose moment went by unsettled reads as lost, not as patience", async () => {
  // Its glyph is the ordinary waiting hourglass and its pill is an ordinary
  // moment, so the word is the only thing on the line that can say no wake is
  // coming (`isStalledTimeWait`, the predicate the CLI parks an agent by).
  const late = task(18, {
    waits: [
      { id: "s1", kind: "time", at: Date.now() - 3 * 24 * HOUR, state: "waiting", created_at: 0 },
      { id: "f1", kind: "pr_merged", repository: "o/r", pr_number: 43, state: "failed", created_at: 0, note: "closed without merging" },
    ],
  });
  const { container, root } = await mount(<Card task={late} tasks={{ id18: late }} onAdd={() => {}} />);
  const lines = [...container.querySelectorAll("[data-blocker-state]")] as HTMLElement[];
  // The failed wait leads; the stalled one still holds, so it bands above the
  // history and reads red like the failed cause above it.
  expect(lines.map((l) => l.querySelector("span.text-sol-red")?.textContent ?? null))
    .toEqual(["closed without merging", "overdue by 3d"]);
  // Two kinds of lost wait, two remedies, each in the number of its own lines.
  expect([...container.querySelectorAll("[data-lost-wait-hint]")].map((h) => h.textContent)).toEqual([
    "A failed wait never clears: remove it, or add a new blocker in its place.",
    "A wait whose moment has gone by was never settled, so no wake is coming: remove it, or add a new blocker in its place.",
  ]);
  root.unmount();
});

test("on a closed task a failed wait holds nothing, so it draws dim", async () => {
  const dropped = task(10, { status: "dropped", waits: [page.waits[1]] });
  const { container, root } = await mount(<Card task={dropped} tasks={{ id10: dropped }} onAdd={() => {}} />);
  const line = container.querySelector("[data-blocker-state=failed]") as HTMLElement;
  expect(line.className).toContain("opacity-60");
  expect(line.querySelector(".text-sol-red")).toBeNull();
  expect(line.textContent).toBe("o/r#43closed without merging");
  root.unmount();
});

test("every blocker cleared: the row says so, in the words the phone uses", async () => {
  // ct-3 is done and the wait is met, so nothing holds ct-14 (`isUnblocked`).
  const clear = task(14, { blocked_by: ["ct-3"], waits: [page.waits[2]] });
  const { container, root } = await mount(<Card task={clear} tasks={{ ...tasks, id14: clear }} onAdd={() => {}} />);
  const row = rowOf(container, "Blocked by")!;
  const verdict = row.querySelector("[data-unblocked]") as HTMLElement;
  expect(verdict.className).toContain("text-sol-green");
  // The verdict scans as a state like its siblings: the met glyph sits in the
  // same gutter every line's glyph does.
  expect(verdict.firstElementChild!.className).toContain("w-3");
  expect(verdict.querySelector("svg")!.getAttribute("class")).toContain("text-sol-green");
  // The verdict leads, level with the label, and the cleared lines follow.
  expect(row.textContent).toBe("Blocked byunblockedct-3sd-4answered: Ship itAdd blocker…b");
  // Still holding: no verdict.
  const { container: held, root: heldRoot } = await mount(<Card task={page} tasks={tasks} onAdd={() => {}} />);
  expect(held.querySelector("[data-unblocked]")).toBeNull();
  root.unmount();
  heldRoot.unmount();
});

test("a closed task keeps its history and is offered no add", async () => {
  // ct-99 is in no fixture row, so the mirror stands (blocksOf keeps a ref
  // the store cannot judge) and the Blocks row has a line to head.
  const done = task(15, { status: "done", blocked_by: ["ct-3"], blocks: ["ct-99"] });
  const { container, root } = await mount(<Card task={done} tasks={{ ...tasks, id15: done }} onAdd={() => {}} />);
  // Nothing holds a closed task, so it says neither "unblocked" nor "Add
  // blocker…"; its heading says its lines are history, as `cast task show` does.
  expect(rowOf(container, "Blocked by (cleared)")!.textContent).toBe("Blocked by (cleared)ct-3");
  expect(rowOf(container, "Blocked by")).toBeNull();
  // The same edge from the other side holds nothing either, and its rows carry
  // their own live status, so that heading says cleared too (`blocksLabel`).
  expect(rowOf(container, "Blocks (cleared)")!.textContent).toBe("Blocks (cleared)ct-99");
  expect(rowOf(container, "Blocks")).toBeNull();
  // A closed task holds nothing, so no blocker adds; its provenance is still correctable.
  expect(rowOf(container, "add")!.textContent).toBe("Set what this was found during…Link related task…kSet parent…t");
  root.unmount();
  // With no blockers left, the row itself drops out.
  const bare = task(16, { status: "dropped" });
  const { container: c2, root: r2 } = await mount(<Card task={bare} tasks={{ id16: bare }} onAdd={() => {}} />);
  expect([...c2.querySelectorAll("[data-relation]")].map((r) => (r as HTMLElement).dataset.relation)).toEqual(["add"]);
  r2.unmount();
});

test("every add on a row with lines indents into the glyph gutter", async () => {
  const { container, root } = await mount(<Card task={page} tasks={tasks} onAdd={() => {}} />);
  const addIn = (label: string) => [...rowOf(container, label)!.querySelectorAll("button")].find((b) => b.textContent?.includes("…"))!;
  for (const label of ["Blocked by", "Blocks", "Related"]) {
    expect(addIn(label).querySelector("svg")).not.toBeNull();
  }
  // Found during's add is a repoint, so it carries no plus — and then takes
  // the gutter instead, or its text would start 18px left of the pill above it.
  const repoint = addIn("Found during");
  expect(repoint.querySelector("svg")).toBeNull();
  expect((repoint.firstElementChild as HTMLElement).className).toContain("w-3");
  // The closing adds are the first line of their own row, so no gutter there.
  expect((addIn("add").firstElementChild as HTMLElement | null)?.className ?? "").not.toContain("w-3");
  root.unmount();
});

test("a superseded task names its replacement at the top", async () => {
  const { container, root } = await mount(<><SupersededBanner task={{ superseded_by: "ct-12" }} /><SupersededBanner task={{}} /></>);
  expect(container.querySelectorAll("[data-superseded]")).toHaveLength(1);
  expect(container.textContent).toBe("Superseded byct-12");
  // The pill is the element that shrinks, so a long replacement title cannot
  // push past the banner in the inline peek's narrow value column.
  expect((container.querySelector("[data-superseded]") as HTMLElement).className).toContain("min-w-0");
  expect(container.querySelector("[data-superseded] [data-pill]")!.getAttribute("data-wide")).toBe("1");
  root.unmount();
});
