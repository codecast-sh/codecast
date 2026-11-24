// The owners model's shared gesture and label: an owners change applied with
// its toast and Undo, and the "Owners: …" line the faces carry.
import { useInboxStore } from "../store/inboxStore";
import { gestureToast } from "../store/undoStack";
import type { SessionOwnersChange } from "../store/sessionOwnersSlice";
import type { SessionOwnersView } from "../hooks/useSessionOwners";

export function ownersTitle(view: Pick<SessionOwnersView, "people" | "role" | "parent" | "meId">): string {
  return `Owners: ${[...view.people.map((p) => (p._id === view.meId ? "You" : p.name)), ...(view.role ? [view.role.name] : []), ...(view.parent ? [view.parent.title] : [])].join(", ")}`;
}

/** Applies an owners change with its toast and Undo. */
export function applyOwnersWithToast(conversationId: string, change: SessionOwnersChange, inverse: SessionOwnersChange | null, message: string) {
  gestureToast(message, () => useInboxStore.getState().applySessionOwners(conversationId, change, inverse));
}
