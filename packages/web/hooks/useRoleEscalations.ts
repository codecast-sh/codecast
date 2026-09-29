// The sessions a role has put in front of the person (org-roles-run-work.md
// R1, revised), as the queue items the decision queue answers, read off the
// store's session rows with the one helper the queue uses
// (escalationQueueItems), so the role's page, the queue and the inbox card
// cannot disagree about what needs the person. Subscribes to a signature of
// the fields the helper reads, never the rows: a heartbeat on a hand must not
// repaint the page.
//
// The helper finds the role's standing session by the `standing_role_id` on
// its row. When the store does not hold that row yet, the caller's pointer
// (the tree's `standing.conversation_id`) stands in for it.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { escalationQueueItems, escalationsWakeSig, type QueueItem } from "../lib/decisionQueue";

const EMPTY: QueueItem[] = [];

export function useRoleEscalations(roleId: string | null | undefined, standingId?: string | null): QueueItem[] {
  const sig = useInboxStore((s) => (roleId ? escalationsWakeSig(s.sessions) : ""));
  return useMemo(() => {
    if (!roleId) return EMPTY;
    const st = useInboxStore.getState();
    const rows: Record<string, any> = { ...st.sessions };
    if (standingId && !rows[standingId]) rows[standingId] = { _id: standingId, standing_role_id: roleId };
    const items = escalationQueueItems(rows).filter((i) => i.escalation?.roleId === roleId);
    return items.length ? items.sort((a, b) => b.createdAt - a.createdAt) : EMPTY;
  }, [sig, roleId, standingId]); // eslint-disable-line react-hooks/exhaustive-deps
}
