import { toast } from "sonner";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { undoAsOne } from "../store/undoActions";
import { counted } from "../store/undo/labels";

/**
 * File sessions under a label (null removes it). The one sink for the bulk
 * menu, the selection bar and a card dropped on a label, so a drag of a ticked
 * card files the whole selection the same way the menu does.
 */
export function labelSessions(ids: string[], bucketId: string | null) {
  const store = useInboxStore.getState();
  // A label mid-create (optimistic stub) can't take assignments yet; the
  // server row supersedes the stub within about a second.
  if (bucketId && !isConvexId(bucketId)) {
    toast.error("Label is still syncing — try again in a moment");
    return;
  }
  const name = bucketId ? store.buckets[bucketId]?.name : null;
  const real = ids.map((id) => store.getConvexId(id) ?? id).filter((id) => isConvexId(id));
  const applied = real.length;
  const sessions = counted(applied, "session");
  undoAsOne(bucketId ? `Labeled ${sessions}${name ? ` ${name}` : ""}` : `Removed the label from ${sessions}`, () => {
    for (const id of real) store.assignSessionToBucket(id, bucketId);
  });
  if (applied === 0) {
    toast.error("Session is still being created — try again in a moment");
    return;
  }
  const what = applied === 1 ? "" : ` ${applied} sessions`;
  toast.success(bucketId ? `Labeled${what}${name ? ` ${name}` : ""}` : `Label removed${what ? ` from${what}` : ""}`);
}
