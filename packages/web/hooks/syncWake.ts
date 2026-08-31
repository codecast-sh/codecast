// ONE platform-neutral "the app came back" bus for the sync layer
// (sync-convergence C5, feeder parity). The consumers — the reconcile-nonce
// tick in useSyncInboxSessions, the recovery controllers in useRecoveryPoll —
// subscribe HERE and stay platform-blind; the platform wires exactly one
// source into it:
//   web    → document visibility / window focus (useSyncCore's web profile)
//   mobile → AppState "active" (StoreSyncBridge), replacing the document-gated
//            listener that never re-ticked on iOS.
// A backgrounded client sleeps through its intervals precisely while it
// accumulates staleness, so the wake emit is the one catch-up pass the
// contract requires on resume.

type SyncWakeListener = () => void;

const listeners = new Set<SyncWakeListener>();

/** Subscribe to app-wake events; returns the unsubscribe. */
export function onSyncWake(fn: SyncWakeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The platform's wake source calls this once per return-to-foreground. */
export function emitSyncWake(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.warn("[syncWake] listener failed", err);
    }
  }
}
