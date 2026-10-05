// The rows a proposal card draws (org-staffing.md S24), projected from the
// same merge the chart draws its ghosts from: a new role under the viewer, a
// move onto that new role with where it came from, a retire, a chip kind on
// its role, a handle nothing answers to, and the same changes without a tree.
// Run: bun test components/org/proposalTree.test.ts
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { partyFace, proposalChangeRows, proposalOutcome, proposalQuietLines, proposalTreeRows, treeOrder } from "./proposalTree";
import type { OrgProposalChange } from "./orgStaffingTypes";

const change = (id: string, seq: number, c: any, status: OrgProposalChange["status"] = "proposed", extra: Partial<OrgProposalChange> = {}): OrgProposalChange =>
  ({ _id: id, proposal_id: "p1", seq, change: c, rationale: `why ${id}`, evidence: [], status, ...extra });

const CHANGES = [
  change("c-role", 1, { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] } }),
  change("c-move", 2, { kind: "move", handle: "growth", reports_to: "@platform" }),
  change("c-retire", 3, { kind: "retire", handle: "growth", reason: "folded into platform" }),
  change("c-budget", 4, { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } }),
  change("c-orphan", 5, { kind: "trust", handle: "nobody", trust: "decide" }),
  change("c-gone", 6, { kind: "scope", handle: "growth", add: ["x"] }, "removed"),
];

