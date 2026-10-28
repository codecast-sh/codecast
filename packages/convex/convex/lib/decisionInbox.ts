// A decision's queue rows (decision_inbox), one per person it is asked of.
// A leaf, so every module that moves a decision between people imports it
// without closing a cycle through sessionDecisions.ts.
import type { Id } from "../_generated/dataModel";

type Ctx = { db: any };

// Keep decision_inbox in lockstep with asked_user_ids: insert missing pending
// rows, delete rows for people who are no longer in the set. Deleting is
// required — a done inbox row for a still-pending decision still lists in
// listForUserCore, so marking it done would leave the card on their stack.
// `queue: false` (a role hears the decision, routeFor) inserts nothing: a
// row already in front of a person stays there, and no new one is made.
export async function syncDecisionInbox(
  ctx: Ctx,
  decisionId: Id<"session_decisions">,
  people: Id<"users">[],
  now: number,
  queue = true,
): Promise<void> {
  const wanted = new Set(people.map(String));
  const existing = await ctx.db
    .query("decision_inbox")
    .withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId))
    .collect();
  const have = new Set<string>();
  for (const row of existing) {
    const key = String(row.user_id);
    if (wanted.has(key)) {
      have.add(key);
      if (row.status !== "pending") await ctx.db.patch(row._id, { status: "pending" });
    } else {
      await ctx.db.delete(row._id);
    }
  }
  for (const userId of queue ? people : []) {
    if (have.has(String(userId))) continue;
    await ctx.db.insert("decision_inbox", { decision_id: decisionId, user_id: userId, status: "pending", created_at: now });
  }
}
