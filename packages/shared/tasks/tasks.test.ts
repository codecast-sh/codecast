import { describe, expect, test } from "bun:test";
import {
  MAX_TASK_DEPTH,
  buildTaskTree,
  descendantCounts,
  directChildren,
  hiddenDescendantCount,
  isActiveTask,
  isCountableSubtask,
  isHumanOrigin,
  subtaskProgressOf,
  taskDepth,
  taskFamilyIndex,
  taskOrigin,
  wouldCreateTaskCycle,
} from "./index";

// Minimal row shape: the tree builder only reads _id and parent_id, so tests
// carry a `title` purely to make failures readable.
type Row = { _id: string; short_id: string; parent_id?: string | null; title?: string };
const t = (id: string, parent?: string): Row => ({
  _id: id,
  short_id: `ct-${id}`,
  ...(parent ? { parent_id: parent } : {}),
});
const order = (rows: { task: Row }[]) => rows.map((r) => r.task._id);

describe("taskOrigin", () => {
  test("human source is human", () => {
    expect(taskOrigin({ source: "human" })).toBe("human");
  });

  test("meeting is its own origin, not lumped in with agent work", () => {
    expect(taskOrigin({ source: "meeting" })).toBe("meeting");
    expect(taskOrigin({ source: "agent" })).toBe("agent");
  });

  // The huddle's complaint was noise leaking onto the human board, so the
  // default for anything unrecognised is the quiet class, never the loud one.
  test("every other source — including unknown ones — counts as agent", () => {
    for (const source of ["insight", "import", "plan_mode", "todo_sync", "template", "fork", "brand_new", undefined]) {
      expect(taskOrigin({ source } as any)).toBe("agent");
    }
  });

  test("isHumanOrigin covers human and meeting only", () => {
    expect(isHumanOrigin({ source: "human" })).toBe(true);
    expect(isHumanOrigin({ source: "meeting" })).toBe(true);
    expect(isHumanOrigin({ source: "agent" })).toBe(false);
    expect(isHumanOrigin({ source: "todo_sync" })).toBe(false);
  });
});

describe("buildTaskTree", () => {
  test("children follow their parent, and input order is kept per level", () => {
    const rows = buildTaskTree([t("a"), t("b"), t("a1", "a"), t("a2", "a"), t("b1", "b")]);
    expect(order(rows)).toEqual(["a", "a1", "a2", "b", "b1"]);
  });

  test("depth and indent track nesting", () => {
    const rows = buildTaskTree([t("a"), t("a1", "a"), t("a1x", "a1")]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2]);
  });

  // "The UI should emphasise the top two levels" — a deeper task still renders,
  // it just stops marching right.
  test("indent clamps at maxDepth while true depth keeps counting", () => {
    const rows = buildTaskTree([t("a"), t("b", "a"), t("c", "b"), t("d", "c"), t("e", "d")]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2, 2, 2]);
    expect(order(rows)).toHaveLength(5);
  });

  test("maxDepth is configurable", () => {
    const rows = buildTaskTree([t("a"), t("b", "a"), t("c", "b")], { maxDepth: 1 });
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 1]);
  });

  test("counts distinguish direct children from the whole subtree", () => {
    const rows = buildTaskTree([t("a"), t("b", "a"), t("c", "b"), t("d", "b"), t("e", "a")]);
    const byId = Object.fromEntries(rows.map((r) => [r.task._id, r]));
    expect(byId.a.childCount).toBe(2);
    expect(byId.a.descendantCount).toBe(4);
    expect(byId.b.childCount).toBe(2);
    expect(byId.b.descendantCount).toBe(2);
    expect(byId.c.childCount).toBe(0);
    expect(byId.c.descendantCount).toBe(0);
  });

  // The load-bearing rule: filtering is the view's job, and this function must
  // never drop a row the view chose to show. A subtask whose parent was
  // filtered out (done, other status tab, other assignee) becomes a root.
  test("a child whose parent is absent is promoted to a root, never dropped", () => {
    const rows = buildTaskTree([t("a1", "gone"), t("b")]);
    expect(order(rows)).toEqual(["a1", "b"]);
    expect(rows[0].depth).toBe(0);
    expect(rows[0].indent).toBe(0);
  });

  test("output is a permutation of the input — nothing added or removed", () => {
    const input = [t("a"), t("b", "a"), t("c", "missing"), t("d"), t("e", "d")];
    const rows = buildTaskTree(input);
    expect(rows).toHaveLength(input.length);
    expect(order(rows).sort()).toEqual(input.map((i) => i._id).sort());
  });

  test("a self-parented row renders as a root instead of recursing", () => {
    const self: Row = { _id: "a", short_id: "ct-a", parent_id: "a" };
    const rows = buildTaskTree([self, t("b")]);
    expect(order(rows)).toEqual(["a", "b"]);
    expect(rows[0].depth).toBe(0);
  });

  // resolveParentTask refuses to create a cycle, but rows written before it
  // existed might carry one; the list must still render.
  test("a cycle is emitted flat rather than looping forever", () => {
    const a: Row = { _id: "a", short_id: "ct-a", parent_id: "b" };
    const b: Row = { _id: "b", short_id: "ct-b", parent_id: "a" };
    const rows = buildTaskTree([a, b, t("c")]);
    expect(order(rows).sort()).toEqual(["a", "b", "c"]);
  });

  test("an empty list yields an empty tree", () => {
    expect(buildTaskTree([])).toEqual([]);
  });

  test("parent ids compare across string and id-object forms", () => {
    // Convex hands back id objects that stringify to the document id; the
    // builder compares via String() so a non-string parent_id still matches.
    const parent = { _id: "a", short_id: "ct-a" };
    const child = { _id: "b", short_id: "ct-b", parent_id: { toString: () => "a" } as any };
    const rows = buildTaskTree([parent, child]);
    expect(order(rows as any)).toEqual(["a", "b"]);
    expect(rows[1].depth).toBe(1);
  });
});

