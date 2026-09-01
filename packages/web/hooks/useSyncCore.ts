import { useEffect } from "react";
import { useSyncInboxSessions } from "./useSyncInboxSessions";
import { useSyncTeamInboxSessions } from "./useSyncTeamInboxSessions";
import { useSyncChangeFeed } from "./useSyncChangeFeed";
import { useSyncSessionDecisions } from "./useSyncSessionDecisions";
import { useSyncBuckets } from "./useSyncBuckets";
import { useInboxDigestCompare } from "./useInboxDigestCompare";
import { emitSyncWake } from "./syncWake";

export type SyncCoreProfile = "web" | "mobile";

// THE feeder mount set (sync-convergence C5, "feeder parity"). Every client
// replica mounts this ONE hook — web in DashboardLayout, mobile in
// StoreSyncBridge — so no platform can fork which channels feed the store:
//
//   useSyncInboxSessions   the live window (useLiveInboxSessions inside it),
//                          the sessionsLiveness overlay, the recovery probes
//                          (SAME args as the subscriptions), client state,
//                          current user, bookmarks, the completeness crawl,
//                          the dismissed/stashed reconciles, the ghost sweep
//   useSyncTeamInboxSessions  the team feeders, mounted per scope (they
//                          subscribe only while inbox_scope is "team")
//   useSyncChangeFeed      the sync-log applier (per-scope catch-up cursors)
//   useSyncSessionDecisions  the decision queue (the questions bucket input)
//   useSyncBuckets         labels
//   useInboxDigestCompare  the anti-entropy loop (sync-convergence C6/C7):
//                          replica digest vs the overlay's stamps, bounded
//                          heal through getInboxSessionsByIds + one probe
//
// A source guard (lib/__tests__/syncCoreParity.guard.test.ts) asserts the set
// above stays mounted here and that both platforms mount THIS hook rather
// than a hand-picked subset — the drift class this replaces (mobile mounted
// two of five feeders, so its replica computed counts from thinner data).
//
// Wake discipline: every timer-driven catch-up (the reconcile nonce, the
// recovery controllers) listens on the syncWake bus. The web profile wires
// the DOM wake source here; mobile wires AppState in StoreSyncBridge —
// backgrounding pauses everything for free (RN freezes timers), and the
// "active" transition emits the one catch-up pass the contract requires.
export function useSyncCore(profile: SyncCoreProfile): void {
  useSyncInboxSessions();
  useSyncTeamInboxSessions();
  useSyncChangeFeed();
  useSyncSessionDecisions();
  useSyncBuckets();
  useInboxDigestCompare();

  // eslint-disable-next-line no-restricted-syntax -- platform wake-source wiring
  useEffect(() => {
    if (profile !== "web") return;
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") emitSyncWake();
    };
    const onFocus = () => emitSyncWake();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [profile]);
}
