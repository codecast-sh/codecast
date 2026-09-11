import { describe, expect, it } from "bun:test";
import { layoutOrgTree, rectsOverlap, personNodeId, roleNodeId, sessionNodeId, clusterNodeId, ORG_SIZES, type OrgLayoutNode } from "./orgLayout";
import { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } from "./orgFixture";
import { sortOrgSessions } from "./orgTypes";

const none = { collapsed: new Set<string>(), expanded: {} };
const byId = (nodes: OrgLayoutNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe("orgLayout", () => {
  it("no two nodes overlap", () => {
    const { nodes } = layoutOrgTree(ORG_FIXTURE, none);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
      }
    }
  });

  it("a parent is centred over its children", () => {
    const { nodes, edges } = layoutOrgTree(ORG_FIXTURE, none);
    const m = byId(nodes);
    const me = m.get(personNodeId("fixture-user-me"))!;
    const kids = edges.filter((e) => e.source === me.id).map((e) => m.get(e.target)!);
    expect(kids.length).toBeGreaterThan(1);
    const left = Math.min(...kids.map((k) => k.x));
    const right = Math.max(...kids.map((k) => k.x + k.w));
    expect(me.x + me.w / 2).toBeCloseTo((left + right) / 2, 5);
    // Children sit one level below the parent.
    for (const k of kids) expect(k.y).toBe(me.y + me.h + ORG_SIZES.levelGap);
  });

  it("sessions under a parent form a vertical stack ending in a cluster", () => {
    const { nodes, edges } = layoutOrgTree(ORG_FIXTURE, none);
    const m = byId(nodes);
    const me = personNodeId("fixture-user-me");
    const sessions = nodes.filter((n) => n.kind === "session" && n.parent.kind === "user" && n.parent.user_id === "fixture-user-me");
    expect(sessions.length).toBe(8);
    const xs = new Set(sessions.map((s) => s.x));
    expect(xs.size).toBe(1);
    const cluster = m.get(clusterNodeId(me))!;
    expect(cluster.kind).toBe("cluster");
    if (cluster.kind === "cluster") {
      expect(cluster.remaining).toBe(22 - 8);
      expect(cluster.total).toBe(22);
    }
    // One tree edge into the top of the stack, then a chain.
    const first = sessionNodeId(ORG_FIXTURE.people[0].sessions[0]._id);
    expect(edges.some((e) => e.source === me && e.target === first && e.kind === "tree")).toBe(true);
    expect(edges.filter((e) => e.source === me).length).toBe(
      1 /* stack head */ + 1 /* role */ + 1 /* anchor */,
    );
  });

  it("a collapsed subtree takes one slot and reports what it hides", () => {
    const full = layoutOrgTree(ORG_FIXTURE, none);
    const me = personNodeId("fixture-user-me");
    const folded = layoutOrgTree(ORG_FIXTURE, { collapsed: new Set([me]), expanded: {} });
    const under = (l: typeof full) => l.edges.filter((e) => e.source === me).length;
    expect(under(full)).toBeGreaterThan(0);
    expect(under(folded)).toBe(0);
    const node = byId(folded.nodes).get(me)!;
    expect(node.kind).toBe("person");
    if (node.kind === "person") {
      expect(node.collapsed).toBe(true);
      // 22 sessions + 1 role (+ its 7 sessions) + 1 anchor.
      expect(node.hidden).toBe(22 + 1 + 7 + 1);
    }
    expect(folded.width).toBeLessThan(full.width);
    // The person still keeps the card's own width as its slot.
    const root = folded.nodes.find((n) => n.id === me)!;
    expect(root.w).toBe(ORG_SIZES.person.w);
    for (let i = 0; i < folded.nodes.length; i++) {
      for (let j = i + 1; j < folded.nodes.length; j++) {
        expect(rectsOverlap(folded.nodes[i], folded.nodes[j])).toBe(false);
      }
    }
  });

  it("expanding a cluster appends the loaded sessions and keeps the stack tidy", () => {
    const me = personNodeId("fixture-user-me");
    const extra = sortOrgSessions(ORG_FIXTURE_ALL_SESSIONS.filter((s) => s.owner_user_id === "fixture-user-me" && !s.org_role_id)).slice(8, 16);
    const { nodes } = layoutOrgTree(ORG_FIXTURE, { collapsed: new Set(), expanded: { [me]: extra } });
    const stack = nodes.filter((n) => n.kind === "session" && n.parent.kind === "user" && n.parent.user_id === "fixture-user-me");
    expect(stack.length).toBe(16);
    const cluster = byId(nodes).get(clusterNodeId(me))!;
    if (cluster.kind === "cluster") expect(cluster.remaining).toBe(6);
    const ys = stack.map((s) => s.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBe(ORG_SIZES.session.h + ORG_SIZES.stackGap);
  });

  it("a role hangs under the person it reports to", () => {
    const { nodes, edges } = layoutOrgTree(ORG_FIXTURE, none);
    const m = byId(nodes);
    const role = m.get(roleNodeId("fixture-role-growth"))!;
    const me = m.get(personNodeId("fixture-user-me"))!;
    expect(edges.some((e) => e.source === me.id && e.target === role.id)).toBe(true);
    expect(role.y).toBeGreaterThan(me.y);
    // The role's own sessions stack under the role, not the person.
    const roleSessions = nodes.filter((n) => n.kind === "session" && n.parent.kind === "role");
    expect(roleSessions.length).toBe(7);
    for (const s of roleSessions) expect(s.y).toBeGreaterThan(role.y + role.h);
  });

  it("an anchor's bot user is drawn as the anchor card, not as a person", () => {
    const tree = {
      ...ORG_FIXTURE,
      people: [...ORG_FIXTURE.people, { ...ORG_FIXTURE.people[1], user_id: "fixture-bot", name: "Anchor", is_me: false, sessions: [], total: 0 }],
    };
    const { nodes } = layoutOrgTree(tree, none);
    expect(nodes.some((n) => n.kind === "person" && n.person.user_id === "fixture-bot")).toBe(false);
    expect(nodes.some((n) => n.kind === "anchor" && n.anchor.bot_user_id === "fixture-bot")).toBe(true);
  });
});
