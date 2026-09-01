import { useEffect } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import {
  createInboxDigestComparer,
  evaluateInboxCompare,
  INBOX_COMPARE_TICK_MS,
  type InboxDigestComparer,
} from "../store/inboxDigestCompare";
import { lastSyncApplyMono, monotonicNow, syncInflightCount } from "../store/syncActivity";
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
  const comparer = createInboxDigestComparer({
    platform: getPlatform(),
    track,
    crawlMetaKeyFor: (meId) => (meId ? syncMetaKey("sessions", inboxCrawlWsKey(meId)) : null),
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
  // Dev console handle (same convention as __inboxStore): `evaluate` is the
  // pure compare over the live store with the tick's exact context — no heal,
  // no telemetry — so a person can read the outcome and the per-row diff;
  // `counters` are the heartbeat counters since the last flush.
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    (window as any).__inboxDigest = {
      evaluate: () => {
        const state = useInboxStore.getState();
        const meId = state.currentUser?._id?.toString?.() ?? null;
        return evaluateInboxCompare(state, {
          now: Date.now(),
          nowMono: monotonicNow(),
          crawlMetaKey: meId ? syncMetaKey("sessions", inboxCrawlWsKey(meId)) : null,
          lastApplyMono: lastSyncApplyMono(),
          inflight: syncInflightCount(),
        });
      },
      counters: comparer.counters,
      healLatched: comparer.healLatched,
      activity: () => ({ apply_age_ms: monotonicNow() - lastSyncApplyMono(), inflight: syncInflightCount() }),
    };
  }
  const unsubscribe = subscribeTick(INBOX_COMPARE_TICK_MS, () => {
    try {
      comparer.tick(useInboxStore.getState());
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
