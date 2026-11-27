// /priorities across workspaces as pure functions: each grouping's order, the
// Workspace grouping's interleave by rank, hidden workspaces, and the controls.
// Run: bun test lib/__tests__/prioritySections.test.ts
import { describe, expect, test } from "bun:test";
import type { PriorityRow } from "../priorities";
import { buildSections, effectiveGroupBy, pageControls, rankDraggable, visibleCount, type RankedRow } from "../prioritySections";

const ME = "u-me";
const workspaceNames: Record<string, string> = { "team:codecast": "Codecast", "team:union": "union", "team:alpha": "Alpha" };

let seq = 0;
function row(over: Partial<PriorityRow> & { user_id?: string }): PriorityRow {
  const short_id = over.short_id ?? `pri-${++seq}`;
  const user_id = over.user_id ?? ME;
  return {
    _id: `id-${short_id}`,
    short_id,
    title: short_id,
    summary: "",
    status: "active",
    rank: null,
    person_pos: null,
    ai_rank: null,
    rank_source: "ai",
    status_set_by: "pass",
    serves: null,
    steps: [],
    counts: { critical_done: 0, critical_total: 0 },
    workspace: "team:codecast",
    owner: user_id === ME ? "Jason" : user_id,
    mine: user_id === ME,
    first_seen_at: 0,
    last_active_at: 0,
    done_at: null,
    session_count: 0,
    session_count_more: false,
    sessions: [],
    correction_pending: false,
    ...over,
    user_id,
  };
}

const opts = (over: { activeWorkspace?: string | null; hidden?: string[]; groupBy?: unknown } = {}) => ({
  activeWorkspace: over.activeWorkspace ?? "team:union",
  hidden: over.hidden ?? [],
  groupBy: over.groupBy ?? "workspace_person",
  workspaceNames,
});

const ids = (rows: readonly PriorityRow[]) => rows.map((r) => r.short_id);
const ranked = (rows: readonly RankedRow[]) => rows.map((r) => `${r.row.short_id}#${r.rank}`);

// Jason in three workspaces plus Personal; Ashot and Zoe in Codecast, Ashot in Union. A teammate's row
// carries the server's rank (their order over what the viewer reads), never their scale.
const ROWS: PriorityRow[] = [
  row({ short_id: "me-c1", person_pos: 1 }),
  row({ short_id: "me-c2", person_pos: 2 }),
  row({ short_id: "me-c3", person_pos: 3 }),
  row({ short_id: "me-cdone", status: "done", done_at: 50 }),
  row({ short_id: "me-cquiet", status: "quiet", last_active_at: 40 }),
  row({ short_id: "me-caside", status: "set_aside" }),
  row({ short_id: "me-cmerged", status: "merged" }),
  row({ short_id: "zoe-c1", user_id: "Zoe", rank: 1 }),
  row({ short_id: "ash-c2", user_id: "ashot", rank: 2 }),
  row({ short_id: "ash-c1", user_id: "ashot", rank: 1 }),
  row({ short_id: "ash-cdone", user_id: "ashot", status: "done", done_at: 10 }),
  row({ short_id: "me-u1", workspace: "team:union", person_pos: 1 }),
  row({ short_id: "ash-u1", user_id: "ashot", workspace: "team:union", rank: 1 }),
  row({ short_id: "me-a1", workspace: "team:alpha", person_pos: 1 }),
  row({ short_id: "me-p1", workspace: `user:${ME}`, person_pos: 1 }),
];

describe("Workspace, then person", () => {
  const s = buildSections(ROWS, opts());
  if (s.groupBy !== "workspace_person") throw new Error(s.groupBy);

  test("the active workspace first, then by name ignoring case, personal named Personal", () => {
    expect(s.sections.map((x) => x.name)).toEqual(["union", "Alpha", "Codecast", "Personal"]);
  });

  test("the viewer first, then by owner name; active in rank order", () => {
    const codecast = s.sections.find((x) => x.key === "team:codecast")!;
    expect(codecast.people.map((p) => p.owner)).toEqual(["Jason", "ashot", "Zoe"]);
    expect(ids(codecast.people[0].active)).toEqual(["me-c1", "me-c2", "me-c3"]);
    expect(ids(codecast.people[1].active)).toEqual(["ash-c1", "ash-c2"]);
  });

  test("done, quiet and set aside fold into past; merged never shows", () => {
    const me = s.sections.find((x) => x.key === "team:codecast")!.people[0];
    expect(ids(me.past)).toEqual(["me-cdone", "me-cquiet", "me-caside"]);
    expect(s.sections.flatMap((x) => x.people.flatMap((p) => [...p.active, ...p.past])).some((r) => r.status === "merged")).toBe(false);
  });
});

