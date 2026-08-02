import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { webApply, webCreate, webDismiss } from "./steeringProposals";

const USER = "u_owner";
function ctx(tables: Record<string, any[]>, userId = USER) {
  return {
    auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) },
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
  } as any;
}
function tables() {
  return {
    users: [{ _id: USER }, { _id: "u_victim" }], teams: [], team_memberships: [], client_state: [], counters: [],
    change_log: [], conversations: [], strategies: [], steering_items: [], steering_proposals: [], entity_links: [],
  } as Record<string, any[]>;
}

describe("Steering proposals", () => {
  test("drafts without mutating and atomically applies a typed graph", async () => {
    const t = tables();
    const proposal = await (webCreate as any)._handler(ctx(t), {
      workspace: "personal",
      title: "Capital formation wedge",
      operations: [
        { op: "create_item", key: "objective", kind: "objective", title: "Earn qualified inbound" },
        { op: "create_item", key: "bet", kind: "bet", parent_ref: "objective", title: "Capital is the wedge", hypothesis: "Founders value market-aware orchestration" },
        { op: "create_item", key: "initiative", kind: "initiative", parent_ref: "objective", title: "Validate capital orchestration" },
        { op: "link", key: "advances", from_type: "steering_item", from_ref: "initiative", link_type: "advances", to_type: "steering_item", to_ref: "objective" },
      ],
    });
    expect(t.steering_items).toHaveLength(0);
    const result = await (webApply as any)._handler(ctx(t), { id: proposal.id });
    expect(result.entities.filter((row: any) => row.type === "steering_item")).toHaveLength(3);
    expect(t.steering_items.map((row) => row.kind)).toEqual(["objective", "bet", "initiative"]);
    expect(t.steering_items[1].parent_item_id).toBe(t.steering_items[0]._id);
    expect(t.entity_links).toHaveLength(1);
    expect(t.steering_proposals[0].status).toBe("applied");
    await expect((webApply as any)._handler(ctx(t), { id: proposal.id })).rejects.toThrow("already applied");
  });

  test("rejects invalid kind fields before persisting", async () => {
    const t = tables();
    await expect((webCreate as any)._handler(ctx(t), {
      workspace: "personal", title: "Bad", operations: [
        { op: "create_item", key: "objective", kind: "objective", title: "Wrong", hypothesis: "not objective data" },
      ],
    })).rejects.toThrow("hypothesis is not valid");
    expect(t.steering_proposals).toHaveLength(0);
  });

  test("dismissed proposals cannot apply", async () => {
    const t = tables();
    const proposal = await (webCreate as any)._handler(ctx(t), { workspace: "personal", title: "No", operations: [{ op: "create_item", key: "q", kind: "question", title: "Unknown?" }] });
    await (webDismiss as any)._handler(ctx(t), { id: proposal.id });
    await expect((webApply as any)._handler(ctx(t), { id: proposal.id })).rejects.toThrow("already dismissed");
  });

  test("cannot inject a child under another user's personal item", async () => {
    const t = tables();
    const victimId = "kd7777victimprivateitem000000000";
    t.steering_items.push({ _id: victimId, user_id: "u_victim", short_id: "si-90", kind: "objective", title: "Private", status: "active", priority: "medium", created_at: 1, updated_at: 1 });
    const proposal = await (webCreate as any)._handler(ctx(t), { workspace: "personal", title: "Injection", operations: [{ op: "create_item", key: "child", kind: "initiative", title: "Foreign child", parent_ref: victimId }] });
    await expect((webApply as any)._handler(ctx(t), { id: proposal.id })).rejects.toThrow();
    expect(t.steering_items).toHaveLength(1);
    expect(t.steering_proposals[0].status).toBe("proposed");
  });
});
