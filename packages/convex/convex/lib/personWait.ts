// A dormant pin that waits on a person (`cast state --status dormant --on
// @handle --ask "<question>"`). The wait is a decide card addressed to that
// person (askCore with `to`), and the card's answer is the wake: the answer
// reaches the session the way every decide answer does, and the wait clears
// (settlePersonWaitCard, from every resolution's settle).
//
// A card unanswered a day after it was raised sends a second card to the
// session's own person, with three ways on: nudge the person (the card is
// raised again, and the day starts over), answer it yourself (the question
// joins your queue), or drop the wait (the session wakes without an answer).
// That card is a pending blocking decide asked of them, so the existing asking
// overlay files the row under Needs you until it is answered; no placement
// rule reads the wait. The day is one scheduled check (escalatePersonWait),
// which does nothing once the card was answered, raised again, or the wait
// moved on.

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { askCore, peopleFor, withdrawCore, type AnsweredBy } from "../sessionDecisions";
import { enqueuePendingMessage } from "../pendingMessages";
import { syncDecisionInbox } from "./decisionInbox";
import { announceDecisionWaiting } from "./decisionPush";
import { inlineForeignText } from "@codecast/shared/contracts";
import type { Verdict } from "./decisionVerdict";

type Ctx = { db: any; scheduler: any };
type Conv = Doc<"conversations">;
type DecisionRow = Doc<"session_decisions">;

export const PERSON_WAIT_ESCALATE_MS = 24 * 60 * 60 * 1000;

export type PersonAsk = { question: string; options: Array<{ label: string; description?: string }> };

/** Ask `person` the session's question: one card, its options when given,
 *  else a line to answer in. The same question again lands on the open card
 *  (askCore's re-ask) and raises it again. Throws the refusal the CLI prints. */
export async function askPerson(ctx: Ctx, conv: Conv, person: string, ask: PersonAsk): Promise<Id<"session_decisions">> {
  const asked = await askCore(ctx, { userId: conv.user_id }, {
    session_id: conv.session_id,
    question: ask.question,
    options: ask.options,
    ...(ask.options.length ? {} : { kind: "form" as const, form: { fields: [{ key: "answer", label: "Your answer", type: "text" as const }] } }),
    to: [person],
    blocking: true,
  });
  if (asked?.error) throw new Error(String(asked.error).replace(/^--to /, "--on "));
  return asked.id as Id<"session_decisions">;
}

/** Start the day the card has to be answered in, from when it was raised. */
export async function armEscalation(ctx: Ctx, conversationId: Id<"conversations">, decisionId: Id<"session_decisions">): Promise<void> {
  const card: DecisionRow | null = await ctx.db.get(decisionId);
  if (!card) return;
  await ctx.scheduler.runAfter(PERSON_WAIT_ESCALATE_MS, internal.waitingOn.escalatePersonWait, {
    conversation_id: conversationId,
    decision_id: decisionId,
    raised_at: card.created_at,
  });
}

const quoted = (q: string) => `"${inlineForeignText(q).replace(/"/g, "'").slice(0, 120)}"`;

/** The escalation card's options, by index. */
export const ESCALATION_CHOICES = ["nudge", "answer", "drop"] as const;
function escalationOptions(person: string) {
  return [
    { label: `Nudge ${person}`, description: "Sends them the question again; another day without an answer comes back to you" },
    { label: "Answer it yourself", description: "The question opens in your queue, and your answer wakes the session" },
    { label: "Drop the wait", description: "The session wakes and goes on without an answer" },
  ];
}

/** The day is up: when the card is still the wait's and still unanswered,
 *  ask the session's own person what to do. */
export async function escalatePersonWaitCore(
  ctx: Ctx,
  args: { conversation_id: Id<"conversations">; decision_id: Id<"session_decisions">; raised_at: number },
): Promise<{ escalated: boolean }> {
  const conv: Conv | null = await ctx.db.get(args.conversation_id);
  const w = conv?.waiting_on;
  if (!conv || conv.inbox_killed_at || w?.kind !== "person" || String(w.decision_id) !== String(args.decision_id) || w.escalation_id) return { escalated: false };
  const card: DecisionRow | null = await ctx.db.get(args.decision_id);
  if (!card || card.status !== "pending" || card.created_at !== args.raised_at) return { escalated: false };
  const owners = await peopleFor(ctx, conv);
  const asked = new Set((card.asked_user_ids ?? []).map(String));
  // A wait on the session's own person is already in their queue.
  if (!owners.length || owners.every((o) => asked.has(String(o)))) return { escalated: false };
  const res = await askCore(ctx, { userId: conv.user_id }, {
    session_id: conv.session_id,
    question: `${w.ref} hasn't answered ${quoted(card.question)} for a day`,
    options: escalationOptions(w.ref),
    context_md: `This session went to sleep until ${w.ref} answers that question, and nothing else will wake it.`,
    to: owners.map(String),
    blocking: true,
    // Its answer acts here (settlePersonWaitCard); nothing is delivered into the session.
    silent: true,
  });
  if (res?.error) {
    console.warn(`[personWait] ${conv._id}: no escalation card: ${res.error}`);
    return { escalated: false };
  }
  await ctx.db.patch(conv._id, { waiting_on: { ...w, escalation_id: res.id } });
  return { escalated: true };
}

