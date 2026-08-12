import { describe, expect, test } from "bun:test";
import { guardParentClose, resolveParentTask, taskAncestorIds, MAX_TASK_ANCESTOR_WALK } from "./tasks";
import { makeFakeDb } from "./testDb";

// SUBTASKS (huddle decision 2). tasks.parent_id and by_parent_id shipped long
// ago, but nothing ever resolved a parent reference: `create` wrote the raw
// `args.parent_id` string into a v.id("tasks") field. resolveParentTask is the
// one place a parent is set, and it enforces three rules — access, workspace
// containment, and acyclicity.

const ME = "users_me";
const OTHER = "users_other";
const TEAM = "teams_a";
const OTHER_TEAM = "teams_b";

const task = (over: any = {}) => ({
  _id: over.short_id ? `tasks_${over.short_id}` : "tasks_x",
  user_id: ME,
  short_id: "ct-x",
  ...over,
});

function ctx(tasks: any[] = [], memberships: any[] = []) {
  return { db: makeFakeDb({ tasks, team_memberships: memberships }) };
}

const personal = (userId = ME) => ({ type: "personal" as const, userId });
const team = (teamId = TEAM) => ({ type: "team" as const, teamId });

describe("resolveParentTask — lookup", () => {
  test("resolves a parent by its short id", async () => {
    const parent = task({ short_id: "ct-1" });
    const found = await resolveParentTask(ctx([parent]), ME as any, "ct-1", { workspace: personal() });
    expect(found._id).toBe(parent._id);
  });

  test("resolves a parent by its raw document id", async () => {
    const parent = task({ short_id: "ct-1" });
    const found = await resolveParentTask(ctx([parent]), ME as any, parent._id, { workspace: personal() });
    expect(found._id).toBe(parent._id);
  });

  test("an unknown reference is a not-found, not a silent no-op", async () => {
    await expect(
      resolveParentTask(ctx([task({ short_id: "ct-1" })]), ME as any, "ct-999", { workspace: personal() }),
    ).rejects.toThrow(/Parent task not found/);
  });
});

describe("resolveParentTask — access", () => {
  test("refuses a parent the caller cannot see", async () => {
    const foreign = task({ short_id: "ct-1", user_id: OTHER });
    await expect(
      resolveParentTask(ctx([foreign]), ME as any, "ct-1", { workspace: personal() }),
    ).rejects.toThrow(/Parent task not found/);
  });

  test("a teammate's team task is a valid parent for a team member", async () => {
    const teamTask = task({ short_id: "ct-1", user_id: OTHER, team_id: TEAM });
    const found = await resolveParentTask(
      ctx([teamTask], [{ _id: "m1", user_id: ME, team_id: TEAM }]),
      ME as any,
      "ct-1",
      { workspace: team() },
    );
    expect(found._id).toBe(teamTask._id);
  });
});

// A nesting edge is a relationship, and relationships never join two
// authorization domains — the same rule addDep applies to blocked_by/blocks.
// Without it, nesting would be a back door for exactly the leak decision 3 is
// closing: a personal task adopted under a team parent would show up in the
// team view through the tree.
describe("resolveParentTask — workspace containment", () => {
  test("a personal task cannot nest under a team task", async () => {
    const teamParent = task({ short_id: "ct-1", team_id: TEAM });
    await expect(
      resolveParentTask(ctx([teamParent], [{ _id: "m1", user_id: ME, team_id: TEAM }]), ME as any, "ct-1", {
        workspace: personal(),
      }),
    ).rejects.toThrow(/another workspace/);
  });

  test("a team task cannot nest under a personal task", async () => {
    const personalParent = task({ short_id: "ct-1" });
    await expect(
      resolveParentTask(ctx([personalParent]), ME as any, "ct-1", { workspace: team() }),
    ).rejects.toThrow(/another workspace/);
  });

  test("a task cannot nest under another team's task", async () => {
    const parent = task({ short_id: "ct-1", team_id: OTHER_TEAM });
    await expect(
      resolveParentTask(
        ctx([parent], [
          { _id: "m1", user_id: ME, team_id: TEAM },
          { _id: "m2", user_id: ME, team_id: OTHER_TEAM },
        ]),
        ME as any,
        "ct-1",
        { workspace: team(TEAM) },
      ),
    ).rejects.toThrow(/another workspace/);
  });

  test("same-team nesting is allowed", async () => {
    const parent = task({ short_id: "ct-1", team_id: TEAM });
    const found = await resolveParentTask(
      ctx([parent], [{ _id: "m1", user_id: ME, team_id: TEAM }]),
      ME as any,
      "ct-1",
      { workspace: team(TEAM) },
    );
    expect(found._id).toBe(parent._id);
  });
});

