// The Goals lens (org-staffing.md S36): the outline of goals and projects,
// the owners column, and a proposal's goal changes laid over it as ghosts,
// read off the same rows the proposal card draws (proposalTreeRows).
// Run: bun test components/org/goalsLayout.test.ts
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { rectsOverlap, personNodeId, roleNodeId } from "./orgLayout";
import { COMPANY_NODE_ID, goalFarHeight, goalNodeId, goalsPlan, hasGoalChanges, layoutGoals, projectNodeId, projectRows, runningUnder, RUNNING_MAX, type GoalsNode } from "./goalsLayout";
import { GOALS_FIXTURE_CHANGES, GOALS_FIXTURE_DATA } from "./goalsFixture";
import { proposalChangeRows } from "./proposalTree";

// A ghost's tag is the word the proposal card's row leads with: read it off the same rows.
const tagOf = (changeId: string) => proposalChangeRows(ORG_FIXTURE, GOALS_FIXTURE_CHANGES, { goals: GOALS_FIXTURE_DATA.initiatives }).find((r) => r.change_id === changeId)!.tag;

const input = (changes = GOALS_FIXTURE_CHANGES) => ({ tree: ORG_FIXTURE, ...GOALS_FIXTURE_DATA, changes });
const node = <K extends GoalsNode["kind"]>(nodes: GoalsNode[], id: string, kind: K) => {
  const n = nodes.find((x) => x.id === id);
  if (!n || n.kind !== kind) throw new Error(`no ${kind} ${id}`);
  return n as Extract<GoalsNode, { kind: K }>;
};

