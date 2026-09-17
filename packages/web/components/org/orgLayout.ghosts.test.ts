// Ghosts on the chart (docs/architecture/org-staffing.md S5): ghostsFor merges
// an open proposal into the tree, the layout carries the decoration. One test
// per change kind, then the accept stub, supersession, skip and focus.
import { describe, expect, it } from "bun:test";
import { focusTargetNodeId, ghostNodeIdFor, ghostsFor, layoutOrgTree, personNodeId, rectsOverlap, refResolves, resolveOrgParentRef, roleNodeId, sessionNodeId, ORG_SIZES, type OrgLayoutNode } from "./orgLayout";
import { ORG_FIXTURE } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import type { OrgChange, OrgProposalChange } from "./orgStaffingTypes";

const none = { collapsed: new Set<string>(), expanded: {} };
const ME = personNodeId("fixture-user-me");
const SAM = personNodeId("fixture-user-sam");
const GROWTH = roleNodeId("fixture-role-growth");
const byId = (nodes: OrgLayoutNode[]) => new Map(nodes.map((n) => [n.id, n]));

let seq = 0;
function change(c: OrgChange, status: OrgProposalChange["status"] = "proposed"): OrgProposalChange {
  seq += 1;
  return { _id: `chg-${seq}`, proposal_id: "p", seq, change: c, rationale: "because", evidence: [], status };
}

function lay(changes: OrgProposalChange[], opts?: Parameters<typeof ghostsFor>[2]) {
  const ghosts = ghostsFor(ORG_FIXTURE, changes, opts);
  return { ghosts, ...layoutOrgTree(ORG_FIXTURE, none, ghosts) };
}

