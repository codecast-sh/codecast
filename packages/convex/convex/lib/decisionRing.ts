// What a decision card's phone push says, and whether it still should. A leaf
// (no pushRouter import), so the push flush can re-check a staged card push
// without closing a cycle through lib/decisionPush.ts.
import type { Id } from "../_generated/dataModel";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";

type Ctx = { db: any };

export const DECISION_PUSH_TYPE = "decision_waiting";

type Card = { _id: any; question: string; short_id?: string; status: string; blocking: boolean; silent?: boolean; trial?: boolean };

/** A card that rings a phone: open, parking its session, a person's to answer (not a pointer card, not a trial's). */
export function ringsPhone(d: Card): boolean {
  return d.status === "pending" && d.blocking && !d.silent && !d.trial;
}

/**
 * A run's change card held by a person: the line already tells them with its
 * own "card waiting" notice (workflow_runs → lineNotices.noticeCardWaiting,
 * the same predicate), so it does not ring a second time as a decision.
 */
export function lineNoticesCard(d: { workflow_run_id?: unknown; task_id?: unknown; card?: unknown; gate_node_id?: string; holder?: { kind: string } }): boolean {
  return !!d.workflow_run_id && !!d.task_id && d.holder?.kind === "user" && (!!d.card || d.gate_node_id === CARD_GATE_NODE_ID);
}

/** The ringing cards this session asked that still wait in this person's queue. */
async function cardsWaitingOn(ctx: Ctx, conversationId: Id<"conversations">, userId: Id<"users">): Promise<number> {
  const open = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", "pending"))
    .collect();
  let n = 0;
  for (const d of open) {
    if (!ringsPhone(d) || lineNoticesCard(d)) continue;
    const queued = await ctx.db
      .query("decision_inbox")
      .withIndex("by_decision", (q: any) => q.eq("decision_id", d._id))
      .collect();
    if (queued.some((r: any) => String(r.user_id) === String(userId) && r.status === "pending")) n++;
  }
  return n;
}

/** Whether this person's "waiting for you" would repeat a card that already rang them. */
export async function cardRangFor(ctx: Ctx, conversationId: Id<"conversations">, user: { _id: Id<"users">; notification_preferences?: { mention?: boolean } }): Promise<boolean> {
  if (user.notification_preferences?.mention === false) return false;
  return (await cardsWaitingOn(ctx, conversationId, user._id)) > 0;
}

/**
 * The bell stops claiming a card waits once none of this session's cards waits
 * on the person: answered, withdrawn, or handed to someone else.
 */
export async function settleDecisionWaiting(ctx: Ctx, conversationId: Id<"conversations">, userIds: Iterable<Id<"users"> | string>): Promise<void> {
  for (const userId of new Set([...userIds].map(String))) {
    const notes = (await ctx.db
      .query("notifications")
      .withIndex("by_recipient_conversation", (q: any) => q.eq("recipient_user_id", userId).eq("conversation_id", conversationId))
      .collect()).filter((n: any) => n.type === DECISION_PUSH_TYPE && !n.read);
    if (notes.length === 0) continue;
    if ((await cardsWaitingOn(ctx, conversationId, userId as Id<"users">)) > 0) continue;
    for (const n of notes) await ctx.db.patch(n._id, { read: true });
  }
}

export function sessionLabel(conv: { title?: string; project_path?: string } | null | undefined): string {
  return conv?.title?.trim() || conv?.project_path?.split("/").pop() || "Session";
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One card: the session asks the question. Several from one turn: one push listing them. */
export function decisionPushContent(
  conv: { title?: string; project_path?: string } | null | undefined,
  cards: Array<Pick<Card, "question" | "short_id">>,
): { title: string; body: string; link: string } {
  const label = sessionLabel(conv);
  if (cards.length === 1) {
    const [d] = cards;
    return { title: label, body: clip(d.question, 200), link: d.short_id ? `/decisions/${d.short_id}` : "/decisions" };
  }
  return {
    title: `${label}: ${cards.length} decisions`,
    body: cards.map((d, i) => `${i + 1}. ${clip(d.question, 100)}`).join("\n"),
    link: "/decisions",
  };
}

/**
 * A staged card push as it should go out now: only the cards still waiting on
 * this person (answered, withdrawn or handed elsewhere drop out). Null when
 * none is left; the same row when nothing changed.
 */
export async function liveDecisionPush<R extends { user_id: any; title: string; body: string; data?: any }>(
  ctx: Ctx,
  row: R,
): Promise<R | null> {
  const ids: string[] = row.data?.decision_ids ?? [];
  const live: Card[] = [];
  for (const id of ids) {
    const d = await ctx.db.get(id);
    if (!d || !ringsPhone(d)) continue;
    const queued = await ctx.db
      .query("decision_inbox")
      .withIndex("by_decision", (q: any) => q.eq("decision_id", d._id))
      .collect();
    if (queued.some((r: any) => String(r.user_id) === String(row.user_id) && r.status === "pending")) live.push(d);
  }
  if (live.length === 0) return null;
  if (live.length === ids.length) return row;
  const conv = await ctx.db.get((live[0] as any).conversation_id);
  const content = decisionPushContent(conv, live);
  return {
    ...row,
    title: content.title,
    body: content.body,
    data: { ...row.data, decision_ids: live.map((d) => String(d._id)), link: content.link },
  };
}
