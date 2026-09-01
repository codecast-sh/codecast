import { useEffect } from "react";
import { useInboxStore } from "../store/inboxStore";
import { startSyncReplication } from "../store/syncReplication";

/**
 * Whether this window feeds itself from the server (sync host or solo) or
 * receives the shared slice from another window (follower). Global feeders
 * gate on this; per-view queries (a conversation's messages, a doc body)
 * never do. See docs/architecture/sync-host.md.
 */
export function useIsSyncHost(): boolean {
  return useInboxStore((s) => s.syncRole !== "follower");
}

/** Mount cross-window replication for this window. `eligible` = this window
 *  mounts the full shell and may be elected host. */
export function useSyncReplication(eligible: boolean): void {
  useEffect(() => startSyncReplication({ eligible }), [eligible]);
}
