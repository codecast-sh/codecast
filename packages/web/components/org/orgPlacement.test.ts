import { describe, expect, it } from "bun:test";
import { layoutOrgTree, personNodeId, rectsOverlap, roleNodeId, sessionNodeId, type OrgLayoutView } from "./orgLayout";
import { ORG_FIXTURE } from "./orgFixture";
import { dragRoots, parentsOf, subtreesOf, withoutPlaced, withPlaced } from "./orgPlacement";

const none: OrgLayoutView = { collapsed: new Set<string>(), expanded: {} };
const lay = (placed?: OrgLayoutView["placed"]) => layoutOrgTree(ORG_FIXTURE, placed ? { ...none, placed } : none, undefined, "far");
const base = lay();
const at = (l: ReturnType<typeof lay>, id: string) => l.nodes.find((n) => n.id === id)!;
const me = personNodeId("fixture-user-me");
const growth = roleNodeId("fixture-role-growth");
const mySession = sessionNodeId(ORG_FIXTURE.people[0].sessions[0]._id);

describe("orgPlacement", () => {
  it("a placed card sits at its spot beside its parent, its branch under it as usual", () => {
    const branch = subtreesOf(base.edges, [growth]);
    expect(branch.size).toBeGreaterThan(0);
    const l = lay({ [growth]: { x: 900, y: 40 } });
    const p = at(l, me), g = at(l, growth);
    expect(g.x).toBe(p.x + 900);
    expect(g.y).toBe(p.y + 40);
    // Its branch still hangs under it.
    for (const id of branch.keys()) expect(at(l, id).y).toBeGreaterThan(g.y + g.h);
    // The edge into it is a plain one: no lane or spine route.
    expect(l.edges.find((e) => e.target === growth)!.route).toBeUndefined();
  });

  it("the lane it left closes up: the card after it takes its place", () => {
    const l = lay({ [mySession]: { x: 1200, y: 0 } });
    const second = sessionNodeId(ORG_FIXTURE.people[0].sessions[1]._id);
    expect(at(l, second).y).toBe(at(base, mySession).y);
    expect(at(l, mySession).x).toBe(at(l, me).x + 1200);
  });

  it("a placed card follows its parent when the parent is placed too", () => {
    const one = lay({ [growth]: { x: 900, y: 40 } });
    const kid = [...subtreesOf(one.edges, [growth]).keys()].find((id) => id.startsWith("session:"))!;
    const both = lay({ [growth]: { x: 900, y: 40 }, [kid]: { x: 0, y: 300 } });
    expect(at(both, kid).x).toBe(at(both, growth).x);
    expect(at(both, kid).y).toBe(at(both, growth).y + 300);
  });

  it("a drag of a parent and its child together moves the branch once, from the parent", () => {
    const kid = [...subtreesOf(base.edges, [growth]).keys()][0];
    expect(dragRoots(base.edges, [growth, kid])).toEqual([growth]);
    expect(parentsOf(base.edges).get(growth)).toBe(me);
  });

  it("spots round to pixels and clear when a card moves under a new parent", () => {
    expect(withPlaced({}, [{ id: growth, x: 10.4, y: -3.6 }])[growth]).toEqual({ x: 10, y: -4 });
    expect(Object.keys(withoutPlaced({ [growth]: { x: 5, y: 5 }, [me]: { x: 1, y: 1 } }, [growth]))).toEqual([me]);
  });

  it("nothing placed is the tidy tree, which never overlaps", () => {
    for (let i = 0; i < base.nodes.length; i++) for (let j = i + 1; j < base.nodes.length; j++) expect(rectsOverlap(base.nodes[i], base.nodes[j])).toBe(false);
  });
});
