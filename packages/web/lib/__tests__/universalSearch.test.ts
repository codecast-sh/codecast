import { expect, test } from "bun:test";
import { kindOfQuery, matchMentionGroups, matchRoutines } from "../universalSearch";

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
