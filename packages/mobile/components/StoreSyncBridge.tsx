import { useSyncInboxSessions } from '@/hooks/useSyncInboxSessions';
import { useSyncBuckets } from '@codecast/web/hooks/useSyncBuckets';

// Hosts the inbox store's server-sync hooks OUTSIDE any screen. The live
// listInboxSessions subscription re-renders whichever component holds it on
// every server push, and message streaming across a busy team makes those
// pushes near-continuous. Parked inside InboxScreen (its old home) each push
// re-rendered the entire session list — a full core burned on an idle phone.
// Here a push re-renders only this null component; screens read the store
// through wake signatures and wake only on structural change. Mirrors web,
// where DashboardLayout hosts these hooks away from the routed page.
export function StoreSyncBridge() {
  useSyncInboxSessions();
  useSyncBuckets();
  return null;
}