describe("resolveParentTask — cycles", () => {
  const child = task({ short_id: "ct-child" });

  test("a task cannot be its own parent", async () => {
    await expect(
      resolveParentTask(ctx([child]), ME as any, "ct-child", { workspace: personal(), child }),
    ).rejects.toThrow(/cannot be its own parent/);
  });

  test("a task cannot adopt its own direct child", async () => {
    const grandchild = task({ short_id: "ct-gc", parent_id: child._id });
    await expect(
      resolveParentTask(ctx([child, grandchild]), ME as any, "ct-gc", { workspace: personal(), child }),
    ).rejects.toThrow(/Cycle/);
  });

  test("a task cannot adopt a distant descendant", async () => {
    const a = task({ short_id: "ct-a", parent_id: child._id });
    const b = task({ short_id: "ct-b", parent_id: a._id });
    const c = task({ short_id: "ct-c", parent_id: b._id });
    await expect(
      resolveParentTask(ctx([child, a, b, c]), ME as any, "ct-c", { workspace: personal(), child }),
    ).rejects.toThrow(/Cycle/);
  });

  test("a sibling elsewhere in the tree is a legal new parent", async () => {
    const uncle = task({ short_id: "ct-uncle" });
    const found = await resolveParentTask(ctx([child, uncle]), ME as any, "ct-uncle", {
      workspace: personal(),
      child,
    });
    expect(found._id).toBe(uncle._id);
  });

  // At create time there is no row yet, so no edge can close a cycle.
  test("create-time resolution skips the cycle walk", async () => {
    const parent = task({ short_id: "ct-1" });
    const found = await resolveParentTask(ctx([parent]), ME as any, "ct-1", { workspace: personal() });
    expect(found._id).toBe(parent._id);
  });
});

describe("taskAncestorIds", () => {
  test("walks to the root, nearest ancestor first", async () => {
    const root = task({ short_id: "ct-root" });
    const mid = task({ short_id: "ct-mid", parent_id: root._id });
    const leaf = task({ short_id: "ct-leaf", parent_id: mid._id });
    const chain = await taskAncestorIds(ctx([root, mid, leaf]), leaf);
    expect(chain).toEqual([mid._id, root._id]);
  });

  test("a root has no ancestors", async () => {
    const root = task({ short_id: "ct-root" });
    expect(await taskAncestorIds(ctx([root]), root)).toEqual([]);
  });

  // A pre-existing cycle (written before this guard existed) must not spin a
  // mutation until the isolate is killed.
  test("a pre-existing cycle terminates instead of looping", async () => {
    const a = task({ short_id: "ct-a", parent_id: "tasks_ct-b" });
    const b = task({ short_id: "ct-b", parent_id: "tasks_ct-a" });
    const chain = await taskAncestorIds(ctx([a, b]), a);
    expect(chain).toEqual([b._id, a._id]);
  });

  test("a very deep chain stops at the walk cap", async () => {
    const depth = MAX_TASK_ANCESTOR_WALK + 20;
    const rows = Array.from({ length: depth }, (_, i) =>
      task({ short_id: `ct-${i}`, ...(i > 0 ? { parent_id: `tasks_ct-${i - 1}` } : {}) }),
    );
    const chain = await taskAncestorIds(ctx(rows), rows[rows.length - 1]);
    expect(chain).toHaveLength(MAX_TASK_ANCESTOR_WALK);
  });
});

