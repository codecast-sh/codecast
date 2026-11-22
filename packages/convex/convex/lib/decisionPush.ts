// Decision cards on the phone. A card entering a person's queue is what their
// phone should ring for, so every new queue row rings (syncDecisionInbox), and
// the cards one session asks in one turn ring as ONE push: while the asking
// session is mid-turn the push holds (up to DECISION_TURN_HOLD_MS), each
// further card it asks joins that same staged push, and the turn's end
// releases it (managedSessions.scheduleNeedsInputCheck → releaseDecisionPushes).
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";
import { AWAY_DEBOUNCE_MS, HOLD_WHILE_ACTIVE_MS, enqueuePush } from "../pushRouter";
import { DECISION_PUSH_TYPE, decisionPushContent, lineNoticesCard, ringsPhone, sessionLabel } from "./decisionRing";

// The decision helpers type the scheduler optional; every mutation ctx has one.
type Ctx = { db: any; scheduler?: any };

// Backstop for a turn that never reports its end (a dead daemon, a status
// write that never lands): the group goes out anyway.
export const DECISION_TURN_HOLD_MS = 5 * 60_000;

async function inTurn(ctx: Ctx, conversationId: Id<"conversations">): Promise<boolean> {
  const managed = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .first();
  return ACTIVE_AGENT_STATUSES.has(managed?.agent_status ?? "");
}

/** The staged card push for this person and session, if one has not gone out yet. */
async function stagedGroup(ctx: Ctx, userId: Id<"users">, conversationId: Id<"conversations">): Promise<any | null> {
  const rows = await ctx.db
    .query("push_outbox")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .collect();
  return rows.find((r: any) => r.type === DECISION_PUSH_TYPE && r.data?.conversationId === String(conversationId)) ?? null;
}

/** Rings each person a card just entered the queue of. */
export async function announceDecisionWaiting(
  ctx: Ctx,
  decisionId: Id<"session_decisions">,
  userIds: Id<"users">[],
  now: number,
): Promise<void> {
  if (userIds.length === 0) return;
  const decision = await ctx.db.get(decisionId);
  if (!decision || !ringsPhone(decision) || lineNoticesCard(decision)) return;
  const conv = await ctx.db.get(decision.conversation_id);
  const conversationId = String(decision.conversation_id);
  const holding = await inTurn(ctx, decision.conversation_id);
  for (const userId of userIds) {
    const user = await ctx.db.get(userId);
    if (!user || user.is_bot) continue;
    // Rides the mention switch, as every other decision notice does (notificationRouter PREFERENCE_MAP).
    if (user.notification_preferences?.mention === false) continue;

    const staged = await stagedGroup(ctx, userId, decision.conversation_id);
    if (staged) {
      const ids: string[] = [...new Set([...(staged.data?.decision_ids ?? []), String(decisionId)])];
      const cards = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(Boolean);
      const content = decisionPushContent(conv, cards);
      await ctx.db.patch(staged._id, {
        title: content.title,
        body: content.body,
        data: { ...staged.data, decision_ids: ids, link: content.link },
      });
      if (staged.notification_id) {
        const n = await ctx.db.get(staged.notification_id);
        if (n) await ctx.db.patch(n._id, { message: content.body, link: content.link, read: false });
      }
      continue;
    }

    const content = decisionPushContent(conv, [decision]);
    const notifId = await ctx.db.insert("notifications", {
      recipient_user_id: userId,
      type: DECISION_PUSH_TYPE,
      actor_name: sessionLabel(conv),
      entity_type: "conversation",
      entity_id: conversationId,
      conversation_id: decision.conversation_id,
      link: content.link,
      message: content.body,
      read: false,
      created_at: now,
    });
    await enqueuePush(ctx, {
      user,
      notification_id: notifId,
      type: DECISION_PUSH_TYPE,
      title: content.title,
      body: content.body,
      data: {
        type: DECISION_PUSH_TYPE,
        conversationId,
        entity_type: "conversation",
        entity_id: conversationId,
        link: content.link,
        decision_ids: [String(decisionId)],
      },
      ...(holding ? { hold_until: now + DECISION_TURN_HOLD_MS } : {}),
    });
  }
}

/** The asking session's turn ended: its staged card pushes go out on the ordinary routing delay. */
export async function releaseDecisionPushes(ctx: { db: any; scheduler: any }, conversationId: Id<"conversations">, now: number): Promise<void> {
  const open = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", "pending"))
    .collect();
  if (!open.some(ringsPhone)) return;
  const people = new Set<string>(open.flatMap((d: any) => (d.asked_user_ids ?? [d.user_id]).map(String)));
  for (const userId of people) {
    const staged = await stagedGroup(ctx, userId as Id<"users">, conversationId);
    if (!staged) continue;
    // A push staged while the desktop was active keeps its one desk hold.
    const due = Math.max(now + AWAY_DEBOUNCE_MS, staged.created_at + (staged.deferred ? HOLD_WHILE_ACTIVE_MS : 0));
    if (staged.due_at <= due) continue;
    await ctx.db.patch(staged._id, { due_at: due });
    await ctx.scheduler.runAfter(due - now, internal.pushRouter.flush, { user_id: staged.user_id });
  }
}
