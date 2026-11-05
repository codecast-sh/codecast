// Helpers the dispatch rail's side effects share: id checks for local stub ids,
// wire shapes, refusal handling and linking a conversation to a work item.

import type { Id } from "./_generated/dataModel";
import { claimTaskOwnership } from "./lib/taskOwner";
import { addConversationToWorkItem } from "./conversationLinks";

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
    if (!task) return;
    if (task.user_id.toString() !== userId.toString()) {
      if (!task.team_id) return;
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", task.team_id))
        .first();
      if (!membership) return;
    }
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
