// Helpers the dispatch rail's side effects share: id checks for local stub ids,
// wire shapes, refusal handling and linking a conversation to a work item.

import type { Id } from "./_generated/dataModel";
import { claimTaskOwnership } from "./lib/taskOwner";
import { linkFromStart, startPlanId } from "./lib/priorityLinks";
import { addConversationToWorkItem } from "./conversationLinks";
import { canAccessPlan, canAccessTask, workspaceForConversation, workspaceForResource, workspacesMatch } from "./lib/access";

export type HandlerCtx = { db: any; storage?: any; runMutation?: any; runQuery?: any };

// The Touch ID grant string an Ask first Approve carries beside its answer
// (the store's answerDecision input), handed to the decision patch's gate. It
// rides the action's arguments, never a row field, so it is stored nowhere.
export function answerPresence(action: string, args: any): string | undefined {
  const presence = action === "answerDecision" ? args?.[1]?.presence : undefined;
  return typeof presence === "string" ? presence : undefined;
}

// A Convex document id is 32 base32 characters. The store's optimistic rows are
// keyed by shorter local stub ids until their server row supersedes them, and a
// stub reaching a mutation's `v.id()` validator is an argument error the outbox
// would then re-drive forever. Handlers that can receive one check first.
const SERVER_ID_RE = /^[a-z0-9]{32}$/;
export function charterWire(fields: Record<string, any>): Record<string, any> {
  const { owner_role_id, ...rest } = fields;
  return owner_role_id === undefined ? rest : { ...rest, owner: owner_role_id };
}

export function isServerId(value: unknown): value is string {
  return typeof value === "string" && SERVER_ID_RE.test(value);
}

/** The id when it names a row of `table`; null for a stub key or another table's id. */
export function opsRowId(ctx: HandlerCtx, table: string, id: unknown): string | null {
  return typeof id === "string" && ctx.db.normalizeId(table, id) ? id : null;
}

export function deepMergeField(existing: any, incoming: any): any {
  if (
    incoming && typeof incoming === "object" && !Array.isArray(incoming) &&
    existing && typeof existing === "object" && !Array.isArray(existing)
  ) {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (v !== null && v !== undefined) result[k] = v;
    }
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null || v === undefined) delete result[k];
      else result[k] = v;
    }
    return result;
  }
  return incoming;
}

export async function linkConversationToObject(
  ctx: HandlerCtx,
  userId: Id<"users">,
  objectType: string,
  objectId: string,
  conversationId: Id<"conversations">,
): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv || conv.user_id.toString() !== userId.toString()) {
    throw new Error("Unauthorized");
  }

  if (objectType === "doc") {
    const doc = await ctx.db.get(objectId as Id<"docs">);
    if (!doc || doc.user_id.toString() !== userId.toString()) return;
    const existing = doc.related_conversation_ids || (doc.conversation_id ? [doc.conversation_id] : []);
    if (!existing.some((id: any) => id.toString() === conversationId.toString())) {
      await ctx.db.patch(objectId as Id<"docs">, {
        related_conversation_ids: [...existing, conversationId],
      });
    }
    return;
  }

  if (objectType === "task") {
    const task = await ctx.db.get(objectId as Id<"tasks">);
    // Access is the task's workspace, never its team: a task private to its
    // owner inside a team is not a teammate's to link and take.
    if (!task || !(await canAccessTask(ctx as any, userId, task))) return;
    // The list append and the association rail (best-effort; legacy fields
    // stay authoritative) are one helper — see conversationLinks.ts.
    await addConversationToWorkItem(ctx, userId, "task", task, conversationId);
    // A person linked this session to the task: it becomes the one owner.
    await claimTaskOwnership(ctx, conv, task, { take: true });
    return;
  }

  if (objectType === "plan") {
    const plan = await ctx.db.get(objectId as Id<"plans">);
    if (!plan || plan.user_id.toString() !== userId.toString()) return;
    await addConversationToWorkItem(ctx, userId, "plan", plan, conversationId);
    return;
  }
}

/**
 * A session created from a milestone's Start (createSession `priority`,
 * `priority_step`, `plan`): mapped to the milestone, then bound to its plan
 * only when that mapping took. Run once, when the session is created, after
 * any task link so the milestone the person chose wins. True when a plan was
 * bound, for the caller's ownership reconcile.
 */
export async function linkStartedSession(
  ctx: HandlerCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  opts: { priority?: string; priority_step?: string; plan?: string },
): Promise<boolean> {
  if (!opts.priority || !(await linkFromStart(ctx, userId, conversationId, opts.priority, opts.priority_step))) return false;
  return !!opts.plan && bindStartPlan(ctx, userId, conversationId, { priority: opts.priority, priority_step: opts.priority_step, plan: opts.plan });
}

/**
 * A session started from a milestone's Start, once it is linked to that
 * milestone (linkFromStart), bound to the milestone's plan as `cast plan
 * bind` binds one (plans.bindSession). The plan comes by short id from a
 * link anyone could write, so it binds only the plan the attribution rules
 * give that milestone (lib/priorityLinks startPlanId), when the starter can
 * open it and it is in the session's own workspace; anything else leaves the
 * session unbound.
 */
export async function bindStartPlan(
  ctx: HandlerCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  start: { priority: string; priority_step?: string; plan: string },
): Promise<boolean> {
  const plan = await ctx.db.query("plans").withIndex("by_short_id", (q: any) => q.eq("short_id", start.plan.trim().toLowerCase())).first();
  const conv = await ctx.db.get(conversationId);
  if (!plan || !conv || !(await canAccessPlan(ctx as any, userId, plan))) return false;
  if ((await startPlanId(ctx, start.priority, start.priority_step)) !== String(plan._id)) return false;
  if (!workspacesMatch(workspaceForConversation(conv), workspaceForResource(plan))) return false;
  await addConversationToWorkItem(ctx, userId, "plan", plan, conversationId, { current_session_id: conversationId, updated_at: Date.now() });
  const planIds: any[] = conv.plan_ids ?? [];
  await ctx.db.patch(conversationId, {
    plan_ids: planIds.some((id) => String(id) === String(plan._id)) ? planIds : [...planIds, plan._id],
    active_plan_id: plan._id,
  });
  return true;
}

/** A side effect whose function answers a refusal as { error }: throw it, so the rail reads it as refused. */
export function refuseOnError<T>(res: T): T {
  const error = (res as { error?: unknown } | null)?.error;
  if (typeof error === "string") throw new Error(error);
  return res;
}

/**
 * A Vault write from the web, run only while its row exists. A stub that never
 * reached the server has nothing to change there. A row deleted since the
 * write was queued (another window, the CLI, a decline) already holds what a
 * delete wanted and leaves an edit nothing to land on, and the list snapshot
 * drops it from the client too: the write settles quietly, where a refusal
 * would toast about an action that did no harm.
 */
export async function liveSecretWrite(ctx: HandlerCtx, id: string, write: () => Promise<unknown>) {
  const rowId = opsRowId(ctx, "secrets", id);
  if (!rowId || !(await ctx.db.get(rowId))) return;
  return refuseOnError(await write());
}
