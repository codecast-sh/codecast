// A decision's queue rows (decision_inbox), one per person it is asked of.
// A leaf, so every module that moves a decision between people imports it
// without closing a cycle through sessionDecisions.ts.
import type { Doc, Id } from "../_generated/dataModel";
import { announceDecisionWaiting } from "./decisionPush";
import { settleDecisionWaiting } from "./decisionRing";

type Ctx = { db: any; scheduler?: any };

// Keep decision_inbox in lockstep with asked_user_ids: insert missing pending
// rows, delete rows for people who are no longer in the set. Deleting is
// required — a done inbox row for a still-pending decision still lists in
// listForUserCore, so marking it done would leave the card on their stack.
// `queue: false` (a role hears the decision, routeFor) inserts nothing: a
// row already in front of a person stays there, and no new one is made.
// Each person a new row is made for hears it on their phone
// (lib/decisionPush.ts); `announce: false` is for a caller that sends its own
// notice (a pass, an escalation, a share-out by area).
export async function syncDecisionInbox(
  ctx: Ctx,
  decisionId: Id<"session_decisions">,
  people: Id<"users">[],
  now: number,
  queue = true,
  opts: { announce?: boolean } = {},
): Promise<void> {
  const wanted = new Set(people.map(String));
  const existing = await ctx.db
    .query("decision_inbox")
    .withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId))
    .collect();
  const have = new Set<string>();
  const removed: string[] = [];
  for (const row of existing) {
    const key = String(row.user_id);
    if (wanted.has(key)) {
      have.add(key);
      if (row.status !== "pending") await ctx.db.patch(row._id, { status: "pending" });
    } else {
      await ctx.db.delete(row._id);
      removed.push(key);
    }
  }
  // Handed to someone else: the people it left stop being told it waits on them.
  if (removed.length) {
    const decision = await ctx.db.get(decisionId);
    if (decision) await settleDecisionWaiting(ctx, decision.conversation_id, removed);
  }
  const added: Id<"users">[] = [];
  for (const userId of queue ? people : []) {
    if (have.has(String(userId))) continue;
    await ctx.db.insert("decision_inbox", { decision_id: decisionId, user_id: userId, status: "pending", created_at: now });
    added.push(userId);
  }
  if (opts.announce !== false) await announceDecisionWaiting(ctx, decisionId, added, now);
}

/**
 * The decisions a person's pending queue rows point at: each pending
 * decision_inbox row's decision while it still asks them (asked_user_ids is
 * the people set), then their own cards from before the inbox existed. The
 * rows come back in any status; a caller that wants only open asks keeps
 * status "pending". The Decisions queue (listForUserCore) and the page
 * reader `waiting` both read through here, so they agree on what waits.
 */
export async function pendingQueueDecisions(ctx: Ctx, userId: Id<"users">): Promise<Doc<"session_decisions">[]> {
  const out: Doc<"session_decisions">[] = [];
  const inboxRows = await ctx.db.query("decision_inbox").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending")).collect();
  for (const r of inboxRows) {
    const d: Doc<"session_decisions"> | null = await ctx.db.get(r.decision_id);
    if (!d) continue;
    // A stale inbox row from before assignment must not keep the card on the previous person's stack.
    if (d.asked_user_ids !== undefined && !d.asked_user_ids.some((id) => String(id) === String(userId))) continue;
    out.push(d);
  }
  const legacy = await ctx.db.query("session_decisions").withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending")).collect();
  const seen = new Set(out.map((d) => String(d._id)));
  for (const d of legacy as Doc<"session_decisions">[]) if (d.asked_user_ids === undefined && !seen.has(String(d._id))) out.push(d);
  return out;
}
