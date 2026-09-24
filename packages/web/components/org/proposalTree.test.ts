// The rows a proposal card draws (org-staffing.md S24), projected from the
// same merge the chart draws its ghosts from: a new role under the viewer, a
// move onto that new role with where it came from, a retire, a chip kind on
// its role, a handle nothing answers to, and the same changes without a tree.
// Run: bun test components/org/proposalTree.test.ts
import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { proposalOutcome, proposalQuietLines, proposalTreeRows } from "./proposalTree";
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
  test("against the tree: faces, parents, the move's origin, the unknown handle; a limit draws no row", () => {
    const rows = proposalTreeRows(ORG_FIXTURE, CHANGES);
    expect(rows.map((r) => r.change_id)).toEqual(["c-role", "c-move", "c-retire", "c-orphan"]);

    const role = rows[0];
    expect(role.tag).toBe("new role");
    expect(role.node).toMatchObject({ kind: "role", name: "Head of Platform", handle: "platform" });
    expect((role.node as any).stub).toMatchObject({ kind: "role", solid: false, status: "proposed" });
    expect(role.parent).toMatchObject({ kind: "person", name: "Ashot Petrosian", me: true });

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

describe("proposalOutcome", () => {
  test("null while anything waits, else the counts in words", () => {
    expect(proposalOutcome(CHANGES)).toBeNull();
    expect(proposalOutcome([{ ...CHANGES[0], status: "applied" }, { ...CHANGES[1], status: "skipped" }, CHANGES[5]])).toBe("1 applied, 1 skipped");
    expect(proposalOutcome([{ ...CHANGES[0], status: "applied" }, { ...CHANGES[1], status: "failed" }])).toBeNull();
    expect(proposalOutcome([])).toBeNull();
  });
});
