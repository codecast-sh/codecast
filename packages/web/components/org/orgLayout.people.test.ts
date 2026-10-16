import { describe, expect, it } from "bun:test";
import { layoutOrgTree, personNodeId, rectsOverlap } from "./orgLayout";
import { ORG_FIXTURE } from "./orgFixture";
import type { OrgTree } from "./orgTypes";

// A person who reports to a person hangs under them; a loop still draws everyone.
const none = { collapsed: new Set<string>(), expanded: {} };
const [me, sam] = ORG_FIXTURE.people;
const withManager = (tree: OrgTree, userId: string, managerId: string | undefined): OrgTree => ({
  ...tree,
  people: tree.people.map((p) => (p.user_id === userId ? { ...p, reports_to_user_id: managerId } : p)),
});

describe("orgLayout people under people", () => {
  it("nests a report under their manager, with no overlap", () => {
    const { nodes, edges } = layoutOrgTree(withManager(ORG_FIXTURE, sam.user_id, me.user_id), none);
    expect(edges.some((e) => e.source === personNodeId(me.user_id) && e.target === personNodeId(sam.user_id))).toBe(true);
    const meNode = nodes.find((n) => n.id === personNodeId(me.user_id))!;
    const samNode = nodes.find((n) => n.id === personNodeId(sam.user_id))!;
    expect(samNode.y).toBeGreaterThan(meNode.y);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
  });

  it("collapsing the manager hides the report and counts them", () => {
    const tree = withManager(ORG_FIXTURE, sam.user_id, me.user_id);
    const open = layoutOrgTree(tree, none);
    const folded = layoutOrgTree(tree, { ...none, collapsed: new Set([personNodeId(me.user_id)]) });
    expect(folded.nodes.some((n) => n.id === personNodeId(sam.user_id))).toBe(false);
    const meNode = folded.nodes.find((n) => n.id === personNodeId(me.user_id))!;
    expect(meNode.kind === "person" && meNode.hidden).toBeGreaterThan(0);
    expect(open.nodes.some((n) => n.id === personNodeId(sam.user_id))).toBe(true);
  });

  it("a loop in a snapshot still draws every person, each once", () => {
    const tree = withManager(withManager(ORG_FIXTURE, sam.user_id, me.user_id), me.user_id, sam.user_id);
    const { nodes } = layoutOrgTree(tree, none);
    expect(nodes.filter((n) => n.id === personNodeId(me.user_id)).length).toBe(1);
    expect(nodes.filter((n) => n.id === personNodeId(sam.user_id)).length).toBe(1);
  });
});
