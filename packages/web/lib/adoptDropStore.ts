// The sidebar's adopt drop (lib/adoptDrop) read against the live store: whether
// a row would take the dragged card as its worker, what its hover says, and
// the drop itself with its toast and Undo.
import { useInboxStore } from "../store/inboxStore";
import { ownerFactsOf, ownersReadOf } from "../store/sessionOwnersSlice";
import { adoptChange, adoptDropRefusal, mayEdit, viewerOwns } from "./adoptDrop";
import { selectionIdsFor } from "./inboxSelection";
import { applyOwnersWithToast } from "./ownersGestures";

const ownersKnownOf = (st: any, id: string) => ({ facts: ownerFactsOf(st, id), canEdit: !!ownersReadOf(st, id)?.can_edit });
const meOf = (st: any) => String(st.currentUser?._id ?? "");
const titleOf = (st: any, id: string) => st.sessions?.[id]?.title || "Untitled session";

/** Why the target row would refuse the dragged card as its worker, or null. */
export function adoptRefusalNow(draggedId: string, targetId: string): string | null {
  if (selectionIdsFor(draggedId).length > 1) return "One session at a time";
  const st = useInboxStore.getState() as any;
  return adoptDropRefusal({
    dragged: st.sessions?.[draggedId],
    target: st.sessions?.[targetId],
    draggedOwners: ownersKnownOf(st, draggedId),
    targetOwners: ownersKnownOf(st, targetId),
    viewerId: meOf(st),
    // The painted parent first, so a reverse drag right after an adopt stays
    // dark; else the parent field on its row (a release leaves it).
    parentOf: (id) => {
      const p = ownerFactsOf(st, id)?.parent_conversation_id ?? (st.sessions?.[id] ?? st.conversations?.[id])?.parent_conversation_id;
      return p ? String(p) : null;
    },
  });
}

/** The hover's words: the dragged title, and whether it leaves the viewer's inbox. */
export function adoptHintNow(draggedId: string): { title: string; leaves: boolean } {
  const st = useInboxStore.getState() as any;
  const dragged = st.sessions?.[draggedId];
  return { title: dragged?.title || "this session", leaves: !!dragged && viewerOwns(dragged, ownersKnownOf(st, draggedId), meOf(st)) };
}

/** The drop: the dragged session becomes the target's worker, with an Undo. */
export function adoptSessionNow(draggedId: string, targetId: string): void {
  const st = useInboxStore.getState() as any;
  const meId = meOf(st);
  const mayHandTo = (id: string) => !!st.sessions?.[id] && mayEdit(st.sessions[id], ownersKnownOf(st, id), meId);
  const { change, inverse } = adoptChange(ownerFactsOf(st, draggedId), ownersReadOf(st, draggedId), meId, targetId, mayHandTo);
  applyOwnersWithToast(draggedId, change, inverse, `“${titleOf(st, draggedId)}” now works for “${titleOf(st, targetId)}”`);
}
