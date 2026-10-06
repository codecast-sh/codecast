// The ONE writer of `authority_events`, the append only audit of who granted
// or changed authority. The rule is audit or deny: a mutation that creates or
// changes authority calls recordAuthorityEvent in its own transaction, so the
// change cannot commit without its row and the row cannot exist without the
// change. Never record from a scheduled function or an action after the fact.
// authorityEvents.guard.test.ts reads the source and fails any other file
// that inserts into, patches or deletes from the table.
//
// A leaf like accessKeys.ts: access.ts (patchConversationVisibility) imports
// it at load, so nothing here may reach a module that defines functions.
import { Id } from "../_generated/dataModel";
import { computeWorkspaceKey } from "./accessKeys";
import { sha256Hex } from "./hash";

export const AUTHORITY_EVENT_KINDS = [
  "permission_answered",
  "share_link_minted",
  "share_link_revoked",
  "share_link_redeemed",
  "conversation_visibility_changed",
  "org_role_trust_changed",
  "org_role_caps_changed",
  "org_role_authority_changed",
  "org_proposal_accepted",
  "team_member_added",
  "team_member_removed",
  "team_member_role_changed",
  "team_member_visibility_changed",
] as const;
export type AuthorityEventKind = (typeof AUTHORITY_EVENT_KINDS)[number];

export type AuthorityEventInput = {
  kind: AuthorityEventKind;
  actor_user_id: Id<"users">;
  actor_conversation_id?: Id<"conversations">;
  /** The conversation the event is about; its POST-change row decides the
   *  access key (a team-visible session's events are the team's, a private
   *  session's are the actor's). */
  conversation?: {
    _id: Id<"conversations">;
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  } | null;
  team_id?: Id<"teams">;
  target_user_id?: Id<"users">;
  role_id?: string;
  share_table?: string;
  /** The raw link token; stored only as its sha256. */
  share_token?: string | null;
  detail?: { before?: unknown; after?: unknown };
};

export async function recordAuthorityEvent(ctx: { db: any }, ev: AuthorityEventInput): Promise<Id<"authority_events">> {
  const conv = ev.conversation ?? null;
  const team_id = ev.team_id ?? conv?.team_id;
  return ctx.db.insert("authority_events", {
    kind: ev.kind,
    actor_user_id: ev.actor_user_id,
    ...(ev.actor_conversation_id ? { actor_conversation_id: ev.actor_conversation_id } : {}),
    ...(conv ? { conversation_id: conv._id } : {}),
    ...(team_id ? { team_id } : {}),
    ...(ev.target_user_id ? { target_user_id: ev.target_user_id } : {}),
    ...(ev.role_id ? { role_id: ev.role_id } : {}),
    ...(ev.share_table ? { share_table: ev.share_table } : {}),
    ...(ev.share_token ? { share_token_hash: await sha256Hex(ev.share_token) } : {}),
    detail: ev.detail ?? {},
    workspace: computeWorkspaceKey({ user_id: ev.actor_user_id, team_id }, conv),
    created_at: Date.now(),
  });
}
