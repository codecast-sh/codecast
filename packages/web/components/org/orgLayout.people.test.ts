import { describe, expect, it } from "bun:test";
import { layoutOrgTree, personNodeId, rectsOverlap, roleNodeId } from "./orgLayout";
import { ORG_FIXTURE } from "./orgFixture";
import type { OrgTree } from "./orgTypes";

// A person who reports to a person hangs under them; a loop still draws everyone.
const none = { collapsed: new Set<string>(), expanded: {} };
const [me, sam] = ORG_FIXTURE.people;
const withManager = (tree: OrgTree, userId: string, managerId: string | undefined): OrgTree => ({
  ...tree,
  people: tree.people.map((p) => (p.user_id === userId ? { ...p, managers: managerId ? [{ kind: "user" as const, user_id: managerId }] : undefined } : p)),
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

describe("orgLayout people under a role (org-people.md P2)", () => {
  const underRole = (tree: OrgTree, userId: string, roleId: string): OrgTree => ({
    ...tree,
    people: tree.people.map((p) => (p.user_id === userId ? { ...p, managers: [{ kind: "role" as const, role_id: roleId }] } : p)),
  });
  const role = ORG_FIXTURE.roles.find((r) => r.status !== "retired" && r.reports_to.kind === "user" && r.reports_to.user_id === me.user_id)!;

  it("hangs the person under the role's card, with no overlap", () => {
    const { nodes, edges } = layoutOrgTree(underRole(ORG_FIXTURE, sam.user_id, role._id), none);
    expect(edges.some((e) => e.source === roleNodeId(role._id) && e.target === personNodeId(sam.user_id))).toBe(true);
    expect(nodes.filter((n) => n.id === personNodeId(sam.user_id)).length).toBe(1);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
  });

  it("collapsing the role hides the person and counts them", () => {
    const folded = layoutOrgTree(underRole(ORG_FIXTURE, sam.user_id, role._id), { ...none, collapsed: new Set([roleNodeId(role._id)]) });
    expect(folded.nodes.some((n) => n.id === personNodeId(sam.user_id))).toBe(false);
    const roleNode = folded.nodes.find((n) => n.id === roleNodeId(role._id))!;
    expect(roleNode.kind === "role" && roleNode.hidden).toBeGreaterThan(0);
  });

  it("a person over the role that they report to (a snapshot loop) is still drawn once", () => {
    const tree = underRole(ORG_FIXTURE, me.user_id, role._id);
    const { nodes } = layoutOrgTree(tree, none);
    expect(nodes.filter((n) => n.id === personNodeId(me.user_id)).length).toBe(1);
    expect(nodes.filter((n) => n.id === roleNodeId(role._id)).length).toBe(1);
  });
});
