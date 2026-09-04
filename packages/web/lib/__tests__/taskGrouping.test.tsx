// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { buildTaskGroups, isValidTaskGroup, parseTaskGroup, TASK_AXES } from "../taskGrouping";
import { DEFAULT_TASK_STATUSES } from "@codecast/shared/tasks";
import { orderedStatuses, statusFill } from "../taskStatuses";

const ctx = { projects: {}, onFilterLabel: () => {} };
// Grouping must never reorder within a bucket, so the identity sort is the
// honest stand-in for the page's comparator here.
const asIs = (tasks) => tasks;

let seq = 0;
function task(over = {}) {
  seq += 1;
  return {
    _id: `t${seq}`,
    short_id: `ct-${seq}`,
    title: `task ${seq}`,
    status: "open",
    priority: "medium",
    created_at: seq,
    updated_at: seq,
    ...over,
  };
}

const person = (id, name) => ({ assignee: id, assignee_info: { name } });

function groups(group, tasks, statusFilter = "", context = ctx) {
  return buildTaskGroups({ group, tasks, sortTasks: asIs, statusFilter, ctx: context });
}

describe("parseTaskGroup", () => {
  it("reads one or two axes and drops unknown names", () => {
    expect(parseTaskGroup("assignee")).toEqual(["assignee"]);
    expect(parseTaskGroup("assignee+project")).toEqual(["assignee", "project"]);
    expect(parseTaskGroup("assignee+nonsense")).toEqual(["assignee"]);
  });

  it("treats none, empty and junk as no grouping", () => {
    expect(parseTaskGroup("none")).toEqual([]);
    expect(parseTaskGroup("")).toEqual([]);
    expect(parseTaskGroup("nonsense")).toEqual([]);
  });

  it("accepts a space separator, which is what a literal '+' in a link decodes to", () => {
    expect(parseTaskGroup("assignee project")).toEqual(["assignee", "project"]);
    expect(isValidTaskGroup("assignee project")).toBe(true);
  });

  it("collapses a repeated axis so a header can't read 'Open · Open'", () => {
    expect(parseTaskGroup("status+status")).toEqual(["status"]);
  });
});

describe("isValidTaskGroup", () => {
  it("accepts none and any combination of known axes", () => {
    expect(isValidTaskGroup("none")).toBe(true);
    expect(isValidTaskGroup("assignee")).toBe(true);
    expect(isValidTaskGroup("assignee+project")).toBe(true);
  });

  it("rejects empty and unknown values so they fall back to the default", () => {
    expect(isValidTaskGroup("")).toBe(false);
    expect(isValidTaskGroup("updated")).toBe(false);
    expect(isValidTaskGroup("assignee+updated")).toBe(false);
  });
});

