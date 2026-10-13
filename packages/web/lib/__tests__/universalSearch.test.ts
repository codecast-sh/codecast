import { describe, expect, test } from "bun:test";
import { kindOfQuery, matchEntities, matchGoals, matchMentionGroups, matchProjects, matchRoles, matchRoutines, matchRows } from "../universalSearch";

const index = {
  tasks: {
    t1: { _id: "t1", title: "Fix login on phone", short_id: "ct-1", status: "open", updated_at: 2 },
    t2: { _id: "t2", title: "Login cleanup", short_id: "ct-2", status: "dropped", updated_at: 3 },
    t3: { _id: "t3", title: "Login for team", short_id: "ct-3", status: "open", team_id: "teamB", updated_at: 4 },
  },
  docs: {
    d1: { _id: "d1", title: "Login design", doc_type: "note" },
    d2: { _id: "d2", title: "Login plan doc", doc_type: "plan" },
  },
  plans: {
    p1: { _id: "p1", title: "Login rollout", status: "active" },
    p2: { _id: "p2", title: "Login v0", status: "abandoned" },
  },
};

test("groups leave out dropped tasks, plan-type docs and abandoned plans, and keep to the workspace", () => {
  const g = matchMentionGroups(index, "login", undefined, 5);
  expect(g.tasks.map((t) => t._id)).toEqual(["t1"]);
  expect(g.docs.map((d) => d._id)).toEqual(["d1"]);
  expect(g.plans.map((p) => p._id)).toEqual(["p1"]);
});

test("an empty query lists nothing unless asked to browse", () => {
  expect(matchMentionGroups(index, "", undefined, 5).tasks).toEqual([]);
  expect(matchMentionGroups(index, "", undefined, 5, { task: true }).tasks.length).toBe(1);
});

test("a kind's own word names the kind, singular or plural", () => {
  expect(kindOfQuery("routines")).toBe("routine");
  expect(kindOfQuery(" To-dos ")).toBe("task");
  expect(kindOfQuery("todo")).toBe("task");
  expect(kindOfQuery("notes")).toBe("doc");
  expect(kindOfQuery("routine for mornings")).toBeNull();
  expect(kindOfQuery("passport")).toBeNull();
  // A start of three letters or more names the kind while it is typed.
  expect(kindOfQuery("rou")).toBe("routine");
  expect(kindOfQuery("rout")).toBe("routine");
  expect(kindOfQuery("to-d")).toBe("task");
  expect(kindOfQuery("not")).toBe("doc");
  expect(kindOfQuery("ro")).toBeNull();
  expect(kindOfQuery("trip")).toBeNull();
});

test("a kind word lists that kind, newest first, and leaves the other kinds to their hits", () => {
  const groups = matchMentionGroups(index, "to-dos", undefined, 5);
  expect(groups.tasks.map((t) => t._id)).toEqual(["t1"]);
  expect(groups.docs).toEqual([]);
  expect(matchMentionGroups(index, "notes", undefined, 5).docs.map((d) => d._id)).toEqual(["d1"]);
});

test("routines: the kind word lists every live routine after a title hit", () => {
  const rows = [
    { _id: "r1", title: "Morning to-do review", status: "scheduled", updated_at: 1 },
    { _id: "r2", title: "Water the plants", status: "scheduled", updated_at: 3 },
    { _id: "r3", title: "Routine check-in", status: "scheduled", updated_at: 2 },
    { _id: "r4", title: "Old one", status: "cancelled", updated_at: 4 },
  ];
  expect(matchRoutines(rows, "routine", 5).map((r) => r._id)).toEqual(["r3", "r2", "r1"]);
  expect(matchRoutines(rows, "routines", 5).map((r) => r._id)).toEqual(["r2", "r3", "r1"]);
  expect(matchRoutines(rows, "plants", 5).map((r) => r._id)).toEqual(["r2"]);
});

describe("matching every word in any order", () => {
  test("a task is found by its words wherever they sit in the title", () => {
    const tasks = { t1: { _id: "t1", title: "Admin and caller pages miss live data", updated_at: 1 } };
    expect(matchEntities(tasks as any, "call page", undefined, 5).map((t) => t._id)).toEqual(["t1"]);
    expect(matchEntities(tasks as any, "call zebra", undefined, 5)).toEqual([]);
  });

  test("projects, goals and roles share one matcher and its exclusions", () => {
    expect(matchProjects([{ title: "Call screen relayout", short_id: "pj-1" }, { title: "Billing" }], "screen call", 5).map((p) => p.title)).toEqual(["Call screen relayout"]);
    expect(matchGoals([{ title: "Grow calls", short_id: "in-1", status: "dropped" }, { title: "More calls", short_id: "in-2" }], "calls", 5).map((g) => g.short_id)).toEqual(["in-2"]);
    expect(matchRoles([{ name: "Release Captain", handle: "release", short_id: "or-1" }, { name: "Old", handle: "rel", status: "retired" }], "@rel", 5).map((r) => r.short_id)).toEqual(["or-1"]);
  });

  test("a stronger match leads, then the newer row", () => {
    const rows = [{ t: "calling pages", at: 9 }, { t: "call page", at: 0 }, { t: "call page now", at: 5 }];
    expect(matchRows(rows, "call page", (r) => [r.t], 5, (r) => r.at).map((r) => r.t)).toEqual(["call page now", "call page", "calling pages"]);
  });
});
