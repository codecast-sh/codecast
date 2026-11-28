// A card other work waits on reaches a person fast (pl-1146 piece 2). What
// waits on an open card: the open tasks blocked by its task (one level: a
// task's direct dependents, such as the runs an incident cause stopped, or
// through a fix's incident cause, the runs that cause stopped), and
// the open tasks with a decision wait on the card itself. Once two wait, the
// card is escalated to the people it is already asked of, with "N changes
// wait on this" as its note, so it sorts first for them, and they get one
// push naming the count; reaching the next threshold pushes once more. Who
// may answer never changes: an approval card is still a person's.
import type { Doc, Id } from "../_generated/dataModel";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { holdsFlowStop } from "@codecast/shared/contracts/signalFingerprint";
import { dependentRefs, taskByRef } from "./taskGraph";
import { emitNotification } from "../notificationRouter";

type Ctx = { db: any; scheduler?: any };
type Card = Doc<"session_decisions">;

/** Each count that pushes the card's people once. */
export const WAITERS_PUSH_AT = [2, 5] as const;
const tier = (n: number) => WAITERS_PUSH_AT.filter((t) => n >= t).length;

/** The open tasks `task` blocks directly. */
async function openDependents(ctx: Ctx, task: Doc<"tasks">): Promise<Doc<"tasks">[]> {
  const self = new Set([task.short_id, String(task._id)]);
  const out: Doc<"tasks">[] = [];
  for (const ref of new Set(await dependentRefs(ctx, task))) {
    const dep = await taskByRef(ctx, ref);
    if (dep && !isTerminalTaskStatus(dep.status) && dep.blocked_by?.some((r) => self.has(r))) out.push(dep);
  }
  return out;
}

/** An open run-stop incident's cause: the changes it stops wait on it. */
const isOpenIncident = (t: Doc<"tasks">) => !isTerminalTaskStatus(t.status) && holdsFlowStop(t.cause?.fingerprints);

/**
 * How many open tasks wait on the card: on its task, or on the card itself. When @release filed the fix as its own
 * task that an incident's cause waits on, the changes the cause stops wait on the fix too: they are counted in the
 * cause's place, since a cause is no change (one level, no deeper).
 */
export async function cardWaiters(ctx: Ctx, card: Card): Promise<number> {
  const ids = new Set<string>();
  const task: Doc<"tasks"> | null = card.task_id ? await ctx.db.get(card.task_id) : null;
  if (task) {
    for (const dep of await openDependents(ctx, task)) {
      if (!isOpenIncident(dep)) {
        ids.add(String(dep._id));
        continue;
      }
      for (const stopped of await openDependents(ctx, dep)) ids.add(String(stopped._id));
    }
  }
  for (const id of card.waiting_task_ids ?? []) {
    const t: Doc<"tasks"> | null = await ctx.db.get(id);
    if (t && !isTerminalTaskStatus(t.status) && (t.waits ?? []).some((w) => w.kind === "decision" && w.decision === card.short_id && w.state === "waiting")) ids.add(String(t._id));
  }
  if (task) ids.delete(String(task._id));
  return ids.size;
}

/** Escalates an open card once enough waits on it; a repeat with no new waiter changes nothing. */
export async function escalateIfWaitedOn(ctx: Ctx, cardId: Id<"session_decisions">, now = Date.now()): Promise<void> {
  const card: Card | null = await ctx.db.get(cardId);
  if (!card || card.status !== "pending" || card.trial) return;
  // A person's escalation keeps their note and the people they sent it to.
  if (card.escalated && card.escalated.waiting === undefined) return;
  const n = await cardWaiters(ctx, card);
  const before = card.escalated?.waiting ?? 0;
  if (tier(n) === 0 || n <= before) return;
  const to: Id<"users">[] = card.asked_user_ids?.length ? card.asked_user_ids : [card.user_id];
  const note = `${n} changes wait on this`;
  await ctx.db.patch(card._id, { escalated: { at: card.escalated?.at ?? now, note, to, waiting: n }, updated_at: now });
  if (tier(n) <= tier(before)) return;
  const question = card.question.length > 120 ? `${card.question.slice(0, 117)}...` : card.question;
  await emitNotification(ctx as any, {
    event_type: "decision_escalated",
    actor_name: "Codecast",
    entity_type: "conversation",
    entity_id: String(card.conversation_id),
    conversation_id: card.conversation_id,
    message: `${note}: "${question}"`,
    ...(card.short_id ? { link: `/decisions/${card.short_id}` } : {}),
    recipient_ids: to,
  });
}

/** A task gained a dependent: each open card on it may now have enough waiting, and when it is an open incident's cause,
 *  each open card on a fix it waits on (cardWaiters counts the cause's dependents there). */
export async function escalateCardsOnTask(ctx: Ctx, taskId: Id<"tasks">, now = Date.now()): Promise<void> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  const fixes = task && isOpenIncident(task) ? (await Promise.all((task.blocked_by ?? []).map((r) => taskByRef(ctx, r)))).filter((t): t is Doc<"tasks"> => !!t) : [];
  for (const id of new Set([String(taskId), ...fixes.map((f) => String(f._id))])) {
    const cards: Card[] = await ctx.db.query("session_decisions").withIndex("by_task", (q: any) => q.eq("task_id", id).eq("status", "pending")).collect();
    for (const c of cards) await escalateIfWaitedOn(ctx, c._id, now);
  }
}