describe("Person, then workspace", () => {
  const s = buildSections(ROWS, opts({ groupBy: "person_workspace" }));
  if (s.groupBy !== "person_workspace") throw new Error(s.groupBy);

  test("the viewer first, then by name, each with their workspaces in section order", () => {
    expect(s.sections.map((p) => p.owner)).toEqual(["Jason", "ashot", "Zoe"]);
    expect(s.sections[0].workspaces.map((w) => w.name)).toEqual(["union", "Alpha", "Codecast", "Personal"]);
    expect(s.sections[1].workspaces.map((w) => w.key)).toEqual(["team:union", "team:codecast"]);
  });

  test("each workspace holds that person's active in rank order and their past", () => {
    const codecast = s.sections[0].workspaces.find((w) => w.key === "team:codecast")!;
    expect(ids(codecast.active)).toEqual(["me-c1", "me-c2", "me-c3"]);
    expect(ids(codecast.past)).toEqual(["me-cdone", "me-cquiet", "me-caside"]);
  });
});

describe("Workspace", () => {
  const s = buildSections(ROWS, opts({ groupBy: "workspace" }));
  if (s.groupBy !== "workspace") throw new Error(s.groupBy);
  const codecast = s.sections.find((x) => x.key === "team:codecast")!;

  test("every #1, then every #2: the viewer first within a rank, then by owner name", () => {
    expect(ranked(codecast.active)).toEqual(["me-c1#1", "ash-c1#1", "zoe-c1#1", "me-c2#2", "ash-c2#2", "me-c3#3"]);
  });

  test("each row carries its owner", () => {
    expect(codecast.active.map((r) => r.row.owner)).toEqual(["Jason", "ashot", "Zoe", "Jason", "ashot", "Jason"]);
  });

  test("one past per section, people in the same order", () => {
    expect(ids(codecast.past)).toEqual(["me-cdone", "me-cquiet", "me-caside", "ash-cdone"]);
  });

  test("the rank is the place in the owner's list, not the server's field", () => {
    const gapped = [row({ short_id: "x1", user_id: "x", person_pos: 4, rank: 4 }), row({ short_id: "x2", user_id: "x", person_pos: 9, rank: 9 })];
    const out = buildSections(gapped, opts({ groupBy: "workspace" }));
    if (out.groupBy !== "workspace") throw new Error(out.groupBy);
    expect(ranked(out.sections[0].active)).toEqual(["x1#1", "x2#2"]);
  });
});

describe("hidden workspaces", () => {
  const hidden = ["team:codecast", "team:alpha"];

  test("leave every grouping", () => {
    for (const groupBy of ["workspace_person", "workspace"] as const) {
      const s = buildSections(ROWS, opts({ hidden, groupBy }));
      expect(s.sections.map((x) => ("key" in x ? x.key : ""))).toEqual(["team:union", `user:${ME}`]);
    }
    const s = buildSections(ROWS, opts({ hidden, groupBy: "person_workspace" }));
    if (s.groupBy !== "person_workspace") throw new Error(s.groupBy);
    expect(s.sections.map((p) => p.owner)).toEqual(["Jason", "ashot"]);
    expect(s.sections.flatMap((p) => p.workspaces.map((w) => w.key))).not.toContain("team:codecast");
  });

  test("the count is everyone's active priorities in the workspaces shown", () => {
    expect(visibleCount(ROWS, [])).toBe(10);
    expect(visibleCount(ROWS, hidden)).toBe(3);
  });

  test("their chips stay, so they can be turned back on", () => {
    const c = pageControls(ROWS, opts({ hidden }));
    expect(c.workspaces).toEqual([
      { key: "team:union", name: "union", count: 2 },
      { key: "team:alpha", name: "Alpha", count: 1 },
      { key: "team:codecast", name: "Codecast", count: 6 },
      { key: `user:${ME}`, name: "Personal", count: 1 },
    ]);
    expect(c.showChips).toBe(true);
  });

  test("a teammate only in a hidden workspace hides Group by", () => {
    expect(pageControls(ROWS, opts({ hidden: ["team:codecast", "team:union"] })).showGroupBy).toBe(false);
  });
});

