import { expect, test } from "bun:test";
import { matchMentionGroups } from "../universalSearch";

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
