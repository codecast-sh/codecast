// "With <owner>": the agent that answers a session's wait under the owners
// model (team feature session_owners, shared agentAnswersRow). Its role by
// handle, or the session that owns it by title. Null when no agent answers it.
import { agentAnswersRow, agentOwnerOfRow } from "@codecast/shared/contracts";
import type { InboxSession } from "../store/inboxStore";
import { roleRowsOf } from "./roleRows";
import { ownerFactsOf } from "../store/sessionOwnersSlice";

/** The "With <owner>" a card or row draws: only while it reads working and no
 *  send of yours is pending, the one rule web's two card styles and the phone
 *  row share. */
export function withOwnerShown(label: string | null, working: boolean, pendingSend: boolean): string | null {
  return label && working && !pendingSend ? label : null;
}

/** The row with its role and owning session as the owners read says them:
 *  the read is their one home, and a change paints it at once, before the
 *  inbox feed restamps the row. The row itself when they agree. */
export function withOwnerFactsOf<R extends InboxSession>(s: Parameters<typeof ownerFactsOf>[0], row: R): R {
  const facts = ownerFactsOf(s, String(row._id));
  if (!facts) return row;
  const role = facts.org_role_id ? String(facts.org_role_id) : null;
  const parent = facts.parent_conversation_id ? String(facts.parent_conversation_id) : null;
  if ((row.org_role_id ?? null) === role && (row.owner_session_id ?? null) === parent) return row;
  return { ...row, org_role_id: role, owner_session_id: parent };
}

export function withOwnerLabelOf(row: InboxSession, ownerSessionTitle: string | null, roleHandle: string | null = null): string | null {
  if (!agentAnswersRow(row)) return null;
  const agent = agentOwnerOfRow(row);
  if (!agent) return null;
  if (agent.kind === "role") {
    const handle = roleHandle ?? (row.role && String(row.role._id) === agent.id ? row.role.handle : null);
    return handle ? `@${handle}` : "its role";
  }
  return ownerSessionTitle?.trim() || "its session";
}

/** The owning session's title, when that session answers the row's wait: one
 *  string, so a card subscribes to it without waking on anything else. */
export function ownerSessionTitleOf(s: { sessions: Record<string, InboxSession>; conversations: Record<string, any> }, row: InboxSession): string | null {
  const owner = agentAnswersRow(row) ? agentOwnerOfRow(row) : null;
  if (owner?.kind !== "session") return null;
  return s.sessions[owner.id]?.title ?? s.conversations[owner.id]?.title ?? null;
}

/** The handle of the role that answers the row's wait, live from the role
 *  rows: a role just added has no snapshot on the row yet. One string. */
export function ownerRoleHandleOf(s: Parameters<typeof roleRowsOf>[0], row: InboxSession): string | null {
  const owner = agentAnswersRow(row) ? agentOwnerOfRow(row) : null;
  if (owner?.kind !== "role") return null;
  return roleRowsOf(s).roles.find((r) => r._id === owner.id)?.handle ?? null;
}