// The board hides agent execution subtasks but must still say they exist —
// that only works if the count comes from the unfiltered set. These pin the
// asymmetry that makes the badge honest.
describe("descendantCounts / hiddenDescendantCount", () => {
  const parent = t("human");
  const agentKids = [t("a1", "human"), t("a2", "human"), t("a3", "human")];
  const all = [parent, ...agentKids];

  test("counts every descendant when nothing is filtered", () => {
    expect(descendantCounts(all).get("human")).toBe(3);
  });

  test("the filtered view counts only what it renders", () => {
    expect(descendantCounts([parent]).get("human")).toBe(0);
  });

  test("the hidden count is the difference — what the board is not showing", () => {
    const total = descendantCounts(all);
    const visible = descendantCounts([parent]);
    expect(hiddenDescendantCount("human", total, visible)).toBe(3);
  });

  test("nothing hidden when the view shows every subtask", () => {
    const total = descendantCounts(all);
    expect(hiddenDescendantCount("human", total, total)).toBe(0);
  });

  // A view can show a subtask whose parent is filtered out (the orphan case),
  // so visible can exceed total for that row. Clamp rather than go negative.
  test("never reports a negative hidden count", () => {
    const total = descendantCounts([parent]);
    const visible = descendantCounts(all);
    expect(hiddenDescendantCount("human", total, visible)).toBe(0);
  });

  test("an unknown task id reads as zero, not undefined", () => {
    expect(hiddenDescendantCount("nope", new Map(), new Map())).toBe(0);
  });
});

describe("directChildren", () => {
  test("returns only the immediate children", () => {
    const all = [t("a"), t("b", "a"), t("c", "b"), t("d", "a")];
    expect(directChildren(all, "a").map((r) => r._id)).toEqual(["b", "d"]);
    expect(directChildren(all, "b").map((r) => r._id)).toEqual(["c"]);
    expect(directChildren(all, "c")).toEqual([]);
  });
});

// A fuller row for the progress/predicate helpers.
type FullRow = {
  _id: string;
  parent_id?: string | null;
  status?: string;
  triage_status?: string;
  source?: string;
  promoted?: boolean;
};
const f = (id: string, extra: Partial<FullRow> = {}): FullRow => ({ _id: id, status: "open", ...extra });