describe("the goals lens without a proposal", () => {
  const { nodes, edges, changeNode } = layoutGoals(input([]));

  test("the company roots the outline; goals that ended are not drawn", () => {
    expect(node(nodes, COMPANY_NODE_ID, "company")).toMatchObject({ name: "Codecast", goals: 4, projects: 3 });
    expect(nodes.filter((n) => n.kind === "goal").map((n) => n.id)).not.toContain(goalNodeId("init-done"));
    expect(changeNode).toEqual({});
  });

  test("a goal that feeds another sits under it; a project carried by two goals is drawn once and referenced on the other", () => {
    const spine = (target: string) => edges.find((e) => e.kind === "spine" && e.target === target)?.source;
    expect(spine(goalNodeId("init-org"))).toBe(COMPANY_NODE_ID);
    expect(spine(goalNodeId("init-org-sub"))).toBe(goalNodeId("init-org"));
    expect(node(nodes, goalNodeId("init-org-sub"), "goal").x).toBeGreaterThan(node(nodes, goalNodeId("init-org"), "goal").x);
    // proj-inbox sits in init-org and init-revenue, siblings nobody leads: the first in the outline draws it.
    expect(spine(projectNodeId("init-org", "proj-inbox"))).toBe(goalNodeId("init-org"));
    expect(nodes.find((n) => n.id === projectNodeId("init-revenue", "proj-inbox"))).toBeUndefined();
    expect(node(nodes, goalNodeId("init-revenue"), "goal").refs).toEqual([{ project: expect.objectContaining({ id: "proj-inbox" }), under: "Agents run the company's routine work" }]);
    // proj-org is drawn under the deeper init-org-sub, so init-org references it.
    expect(node(nodes, goalNodeId("init-org"), "goal").refs.map((r) => `${r.project.id} under ${r.under}`)).toEqual(["proj-org under The role page is the session page"]);
  });

  test("among sibling goals, the one whose owner leads the project draws it; the deeper goal wins over both", () => {
    const growth = { kind: "role", id: "fixture-role-growth", name: "Growth", handle: "growth" } as const;
    const lead = { id: "proj-org", title: "Agent org", lead: growth };
    const plain = { id: "proj-inbox", title: "Inbox", lead: null };
    const goal = (id: string, owner: typeof growth | null, projects: typeof lead[] | typeof plain[]) => ({ id, title: id, parentId: null, owner, projects: projects as any, chips: [], order: 0 });
    const rows = projectRows([
      { id: "a", depth: 1, goal: goal("a", null, [lead, plain]) },
      { id: "b", depth: 1, goal: goal("b", growth, [lead, plain]) },
      { id: "c", depth: 2, goal: goal("c", null, [plain]) },
    ]);
    expect(rows.get("a")!.rows.map((p) => p.id)).toEqual([]);
    expect(rows.get("a")!.refs.map((r) => `${r.project.id} under ${r.under}`)).toEqual(["proj-org under b", "proj-inbox under c"]);
    expect(rows.get("b")!.rows.map((p) => p.id)).toEqual(["proj-org"]);
    expect(rows.get("c")!.rows.map((p) => p.id)).toEqual(["proj-inbox"]);
    // A goal a proposal would set does not take the row from a live goal as deep; alone, it draws its own.
    const ghost = { change_id: "x", status: "proposed", line: "", kind: "initiative", tag: null, solid: false } as const;
    const fresh = projectRows([
      { id: "new", depth: 1, goal: goal("new", growth, [{ ...lead, ghost }] as any) },
      { id: "live", depth: 1, goal: goal("live", null, [lead]) },
      { id: "solo", depth: 1, goal: goal("solo", null, [{ ...plain, ghost }] as any) },
    ]);
    expect(fresh.get("new")!.refs.map((r) => r.under)).toEqual(["live"]);
    expect(fresh.get("live")!.rows.map((p) => p.id)).toEqual(["proj-org"]);
    expect(fresh.get("solo")!.rows.map((p) => p.id)).toEqual(["proj-inbox"]);
  });

  test("a goal's running sessions are the working ones under a role whose area holds one of its projects", () => {
    const working = ORG_FIXTURE.roles[0].sessions.filter((s) => s.state === "working").map((s) => s._id);
    expect(runningUnder(ORG_FIXTURE, ["fixture-project-growth"]).map((s) => s._id)).toEqual(working.slice(0, RUNNING_MAX));
    expect(runningUnder(ORG_FIXTURE, ["proj-inbox"])).toEqual([]);
  });

  test("each goal has an edge to its owner and each led project to its lead, one card per owner", () => {
    const owner = (source: string) => edges.filter((e) => e.kind === "owner" && e.source === source).map((e) => e.target);
    const growth = roleNodeId("fixture-role-growth");
    expect(owner(goalNodeId("init-org"))).toEqual([growth]);
    expect(owner(goalNodeId("init-revenue"))).toEqual([personNodeId("fixture-user-me")]);
    expect(owner(goalNodeId("init-orphan"))).toEqual([]);
    // proj-org is carried by init-org and by init-org-sub under it: drawn once, under the nearer goal.
    expect(nodes.find((n) => n.id === projectNodeId("init-org", "proj-org"))).toBeUndefined();
    expect(owner(projectNodeId("init-org-sub", "proj-org"))).toEqual([growth]);
    expect(owner(projectNodeId("init-org", "proj-inbox"))).toEqual([]);
    const owners = nodes.filter((n) => n.kind === "owner");
    expect(owners.map((n) => n.id).sort()).toEqual([personNodeId("fixture-user-me"), growth].sort());
    // init-org, init-org-sub and proj-org (drawn once, under init-org-sub).
    expect(node(nodes, growth, "owner").owns).toBe(3);
  });

  test("each zoom level is laid out at its own card sizes: far is the shortest, close the tallest, and none overlaps", () => {
    const at = (level: "far" | "mid" | "close") => layoutGoals(input([]), level);
    const far = at("far"), mid = at("mid"), close = at("close");
    expect(far.height).toBeLessThan(mid.height);
    expect(mid.height).toBeLessThan(close.height);
    // A far goal is its title alone; the close card adds the description, the update and the rest under the middle one.
    const g = (l: typeof far) => node(l.nodes, goalNodeId("init-org"), "goal");
    expect(g(far).h).toBe(goalFarHeight(g(far).goal.title));
    expect(g(close).h).toBeGreaterThan(g(mid).h);
    // Same cards in the same order at every level: only the heights and what follows from them move.
    expect(far.nodes.map((n) => n.id)).toEqual(close.nodes.map((n) => n.id));
    expect(far.nodes.map((n) => n.x)).toEqual(close.nodes.map((n) => n.x));
    for (const l of [far, mid, close]) for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(rectsOverlap(l.nodes[i], l.nodes[j])).toBe(false);
  });

  test("no two cards overlap, and the owners stand clear of the outline", () => {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
    const outlineRight = Math.max(...nodes.filter((n) => n.kind !== "owner").map((n) => n.x + n.w));
    for (const o of nodes.filter((n) => n.kind === "owner")) expect(o.x).toBeGreaterThan(outlineRight + 100);
  });
});

