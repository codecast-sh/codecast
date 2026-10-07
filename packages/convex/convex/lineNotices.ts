// The line's three notices (docs/architecture/the-line-end-to-end.md LE16,
// "people hear about it"): a card waiting on you, a change shipped, and a
// watched cause that reopened. Each reaches the person who answers for it
// through the one notification router, under the "task activity" switch a
// person already has, the same way an assignment or a comment does.
//
// The line runs under its owner's token, so the run's owner is no actor here:
// the notices name the line as the sender, and the owner hears about their own
// line like anyone else.

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resolveAssigneeToUserId, roleAssigneeOf } from "./tasks";

const LINE_SENDER = "The line";

/** The person a task's assignee names: a user, or the host of the role it names. */
async function assigneePerson(ctx: any, task: any): Promise<Id<"users"> | null> {
  if (!task.assignee) return null;
  const role = await roleAssigneeOf(ctx, task.assignee);
  if (role) return role.host_user_id ?? null;
  return resolveAssigneeToUserId(ctx, task.assignee, task.team_id);
}

/** Who answered the card on the cause's run, when a person did. */
async function cardAnswerer(ctx: any, task: any): Promise<Id<"users"> | null> {
  const run = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  const decision = run?.gate_decision_id ? await ctx.db.get(run.gate_decision_id) : null;
  if (decision?.answered_by?.kind !== "user") return null;
  return ctx.db.normalizeId("users", decision.answered_by.id);
}

/** The people a cause's news is for: its owner, the person it is assigned to, and whoever answered its card. */
export async function causePeople(ctx: any, task: any): Promise<Id<"users">[]> {
  const ids = [task.user_id, await assigneePerson(ctx, task), await cardAnswerer(ctx, task)].filter(Boolean) as Id<"users">[];
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}

const label = (task: any) => `${task.short_id}: ${task.title ?? ""}`.trim();

async function emit(ctx: any, type: "card_waiting" | "change_shipped" | "cause_reopened", task: any, recipients: Id<"users">[], message: string, link?: string) {
  if (recipients.length === 0) return;
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: type,
    actor_name: LINE_SENDER,
    entity_type: "task",
    entity_id: String(task._id),
    message,
    ...(link ? { link } : {}),
    recipient_ids: recipients,
  });
}

/**
 * A card's decision waits on a person (LE11): the person holding it. The
 * notice leads with the card's headline, which says what the change does; a
 * cause's own title can be a long statement of what was observed.
 */
export async function noticeCardWaiting(ctx: any, task: any, holderUserId: Id<"users">, decisionShortId?: string, headline?: string) {
  const what = headline?.trim() ? `${headline.trim()} (${task.short_id})` : label(task);
  await emit(ctx, "card_waiting", task, [holderUserId], `has a change card waiting on your answer: ${what}`,
    decisionShortId ? cardLink(decisionShortId) : undefined);
}

const cardLink = (decisionShortId: string) => `/decisions/${decisionShortId}`;

/**
 * A card stops waiting the moment its decision settles, whoever settled it and
 * wherever (answered on the web or the CLI, withdrawn with its run): its
 * unread notice is marked read, so nobody is told a card waits that does not.
 */
export async function settleCardWaiting(ctx: any, decision: { short_id?: string; workflow_run_id?: unknown; asked_user_ids?: Id<"users">[]; holder?: { kind: string; id: string }; user_id?: Id<"users">; _creationTime: number }) {
  if (!decision.workflow_run_id || !decision.short_id) return;
  const link = cardLink(decision.short_id);
  const holder = decision.holder?.kind === "user" ? ctx.db.normalizeId("users", decision.holder.id) : null;
  const people = new Set([holder, decision.user_id, ...(decision.asked_user_ids ?? [])].filter(Boolean).map(String));
  for (const person of people) {
    const notes = await ctx.db
      .query("notifications")
      // The notice is written in the same transaction as the decision, stamped
      // in whole ms while _creationTime carries a fraction: floor it.
      .withIndex("by_recipient_created", (q: any) => q.eq("recipient_user_id", person).gte("created_at", Math.floor(decision._creationTime)))
      .collect();
    for (const note of notes) {
      if (note.type === "card_waiting" && note.link === link && !note.read) await ctx.db.patch(note._id, { read: true });
    }
  }
}

/** The line landed the change for a cause (LE12). */
export async function noticeChangeShipped(ctx: any, task: any, watchUntil?: number) {
  const watch = watchUntil ? `, watching until ${new Date(watchUntil).toISOString().slice(0, 10)}` : "";
  await emit(ctx, "change_shipped", task, await causePeople(ctx, task), `shipped the change for ${label(task)}${watch}`);
}

/** A signal came back while the cause was in watch (LE12). */
export async function noticeCauseReopened(ctx: any, task: any, source: string) {
  await emit(ctx, "cause_reopened", task, await causePeople(ctx, task), `reopened ${label(task)} after ${source} saw it again during the watch`);
}
