// Vault's audit trail writer and the Ask first settle hook
// (docs/architecture/vault.md). A leaf: sessionDecisions settles an approval
// decision through it, and secrets.ts records every event with it, so neither
// imports the other's module graph.

import type { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };

export const APPROVE_FOR_SESSION = "Approve for this session";
export const DENY = "Deny";

export async function recordSecretEvent(
  ctx: Ctx,
  row: { _id: Id<"secrets">; workspace: string; name: string; short_id: string },
  kind: Doc<"secret_events">["kind"],
  fields: { actor?: Id<"users">; conversation_id?: Id<"conversations">; purpose?: string; decision_id?: Id<"session_decisions"> } = {},
) {
  await ctx.db.insert("secret_events", {
    secret_id: row._id,
    workspace: row.workspace,
    secret_name: row.name,
    secret_short_id: row.short_id,
    kind,
    actor_user_id: fields.actor,
    conversation_id: fields.conversation_id,
    purpose: fields.purpose,
    decision_id: fields.decision_id,
    at: Date.now(),
  });
}

/**
 * A decision an Ask first read filed was resolved. A person's Approve lets
 * that conversation read the secret from now on; Deny or a dismissal closes
 * it, and the next read asks again. An approval is a person's alone: an
 * answer by a role or a standing grant settles nothing (the category is
 * `access`, which no role holds, so this is the belt to that brace).
 */
export async function settleSecretApproval(
  ctx: Ctx,
  row: { _id: Id<"session_decisions">; options?: Array<{ label: string }> },
  verdict: { status: string; answer_index?: number },
  by: { kind: string; user_id?: Id<"users"> },
  now: number,
): Promise<void> {
  const approval = await ctx.db.query("secret_approvals").withIndex("by_decision", (q: any) => q.eq("decision_id", row._id)).first();
  if (!approval || approval.status !== "pending") return;
  const label = verdict.status === "answered" ? row.options?.[verdict.answer_index ?? -1]?.label : undefined;
  const approved = label === APPROVE_FOR_SESSION;
  if (approved && (by.kind !== "user" || !by.user_id)) return;
  await ctx.db.patch(approval._id, { status: approved ? "approved" : "denied", approved_by: approved ? by.user_id : undefined, at: now });
  const secret = await ctx.db.get(approval.secret_id);
  if (!secret) return;
  await recordSecretEvent(ctx, secret, approved ? "approved" : "denied", {
    actor: by.user_id,
    conversation_id: approval.conversation_id,
    decision_id: row._id,
  });
}
