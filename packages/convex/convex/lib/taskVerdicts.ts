// A person's answers to decision cards: the task's approval cards (the gate cards a
// run posted that offered Ship, answered or dismissed by a person), and the
// cards a session asked. Land reads the task's to know who authorizes a merge
// (orgLineMerge.personAuthorized); the intent segment reads both beside the
// person's typed lines (/cli/sessions/originator, /cli/intent/verify), where a
// Revise on a card undoes an earlier "ship it" and a later "ship it" outranks it.
import type { Id } from "../_generated/dataModel";
import { optionIsShip } from "@codecast/shared/contracts/shipAnswer";
import { isPriorityCard } from "./priorityCardAccess";

// "Approve merge" is the approval card's button and means what "Ship" did (shared/contracts/shipAnswer).
export { optionIsShip };
export const isShipAnswer = (card: any): boolean => card.status === "answered" && optionIsShip(card.options?.[card.answer_index ?? -1]?.label);
export const offersShip = (card: any): boolean => (card.options ?? []).some((o: any) => optionIsShip(o?.label));
export const cardRef = (card: any): string => card.short_id ?? String(card._id);
/** When the verdict was given. */
export const verdictAt = (card: any): number => card.resolved_at ?? card.created_at ?? 0;
export const newestFirst = (a: any, b: any) => verdictAt(b) - verdictAt(a);
// A person's verdict: an answer a user gave, or a dismissal a user made (a dismissal names its person in answered_by,
// or, on older rows, only in resolved_by). A withdrawal names nobody: the asker took its own question back.
export const byPerson = (card: any): boolean =>
  card.answered_by ? card.answered_by.kind === "user" : card.status === "dismissed" && !!card.resolved_by;
/** The person who gave a verdict. */
export const verdictPerson = (card: any): string | null =>
  card.answered_by?.kind === "user" ? String(card.answered_by.id) : card.resolved_by ? String(card.resolved_by) : null;
/** What the verdict was, in the card's own words: the option chosen, or "Dismissed". */
export const verdictLabel = (card: any): string =>
  card.status === "dismissed" ? "Dismissed" : String(card.options?.[card.answer_index ?? -1]?.label ?? card.answer_text ?? "something other than Ship").trim();

/** A task's approval cards that are not a trial's, newest first, in the statuses given. */
export async function taskShipCards(ctx: any, taskId: Id<"tasks">, statuses: string[]): Promise<any[]> {
  const rows = await Promise.all(statuses.map((status) =>
    ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", taskId).eq("status", status)).order("desc").take(100)));
  return rows.flat().filter((d: any) => !d.trial && offersShip(d)).sort(newestFirst);
}

export type PersonVerdict = { ref: string; at: number; ship: boolean; label: string; note?: string; user_id: string; question: string };

/** A person's verdicts on the task's approval cards of its runs, newest first. */
export async function personVerdicts(ctx: any, taskId: Id<"tasks">): Promise<PersonVerdict[]> {
  const cards = await taskShipCards(ctx, taskId, ["answered", "dismissed"]);
  return cards.filter((d) => d.workflow_run_id && byPerson(d)).map((d) => ({
    ref: cardRef(d),
    at: verdictAt(d),
    ship: isShipAnswer(d),
    label: verdictLabel(d),
    ...(d.answer_text && d.answer_text.trim() !== verdictLabel(d) ? { note: String(d.answer_text) } : {}),
    user_id: verdictPerson(d)!,
    question: String(d.question ?? ""),
  }));
}

/** How many answered cards of each session the asker reads, newest first. */
export const CARDS_PER_SESSION = 50;

/**
 * A person's answers to the decision cards a session asked, newest first: the option chosen (or the words they
 * typed), when, and on what question. An agent's or a policy's answer is no person's word and is left out.
 */
export async function personAnswersIn(ctx: any, conversationId: Id<"conversations">): Promise<Array<PersonVerdict & { session: string }>> {
  const rows = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", "answered"))
    .order("desc")
    .take(CARDS_PER_SESSION);
  // A priority card answered in the session is not the session's verdict on its work (lib/priorityCardAccess).
  return rows.filter((d: any) => d.answered_by?.kind === "user" && !isPriorityCard(d)).map((d: any) => ({
    ref: cardRef(d),
    at: verdictAt(d),
    ship: isShipAnswer(d),
    label: verdictLabel(d),
    ...(d.answer_text && d.answer_text.trim() !== verdictLabel(d) ? { note: String(d.answer_text) } : {}),
    user_id: String(d.answered_by.id),
    question: String(d.question ?? ""),
    session: String(conversationId),
  }));
}
