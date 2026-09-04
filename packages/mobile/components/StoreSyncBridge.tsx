import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSyncCore } from '@codecast/web/hooks/useSyncCore';
import { emitSyncWake } from '@codecast/web/hooks/syncWake';
import { flushPersistence } from '@codecast/web/store/idbCache';

// Hosts the inbox store's server-sync hooks OUTSIDE any screen. The live
// listInboxSessions subscription re-renders whichever component holds it on
// every server push, and message streaming across a busy team makes those
// pushes near-continuous. Parked inside InboxScreen (its old home) each push
// re-rendered the entire session list — a full core burned on an idle phone.
// Here a push re-renders only this null component; screens read the store
// through wake signatures and wake only on structural change.
//
// The mount set is useSyncCore — the SAME feeder profile web's DashboardLayout
// mounts (sync-convergence C5, feeder parity), so the phone's replica is fed
// by every channel the desktop's is: live window, liveness overlay, recovery
// probes, team feeders, the sync-log applier, session decisions, labels.
// Screens must never host sync hooks (syncCoreParity guard).
//
// AppState is this platform's wake source: backgrounding pauses every sync
// timer for free (RN freezes them), and the "active" transition emits ONE
// catch-up pass on the syncWake bus — the reconcile nonce and the recovery
// controllers listen there. This replaces the document-gated listener that
// never re-ticked on iOS (no DOM visibility events).
export function StoreSyncBridge() {
  useSyncCore('mobile');
  // eslint-disable-next-line no-restricted-syntax -- platform wake-source wiring
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') emitSyncWake();
      // Scheduled blob writes (idbCache.native) ride a short delay; iOS may
      // suspend or kill a backgrounded app at any moment, so land them now.
      else void flushPersistence();
    });
    return () => sub.remove();
  }, []);
  return null;
}