describe("isActiveTask / isCountableSubtask", () => {
  test("suggested and dismissed rows are not active", () => {
    expect(isActiveTask(f("a", { triage_status: "suggested" }))).toBe(false);
    expect(isActiveTask(f("a", { triage_status: "dismissed" }))).toBe(false);
    expect(isActiveTask(f("a", { triage_status: "active" }))).toBe(true);
    expect(isActiveTask(f("a"))).toBe(true);
  });

  test("unpromoted insight rows are not active; promotion activates them", () => {
    expect(isActiveTask(f("a", { source: "insight" }))).toBe(false);
    expect(isActiveTask(f("a", { source: "insight", promoted: true }))).toBe(true);
  });

  test("countable = active and unfinished", () => {
    expect(isCountableSubtask(f("a"))).toBe(true);
    expect(isCountableSubtask(f("a", { status: "done" }))).toBe(false);
    expect(isCountableSubtask(f("a", { status: "dropped" }))).toBe(false);
    expect(isCountableSubtask(f("a", { triage_status: "dismissed" }))).toBe(false);
  });
});

describe("subtaskProgressOf", () => {
  test("dropped children leave the denominator entirely", () => {
    const p = subtaskProgressOf([f("a", { status: "done" }), f("b", { status: "dropped" }), f("c")]);
    expect(p).toEqual({ total: 2, done: 1, inProgress: 0 });
  });

  test("in_progress and in_review both count as in progress", () => {
    const p = subtaskProgressOf([f("a", { status: "in_progress" }), f("b", { status: "in_review" }), f("c")]);
    expect(p.inProgress).toBe(2);
    expect(p.total).toBe(3);
  });

  test("suggested/dismissed mined rows never enter the denominator", () => {
    const p = subtaskProgressOf([
      f("a", { source: "insight" }),
      f("b", { triage_status: "dismissed" }),
      f("c", { status: "done" }),
    ]);
    expect(p).toEqual({ total: 1, done: 1, inProgress: 0 });
  });
});

describe("taskFamilyIndex", () => {
  test("progress is direct-children only; descendants are deep and countable", () => {
    const all: FullRow[] = [
      f("root"),
      f("a", { parent_id: "root" }),
      f("b", { parent_id: "root", status: "done" }),
      f("a1", { parent_id: "a", status: "in_progress" }),
    ];
    const idx = taskFamilyIndex(all);
    // Progress on root sees a and b only — the grandchild belongs to a's progress.
    expect(idx.progress.get("root")).toEqual({ total: 2, done: 1, inProgress: 0 });
    expect(idx.progress.get("a")).toEqual({ total: 1, done: 0, inProgress: 1 });
    // Deep count on root: a and a1 (b is done, not countable).
    expect(idx.descendants.get("root")).toBe(2);
  });

  test("self-parenting rows do not loop the index", () => {
    const idx = taskFamilyIndex([f("a", { parent_id: "a" })]);
    expect(idx.progress.size).toBe(0);
  });
});

describe("write-side guards", () => {
  const parentOf = (map: Record<string, string | undefined>) => (id: string) => map[id];

  test("taskDepth walks the chain and caps on cycles", () => {
    const chain = parentOf({ c: "b", b: "a" });
    expect(taskDepth("a", chain)).toBe(0);
    expect(taskDepth("c", chain)).toBe(2);
    const cyclic = parentOf({ a: "b", b: "a" });
    expect(taskDepth("a", cyclic)).toBeLessThanOrEqual(2);
  });

  test("wouldCreateTaskCycle catches self and ancestor-under-descendant", () => {
    const chain = parentOf({ c: "b", b: "a" });
    expect(wouldCreateTaskCycle("a", "a", chain)).toBe(true);
    expect(wouldCreateTaskCycle("a", "c", chain)).toBe(true); // a under its own grandchild
    // Flattening c from grandchild of a to direct child of a is legal.
    expect(wouldCreateTaskCycle("c", "a", chain)).toBe(false);
  });

  test("legal re-parent between siblings is not a cycle", () => {
    const chain = parentOf({ b: "a", c: "a" });
    expect(wouldCreateTaskCycle("b", "c", chain)).toBe(false);
  });

  test("MAX_TASK_DEPTH matches the render clamp default", () => {
    expect(MAX_TASK_DEPTH).toBe(2);
  });
});