describe("page controls", () => {
  test("many workspaces with teammates: chips, headings, every grouping", () => {
    expect(pageControls(ROWS, opts())).toMatchObject({
      showChips: true,
      showGroupBy: true,
      groupByOptions: ["workspace_person", "person_workspace", "workspace"],
      showSectionHeadings: true,
    });
  });

  test("one workspace: no chips, no heading, no Person then workspace", () => {
    const one = ROWS.filter((r) => r.workspace === "team:codecast");
    expect(pageControls(one, opts())).toMatchObject({
      showChips: false,
      showGroupBy: true,
      groupByOptions: ["workspace_person", "workspace"],
      showSectionHeadings: false,
    });
  });

  test("a lone workspace cannot be hidden into an empty page", () => {
    const union = ROWS.filter((r) => r.workspace === "team:union");
    const hidden = ["team:union"];
    const s = buildSections(union, opts({ hidden }));
    if (s.groupBy !== "workspace_person") throw new Error(s.groupBy);
    expect(s.sections.map((x) => x.key)).toEqual(["team:union"]);
    expect(visibleCount(union, hidden)).toBe(2);
    expect(pageControls(union, opts({ hidden }))).toMatchObject({ showChips: false, showGroupBy: true, showSectionHeadings: false });
  });

  test("a workspace name missing from the map reads as its key", () => {
    const s = buildSections([row({ workspace: "team:new" })], opts());
    if (s.groupBy !== "workspace_person") throw new Error(s.groupBy);
    expect(s.sections[0].name).toBe("team:new");
  });

  test("a workspace holding only merged rows is not on the page", () => {
    const rows = [row({ short_id: "a" }), row({ short_id: "b", workspace: "team:union", status: "merged" })];
    expect(pageControls(rows, opts()).showChips).toBe(false);
  });

  test("only the viewer's own priorities: no Group by", () => {
    expect(pageControls(ROWS.filter((r) => r.mine), opts()).showGroupBy).toBe(false);
  });

  test("one workspace left visible: no headings, no Person then workspace", () => {
    const c = pageControls(ROWS, opts({ hidden: ["team:codecast", "team:alpha", `user:${ME}`] }));
    expect(c.showSectionHeadings).toBe(false);
    expect(c.groupByOptions).toEqual(["workspace_person", "workspace"]);
  });
});

describe("fallbacks", () => {
  test("an unknown or missing Group by reads as Workspace, then person", () => {
    expect(effectiveGroupBy("person", { workspaces: 3, teammates: true })).toBe("workspace_person");
    expect(effectiveGroupBy(undefined, { workspaces: 3, teammates: true })).toBe("workspace_person");
    expect(buildSections(ROWS, opts({ groupBy: "flat" })).groupBy).toBe("workspace_person");
  });

  test("Person then workspace with one workspace shown reads as the default", () => {
    expect(effectiveGroupBy("person_workspace", { workspaces: 1, teammates: true })).toBe("workspace_person");
    expect(buildSections(ROWS.filter((r) => r.workspace === "team:codecast"), opts({ groupBy: "person_workspace" })).groupBy).toBe("workspace_person");
    expect(effectiveGroupBy("person_workspace", { workspaces: 2, teammates: true })).toBe("person_workspace");
    expect(effectiveGroupBy("workspace", { workspaces: 1, teammates: true })).toBe("workspace");
  });

  test("with no teammate shown, a stored grouping reads as the default, so drag to rank works", () => {
    expect(effectiveGroupBy("workspace", { workspaces: 3, teammates: false })).toBe("workspace_person");
    const mineOnly = ROWS.filter((r) => r.mine);
    const s = buildSections(mineOnly, opts({ groupBy: "workspace" }));
    expect(s.groupBy).toBe("workspace_person");
    expect(rankDraggable(s.groupBy, mineOnly.find((r) => r.status === "active")!)).toBe(true);
    expect(buildSections(ROWS, opts({ groupBy: "workspace", hidden: ["team:codecast", "team:union"] })).groupBy).toBe("workspace_person");
  });

  test("no rows: no sections", () => {
    expect(buildSections([], opts()).sections).toEqual([]);
    expect(pageControls([], opts())).toMatchObject({ workspaces: [], showChips: false, showGroupBy: false, showSectionHeadings: false });
  });
});

describe("rankDraggable", () => {
  const mine = row({ short_id: "m" });
  test("the viewer's own active rows in the nested groupings", () => {
    expect(rankDraggable("workspace_person", mine)).toBe(true);
    expect(rankDraggable("person_workspace", mine)).toBe(true);
  });
  test("never in Workspace grouping, never a teammate's, never a past row", () => {
    expect(rankDraggable("workspace", mine)).toBe(false);
    expect(rankDraggable("workspace_person", row({ user_id: "ashot" }))).toBe(false);
    expect(rankDraggable("workspace_person", row({ status: "done" }))).toBe(false);
  });
});
