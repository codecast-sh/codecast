import { toast } from "sonner";
import { useInboxStore, isConvexId } from "../store/inboxStore";

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
  let applied = 0;
  for (const id of ids) {
    const real = store.getConvexId(id) ?? id;
    if (!isConvexId(real)) continue;
    store.assignSessionToBucket(real, bucketId);
    applied++;
  }
  if (applied === 0) {
    toast.error("Session is still being created — try again in a moment");
    return;
  }
  const what = applied === 1 ? "" : ` ${applied} sessions`;
  const name = bucketId ? store.buckets[bucketId]?.name : null;
  toast.success(bucketId ? `Labeled${what}${name ? ` ${name}` : ""}` : `Label removed${what ? ` from${what}` : ""}`);
}
