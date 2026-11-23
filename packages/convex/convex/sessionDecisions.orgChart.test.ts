// Decisions follow the org chart (ct-99776): a sub-lead's card reaches the
// person its line ends at, never whoever started its seat, and the repair that
// moves cards areas gave away keeps a handed-up card in a person's queue.
import { describe, expect, test } from "bun:test";
import { listForUserCore, recommendCore, rerouteChartedDecisionsCore } from "./sessionDecisions";
import { BOSS, OWNER2, NOW, seed, askApproach, seated } from "./testDecisions";

const KIM = "users_kim" as any; // a teammate off every line here, as an area owner would be

async function unownedSeat(ctx: any) {
  await ctx.db.patch("conversations_standing", { owner_user_id: undefined, author_user_id: OWNER2 });
  for (const row of await ctx.db.query("session_owners").withIndex("by_conversation", (q: any) => q.eq("conversation_id", "conversations_standing")).collect()) {
    await ctx.db.delete(row._id);
  }
}

describe("a sub-lead's card", () => {
  test("a seat nobody owns asks the person its line ends at, never whoever started it", async () => {
    const { ctx, tables } = seed();
    await unownedSeat(ctx);
    const r = await askApproach(ctx, "sess-standing");
    expect(r.error).toBeUndefined();
    const row = tables.session_decisions[0];
    expect(row.asked_user_ids).toEqual([BOSS]);
    expect(row.hops.map((h: any) => h.role_id)).toEqual(["org_roles_head"]);
    expect((await listForUserCore(ctx, OWNER2, NOW)).map((d) => d._id)).toEqual([]);
  });

  test("a seat whose line ends at no person never asks its starter", async () => {
    const { ctx, tables } = seed();
    await unownedSeat(ctx);
    // The head reports back to the lead: the line loops and reaches no person.
    await ctx.db.patch("org_roles_head", { reports_to: { kind: "role", role_id: "org_roles_lead" } });
    const r = await askApproach(ctx, "sess-standing");
    expect(r.error).toBeUndefined();
    const asked = tables.session_decisions[0].asked_user_ids;
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain(OWNER2);
  });
});

describe("the repair for cards areas gave away", () => {
  test("a card its lead already handed up lands in the queue of the people it moves to", async () => {
    const { ctx, tables } = await seated();
    const r = await askApproach(ctx);
    expect(r.error).toBeUndefined();
    const row = tables.session_decisions[0];
    expect(tables.decision_inbox).toEqual([]);
    await recommendCore(ctx, { userId: row.user_id }, { decision_id: String(row.short_id), session_id: "sess-standing", recommendation: 1 });
    const chain = [...row.asked_user_ids].map(String).sort();
    expect(tables.decision_inbox.map((i: any) => String(i.user_id)).sort()).toEqual(chain);
    // Before the org chart came first, an area gave it to someone off the line.
    expect(chain).not.toContain(KIM);
    await ctx.db.patch(row._id, { asked_user_ids: [KIM], holder: { kind: "user", id: KIM }, holder_key: `user:${KIM}` });
    for (const i of [...tables.decision_inbox]) await ctx.db.delete(i._id);
    await ctx.db.insert("decision_inbox", { decision_id: row._id, user_id: KIM, status: "pending", created_at: NOW });

    const done = await rerouteChartedDecisionsCore(ctx, false, NOW);
    expect(done.moved).toEqual([String(row.short_id)]);
    expect([...tables.session_decisions[0].asked_user_ids].map(String).sort()).toEqual(chain);
    expect(tables.decision_inbox.map((i: any) => String(i.user_id)).sort()).toEqual(chain);
    expect((await listForUserCore(ctx, BOSS, NOW)).map((d) => d._id)).toEqual([row._id]);
    expect((await listForUserCore(ctx, KIM, NOW)).map((d) => d._id)).toEqual([]);
  });
});
