import { describe, expect, test } from "bun:test";
import { inboxEpoch, isDirectEscalation, isUnderRole, projectInbox, roleEscalationsOf, type ProjectableInboxRow } from "./inboxProjection";

// An escalation reaches the person through the role (org-roles-run-work.md
// R1, revised): the role's standing session is the card in needs input, its
// sessions stay nested under it, and the role's card carries the lines of the
// escalations under it, derived from the children. `direct` is the exception.

const EPOCH = inboxEpoch(1_800_000_000_000);
const MIN = 60_000;

function row(id: string, over: Record<string, unknown> = {}): ProjectableInboxRow & Record<string, unknown> {
  return { _id: id, status: "active", updated_at: EPOCH - 2 * MIN, message_count: 12, is_idle: true, ...over } as any;
}
const standing = (id: string, role: string, over: Record<string, unknown> = {}) => row(id, { anchor_id: `anchor_${role}`, standing_role_id: role, agent_status: "dormant", thread_state_status: "dormant", ...over });
const hand = (id: string, role: string, over: Record<string, unknown> = {}) => row(id, { org_role_id: role, ...over });
const stamp = (at: number, line: string, direct?: boolean) => ({ role_id: "growth", line, at, ...(direct ? { direct } : {}) });

const bucketOf = (p: ReturnType<typeof projectInbox>, id: string) => p.placements.get(id)?.bucket;

describe("an escalation reaches the person through the role", () => {
  test("by default the role's card files in needs input and the child stays nested; direct puts the child", () => {
    const rows = [
      standing("role", "growth"),
      hand("plain", "growth"),
      hand("handed", "growth", { agent_status: "done", thread_state_status: "done", escalated_by_role: stamp(EPOCH - 5 * MIN, "the pricing copy needs your eye") }),
      hand("direct", "growth", { agent_status: "done", thread_state_status: "done", escalated_by_role: stamp(EPOCH - 4 * MIN, "a permission prompt is open", true) }),
    ];
    const p = projectInbox(rows, EPOCH);
    // The role's own facts say dormant; the escalation under it says needs input.
    expect(bucketOf(p, "role")).toBe("needs_input");
    expect(p.placements.get("role")?.work_state).toBe("needs_input");
    // Every session under the role files with it, the escalated one included.
    expect(bucketOf(p, "handed")).toBe("needs_input");
    expect(bucketOf(p, "plain")).toBe("needs_input");
    expect(isUnderRole(rows[2] as any)).toBe(true);
    // The direct one is a card of its own.
    expect(isUnderRole(rows[3] as any)).toBe(false);
    expect(bucketOf(p, "direct")).toBe("needs_input");
    // The role's card carries the one line that reaches the person through it.
    const byId = new Map(rows.map((r) => [r._id, r]));
    const lines = roleEscalationsOf(byId.keys(), (id) => byId.get(id) as any);
    expect(lines.get("role")).toEqual([{ conversation_id: "handed", line: "the pricing copy needs your eye", at: EPOCH - 5 * MIN }]);
  });

  test("a role with two escalations has one card with two lines, newest first", () => {
    const rows = [
      standing("role", "growth"),
      hand("older", "growth", { escalated_by_role: stamp(EPOCH - 9 * MIN, "older ask") }),
      hand("newer", "growth", { escalated_by_role: stamp(EPOCH - 3 * MIN, "newer ask") }),
    ];
    const p = projectInbox(rows, EPOCH);
    expect(p.tally.shown.needs_input).toBe(3);
    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(roleEscalationsOf(byId.keys(), (id) => byId.get(id) as any).get("role")!.map((e) => e.conversation_id)).toEqual(["newer", "older"]);
  });

  test("hand back clears the lift; a stamp from before the flag is the role's ordinary escalation", () => {
    const rows = [standing("role", "growth"), hand("child", "growth", { escalated_by_role: stamp(EPOCH - MIN, "needs you") })];
    expect(bucketOf(projectInbox(rows, EPOCH), "role")).toBe("needs_input");
    delete (rows[1] as any).escalated_by_role;
    expect(bucketOf(projectInbox(rows, EPOCH), "role")).toBe("dormant");
    expect(isDirectEscalation({ role_id: "growth", line: "x", at: 1 })).toBe(false);
    expect(isDirectEscalation({ role_id: "growth", line: "x", at: 1, direct: true })).toBe(true);
    expect(isDirectEscalation(null)).toBe(false);
  });

  test("the person's own placement of the role wins: a stashed or retired role is not lifted, and a child with no standing session stands alone", () => {
    const rows = [
      standing("stashed", "growth", { inbox_stashed_at: EPOCH - 10 * MIN }),
      hand("under_stashed", "growth", { escalated_by_role: stamp(EPOCH - MIN, "needs you") }),
      standing("retired", "ops", { inbox_dismissed_at: EPOCH - 10 * MIN }),
      hand("under_retired", "ops", { escalated_by_role: { role_id: "ops", line: "needs you", at: EPOCH - MIN } }),
      hand("orphan", "gone", { escalated_by_role: { role_id: "gone", line: "needs you", at: EPOCH - MIN } }),
    ];
    const p = projectInbox(rows, EPOCH);
    expect(bucketOf(p, "stashed")).toBe("stashed");
    expect(bucketOf(p, "under_stashed")).toBe("stashed");
    expect(bucketOf(p, "retired")).toBe("dismissed");
    expect(bucketOf(p, "under_retired")).toBe("needs_input");
    expect(bucketOf(p, "orphan")).toBe("needs_input");
  });
});
