// What a decision card's phone push says, and whether it still should. A leaf
// (no pushRouter import), so the push flush can re-check a staged card push
// without closing a cycle through lib/decisionPush.ts.
import type { Id } from "../_generated/dataModel";

type Ctx = { db: any };

export const DECISION_PUSH_TYPE = "decision_waiting";

type Card = { _id: any; question: string; short_id?: string; status: string; blocking: boolean; silent?: boolean; trial?: boolean };

/** A card that rings a phone: open, parking its session, a person's to answer (not a pointer card, not a trial's). */
export function ringsPhone(d: Card): boolean {
  return d.status === "pending" && d.blocking && !d.silent && !d.trial;
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

/** Whether a session is parked on a card that rings on its own, so its "waiting for you" push would say the same thing twice. */
export async function hasRingingCard(ctx: Ctx, conversationId: Id<"conversations">): Promise<boolean> {
  const open = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", "pending"))
    .collect();
  return open.some(ringsPhone);
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
