import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { webApply, webCreate, webDismiss, webGetRef } from "./steeringProposals";

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
    users: [{ _id: USER }, { _id: "u_victim" }, { _id: "u_teammate" }], teams: [{ _id: "t_team" }, { _id: "t_other" }], team_memberships: [{ _id: "m1", user_id: USER, team_id: "t_team", role: "member" }, { _id: "m2", user_id: "u_teammate", team_id: "t_team", role: "member" }, { _id: "m3", user_id: USER, team_id: "t_other", role: "member" }], client_state: [], counters: [],
    change_log: [], conversations: [], plans: [], tasks: [], strategies: [], steering_items: [], steering_proposals: [], entity_links: [],
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

  test("a private conversation routed through a team creates a private proposal", async () => {
    const t = tables();
    t.conversations.push({ _id: "conv_private", session_id: "jxprivate", user_id: USER, team_id: "t_team", team_visibility: "private", is_private: true, created_at: 1, updated_at: 1 });
    const proposal = await (webCreate as any)._handler(ctx(t), { conversation_id: "conv_private", title: "Private reasoning", operations: [{ op: "create_item", key: "q", kind: "question", title: "Private question" }] });
    expect(t.steering_proposals[0].team_id).toBeUndefined();
    expect(await (webGetRef as any)._handler(ctx(t, "u_teammate"), { short_id: proposal.short_id })).toBeNull();
    await expect((webApply as any)._handler(ctx(t, "u_teammate"), { id: proposal.id })).rejects.toThrow("Proposal not found");
    expect(t.steering_items).toHaveLength(0);
  });

  test("links existing execution by its human-facing short id", async () => {
    const t = tables();
    t.plans.push({ _id: "plan_raw_id", user_id: USER, short_id: "pl-246", title: "Validate the wedge", status: "active" });
    const proposal = await (webCreate as any)._handler(ctx(t), {
      workspace: "personal",
      title: "Connect strategy to execution",
      operations: [
        { op: "create_item", key: "initiative", kind: "initiative", title: "Validate the wedge" },
        { op: "link", key: "execution", from_type: "plan", from_ref: "pl-246", link_type: "executes", to_type: "steering_item", to_ref: "initiative" },
      ],
    });
    await (webApply as any)._handler(ctx(t), { id: proposal.id });
    expect(t.entity_links[0]).toMatchObject({ from_type: "plan", from_id: "plan_raw_id", link_type: "executes", to_type: "steering_item" });
  });

  test("a personal proposal cannot import a team execution edge", async () => {
    const t = tables();
    t.plans.push({ _id: "team_plan", user_id: USER, team_id: "t_team", short_id: "pl-team", title: "Team plan", status: "active" });
    t.steering_items.push({ _id: "team_item", user_id: USER, team_id: "t_team", short_id: "si-team", kind: "initiative", title: "Team initiative", status: "active" });
    const proposal = await (webCreate as any)._handler(ctx(t), { workspace: "personal", title: "Wrong scope", operations: [
      { op: "link", key: "execution", from_type: "plan", from_ref: "pl-team", link_type: "executes", to_type: "steering_item", to_ref: "si-team" },
    ] });
    await expect((webApply as any)._handler(ctx(t), { id: proposal.id })).rejects.toThrow("another workspace");
    expect(t.entity_links).toHaveLength(0);
  });

  test("a team proposal cannot import another team's execution edge", async () => {
    const t = tables();
    t.plans.push({ _id: "other_plan", user_id: USER, team_id: "t_other", short_id: "pl-other", title: "Other plan", status: "active" });
    t.steering_items.push({ _id: "other_item", user_id: USER, team_id: "t_other", short_id: "si-other", kind: "initiative", title: "Other initiative", status: "active" });
    const proposal = await (webCreate as any)._handler(ctx(t), { workspace: "team", team_id: "t_team", title: "Wrong team", operations: [
      { op: "link", key: "execution", from_type: "plan", from_ref: "pl-other", link_type: "executes", to_type: "steering_item", to_ref: "si-other" },
    ] });
    await expect((webApply as any)._handler(ctx(t), { id: proposal.id })).rejects.toThrow("another workspace");
    expect(t.entity_links).toHaveLength(0);
  });

  test("atomically updates existing Strategy and Steering Items by short id", async () => {
    const t = tables();
    t.strategies.push({ _id: "strategy_raw", user_id: USER, short_id: "st-12", title: "Draft strategy", status: "draft", created_at: 1, updated_at: 1 });
    t.steering_items.push({ _id: "item_raw", user_id: USER, short_id: "si-12", kind: "bet", title: "Old belief", hypothesis: "Old", status: "draft", priority: "medium", created_at: 1, updated_at: 1 });
    const proposal = await (webCreate as any)._handler(ctx(t), { workspace: "personal", title: "Sharpen the view", operations: [
      { op: "update_strategy", key: "strategy", strategy_ref: "st-12", fields: { title: "Current strategy", status: "active" } },
      { op: "update_item", key: "belief", item_ref: "si-12", fields: { title: "Sharper belief", hypothesis: "New", status: "active" } },
    ] });
    expect(t.strategies[0].title).toBe("Draft strategy");
    expect(t.steering_items[0].hypothesis).toBe("Old");
    await (webApply as any)._handler(ctx(t), { id: proposal.id });
    expect(t.strategies[0]).toMatchObject({ title: "Current strategy", status: "active" });
    expect(t.steering_items[0]).toMatchObject({ title: "Sharper belief", hypothesis: "New", status: "active" });
  });

  test("kind-changing updates remap lifecycle and clear foreign fields", async () => {
    const t = tables();
    t.steering_items.push({ _id: "item_raw", user_id: USER, short_id: "si-13", kind: "bet", title: "Belief", hypothesis: "Maybe", status: "active", priority: "medium", created_at: 1, updated_at: 1 });
    const proposal = await (webCreate as any)._handler(ctx(t), { workspace: "personal", title: "This is really a question", operations: [
      { op: "update_item", key: "reframe", item_ref: "si-13", fields: { kind: "question", why_it_matters: "It changes the path" } },
    ] });
    await (webApply as any)._handler(ctx(t), { id: proposal.id });
    expect(t.steering_items[0]).toMatchObject({ kind: "question", status: "open", why_it_matters: "It changes the path" });
    expect(t.steering_items[0].hypothesis).toBeUndefined();
  });

  test("rejects proposals that clear required lifecycle fields", async () => {
    const t = tables();
    await expect((webCreate as any)._handler(ctx(t), { workspace: "personal", title: "Invalid clear", operations: [
      { op: "update_item", key: "clear", item_ref: "si-13", fields: { status: null } },
    ] })).rejects.toThrow("status cannot be cleared");
    await expect((webCreate as any)._handler(ctx(t), { workspace: "personal", title: "Invalid strategy clear", operations: [
      { op: "update_strategy", key: "clear", strategy_ref: "st-13", fields: { status: null } },
    ] })).rejects.toThrow("status cannot be cleared");
    expect(t.steering_proposals).toHaveLength(0);
  });
});
