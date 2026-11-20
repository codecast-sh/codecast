import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveSessionConversation } from "./access";
import { computeWorkspaceKey } from "./accessKeys";
import { cliDocWriter, writeDocBody } from "./docBody";

// A role's charter has one home: its charter doc (org-roles-standing.md T2).
// The role row holds only `charter_doc_id`. Every surface that shows the
// charter, and every door that changes it (the role page, `cast role update
// --charter`, a proposal's charter edit, a template's loader), reads and
// writes the doc through these two functions, so what a person edits is what
// the role reads at its next run.

/** The charter's text: its doc's content, or "" for a role without one. */
export async function roleCharterOf(ctx: { db: any }, role: { charter_doc_id?: Id<"docs"> | string | null }): Promise<string> {
  const doc = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
  return String(doc?.content ?? "").trim();
}

/** The charter a role is born with when nobody wrote one: its job, in a sentence. */
export function defaultCharter(role: { name: string }, scopeNames: string[], parentName: string): string {
  return scopeNames.length
    ? `${role.name} looks after the work in its area on behalf of ${parentName}: it keeps the area's plans and tasks moving, reports what changed and why, and raises what needs a person with a recommendation.`
    : `${role.name} works on behalf of ${parentName}: it runs its routine, answers what it is asked, and raises what needs a person with a recommendation.`;
}

/** A new charter doc for `role`, holding `content`. The caller sets `charter_doc_id`. */
export async function insertCharterDoc(ctx: { db: any }, userId: Id<"users">, role: { name: string; team_id?: Id<"teams"> | null }, content: string): Promise<Id<"docs">> {
  const now = Date.now();
  return await ctx.db.insert("docs", {
    user_id: userId,
    team_id: role.team_id ?? undefined,
    // The role's boundary, the key an undo of a charter edit is checked against (orgChanges.mayWrite).
    workspace: computeWorkspaceKey({ user_id: userId, team_id: role.team_id ?? undefined }, null),
    title: `Charter: ${role.name}`,
    content,
    doc_type: "charter",
    source: "human",
    created_at: now,
    updated_at: now,
  });
}

// A charter belongs to the humans (org-roles-standing.md T2): no session
// carrying a standing or hand pointer may write one, through the doc's own
// write or through the role's charter edit. Keyed on the STORED doc type, so
// retyping the doc in the same call cannot slip past it, and on a session the
// caller RUNS (resolveSessionConversation resolves only rows the caller can
// see; the ownership check keeps a teammate's id from mattering).
export async function refuseRoleCharterWrite(ctx: any, userId: Id<"users">, doc: any, sessionRef: string | undefined): Promise<void> {
  if (doc.doc_type !== "charter" || !sessionRef) return;
  const caller = await resolveSessionConversation(ctx, userId, sessionRef);
  if (!caller || String(caller.user_id) !== String(userId)) return;
  if (caller.standing_role_id || caller.org_role_id) {
    throw new Error("A charter is written by people: a role's session or a hand may read it but not change it");
  }
}

/** Replace the charter's text. Writes the doc the way every whole-body write
 *  does (lib/docBody), so an open editor remounts on it and unsaved editor
 *  steps refuse the write. A role without a doc gets one. Returns the doc id
 *  when it was created here, for the caller to store on the row. */
export async function writeRoleCharter(ctx: MutationCtx, userId: Id<"users">, role: any, text: string, fromSession?: string): Promise<Id<"docs"> | null> {
  const content = text.trim();
  await refuseRoleCharterWrite(ctx, userId, { doc_type: "charter" }, fromSession);
  const doc = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id as Id<"docs">) : null;
  if (!doc) return await insertCharterDoc(ctx, userId, role, content);
  if ((doc.content ?? "").trim() === content) return null;
  await writeDocBody(ctx, doc, { content, title: doc.title }, {
    writer: await cliDocWriter(ctx, userId, fromSession),
    reread: "open the role's charter again",
  });
  return null;
}
