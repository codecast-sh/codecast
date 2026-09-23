// The sessions a role has put in front of the person (org-roles-run-work.md
// R1, revised), read off the store's session rows with the one helper the
// inbox card uses (roleEscalationsOf), so the role's page, the phone and the
// inbox card cannot disagree about what needs the person. Subscribes to a
// signature of the fields the helper reads, never the rows: a heartbeat on a
// hand must not repaint the page.
//
// The helper finds the role's standing session by the `standing_role_id` on
// its row. When the store does not hold that row yet, the caller's pointer
// (the tree's `standing.conversation_id`) stands in for it.
import { useMemo } from "react";
import { roleEscalationsOf, type RoleEscalation } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

const EMPTY: RoleEscalation[] = [];

export function useRoleEscalations(roleId: string | null | undefined, standingId?: string | null): RoleEscalation[] {
  const sig = useInboxStore((s) => {
    if (!roleId) return "";
    const parts: string[] = [];
    for (const id in s.sessions) {
      const row = s.sessions[id] as any;
      if (String(row?.standing_role_id ?? "") === roleId) parts.push(`lead:${id}`);
      else if (String(row?.org_role_id ?? "") === roleId && row?.escalated_by_role) parts.push(`${id}|${row.escalated_by_role.line}|${row.escalated_by_role.at}|${row.escalated_by_role.direct ? 1 : 0}`);
    }
    return parts.join("\n");
  });
  return useMemo(() => {
    if (!roleId) return EMPTY;
    const st = useInboxStore.getState();
    const rowOf = (id: string): any => st.sessions[id] ?? (id === standingId ? { _id: id, standing_role_id: roleId } : undefined);
    const ids = Object.keys(st.sessions).filter((id) => { const r = st.sessions[id] as any; return String(r?.standing_role_id ?? "") === roleId || String(r?.org_role_id ?? "") === roleId; });
    if (standingId && !ids.includes(standingId)) ids.push(standingId);
    const lead = ids.find((id) => String(rowOf(id)?.standing_role_id ?? "") === roleId);
    if (!lead) return EMPTY;
    return roleEscalationsOf(ids, rowOf).get(lead) ?? EMPTY;
  }, [sig, roleId, standingId]); // eslint-disable-line react-hooks/exhaustive-deps
}