describe("a proposal's goal changes as ghosts", () => {
  const { nodes, edges, changeNode } = layoutGoals(input());
  const goal = (id: string) => node(nodes, goalNodeId(id), "goal").goal;

  test("a new goal is a ghost under its parent, its owner edge and its metrics its own; a project a live goal already draws is a reference on it", () => {
    const g = goal("g-new");
    expect(g).toMatchObject({ title: "Every team runs a head of people", parentId: "init-org", ghost: { tag: tagOf("g-new"), status: "proposed", solid: false } });
    expect(g.chips.map((c) => c.chip)).toEqual(["Teams with a head of people → 40"]);
    // proj-org is carried today by init-org-sub, as deep in the outline: the live goal keeps the row.
    expect(nodes.find((n) => n.id === projectNodeId("g-new", "proj-org"))).toBeUndefined();
    expect(node(nodes, goalNodeId("g-new"), "goal").refs.map((r) => `${r.project.id} under ${r.under}`)).toEqual(["proj-org under The role page is the session page"]);
    expect(node(nodes, projectNodeId("init-org-sub", "proj-org"), "project").project.ghost).toBeUndefined();
    expect(edges.find((e) => e.kind === "spine" && e.target === goalNodeId("g-new"))).toMatchObject({ source: goalNodeId("init-org"), ghost: true });
    expect(edges.find((e) => e.kind === "owner" && e.source === goalNodeId("g-new"))).toMatchObject({ target: roleNodeId("fixture-role-growth"), ghost: true });
    expect(changeNode["g-new"]).toBe(goalNodeId("g-new"));
  });

  test("a placed goal is drawn under its new parent and says where it was", () => {
    expect(goal("init-org-sub")).toMatchObject({ parentId: "init-revenue", was: "Agents run the company's routine work", ghost: { tag: tagOf("g-place") } });
    expect(edges.find((e) => e.kind === "spine" && e.target === goalNodeId("init-org-sub"))?.source).toBe(goalNodeId("init-revenue"));
  });

  test("added projects are ghost rows on the goal; one it already carries is not drawn twice", () => {
    const added = node(nodes, projectNodeId("init-revenue", "proj-org"), "project").project;
    expect(added.ghost).toMatchObject({ change_id: "g-projects", tag: "added" });
    expect(node(nodes, projectNodeId("init-revenue", "proj-billing"), "project").project.ghost).toBeUndefined();
    expect(changeNode["g-projects"]).toBe(goalNodeId("init-revenue"));
  });

  test("a named owner is a proposed edge and a chip; new metrics are a chip, with no ghost frame on the goal", () => {
    expect(goal("init-orphan")).toMatchObject({ owner: { kind: "person", name: "Samvit Jain" }, ownerGhost: { tag: tagOf("g-owner") } });
    expect(goal("init-orphan").chips.map((c) => c.chip)).toEqual(["owner Samvit Jain"]);
    expect(edges.find((e) => e.kind === "owner" && e.source === goalNodeId("init-orphan"))).toMatchObject({ target: personNodeId("fixture-user-sam"), ghost: true });
    expect(goal("init-revenue").ghost).toBeUndefined();
    // Two changes to one goal (projects added, measured) are each drawn.
    expect(goal("init-revenue").chips.map((c) => c.change_id)).toEqual(["g-measure"]);
    expect(goal("init-revenue").chips[0].chip).toContain("Paying teams");
  });

  test("an owner change fades the old edge; an owner nothing answers to is a warning, not a dropped change", () => {
    const { nodes: n2, edges: e2 } = layoutGoals(input([{ ...GOALS_FIXTURE_CHANGES[3], change: { kind: "initiative_owner", initiative: "in-3", owner: "Nobody Here" } }]));
    const from = e2.filter((e) => e.kind === "owner" && e.source === goalNodeId("init-revenue"));
    expect(from.find((e) => e.faded)?.target).toBe(personNodeId("fixture-user-me"));
    expect(from.find((e) => e.ghost)?.target).toBe("owner:nobody here");
    expect(node(n2, goalNodeId("init-revenue"), "goal").goal.ownerGhost).toMatchObject({ unresolved: true });
    expect(node(n2, "owner:nobody here", "owner").owner).toMatchObject({ kind: "unknown", name: "Nobody Here" });
  });

  test("accepted is solid, applied and skipped draw nothing", () => {
    const withStatus = (status: "accepted" | "applied" | "skipped") => goalsPlan(input([{ ...GOALS_FIXTURE_CHANGES[0], status }])).goals.find((g) => g.id === "g-new");
    expect(withStatus("accepted")?.ghost).toMatchObject({ solid: true });
    expect(withStatus("applied")).toBeUndefined();
    expect(withStatus("skipped")).toBeUndefined();
  });

  test("a goal a change names that nothing answers to is drawn as a warning at the top", () => {
    const { goals } = goalsPlan(input([{ ...GOALS_FIXTURE_CHANGES[2], change: { kind: "initiative_projects", initiative: "in-99", projects: ["Billing"], title: "A goal that is gone" } }]));
    expect(goals.find((g) => g.title === "A goal that is gone")).toMatchObject({ parentId: null, ghost: { tag: "unknown", unresolved: true } });
  });

  test("ghosts still overlap nothing", () => {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
  });

  test("the lens a proposal opens in follows what it changes", () => {
    expect(hasGoalChanges(GOALS_FIXTURE_CHANGES)).toBe(true);
    expect(hasGoalChanges([{ ...GOALS_FIXTURE_CHANGES[0], change: { kind: "retire", handle: "growth", reason: "x" } }])).toBe(false);
  });
});