// Depth is a product cap (panel decision 9): views emphasise the top levels,
// so writes deeper than the UI can express are refused with advice.
describe("resolveParentTask — depth cap", () => {
  test("a parent two levels down is refused", async () => {
    const a = task({ short_id: "ct-a" });
    const b = task({ short_id: "ct-b", parent_id: a._id });
    const c = task({ short_id: "ct-c", parent_id: b._id });
    await expect(
      resolveParentTask(ctx([a, b, c]), ME as any, "ct-c", { workspace: personal() }),
    ).rejects.toThrow(/Too deep/);
  });

  test("a parent one level down is fine for a leaf child", async () => {
    const a = task({ short_id: "ct-a" });
    const b = task({ short_id: "ct-b", parent_id: a._id });
    const found = await resolveParentTask(ctx([a, b]), ME as any, "ct-b", { workspace: personal() });
    expect(found._id).toBe(b._id);
  });

  test("re-parenting a task that has its own child must fit the whole subtree", async () => {
    const a = task({ short_id: "ct-a" });
    const b = task({ short_id: "ct-b", parent_id: a._id });
    const x = task({ short_id: "ct-x" });
    const x1 = task({ short_id: "ct-x1", parent_id: x._id });
    // x (with child x1) under b would put x1 at depth 3.
    await expect(
      resolveParentTask(ctx([a, b, x, x1]), ME as any, "ct-b", { workspace: personal(), child: x }),
    ).rejects.toThrow(/Too deep/);
    // Same move under a top-level parent fits: x1 lands at depth 2.
    const ok = await resolveParentTask(ctx([a, b, x, x1]), ME as any, "ct-a", { workspace: personal(), child: x });
    expect(ok._id).toBe(a._id);
  });
});

// The close-guard (panel decision 3): closing a parent with open subtasks is
// refused unless resolved; the guard lives in the mutation path so the CLI and
// every web surface hit the same rule.
describe("guardParentClose", () => {
  const parent = task({ short_id: "ct-p" });
  const openChild = task({ short_id: "ct-c1", parent_id: parent._id, status: "open" });
  const doneChild = task({ short_id: "ct-c2", parent_id: parent._id, status: "done" });

  test("refuses done with open subtasks, naming them", async () => {
    await expect(
      guardParentClose(ctx([parent, openChild, doneChild]), parent, "done", undefined),
    ).rejects.toThrow(/ct-c1/);
  });

  test("dropped is guarded the same way", async () => {
    await expect(
      guardParentClose(ctx([parent, openChild]), parent, "dropped", undefined),
    ).rejects.toThrow(/open subtask/);
  });

  test("non-terminal statuses pass through untouched", async () => {
    expect(await guardParentClose(ctx([parent, openChild]), parent, "in_progress", undefined)).toEqual([]);
    expect(await guardParentClose(ctx([parent, openChild]), parent, undefined, undefined)).toEqual([]);
  });

  test("all-closed children never block", async () => {
    expect(await guardParentClose(ctx([parent, doneChild]), parent, "done", undefined)).toEqual([]);
  });

  test("only_parent closes just the parent, leaving children", async () => {
    expect(await guardParentClose(ctx([parent, openChild]), parent, "done", "only_parent")).toEqual([]);
  });

  test("cascade returns the open subtree, deep", async () => {
    const grandchild = task({ short_id: "ct-g1", parent_id: openChild._id, status: "in_progress" });
    const ids = await guardParentClose(ctx([parent, openChild, doneChild, grandchild]), parent, "done", "cascade");
    expect(ids).toEqual([openChild._id, grandchild._id]);
  });

  test("suggested mined rows do not hold a parent open", async () => {
    const suggested = task({ short_id: "ct-s", parent_id: parent._id, status: "open", triage_status: "suggested" });
    expect(await guardParentClose(ctx([parent, suggested]), parent, "done", undefined)).toEqual([]);
  });
});
