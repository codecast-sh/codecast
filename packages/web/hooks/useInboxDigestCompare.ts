import { useEffect } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import {
  createInboxDigestComparer,
  createInboxDigestDevHandle,
  INBOX_COMPARE_TICK_MS,
  type InboxDigestComparer,
} from "../store/inboxDigestCompare";
import { syncMetaKey } from "./reconcileCrawl";
import { inboxCrawlWsKey } from "./useSyncInboxSessions";
import { batchGet } from "./useSyncChangeFeed";
import { subscribeCoarseTick } from "./useCoarseNow";
import { getPlatform, track } from "../lib/analytics";

// The anti-entropy loop's mount (sync-convergence C6/C7): one comparer per
// replica, ticking on the SHARED coarse clock (useCoarseNow's fan-out — no
// feeder owns a private interval, C5). Part of the useSyncCore profile so
// web, desktop and mobile all run it — the drift metric is only meaningful
// when every platform reports. The IO surface it gets is the EXISTING
// recovery path: the sync-log hydration fetch (batchGet over
// getInboxSessionsByIds) for missing bodies, applied through the one heal
// applier, and one sessionsLiveness `_probe` applied through the one overlay
// applier — never a working-set refetch, never a store write outside
// syncTable's pending filter. `track` / `getPlatform` are the analytics
// channel every other sync metric uses (lib/analytics; the native twin stamps
// "mobile").
export function startInboxDigestCompare(
  convex: { query: (fn: any, args: any) => Promise<any> },
  subscribeTick: (intervalMs: number, fn: () => void) => () => void = subscribeCoarseTick,
): { comparer: InboxDigestComparer; dispose: () => void } {
  const crawlMetaKeyFor = (meId: string | null) => (meId ? syncMetaKey("sessions", inboxCrawlWsKey(meId)) : null);
  const comparer = createInboxDigestComparer({
    platform: getPlatform(),
    track,
    crawlMetaKeyFor,
    fetchByIds: async (ids) => {
      const rows = await batchGet(convex, "sessions", ids);
      useInboxStore.getState().applyHealedSessions(ids, rows);
    },
    probeOverlay: async () => {
      const fresh: any = await convex.query(api.conversations.sessionsLiveness, { _probe: Date.now() });
      if (!fresh?.liveness) return;
      useInboxStore.getState().applyInboxLivenessPayload("mine", fresh);
    },
  });
  // Dev console handle (same convention as __inboxStore): the read-only
  // diagnostics live in the compare module (an allowed reader of the stamp
  // buffer); this mount only adds the two IO peeks and attaches it.
  const dev = process.env.NODE_ENV !== "production" ? createInboxDigestDevHandle(comparer, crawlMetaKeyFor) : null;
  if (dev && typeof window !== "undefined") {
    (window as any).__inboxDigest = {
      ...dev,
      /** One raw overlay execution, as the server ships it (nothing applied). */
      overlay: () => convex.query(api.conversations.sessionsLiveness, { _probe: Date.now() }),
      /** The server's current rows for ids (read only; nothing applied). */
      peek: (ids: string[]) => batchGet(convex, "sessions", ids),
    };
  }
  const unsubscribe = subscribeTick(INBOX_COMPARE_TICK_MS, () => {
    try {
      const outcome = comparer.tick(useInboxStore.getState());
      dev?.logOutcome(outcome);
    } catch (err) {
      console.warn("[inboxDigest] tick failed", err);
    }
  });
  return {
    comparer,
    dispose: () => {
      unsubscribe();
      comparer.dispose();
    },
  };
}

export function useInboxDigestCompare(): void {
  const convex = useConvex();
  // eslint-disable-next-line no-restricted-syntax -- subscribes to the shared coarse clock
  useEffect(() => startInboxDigestCompare(convex).dispose, [convex]);
}
