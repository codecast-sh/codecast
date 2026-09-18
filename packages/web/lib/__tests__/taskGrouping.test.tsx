// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { buildTaskGroups, canSubGroup, isValidTaskGroup, parseTaskGroup, taskGroupDropUpdates, TASK_AXES } from "../taskGrouping";
import { DEFAULT_TASK_STATUSES, isOnHumanBoard } from "@codecast/shared/tasks";
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
    expect(result.map((g) => g.label)).toEqual(["Done", "In Progress", "In Review", "Open", "Backlog", "Dropped"]);
  });

  it("keeps in-progress buckets ahead of review, further-progressed custom statuses first within each", () => {
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
    expect(result.map((g) => g.label)).toEqual(["Today", "In Progress", "Approved", "In Review"]);
    // Fill still reads progress: each category's further-progressed status leads it.
    expect(result.map((g) => statusFill(taskStatuses.find((s) => s.name === g.label), taskStatuses)))
      .toEqual([0.4, 0.2, 0.8, 0.6]);
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

// Roles own tasks like people do (org-roles-run-work.md R5). The fixture is the
// shape lib/liveEntities resolveAssigneeInfo returns for a role.
const roleRow = (id, name, reports_to) => ({ _id: id, short_id: `or-${id}`, name, handle: id, avatar: "fox", status: "active", reports_to });
const asRole = (r) => ({ assignee: r._id, assignee_info: { kind: "role", name: r.name, handle: r.handle, avatar: "fox", role_id: r._id, role_short_id: r.short_id } });

const growth = roleRow("growth", "Growth", { kind: "user", user_id: "founder" });
const platform = roleRow("platform", "Platform", { kind: "user", user_id: "founder" });
const ads = roleRow("ads", "Ads", { kind: "role", role_id: "growth" });
const founder = { _id: "founder", name: "Ashot" };
const sam = { _id: "sam", name: "Samvit" };
const orgCtx = { ...ctx, roles: [growth, platform, ads], teamMembers: [founder, sam], currentUser: founder };

const outline = (result) => result.map((g) => `${"  ".repeat(g.depth ?? 0)}${g.label} (${g.items.length})`);

describe("the assignee axis with roles", () => {
  it("sorts roles and people together by name, as peers", () => {
    const result = groups("assignee", [task(asRole(platform)), task(person("sam", "Samvit")), task(asRole(growth)), task()], "", orgCtx);
    expect(result.map((g) => g.label)).toEqual(["Growth", "Platform", "Samvit", "Unassigned"]);
    expect(result.every((g) => g.depth === undefined)).toBe(true);
  });

  it("heads a role's group with its ringed face and the way to the role, a person's with theirs", () => {
    const result = groups("assignee", [task(asRole(growth)), task({ assignee: "sam", assignee_info: { name: "Samvit", github_username: "samvit" } })], "", orgCtx);
    const html = (node) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
    expect(html(result[0].icon)).toContain('data-assignee-role="or-growth"');
    expect(html(result[0].icon)).toContain('data-avatar="fox"');
    expect(html(result[0].extra)).toContain('href="/org/or-growth"');
    expect(html(result[1].icon)).not.toContain("data-assignee-role");
    expect(html(result[1].extra)).toContain('href="/team/samvit"');
  });

  it("assigns to a role when a task is dropped on the role's group", () => {
    const result = groups("assignee", [task(asRole(growth))], "", orgCtx);
    expect(taskGroupDropUpdates("assignee", result[0].key, task(), orgCtx)).toEqual({ assignee: "growth" });
  });
});

describe("the chain axis", () => {
  it("nests a founder's two roles under the founder, own tasks first", () => {
    const result = groups("chain", [task(asRole(platform)), task(person("founder", "Ashot")), task(asRole(growth)), task(asRole(growth))], "", orgCtx);
    expect(outline(result)).toEqual(["Ashot (1)", "  Growth (2)", "  Platform (1)"]);
  });

  it("nests a role under the role it reports to", () => {
    const result = groups("chain", [task(asRole(ads)), task(asRole(growth))], "", orgCtx);
    expect(outline(result)).toEqual(["Ashot (0)", "  Growth (1)", "    Ads (1)"]);
  });

  it("gives a person with no roles one group with nothing under it, and trails unassigned", () => {
    const result = groups("chain", [task(), task(person("sam", "Samvit")), task(asRole(growth))], "", orgCtx);
    expect(outline(result)).toEqual(["Ashot (0)", "  Growth (1)", "Samvit (1)", "Unassigned (1)"]);
  });

  it("names a person who heads a chain but holds no task, from the roster", () => {
    const result = groups("chain", [task(asRole(growth))], "", orgCtx);
    expect(result[0].label).toBe("Ashot");
    expect(result[0].items).toEqual([]);
  });

  it("counts the whole chain on a group that has groups under it, and nowhere else", () => {
    const result = groups("chain", [task(person("founder", "Ashot")), task(asRole(growth)), task(asRole(ads)), task(asRole(ads)), task(person("sam", "Samvit"))], "", orgCtx);
    const total = (g) => renderToStaticMarkup(<>{g.badge}</>);
    expect(outline(result)).toEqual(["Ashot (1)", "  Growth (1)", "    Ads (2)", "Samvit (1)"]);
    expect(total(result[0])).toContain("4 in chain");
    expect(total(result[1])).toContain("3 in chain");
    expect(result[2].badge).toBeUndefined();
    expect(result[3].badge).toBeUndefined();
  });

  it("keeps every task exactly once", () => {
    const tasks = [task(), task(person("founder", "Ashot")), task(asRole(growth)), task(asRole(ads)), task(person("sam", "Samvit"))];
    const result = groups("chain", tasks, "", orgCtx);
    expect(result.flatMap((g) => g.items.map((t) => t._id)).sort()).toEqual(tasks.map((t) => t._id).sort());
  });

  it("assigns to the person or role a task is dropped on, an empty group included", () => {
    const result = groups("chain", [task(asRole(growth))], "", orgCtx);
    expect(taskGroupDropUpdates("chain", result[0].key, task(), orgCtx)).toEqual({ assignee: "founder" });
    expect(taskGroupDropUpdates("chain", result[1].key, task(), orgCtx)).toEqual({ assignee: "growth" });
  });

  it("divides each chain group by a second axis and keeps the nesting", () => {
    const result = groups("chain+status", [task({ ...asRole(growth), status: "open" }), task({ ...asRole(growth), status: "done" }), task(asRole(ads))], "", orgCtx);
    // Inside a chain group the second axis keeps its own order (Done leads the board).
    expect(outline(result)).toEqual(["Ashot (0)", "  Growth · Done (1)", "  Growth · Open (1)", "    Ads · Open (1)"]);
  });

  // The page filters with isOnHumanBoard before it groups. A task an agent
  // filed is hidden until someone holds it, and a role is someone (R5).
  it("shows an agent filed task under the role that holds it, on the default board", () => {
    const board = [
      task({ ...asRole(growth), source: "agent", title: "held by a role" }),
      task({ source: "agent", title: "one session's bookkeeping" }),
      task({ ...person("founder", "Ashot"), source: "human" }),
    ].filter(isOnHumanBoard);
    const result = groups("chain", board, "", orgCtx);
    expect(outline(result)).toEqual(["Ashot (1)", "  Growth (1)"]);
    expect(result[1].items[0].title).toBe("held by a role");
  });

  it("only nests as the first axis, and never pairs with the assignee axis it repeats", () => {
    expect(parseTaskGroup("project+chain")).toEqual(["project"]);
    expect(parseTaskGroup("chain+assignee")).toEqual(["chain"]);
    expect(parseTaskGroup("assignee+chain")).toEqual(["assignee"]);
    expect(canSubGroup("chain", "status")).toBe(true);
    expect(canSubGroup("status", "chain")).toBe(false);
  });
});
