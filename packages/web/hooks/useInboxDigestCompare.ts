import { useEffect } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import {
  createInboxDigestComparer,
  INBOX_COMPARE_TICK_MS,
} from "../store/inboxDigestCompare";
import { syncMetaKey } from "./reconcileCrawl";
import { inboxCrawlWsKey } from "./useSyncInboxSessions";
import { chunkIds } from "./useSyncChangeFeed";
import { track } from "../lib/analytics";
import type { SyncCoreProfile } from "./useSyncCore";

// The anti-entropy loop's mount (sync-convergence C6/C7): one comparer per
// replica, ticking on the coarse clock. Part of the useSyncCore profile so
// web, desktop and mobile all run it — the drift metric is only meaningful
// when every platform reports. The IO surface it gets is the EXISTING
// recovery path: getInboxSessionsByIds for missing bodies (the sync-log
// hydration channel), and one sessionsLiveness `_probe` applied through the
// one overlay applier — never a working-set refetch, never a store write
// outside syncTable's pending filter. `track` is the analytics channel every
// other sync metric uses (lib/analytics; a no-op twin on native).
export function useInboxDigestCompare(profile: SyncCoreProfile): void {
  const convex = useConvex();
  // eslint-disable-next-line no-restricted-syntax -- self-managed coarse tick
  useEffect(() => {
    // Same platform test lib/analytics applies to every event it captures;
    // inlined so the mobile bundle (Hermes) never pulls the desktop bridge.
    const desktop = typeof window !== "undefined" && !!(window as any).__CODECAST_ELECTRON__;
    const platform = profile === "mobile" ? "mobile" : desktop ? "desktop" : "web";
    const comparer = createInboxDigestComparer({
      platform,
      track,
      crawlMetaKeyFor: (meId) => (meId ? syncMetaKey("sessions", inboxCrawlWsKey(meId)) : null),
      fetchByIds: async (ids) => {
        for (const chunk of chunkIds(ids)) {
          const res: any = await convex.query(api.conversations.getInboxSessionsByIds, { ids: chunk as any });
          const rows: InboxSession[] = res?.sessions ?? [];
          if (!rows.length) continue;
          const store = useInboxStore.getState();
          // A returned row proves it is visible: lift any planted exclude
          // before the delta merge, or the engine drops the row forever.
          store.clearFeedExcludes("sessions", rows.map((r) => String(r._id)));
          store.syncTable("sessions", rows);
        }
      },
      probeOverlay: async () => {
        const fresh: any = await convex.query(api.conversations.sessionsLiveness, { _probe: Date.now() });
        if (!fresh?.liveness) return;
        useInboxStore.getState().applyInboxLivenessPayload("mine", fresh);
      },
    });
    const id = setInterval(() => {
      try {
        comparer.tick(useInboxStore.getState());
      } catch (err) {
        console.warn("[inboxDigest] tick failed", err);
      }
    }, INBOX_COMPARE_TICK_MS);
    return () => {
      clearInterval(id);
      comparer.dispose();
    };
  }, [convex, profile]);
}
