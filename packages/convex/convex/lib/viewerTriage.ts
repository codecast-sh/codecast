// A team session's triage is each person's own (team sessions spec): one
// teammate dismissing, stashing, snoozing or pinning it must not move it for
// the rest of the team. Those four live per person in session_viewer_triage
// and are laid over the row each viewer reads; the conversation's own stamps
// stay for what ends it for everyone (Done, kill). A leaf module.
import { closeWakeFields, pinHideFields } from "@codecast/shared/contracts";
import type { Id } from "../_generated/dataModel";

type Db = { db: any };

/** The conversation fields that are one person's own on a team session. */
export const VIEWER_TRIAGE_FIELDS = ["inbox_dismissed_at", "inbox_closed_at", "inbox_stashed_at", "inbox_stash_hidden", "inbox_snoozed_until", "inbox_pinned_at"] as const;
export type ViewerTriage = Partial<Record<(typeof VIEWER_TRIAGE_FIELDS)[number], any>>;

/** False when a full conversation doc says no team owns it (its
 *  team_owner_team_id copy), so the caller skips the read. */
export function mayBeTeamOwned(doc: any): boolean {
  return !(doc && doc._creationTime !== undefined && !doc.team_owner_team_id);
}

export async function isTeamOwnedConversation(ctx: Db, conversationId: Id<"conversations">, doc?: any): Promise<boolean> {
  if (doc && !mayBeTeamOwned(doc)) return false;
  return !!(await ctx.db
    .query("session_team_owners")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .first());
}

/** Write one person's triage for a team session: the fields named are set
 *  (null or undefined clears one). */
export async function recordViewerTriage(ctx: Db, userId: Id<"users">, conversationId: Id<"conversations">, fields: ViewerTriage): Promise<void> {
  const patch: Record<string, any> = { updated_at: Date.now() };
  for (const k of VIEWER_TRIAGE_FIELDS) if (k in fields) patch[k] = fields[k] ?? undefined;
  const existing = await ctx.db
    .query("session_viewer_triage")
    .withIndex("by_user_conversation", (q: any) => q.eq("user_id", userId).eq("conversation_id", conversationId))
    .first();
  if (existing) await ctx.db.patch(existing._id, patch);
  else await ctx.db.insert("session_viewer_triage", { user_id: userId, conversation_id: conversationId, ...patch });
}

// One person's triage of the team sessions in their window, by conversation
// id: one indexed read per windowed session, issued together, so nothing past
// a cap is ever dropped.
export async function viewerTriageMap(ctx: Db, userId: Id<"users">, conversationIds: Id<"conversations">[]): Promise<Map<string, ViewerTriage>> {
  const rows = await Promise.all(conversationIds.map((id) => ctx.db
    .query("session_viewer_triage")
    .withIndex("by_user_conversation", (q: any) => q.eq("user_id", userId).eq("conversation_id", id))
    .first()));
  return new Map(rows.filter(Boolean).map((r: any) => [String(r.conversation_id), pickTriage(r)]));
}

export async function viewerTriageFor(ctx: Db, userId: Id<"users">, conversationId: Id<"conversations">): Promise<ViewerTriage> {
  const row = await ctx.db
    .query("session_viewer_triage")
    .withIndex("by_user_conversation", (q: any) => q.eq("user_id", userId).eq("conversation_id", conversationId))
    .first();
  return row ? pickTriage(row) : {};
}

function pickTriage(row: any): ViewerTriage {
  const out: ViewerTriage = {};
  for (const k of VIEWER_TRIAGE_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

/** Lay one viewer's triage over a team session's inbox row: their own
 *  stamps replace the conversation's (absent ones read as cleared). */
export function overlayViewerTriage(row: any, triage: ViewerTriage | undefined): void {
  for (const k of VIEWER_TRIAGE_FIELDS) row[k] = triage?.[k] ?? null;
  row.is_pinned = !!triage?.inbox_pinned_at;
}

/** A team session's visibility patch with anything that would hide it from
 *  the team taken out: private, the private lock, or a summary-only level. */
export function keepTeamSessionVisible(updates: Record<string, any>): Record<string, any> {
  const out = { ...updates };
  if (out.is_private === true) delete out.is_private;
  if ("team_visibility" in out && out.team_visibility !== "full") delete out.team_visibility;
  return out;
}

/** The message a person sees when they try to make a team session private. */
export const TEAM_SESSION_STAYS_SHARED = "A team session is always the team's. Take ownership to make it yours, then make it private.";

/** Refuse a person's gesture that would hide a team session from its team. */
export async function refuseHidingTeamSession(ctx: Db, conversationId: Id<"conversations">, updates: { is_private?: boolean; team_visibility?: string | null }): Promise<void> {
  const hides = updates.is_private === true || (updates.team_visibility != null && updates.team_visibility !== "full");
  if (hides && await isTeamOwnedConversation(ctx, conversationId)) throw new Error(TEAM_SESSION_STAYS_SHARED);
}

/** A person writing in a team session brings it back for them: their own
 *  dismiss, stash and snooze come off, as the row's own stamps do on a send.
 *  A pin stays. */
export async function clearViewerTriageOnSend(ctx: Db, userId: Id<"users">, conversationId: Id<"conversations">): Promise<void> {
  const row = await ctx.db
    .query("session_viewer_triage")
    .withIndex("by_user_conversation", (q: any) => q.eq("user_id", userId).eq("conversation_id", conversationId))
    .first();
  if (!row || (!row.inbox_dismissed_at && !row.inbox_closed_at && !row.inbox_stashed_at && !row.inbox_snoozed_until)) return;
  await ctx.db.patch(row._id, { inbox_dismissed_at: undefined, inbox_closed_at: undefined, inbox_stashed_at: undefined, inbox_stash_hidden: undefined, inbox_snoozed_until: undefined, updated_at: Date.now() });
}

async function triageRowsOf(ctx: Db, conversation: any): Promise<any[]> {
  if (!mayBeTeamOwned(conversation)) return [];
  return await ctx.db
    .query("session_viewer_triage")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversation._id))
    .collect();
}

/** A machine wake (isMachineWake) of a team session runs each person's own
 *  Close of it out of sight, as wakeHideFields does for the row. */
export async function hideViewerClosesOnWake(ctx: Db, conversation: any): Promise<void> {
  for (const row of await triageRowsOf(ctx, conversation)) {
    const fields = closeWakeFields(row, Date.now());
    if (fields) await ctx.db.patch(row._id, { ...fields, updated_at: Date.now() });
  }
}

/** A pinned state brings a team session back for each person who hid it, by
 *  the rule the row follows (pinHideFields). True when it brought any back. */
export async function resurfaceViewerTriageOnPin(ctx: Db, conversation: any, status: string, returnsOnDone: boolean): Promise<boolean> {
  if (status !== "blocked" && status !== "done") return false;
  let any = false;
  for (const row of await triageRowsOf(ctx, conversation)) {
    const fields = pinHideFields(row, status, returnsOnDone);
    if (!fields) continue;
    await ctx.db.patch(row._id, { ...fields, updated_at: Date.now() });
    any = true;
  }
  return any;
}

/** Every person's own triage of one session, gone (it ended, or the team no
 *  longer owns it). */
export async function dropViewerTriage(ctx: Db, conversationId: Id<"conversations">): Promise<void> {
  const rows = await ctx.db
    .query("session_viewer_triage")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}
