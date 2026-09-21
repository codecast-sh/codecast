import { useInboxStore } from "../store/inboxStore";
import type { OrgRoleSeat } from "@codecast/shared/contracts/orgProposal";

/** A session this old may already be a role (the analyzer's own age rule). */
export const MAKE_ROLE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type SessionRow = { _id?: string; short_id?: string; title?: string; started_at?: number; created_at?: number; project_path?: string; parent_conversation_id?: string; is_subagent?: boolean; org_role_id?: string; is_anchor?: boolean; anchor_id?: string; standing_role_id?: string };

/** Whether the ownership menu offers "Make this a role": an old enough top
 *  level session that is not a role's standing session and reports to no role
 *  (the server refuses to seat a session that already reports to one). */
export function sessionFitsARole(row: SessionRow | undefined, now: number): boolean {
  if (!row || row.is_subagent || row.parent_conversation_id || row.org_role_id || row.is_anchor || row.anchor_id || row.standing_role_id) return false;
  const started = row.started_at ?? row.created_at;
  return !!started && now - started >= MAKE_ROLE_MIN_AGE_MS;
}

/** The seat a session offers, read once from the store when the person asks:
 *  its title, its age, and the sessions it started that the store holds. */
export function seatOfSession(conversationId: string): { seat: OrgRoleSeat; project_path?: string } | null {
  const s = useInboxStore.getState() as any;
  const live = s.resolveLiveSessionId?.(conversationId) ?? conversationId;
  const row: SessionRow | undefined = s.sessions?.[live] ?? s.conversations?.[conversationId];
  if (!row) return null;
  const ids = new Set([conversationId, live, row._id].filter(Boolean));
  const helpers = Object.values(s.sessions ?? {}).filter((c: any) => c?.parent_conversation_id && ids.has(c.parent_conversation_id)).length;
  return {
    seat: { existing: row.short_id ?? conversationId, ...(row.title ? { title: row.title } : {}), ...(row.started_at ?? row.created_at ? { started_at: row.started_at ?? row.created_at } : {}), ...(helpers ? { helpers } : {}) },
    project_path: row.project_path,
  };
}
