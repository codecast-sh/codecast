import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";

// restartSession can answer with a DIFFERENT conversation: the ghost's live
// twin, or a freshly recreated row. Follow it there, and clear the ghost from
// the cache once we've left it (pruneGhostSessions skips the open session, so
// the delayed call runs after navigation lands; both calls are no-op safe).
// Returns true when it redirected.
export function followRestoredConversation(res: any, ghostId: string): boolean {
  const targetId = res?.conversation_id;
  if (!res?.restored || !targetId || targetId === ghostId) return false;
  toast.success("Restored the live session", { description: "This conversation was deleted on the server." });
  // Same logical conversation reborn under a new id — rekey-class, not a jump.
  useInboxStore.getState().requestNavigate(targetId, { source: "rekey" });
  useInboxStore.getState().pruneGhostSessions([ghostId]);
  setTimeout(() => useInboxStore.getState().pruneGhostSessions([ghostId]), 3000);
  return true;
}
