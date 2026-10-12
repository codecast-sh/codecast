// The Everything chart as one graph (orgProductLayer + orgLayout) over the
// Union fixture: the people chart is the spine, a goal hangs under its owner,
// a project under its lead with its sessions under it, cross edges link a
// project to a goal in another branch, and what nobody owns collects in one
// group at the end.
import { describe, expect, it } from "bun:test";
import { UNION_GOALS_DATA, UNION_GOALS_TREE } from "./goalsFixture";
import { productLayer } from "./orgProductLayer";
import { goalNodeIdOf, layoutOrgTree, MISSION_NODE_ID, projectNodeIdOf, rectsOverlap, roleNodeId, personNodeId, sessionNodeId, UNOWNED_NODE_ID, type OrgLayoutView } from "./orgLayout";

const tree = UNION_GOALS_TREE;
const quality = tree.roles.find((r) => r._id === "fixture-role-agent-quality")!;
const [worksOnQuality, alsoQuality] = quality.sessions;
const sessionProject = { [worksOnQuality._id]: "union-proj-quality", [alsoQuality._id]: "union-proj-quality" };

function lay(level: "far" | "mid" | "close" = "mid", extra: Partial<OrgLayoutView> = {}) {
  const view: OrgLayoutView = { collapsed: new Set(), expanded: {}, sessionCards: true, ...extra, product: productLayer(tree, { ...UNION_GOALS_DATA, sessionProject }, level) };
  const out = layoutOrgTree(tree, view, undefined, level);
  const parent = new Map(out.edges.filter((e) => e.kind === "tree" || e.kind === "stack").map((e) => [e.target, e.source]));
  /** The card a node hangs under, walking up a session stack to its head. */
  const owner = (id: string): string | undefined => { let p = parent.get(id); while (p?.startsWith("session:")) p = parent.get(p); return p; };
  return { ...out, parent, owner, byId: new Map(out.nodes.map((n) => [n.id, n])) };
}

describe("the Everything chart", () => {
  it("hangs each goal under its owner and each project under its lead, with the project's sessions under the project", () => {
    const l = lay();
    expect(l.parent.get(goalNodeIdOf("union-in-2"))).toBe(personNodeId("fixture-user-me"));
    expect(l.parent.get(goalNodeIdOf("union-in-4"))).toBe(roleNodeId("fixture-role-agent-quality"));
    expect(l.parent.get(goalNodeIdOf("union-in-1"))).toBe(roleNodeId("fixture-role-head-of-people"));
    expect(l.parent.get(projectNodeIdOf("union-proj-quality"))).toBe(roleNodeId("fixture-role-agent-quality"));
    // The sessions working on the project sit under it, and leave the role's own stack.
    for (const s of [worksOnQuality, alsoQuality]) expect(l.owner(sessionNodeId(s._id))).toBe(projectNodeIdOf("union-proj-quality"));
    const rest = quality.sessions.filter((s) => !sessionProject[s._id]).slice(0, 3);
    for (const s of rest) expect(l.owner(sessionNodeId(s._id))).toBe(roleNodeId(quality._id));
    // Each session is drawn once.
    const ids = l.nodes.filter((n) => n.kind === "session").map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the goals a project serves, and draws a cross edge only where the goal sits in another branch", () => {
    const l = lay();
    const p = l.byId.get(projectNodeIdOf("union-proj-quality"))!;
    expect(p.kind === "project" && (p.data.goals as { id: string }[]).map((g) => g.id)).toEqual(["union-in-1"]);
    const cross = l.edges.filter((e) => e.kind === "cross");
    // Agent Quality (under its role) serves a goal owned by the head of people: another branch.
    expect(cross.some((e) => e.source === projectNodeIdOf("union-proj-quality") && e.target === goalNodeIdOf("union-in-1"))).toBe(true);
    // Unled projects sit in the group with the goal they serve elsewhere: also a cross edge, never a tree edge to the goal.
    expect(l.edges.some((e) => e.kind === "tree" && e.source.startsWith("goal:"))).toBe(false);
  });

  it("collects what nobody owns or leads in one group at the end, and puts the mission (here the company) first", () => {
    const l = lay();
    const group = l.byId.get(UNOWNED_NODE_ID)!;
    expect(group.kind).toBe("group");
    const unled = ["union-proj-matching", "union-proj-callers", "union-proj-network", "union-proj-outreach", "union-proj-launch"];
    for (const id of unled) expect(l.parent.get(projectNodeIdOf(id))).toBe(UNOWNED_NODE_ID);
    expect(group.kind === "group" && group.count).toBe(l.edges.filter((e) => e.source === UNOWNED_NODE_ID && e.kind === "tree").length);
    // Roots run left to right: the mission first, the group last.
    const roots = l.nodes.filter((n) => n.y === 0).sort((a, b) => a.x - b.x);
    expect(roots[0].id).toBe(MISSION_NODE_ID);
    expect(roots.at(-1)!.id).toBe(UNOWNED_NODE_ID);
  });

  it("never overlaps, at every zoom level and with every card opened", () => {
    for (const level of ["far", "mid", "close"] as const) {
      const base = lay(level);
      const opened = new Set(base.nodes.filter((n) => n.kind === "role" || n.kind === "session").map((n) => n.id));
      for (const l of [base, lay(level, { opened })]) {
        for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(rectsOverlap(l.nodes[i], l.nodes[j])).toBe(false);
      }
    }
  });

  it("a folded owner hides its goals and projects with the rest of its branch", () => {
    const l = lay("mid", { collapsed: new Set([roleNodeId(quality._id)]) });
    expect(l.byId.has(projectNodeIdOf("union-proj-quality"))).toBe(false);
    expect(l.byId.has(goalNodeIdOf("union-in-4"))).toBe(false);
    const role = l.byId.get(roleNodeId(quality._id))!;
    expect(role.kind === "role" && role.hidden).toBeGreaterThan(0);
  });
});