describe("ghostsFor", () => {
  it("never mutates the tree it reads", () => {
    const before = JSON.stringify(ORG_FIXTURE);
    lay(ORG_STAFFING_FIXTURE_PROPOSAL.changes);
    expect(JSON.stringify(ORG_FIXTURE)).toBe(before);
  });

  it("role: a ghost node under its proposed parent, keyed by the change id, with scope chips and a proposed tag", () => {
    const c = change({ kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } });
    const { nodes, edges, ghosts } = lay([c]);
    const m = byId(nodes);
    const ghost = m.get(roleNodeId(c._id))!;
    expect(ghost?.kind).toBe("role");
    if (ghost.kind !== "role") return;
    expect(ghost.ghost).toEqual({ change_id: c._id, status: "proposed", line: "Create role Head of Platform @platform reporting to me over Platform", kind: "role", solid: false });
    expect(ghost.role.handle).toBe("platform");
    expect(ghost.role.scope_names.projects.map((p) => p.title)).toEqual(["Platform"]);
    // Under the viewer, one level below, on a ghost edge.
    const me = m.get(ME)!;
    expect(ghost.y).toBe(me.y + me.h + ORG_SIZES.levelGap);
    const edge = edges.find((e) => e.target === ghost.id)!;
    expect(edge.source).toBe(ME);
    expect(edge.kind).toBe("ghost");
    expect(ghostNodeIdFor(ghosts, c._id)).toBe(ghost.id);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
  });

  it("role: reports_to resolves @handle, or-N, a member's name, and a role the same proposal creates", () => {
    const parent = change({ kind: "role", name: "Head of Platform", handle: "platform", reports_to: "Samvit Jain" });
    const child = change({ kind: "role", name: "Sync Lead", handle: "sync", reports_to: "@platform" });
    const byShort = change({ kind: "role", name: "SEO", handle: "seo", reports_to: "or-1" });
    const { edges } = lay([parent, child, byShort]);
    expect(edges.find((e) => e.target === roleNodeId(parent._id))?.source).toBe(SAM);
    expect(edges.find((e) => e.target === roleNodeId(child._id))?.source).toBe(roleNodeId(parent._id));
    expect(edges.find((e) => e.target === roleNodeId(byShort._id))?.source).toBe(GROWTH);
  });

  it("role: accepted renders solid at once (the tree draft stub), applied stays until org.tree carries the handle", () => {
    const c = change({ kind: "role", name: "Head of Platform", handle: "platform" }, "accepted");
    const { nodes, edges } = lay([c]);
    const ghost = byId(nodes).get(roleNodeId(c._id))!;
    if (ghost.kind !== "role") throw new Error("role");
    expect(ghost.ghost?.solid).toBe(true);
    expect(ghost.ghost?.status).toBe("accepted");
    expect(ghost.role._id).toBe(c._id);
    expect(ghost.role.status).toBe("active");
    expect(ghost.role.reports_to).toEqual({ kind: "user", user_id: "fixture-user-me" });
    // A solid stub hangs on a plain tree edge.
    expect(edges.find((e) => e.target === ghost.id)?.kind).toBe("tree");
    const applied = lay([{ ...c, status: "applied" }]);
    expect(applied.ghosts.stubs[roleNodeId(c._id)]?.solid).toBe(true);
  });

  it("role: superseded once the tree carries a live role with the handle", () => {
    const c = change({ kind: "role", name: "Growth", handle: "growth" }, "applied");
    const { nodes, ghosts } = lay([c]);
    expect(Object.keys(ghosts.stubs)).toEqual([]);
    expect(nodes.filter((n) => n.kind === "role").length).toBe(1);
  });

  it("move: a dashed edge to the new parent and the old edge faded; accepted re-parents the row", () => {
    const c = change({ kind: "move", handle: "growth", reports_to: "Samvit Jain" });
    const { nodes, edges, ghosts } = lay([c]);
    const old = edges.find((e) => e.target === GROWTH && e.kind === "tree")!;
    expect(old.source).toBe(ME);
    expect(old.faded).toBe(true);
    const dashed = edges.find((e) => e.kind === "ghost" && e.change_id === c._id)!;
    expect(dashed.source).toBe(SAM);
    expect(dashed.target).toBe(GROWTH);
    const role = byId(nodes).get(GROWTH)!;
    if (role.kind !== "role") throw new Error("role");
    expect(role.move?.to).toEqual({ kind: "user", user_id: "fixture-user-sam" });
    expect(role.chips?.[0]).toMatchObject({ kind: "move", change_id: c._id });
    expect(ghostNodeIdFor(ghosts, c._id)).toBe(GROWTH);
    // Accepted: the role now hangs under Sam, no ghost edge, no chip.
    const acc = lay([{ ...c, status: "accepted" }]);
    expect(acc.edges.find((e) => e.target === GROWTH && e.kind === "tree")?.source).toBe(SAM);
    expect(acc.edges.some((e) => e.kind === "ghost")).toBe(false);
    expect(acc.ghosts.chips[GROWTH]).toBeUndefined();
  });

  it("retire: a hatched overlay and tag on the node; accepted hides it and re-homes its reports", () => {
    const c = change({ kind: "retire", handle: "growth" });
    const { nodes } = lay([c]);
    const role = byId(nodes).get(GROWTH)!;
    if (role.kind !== "role") throw new Error("role");
    expect(role.retire).toEqual({ change_id: c._id, status: "proposed", line: "Retire @growth" });
    // A role under growth, then growth retired and accepted: the child moves up to me.
    const child = change({ kind: "role", name: "SEO", handle: "seo", reports_to: "@growth" }, "applied");
    const acc = lay([child, { ...c, status: "accepted" }]);
    expect(acc.nodes.some((n) => n.id === GROWTH)).toBe(false);
    expect(acc.edges.find((e) => e.target === roleNodeId(child._id))?.source).toBe(ME);
  });

  it("scope, budget, trust, routine: a dashed chip carrying describeOrgChange's line on the handle's node", () => {
    const cs = [
      change({ kind: "scope", handle: "growth", add: ["Platform"] }),
      change({ kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } }),
      change({ kind: "trust", handle: "growth", trust: "decide" }),
      change({ kind: "routine", handle: "growth", title: "Weekly growth review", prompt: "p", every: "7d" }),
    ];
    const { nodes, ghosts } = lay(cs);
    const chips = ghosts.chips[GROWTH]!;
    expect(chips.map((c) => c.kind)).toEqual(["scope", "budget", "trust", "routine"]);
    expect(chips.map((c) => c.line)).toEqual([
      "Scope @growth +Platform",
      "Budget @growth tokens 800000/day",
      "Trust @growth to decide",
      "Routine on @growth: Weekly growth review every 7d",
    ]);
    // The card grows by one chip row (on top of its standing line's row) so the layout never overlaps.
    const role = byId(nodes).get(GROWTH)!;
    expect(role.h).toBe(ORG_SIZES.role.h + ORG_SIZES.standingRow + ORG_SIZES.chipRow);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
    // Accepted stays as a solid chip; applied drops.
    expect(lay([{ ...cs[1], status: "accepted" }]).ghosts.chips[GROWTH]?.[0].status).toBe("accepted");
    expect(lay([{ ...cs[1], status: "applied" }]).ghosts.chips[GROWTH]).toBeUndefined();
  });

  it("a chip on a handle nobody has lands on the viewer's own card", () => {
    const c = change({ kind: "budget", handle: "nobody", caps: { wakes_per_day: 3 } });
    const { ghosts, nodes } = lay([c]);
    expect(ghosts.chips[ME]?.[0].change_id).toBe(c._id);
    expect(byId(nodes).get(ME)!.h).toBe(ORG_SIZES.person.h + ORG_SIZES.chipRow);
  });

  it("file: a chip on the role whose scope names the plan or project, else the viewer", () => {
    const planTitle = ORG_FIXTURE.roles[0].scope_names.plans[0]?.short_id ?? ORG_FIXTURE.roles[0].scope_names.projects[0]?.title;
    const inScope = change({ kind: "file", plan: planTitle ?? "pl-88", project: ORG_FIXTURE.roles[0].scope_names.projects[0]?.title ?? "Growth" });
    const orphan = change({ kind: "file", plan: "pl-999", project: "Nowhere" });
    const { ghosts } = lay([inScope, orphan]);
    expect(ghosts.chips[GROWTH]?.map((c) => c.change_id)).toEqual([inScope._id]);
    expect(ghosts.chips[ME]?.map((c) => c.change_id)).toEqual([orphan._id]);
  });

  it("project_meta: a chip on the owner role, else the role whose scope has the project", () => {
    const owned = change({ kind: "project_meta", project: "Anything", owner: "@growth", goal: "Double signups" });
    const scoped = change({ kind: "project_meta", project: ORG_FIXTURE.roles[0].scope_names.projects[0]?.title ?? "Growth", priority: "p1" });
    const { ghosts } = lay([owned, scoped]);
    expect(ghosts.chips[GROWTH]?.map((c) => c.change_id)).toEqual([owned._id, scoped._id]);
    expect(ghosts.chips[GROWTH]?.[0].line).toBe("Charter Anything owner @growth: Double signups");
  });

  it("adopt: a ghost session under the role, 'this session' when the viewer is looking from it", () => {
    const c = change({ kind: "adopt", handle: "growth", conversation: "jx7abcd" });
    const mine = lay([c], { viewerSession: { short_id: "jx7abcd" } });
    const node = byId(mine.nodes).get(sessionNodeId(c._id))!;
    expect(node.kind).toBe("session");
    if (node.kind !== "session") return;
    expect(node.ghost).toMatchObject({ kind: "adopt", solid: false, this_session: true, change_id: c._id });
    expect(node.session.title).toBe("This session");
    expect(node.session.short_id).toBe("jx7abcd");
    expect(node.parent).toEqual({ kind: "role", role_id: "fixture-role-growth" });
    // First in the role's stack, on a ghost edge from the role.
    expect(mine.edges.find((e) => e.target === node.id)).toMatchObject({ source: GROWTH, kind: "ghost" });
    const theirs = lay([c], { viewerSession: { short_id: "jx7other" } });
    const other = byId(theirs.nodes).get(sessionNodeId(c._id))!;
    if (other.kind === "session") {
      expect(other.ghost?.this_session).toBe(false);
      expect(other.session.title).toBe("Offered session");
    }
    // An adopt naming a role the same proposal creates hangs under that stub.
    const role = change({ kind: "role", name: "Chief of Staff", handle: "chief-of-staff" });
    const adopt = change({ kind: "adopt", handle: "chief-of-staff", conversation: "jx7abcd" });
    const both = lay([role, adopt]);
    expect(both.edges.find((e) => e.target === sessionNodeId(adopt._id))?.source).toBe(roleNodeId(role._id));
  });

  it("skipped changes drop; failed ones stay drawn as decidable", () => {
    const skipped = change({ kind: "role", name: "X", handle: "x" }, "skipped");
    const failed = change({ kind: "role", name: "Y", handle: "y" }, "failed");
    const { ghosts } = lay([skipped, failed]);
    expect(ghosts.stubs[roleNodeId(skipped._id)]).toBeUndefined();
    expect(ghosts.stubs[roleNodeId(failed._id)]).toMatchObject({ status: "failed", solid: false });
  });

  it("the fixture proposal lays out without overlap and every open change has a place", () => {
    const { nodes, ghosts } = lay(ORG_STAFFING_FIXTURE_PROPOSAL.changes);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
    for (const c of ORG_STAFFING_FIXTURE_PROPOSAL.changes) {
      // A skipped change has no place by design; a project charter with no
      // owning role lives on the scope panel's project row, not the canvas.
      if (c.status === "skipped") continue;
      if (c.change.kind === "project_meta" && !ghostNodeIdFor(ghosts, c._id)) continue;
      expect(ghostNodeIdFor(ghosts, c._id)).not.toBeNull();
    }
  });

  it("a chip carries the delta alone; the full sentence is its line", () => {
    const cs = [
      change({ kind: "scope", handle: "growth", add: ["Platform"], remove: ["pl-3"] }),
      change({ kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000, hands_per_day: 4 } }),
      change({ kind: "trust", handle: "growth", trust: "decide" }),
      change({ kind: "routine", handle: "growth", title: "Weekly growth review", prompt: "p", every: "7d" }),
      change({ kind: "move", handle: "growth", reports_to: "Samvit Jain" }),
    ];
    const { ghosts } = lay(cs);
    expect(ghosts.chips[GROWTH]!.map((c) => c.chip)).toEqual([
      "under Samvit Jain",
      "+ Platform \u2212 pl-3",
      "hands 4 \u00b7 tokens 800k",
      "trust to decide",
      "every 7d \u00b7 Weekly growth review",
    ]);
    expect(ghosts.chips[GROWTH]!.every((c) => c.line.length > c.chip.length)).toBe(true);
  });

  it("a handle nothing live answers to is a warning chip on the viewer, never a vanished change", () => {
    const move = change({ kind: "move", handle: "nobody", reports_to: "me" });
    const retire = change({ kind: "retire", handle: "nobody" });
    const adopt = change({ kind: "adopt", handle: "nobody", conversation: "jx7abcd" });
    const trust = change({ kind: "trust", handle: "nobody", trust: "decide" });
    const { ghosts } = lay([move, retire, adopt, trust]);
    const chips = ghosts.chips[ME]!;
    expect(chips.map((c) => [c.change_id, c.unresolved])).toEqual([[move._id, true], [retire._id, true], [adopt._id, true], [trust._id, true]]);
    for (const c of [move, retire, adopt, trust]) expect(ghostNodeIdFor(ghosts, c._id)).toBe(ME);
    // Applied ones are history: the subject is gone and nothing is drawn.
    const done = lay([{ ...retire, status: "applied" }, { ...adopt, status: "applied" }]);
    expect(done.ghosts.chips[ME]).toBeUndefined();
    // A move whose target nothing answers to warns on the role's own card.
    const badTarget = change({ kind: "move", handle: "growth", reports_to: "@nowhere" });
    const bt = lay([badTarget]);
    expect(bt.ghosts.chips[GROWTH]?.[0]).toMatchObject({ change_id: badTarget._id, unresolved: true });
    expect(bt.ghosts.moves).toEqual([]);
  });

  it("projects and a kind this build does not know are chips on the viewer's card", () => {
    const projects = change({ kind: "projects", changes: [{ op: "create", title: "Platform" }, { op: "merge", from: "Old", into: "Platform" }] });
    const unknown = change({ kind: "rename", handle: "growth", to: "Growth 2" } as unknown as OrgChange);
    const { ghosts } = lay([projects, unknown]);
    expect(ghosts.chips[ME]!.map((c) => [c.change_id, c.chip])).toEqual([[projects._id, "+ Platform, Old into Platform"], [unknown._id, 'A change this version of codecast cannot show yet ("rename")']]);
    expect(ghosts.chips[ME]![1].line).toBe('A change this version of codecast cannot show yet ("rename")');
  });

  it("project_meta: with no owning role the canvas draws nothing (the scope panel's project row carries it); an owner nothing answers to warns", () => {
    const unowned = change({ kind: "project_meta", project: "Nowhere", goal: "A goal" });
    const badOwner = change({ kind: "project_meta", project: "Nowhere", owner: "@nobody" });
    const { ghosts } = lay([unowned, badOwner]);
    expect(ghostNodeIdFor(ghosts, unowned._id)).toBeNull();
    expect(ghosts.chips[ME]?.map((c) => [c.change_id, c.unresolved])).toEqual([[badOwner._id, true]]);
  });

  it("edits ride over the proposal: an accepted role with edits draws the edited name and handle, and supersedes by the edited handle", () => {
    const c = { ...change({ kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me" }, "accepted"), edits: { name: "Platform Lead", handle: "platform-lead", reports_to: "Samvit Jain" } };
    const { nodes, edges, ghosts } = lay([c]);
    const stub = byId(nodes).get(roleNodeId(c._id))!;
    if (stub.kind !== "role") throw new Error("role");
    expect(stub.role.name).toBe("Platform Lead");
    expect(stub.role.handle).toBe("platform-lead");
    expect(stub.ghost?.line).toBe("Create role Platform Lead @platform-lead reporting to Samvit Jain");
    expect(edges.find((e) => e.target === stub.id)?.source).toBe(SAM);
    // The edited handle is what org.tree will echo: a proposal for "growth" edited to a live handle is superseded.
    const dup = { ...change({ kind: "role", name: "G", handle: "g2" }, "accepted"), edits: { handle: "growth" } };
    expect(Object.keys(lay([dup]).ghosts.stubs)).toEqual([]);
    // A budget edit merges one level deep on the chip too.
    const budget = { ...change({ kind: "budget", handle: "growth", caps: { hands_per_day: 4, tokens_per_day: 400_000 } }), edits: { caps: { tokens_per_day: 800_000 } } };
    expect(lay([budget]).ghosts.chips[GROWTH]?.[0].chip).toBe("hands 4 \u00b7 tokens 800k");
    void ghosts;
  });

  it("adopt: the stub is taller than a session row and the stack below it moves down", () => {
    const c = change({ kind: "adopt", handle: "growth", conversation: "jx7abcd" });
    const { nodes } = lay([c]);
    const stub = byId(nodes).get(sessionNodeId(c._id))!;
    expect(stub.h).toBe(ORG_SIZES.session.h + ORG_SIZES.adoptRow);
    if (stub.kind !== "session") throw new Error("session");
    expect(stub.ghost?.role_handle).toBe("growth");
    const below = nodes.filter((n) => n.kind === "session" && n.x === stub.x && n.y > stub.y).sort((a, b) => a.y - b.y)[0];
    if (below) expect(below.y).toBe(stub.y + stub.h + ORG_SIZES.stackGap);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
  });
});

describe("focus target", () => {
  it("the last ask wins: a node asked after a change pans to the node, and vice versa; a repeat ask carries a new seq", () => {
    const c = change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 3 } });
    const { ghosts } = lay([c]);
    expect(focusTargetNodeId(ghosts, { kind: "change", id: c._id, seq: 1 })).toBe(GROWTH);
    expect(focusTargetNodeId(ghosts, { kind: "node", id: SAM, seq: 2 })).toBe(SAM);
    expect(focusTargetNodeId(ghosts, { kind: "change", id: "nope", seq: 3 })).toBeNull();
    expect(focusTargetNodeId(ghosts, null)).toBeNull();
    // Two asks for the same node differ only by seq, which is what re-pans.
    const a = { kind: "node" as const, id: SAM, seq: 4 };
    const b = { kind: "node" as const, id: SAM, seq: 5 };
    expect(focusTargetNodeId(ghosts, a)).toBe(focusTargetNodeId(ghosts, b));
    expect(a.seq).not.toBe(b.seq);
  });
});