/** Take back a pending escalation card (its wait moved on). */
export async function withdrawEscalation(ctx: Ctx, escalationId: Id<"session_decisions"> | undefined, now: number): Promise<void> {
  const row: DecisionRow | null = escalationId ? await ctx.db.get(escalationId) : null;
  if (row?.status === "pending") await withdrawCore(ctx, row, now, undefined, "the wait it was about moved on");
}

/** A person wait that ended: its open card to them, and the one that went
 *  to the session's person about it, are taken back. */
export async function withdrawPersonCards(ctx: Ctx, w: { decision_id?: Id<"session_decisions">; escalation_id?: Id<"session_decisions"> }, now: number): Promise<void> {
  await withdrawEscalation(ctx, w.escalation_id, now);
  const card: DecisionRow | null = w.decision_id ? await ctx.db.get(w.decision_id) : null;
  if (card?.status === "pending") await withdrawCore(ctx, card, now, undefined, "the wait it was asked for moved on");
}

async function nameOf(ctx: Ctx, userId: Id<"users"> | undefined): Promise<string> {
  const u = userId ? await ctx.db.get(userId) : null;
  return u?.name || u?.email || "Your person";
}

/** A person wait's card, or its escalation, was resolved (every path:
 *  settleResolution). The person's card: the wait is over, its answer reaches
 *  the session as usual, and a dismissal is told. The escalation: nudge,
 *  hand the question to the session's person, or drop the wait. */
export async function settlePersonWaitCard(ctx: Ctx, row: DecisionRow, verdict: Verdict, by: AnsweredBy, now: number): Promise<void> {
  const conv: Conv | null = await ctx.db.get(row.conversation_id);
  const w = conv?.waiting_on;
  if (!conv || w?.kind !== "person") return;
  const id = String(row._id);

  if (String(w.decision_id) === id) {
    await ctx.db.patch(conv._id, { waiting_on: undefined });
    await withdrawEscalation(ctx, w.escalation_id, now);
    if (verdict.status === "dismissed") {
      await enqueuePendingMessage(ctx, conv, conv.user_id, {
        content: `${w.ref} dismissed ${quoted(row.question)} without answering, which you waited on (cast state --on ${w.ref}). Go on without the answer or ask someone else, and pin your state again.`,
        origin: "scheduler",
        client_id: `waiting-on:person:${id}:dismissed`,
      });
    }
    return;
  }

  if (String(w.escalation_id) !== id) return;
  const kept = { ...w, escalation_id: undefined };
  const choice = verdict.status === "answered" && verdict.answer_index !== undefined ? ESCALATION_CHOICES[verdict.answer_index] : undefined;
  const card: DecisionRow | null = w.decision_id ? await ctx.db.get(w.decision_id) : null;
  if (!choice || !card || card.status !== "pending") {
    await ctx.db.patch(conv._id, { waiting_on: kept });
    return;
  }
  if (choice === "nudge") {
    await ctx.db.patch(card._id, { created_at: now });
    await announceDecisionWaiting(ctx, card._id, card.asked_user_ids ?? [], now);
    await ctx.db.patch(conv._id, { waiting_on: kept });
    await armEscalation(ctx, conv._id, card._id);
    return;
  }
  if (choice === "answer") {
    const people = [...new Set([...(card.asked_user_ids ?? []), ...(await peopleFor(ctx, conv))].map(String))] as Id<"users">[];
    await ctx.db.patch(card._id, { asked_user_ids: people });
    await syncDecisionInbox(ctx, card._id, people, now);
    await ctx.db.patch(conv._id, { waiting_on: kept });
    return;
  }
  // Drop: the wait goes first, so withdrawing the card finds nothing to settle here.
  await ctx.db.patch(conv._id, { waiting_on: undefined });
  await withdrawCore(ctx, card, now, undefined, "the wait on it was dropped");
  await enqueuePendingMessage(ctx, conv, conv.user_id, {
    content: `${await nameOf(ctx, by.user_id)} dropped your wait on ${w.ref} for ${quoted(card.question)}: go on without the answer, and pin your state again.`,
    origin: "scheduler",
    client_id: `waiting-on:person:${String(card._id)}:dropped`,
  });
}
