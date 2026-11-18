import { expect, test } from "bun:test";
import { goalTreeLines, newProjectGoalLines, unplacedPlanLines } from "./planPlacement";

const c = { cyan: "", dim: "", bold: "", yellow: "", reset: "" };
const projects = [
  { _id: "p1", title: "People & Deals", short_id: "pj-a" },
  { _id: "p2", title: "Cold Email", short_id: "pj-b" },
  { _id: "p3", title: "Old thing", short_id: "pj-c", status: "done" },
];
const goals = [
  { short_id: "in-2", title: "Close deals", status: "active", project_ids: ["p1"] },
  { short_id: "in-3", title: "Shipped goal", status: "completed", project_ids: ["p2"] },
  { short_id: "in-4", title: "New market", status: "proposed", project_ids: [] },
];

test("goals list the projects that carry them; live projects no open goal carries follow", () => {
  expect(goalTreeLines(c, goals, projects)).toEqual([
    "    in-2 Close deals  in People & Deals",
    "    in-4 New market  no project yet",
    "    no goal  Cold Email",
  ]);
});

test("an unplaced plan says how to file it, then the tree", () => {
  const lines = unplacedPlanLines(c, "pl-9", goals, projects);
  expect(lines[0]).toContain("unplaced pl-9");
  expect(lines[1]).toBe("    cast plan update pl-9 --project <ref>");
  expect(lines).toHaveLength(6);
  expect(unplacedPlanLines(c, "pl-9", goals, [])).toHaveLength(1);
});

test("a new project lists the open goals it could serve, and nothing when there are none", () => {
  expect(newProjectGoalLines(c, "pj-z", goals)).toEqual([
    "  no goal Add it to the goal it serves:  cast goal add-project <in-N> pj-z",
    "    in-2 Close deals",
    "    in-4 New market",
  ]);
  expect(newProjectGoalLines(c, "pj-z", [goals[1]])).toEqual([]);
});