describe("refResolves", () => {
  it("exact id, short id or title first, else a unique title substring, else null", () => {
    const rows = [{ id: "p1", title: "Growth", short_id: "pr-1" }, { id: "p2", title: "Growth platform", short_id: "pr-2" }, { id: "p3", title: "Billing", short_id: "pr-3" }];
    expect(refResolves("pr-2", rows)?.id).toBe("p2");
    expect(refResolves("growth", rows)?.id).toBe("p1");
    expect(refResolves("platform", rows)?.id).toBe("p2");
    expect(refResolves("bill", rows)?.id).toBe("p3");
    expect(refResolves("gro", rows)).toBeNull();
    expect(refResolves("nowhere", rows)).toBeNull();
    expect(refResolves("  ", rows)).toBeNull();
  });
});

describe("a role's standing line", () => {
  it("is charged in the layout on the same predicate the card draws it with, so chips never hang outside the frame", () => {
    const withLine = ORG_FIXTURE.roles.find((r) => r.standing?.state_line || r.standing?.state)!;
    expect(withLine).toBeDefined();
    const { nodes } = lay([]);
    const node = byId(nodes).get(roleNodeId(withLine._id))!;
    expect(node.h).toBe(ORG_SIZES.role.h + ORG_SIZES.standingRow);
    // Without a standing line the seat is the base height; with a chips row both stack.
    const bare = { ...ORG_FIXTURE, roles: ORG_FIXTURE.roles.map((r) => ({ ...r, standing: undefined })) };
    const plain = layoutOrgTree(bare, none).nodes.find((n) => n.id === roleNodeId(withLine._id))!;
    expect(plain.h).toBe(ORG_SIZES.role.h);
    const c = change({ kind: "trust", handle: withLine.handle, trust: "decide" });
    const chipped = byId(lay([c]).nodes).get(roleNodeId(withLine._id))!;
    expect(chipped.h).toBe(ORG_SIZES.role.h + ORG_SIZES.standingRow + ORG_SIZES.chipRow);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) expect(rectsOverlap(nodes[i], nodes[j])).toBe(false);
  });
});

describe("resolveOrgParentRef", () => {
  it("reads every form a proposal writes, and null for a stranger", () => {
    expect(resolveOrgParentRef(ORG_FIXTURE, undefined)).toEqual({ kind: "user", user_id: "fixture-user-me" });
    expect(resolveOrgParentRef(ORG_FIXTURE, "me")).toEqual({ kind: "user", user_id: "fixture-user-me" });
    expect(resolveOrgParentRef(ORG_FIXTURE, "@growth")).toEqual({ kind: "role", role_id: "fixture-role-growth" });
    expect(resolveOrgParentRef(ORG_FIXTURE, ORG_FIXTURE.roles[0].short_id)).toEqual({ kind: "role", role_id: "fixture-role-growth" });
    expect(resolveOrgParentRef(ORG_FIXTURE, "Samvit Jain")).toEqual({ kind: "user", user_id: "fixture-user-sam" });
    expect(resolveOrgParentRef(ORG_FIXTURE, "fixture-user-sam")).toEqual({ kind: "user", user_id: "fixture-user-sam" });
    expect(resolveOrgParentRef(ORG_FIXTURE, "@nobody")).toBeNull();
  });
});
