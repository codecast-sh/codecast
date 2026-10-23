// Vault's audit trail writer, its redaction counter and the Ask first settle
// hook (docs/architecture/vault.md). A leaf: sessionDecisions settles an
// approval decision through it, and secrets.ts records every event with it,
// so neither imports the other's module graph.

import type { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };

export const APPROVE_FOR_SESSION = "Approve for this session";
export const DENY = "Deny";

// The redaction version is one counter per workspace, bumped on every change
// to what the daemon's redaction feed holds (a value written or deleted, an
// Ask first secret approved), so a daemon polls a few counter reads instead of
// decrypting every value it can read.
export const redactionCounter = (workspace: string) => `secrets-redaction:${workspace}`;

export async function bumpRedaction(ctx: Ctx, workspace: string) {
  const name = redactionCounter(workspace);
  const row = await ctx.db.query("counters").withIndex("by_name", (q: any) => q.eq("name", name)).unique();
  if (row) await ctx.db.patch(row._id, { value: row.value + 1 });
  else await ctx.db.insert("counters", { name, value: 1 });
}

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
 * Whether `userId` may grant an Ask first approval: only the person whose
 * session asked (the conversation's owner, the only one who reads under it),
 * and for a personal secret only when that is also the secret's owner. A
 * teammate who can view a team-shared session cannot open someone's secret
 * to it.
 */
async function mayApprove(ctx: Ctx, approval: Doc<"secret_approvals">, userId: Id<"users"> | undefined): Promise<boolean> {
  if (!userId) return false;
  const conversation = await ctx.db.get(approval.conversation_id);
  if (!conversation || String(conversation.user_id) !== String(userId)) return false;
  return !approval.workspace.startsWith("user:") || approval.workspace === `user:${userId}`;
}

const pendingApproval = async (ctx: Ctx, decisionId: Id<"session_decisions">): Promise<Doc<"secret_approvals"> | null> => {
  const approval = await ctx.db.query("secret_approvals").withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId)).first();
  return approval?.status === "pending" ? approval : null;
};

/**
 * Why `by` may not resolve this decision, or null. An Ask first decision is
 * the asking session's owner's, signed in to the app (the web's resolve, or
 * its dispatch rail): an answer through an api token may be the gated agent
 * answering its own question, from its own shell with no session named, and
 * a teammate viewing the session is not the person whose secret it opens.
 * finalizeAnswer, answerCore and the dispatch rail check it the way they
 * check hostedAnswerRefusal.
 */
export async function secretApprovalRefusal(
  ctx: Ctx,
  row: { _id: Id<"session_decisions"> },
  by: { user_id?: Id<"users">; signed_in?: boolean },
): Promise<string | null> {
  const approval = await pendingApproval(ctx, row._id);
  if (!approval) return null;
  if (!by.signed_in) return "An Ask first decision is a person's: answer it on the web or the phone, where you are signed in";
  if (!(await mayApprove(ctx, approval, by.user_id))) return "Only the person whose session asked can answer an Ask first decision";
  return null;
}

/**
 * A decision an Ask first read filed was resolved. A signed-in person's
 * Approve lets that conversation read the secret from now on, and moves the
 * redaction version (the daemon's feed now holds the value); Deny or a
 * dismissal closes it, and the next read asks again. A withdrawal (the asking
 * session took it back) drops the approval and records `withdrawn`, since no
 * person denied anything. An approval by anyone
 * else (a role, a standing grant, an api token, a teammate viewing the
 * session) settles nothing and the approval stays pending; the resolve paths
 * refuse those first (secretApprovalRefusal), so this is the belt to that
 * brace.
 */
export async function settleSecretApproval(
  ctx: Ctx,
  row: { _id: Id<"session_decisions">; options?: Array<{ label: string }> },
  verdict: { status: string; answer_index?: number },
  by: { kind: string; user_id?: Id<"users">; signed_in?: boolean },
  now: number,
): Promise<void> {
  const approval = await pendingApproval(ctx, row._id);
  if (!approval) return;
  const label = verdict.status === "answered" ? row.options?.[verdict.answer_index ?? -1]?.label : undefined;
  const approved = label === APPROVE_FOR_SESSION;
  if (approved && (by.kind !== "user" || !by.signed_in || !(await mayApprove(ctx, approval, by.user_id)))) return;
  const withdrawn = verdict.status === "withdrawn";
  if (withdrawn) await ctx.db.delete(approval._id);
  else await ctx.db.patch(approval._id, { status: approved ? "approved" : "denied", approved_by: approved ? by.user_id : undefined, at: now });
  if (approved) await bumpRedaction(ctx, approval.workspace);
  const secret = await ctx.db.get(approval.secret_id);
  if (!secret) return;
  await recordSecretEvent(ctx, secret, approved ? "approved" : withdrawn ? "withdrawn" : "denied", {
    actor: by.user_id,
    conversation_id: approval.conversation_id,
    decision_id: row._id,
  });
}