describe("proposalTreeRows", () => {
  test("goals draw as their tree: owners by name resolve to people, children follow the goal they feed", () => {
    const goals = [{ _id: "g-live", short_id: "in-2", title: "Win the private network", status: "active", project_ids: [], health: "none", workspace: "team:x", user_id: "u", created_at: 0, updated_at: 0 }] as any;
    const rows = proposalTreeRows(ORG_FIXTURE, [
      change("c-shape", 1, { kind: "initiative_shape", initiative: "in-2", parent: "Broker introductions", title: "Win the private network" }),
      change("c-top", 2, { kind: "initiative", title: "Broker introductions", description: "d", projects: ["Union"], owner: "Ashot Petrosian" }),
      change("c-rev", 3, { kind: "initiative", title: "Make revenue", description: "d", projects: ["Deals"], owner: "Samvit Jain", parent: "Broker introductions", metrics: [{ name: "Fees", target: "$1" }] }),
      change("c-who", 4, { kind: "initiative", title: "Hire", description: "d", projects: ["People"], owner: "Nobody Here", parent: "Broker introductions" }),
    ], { goals });
    expect(rows.map((r) => r.change_id)).toEqual(["c-top", "c-shape", "c-rev", "c-who"]);
    const [top, shape, rev, who] = rows;
    expect(top).toMatchObject({ tag: "new", node: { kind: "goal", name: "Broker introductions", proposed: true }, parent: null, owner: { kind: "person", name: "Ashot Petrosian" }, unresolved: false });
    expect(shape).toMatchObject({ tag: "moves here", node: { kind: "goal", id: "g-live", short_id: "in-2" }, parent: { kind: "goal", id: "c-top" } });
    expect(rev).toMatchObject({ parent: { id: "c-top" }, owner: { kind: "person", name: "Samvit Jain" }, detail: "Fees → $1 · Deals" });
    expect(who).toMatchObject({ owner: { kind: "unknown", name: "Nobody Here" }, unresolved: true });
  });

  test("several changes to one existing goal read as one line", () => {
    const goals = [{ _id: "g4", short_id: "in-4", title: "Proud relationships", status: "active", project_ids: [], health: "none", workspace: "team:x", user_id: "u", created_at: 0, updated_at: 0 }] as any;
    const rows = proposalTreeRows(ORG_FIXTURE, [
      change("s", 1, { kind: "initiative_shape", initiative: "in-4", metrics: [{ name: "Trust breaks", target: "0" }] }),
      change("p", 2, { kind: "initiative_projects", initiative: "in-4", projects: ["Agent Quality"] }),
    ], { goals });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tag: "measured, projects added", detail: "Trust breaks → 0 · Agent Quality" });
  });

  test("a status change draws the record itself, with its new status and reason", () => {
    const [row] = proposalTreeRows(ORG_FIXTURE, [change("c-task", 1, { kind: "task_status", task: "ct-9", status: "done", reason: "shipped on main", title: "Remove the pilot" })]);
    expect(row.node).toEqual({ kind: "record", id: "ct-9", name: "Remove the pilot", record: "task" });
    expect(row.tag).toBe("→ done");
    expect(row.closes).toBe("done");
    expect(row.detail).toBe("shipped on main");
  });

  test("a change to a project's fields draws the project: its live id with the workspace's projects, the ref without", () => {
    const projects = [{ id: "p-platform", title: "Platform", short_id: "pr-11" }];
    const changes = [
      change("c-meta", 1, { kind: "project_meta", project: "pr-11", priority: "p1", owner: "@growth" }),
      change("c-status", 2, { kind: "project_status", project: "Platform", status: "paused", reason: "nobody on it" }),
    ];
    const [meta, status] = proposalChangeRows(ORG_FIXTURE, changes, { projects });
    expect(meta.node).toEqual({ kind: "record", record: "project", id: "p-platform", name: "Platform" });
    expect(meta).toMatchObject({ tag: "charter", parent: null, from: null, closes: null, unresolved: false, owner: { kind: "role", handle: "growth" } });
    // A status change on the same project names the same record, so the two share a subject.
    expect(status.node).toEqual({ kind: "record", record: "project", id: "p-platform", name: "Platform" });
    expect(status).toMatchObject({ tag: "→ paused", detail: "nobody on it" });

    const [bare, bareStatus] = proposalChangeRows(ORG_FIXTURE, changes);
    expect(bare.node).toEqual({ kind: "record", record: "project", id: "pr-11", name: "pr-11" });
    expect(bareStatus.node).toEqual({ kind: "record", record: "project", id: "Platform", name: "Platform" });
    // No lead named: nobody rides as the owner, and nothing is unresolved.
    const [plain] = proposalChangeRows(ORG_FIXTURE, [change("c", 1, { kind: "project_meta", project: "Platform", priority: "p0" })]);
    expect(plain).toMatchObject({ owner: null, unresolved: false, node: { kind: "record", record: "project" } });
    const [orphan] = proposalChangeRows(ORG_FIXTURE, [change("c", 1, { kind: "project_meta", project: "Platform", owner: "@nobody" })]);
    expect(orphan).toMatchObject({ unresolved: true, owner: { kind: "unknown", name: "nobody" } });
  });

  test("only a closing status strikes the record; reopening it does not", () => {
    const [row] = proposalTreeRows(ORG_FIXTURE, [change("c-task", 1, { kind: "task_status", task: "ct-9", status: "open", reason: "still in progress", title: "Remove the pilot" })]);
    expect(row.tag).toBe("→ open");
    expect(row.closes).toBeNull();
  });

  test("a role that takes over a session names it; no scope reads as no area of its own", () => {
    const [row] = proposalTreeRows(ORG_FIXTURE, [change("c-seat", 1, { kind: "role", name: "Funnel lead", handle: "funnel", seat: { existing: "jx7b88a", title: "Market growth mandate" } })]);
    expect(row.detail).toBe("no area of its own · from Market growth mandate");
  });

  test("against the tree: faces, parents, the move's origin, the unknown handle; a limit draws no row", () => {
    const rows = proposalTreeRows(ORG_FIXTURE, CHANGES);
    expect(rows.map((r) => r.change_id)).toEqual(["c-role", "c-move", "c-retire", "c-orphan"]);

    const role = rows[0];
    expect(role.tag).toBe("new role");
    expect(role.node).toMatchObject({ kind: "role", name: "Head of Platform", handle: "platform" });
    expect((role.node as any).stub).toMatchObject({ kind: "role", solid: false, status: "proposed" });
    expect(role.parent).toMatchObject({ kind: "person", name: "Ashot Petrosian", me: true });
    expect(role.detail).toBe("Platform · new session");

    const move = rows[1];
    expect(move.tag).toBe("move");
    expect(move.node).toMatchObject({ kind: "role", name: "Head of Growth", handle: "growth" });
    // Under the role the same proposal creates, from under the founder.
    expect(move.parent).toMatchObject({ kind: "role", handle: "platform" });
    expect(move.from).toMatchObject({ kind: "person", name: "Ashot Petrosian" });

    expect(rows[2]).toMatchObject({ tag: "retire", parent: null, node: { kind: "role", handle: "growth" } });
    expect(rows[3]).toMatchObject({ unresolved: true, node: { kind: "unknown", name: "@nobody" } });
    expect(rows.every((r) => r.line.length > 0)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/800|tokens|wakes/);
  });

  test("a limit is a quiet line: the role by name, what changes, never how much (S23.2)", () => {
    const quiet = proposalQuietLines(ORG_FIXTURE, CHANGES);
    expect(quiet).toEqual([{ change_id: "c-budget", status: "proposed", line: "Head of Growth keeps a safety net on its daily work." }]);
    expect(proposalQuietLines(null, CHANGES)[0].line).toBe("@growth keeps a safety net on its daily work.");
    expect(JSON.stringify(quiet)).not.toMatch(/800|tokens|wakes|caps/);
  });

  test("an accepted move is already re-parented and still names where it came from", () => {
    const rows = proposalTreeRows(ORG_FIXTURE, [CHANGES[0], { ...CHANGES[1], status: "applied" }]);
    const move = rows[1];
    expect(move.status).toBe("applied");
    expect(move.parent).toMatchObject({ kind: "role", handle: "platform" });
    expect(move.from).toMatchObject({ kind: "person", name: "Ashot Petrosian" });
  });

  test("without a tree the rows keep their lines and statuses and lose their faces", () => {
    const rows = proposalTreeRows(null, CHANGES);
    expect(rows).toHaveLength(4);
    expect(rows[0].node).toMatchObject({ kind: "role", name: "Head of Platform", handle: "platform" });
    expect(rows[0].parent).toBeNull();
    expect(rows[1].node).toMatchObject({ kind: "unknown", name: "@growth" });
    expect(rows[1].unresolved).toBe(false);
    expect(rows.every((r) => r.chip === null)).toBe(true);
  });

  test("a skipped change keeps its row so the card can say what happened", () => {
    const rows = proposalTreeRows(ORG_FIXTURE, [{ ...CHANGES[0], status: "skipped" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].node).toMatchObject({ kind: "role", name: "Head of Platform" });
  });
});