describe("buildTaskGroups", () => {
  it("returns null when there is nothing to group by", () => {
    expect(groups("none", [task()])).toBeNull();
  });

  it("suppresses status grouping under a single-status tab, where every row would share one header", () => {
    expect(groups("status", [task()], "open")).toBeNull();
    // …but a second axis still differentiates the rows, so the grouping stands.
    expect(groups("status+assignee", [task()], "open")).not.toBeNull();
    // Several selected statuses can still split the rows, so it stands too.
    expect(groups("status", [task(), task({ status: "in_progress" })], "open,in_progress")).not.toBeNull();
  });

  it("orders status buckets by completion, with dropped tasks last", () => {
    const result = groups("status", [
      task({ status: "done" }),
      task({ status: "backlog" }),
      task({ status: "in_progress" }),
      task({ status: "dropped" }),
      task({ status: "open" }),
      task({ status: "in_review" }),
    ]);
    expect(result.map((g) => g.label)).toEqual(["Done", "In Review", "In Progress", "Open", "Backlog", "Dropped"]);
  });

  it("puts further-progressed custom statuses first without reversing their progress indicators", () => {
    const taskStatuses = orderedStatuses([
      ...DEFAULT_TASK_STATUSES,
      { id: "today", name: "Today", category: "in_progress" },
      { id: "approved", name: "Approved", category: "in_review" },
    ]);
    const result = groups("status", [
      task({ status: "in_progress" }),
      task({ status: "in_progress", status_id: "today" }),
      task({ status: "in_review" }),
      task({ status: "in_review", status_id: "approved" }),
    ], "", { ...ctx, taskStatuses });
    expect(result.map((g) => g.label)).toEqual(["Approved", "In Review", "Today", "In Progress"]);
    expect(result.map((g) => statusFill(taskStatuses.find((s) => s.name === g.label), taskStatuses)))
      .toEqual([0.8, 0.6, 0.4, 0.2]);
  });

  it("sorts named buckets alphabetically and trails the empty one", () => {
    const result = groups("assignee", [
      task(person("u2", "Zoe")),
      task(),
      task(person("u1", "Ada")),
    ]);
    expect(result.map((g) => g.label)).toEqual(["Ada", "Zoe", "Unassigned"]);
  });

  it("reads an unresolvable assignee as unassigned rather than naming a bucket after a raw id", () => {
    const result = groups("assignee", [task({ assignee: "u9" })]);
    expect(result.map((g) => g.label)).toEqual(["Unassigned"]);
  });

  it("combines two axes into one flat header per pair", () => {
    const projects = { p1: { _id: "p1", title: "Codecast" }, p2: { _id: "p2", title: "Mail" } };
    const result = groups(
      "assignee+project",
      [
        task({ ...person("u1", "Ada"), project_id: "p2" }),
        task({ ...person("u1", "Ada"), project_id: "p1" }),
        task({ ...person("u2", "Zoe"), project_id: "p1" }),
        task({ ...person("u1", "Ada") }),
      ],
      "",
      { ...ctx, projects },
    );
    expect(result.map((g) => g.label)).toEqual([
      "Ada · Codecast",
      "Ada · Mail",
      "Ada · No project",
      "Zoe · Codecast",
    ]);
  });

  it("keeps every task exactly once, so no row is dropped or duplicated", () => {
    const tasks = [
      task({ ...person("u1", "Ada"), status: "done" }),
      task({ status: "open" }),
      task({ ...person("u1", "Ada"), status: "open" }),
    ];
    const result = groups("assignee+status", tasks);
    const ids = result.flatMap((g) => g.items.map((t) => t._id)).sort();
    expect(ids).toEqual(tasks.map((t) => t._id).sort());
  });

  it("gives each bucket a distinct key, including across axis boundaries", () => {
    // ("ab","c") and ("a","bc") must not collide into one virtualizer row key.
    const result = groups("label+plan", [
      task({ labels: ["ab"], plan: { _id: "c", title: "C", status: "active" } }),
      task({ labels: ["a"], plan: { _id: "bc", title: "BC", status: "active" } }),
    ]);
    const keys = result.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders session buckets by their newest task, not alphabetically", () => {
    const older = { session_id: "sess_old", title: "Older", conversation_id: "c1" };
    const newer = { session_id: "sess_new", title: "Newer", conversation_id: "c2" };
    const result = groups("session", [
      task({ origin_session: older, created_at: 10 }),
      task({ origin_session: newer, created_at: 99 }),
    ]);
    expect(result.map((g) => g.label)).toEqual(["Newer", "Older"]);
  });

  it("names the empty bucket per axis", () => {
    expect(groups("plan", [task()])[0].label).toBe("Unplanned");
    expect(groups("project", [task()])[0].label).toBe("No project");
    expect(groups("label", [task()])[0].label).toBe("No label");
    expect(groups("session", [task()])[0].label).toBe("No session");
  });

  it("exposes every menu axis as a usable grouping", () => {
    for (const key of Object.keys(TASK_AXES)) {
      const result = groups(key, [task(person("u1", "Ada"))]);
      expect(result?.length).toBe(1);
    }
  });
});