describe("treeOrder", () => {
  const item = (id: string, parent: string | null = null) => ({ id, parent });
  const order = (items: { id: string; parent: string | null }[]) => treeOrder(items, (t) => t.id, (t) => t.parent).map((t) => t.id);

  test("an item follows its parent, depth first; the rest keep their order", () => {
    expect(order([item("c", "b"), item("x"), item("b", "a"), item("a"), item("d", "a")])).toEqual(["x", "a", "b", "c", "d"]);
  });

  test("a parent the list does not hold makes a root; a loop and a self parent still come out once", () => {
    expect(order([item("a", "gone"), item("b", "a")])).toEqual(["a", "b"]);
    expect(order([item("a", "b"), item("b", "a"), item("c", "c")])).toEqual(["c", "a", "b"]);
  });
});

describe("partyFace", () => {
  test("a person or a role by the ref a record stores, and a ref the tree does not hold", () => {
    expect(partyFace(ORG_FIXTURE, { kind: "user", user_id: "fixture-user-me" })).toMatchObject({ kind: "person", name: "Ashot Petrosian", me: true });
    expect(partyFace(ORG_FIXTURE, { kind: "role", role_id: "fixture-role-growth" })).toMatchObject({ kind: "role", handle: "growth", name: "Head of Growth" });
    expect(partyFace(ORG_FIXTURE, { kind: "role", role_id: "gone" })).toEqual({ kind: "unknown", id: "gone", name: "a role" });
    expect(partyFace(ORG_FIXTURE, null)).toBeNull();
  });
});

describe("proposalOutcome", () => {
  test("null while anything waits, else the counts in words", () => {
    expect(proposalOutcome(CHANGES)).toBeNull();
    expect(proposalOutcome([{ ...CHANGES[0], status: "applied" }, { ...CHANGES[1], status: "skipped" }, CHANGES[5]])).toBe("1 applied, 1 skipped");
    expect(proposalOutcome([{ ...CHANGES[0], status: "applied" }, { ...CHANGES[1], status: "failed" }])).toBeNull();
    expect(proposalOutcome([])).toBeNull();
  });
});
