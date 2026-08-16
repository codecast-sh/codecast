// The daemon-side fleet (managed_sessions) — store-fed. Snapshot sync: the
// server's list IS the live set. Readers hide rows past the heartbeat window
// so a persisted row can't outlive it across a reload.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useCoarseNow } from "./useCoarseNow";

const api = _api as any;

// Mirrors lib/liveSessions.ts on the server.
const HEARTBEAT_WINDOW_MS = 24 * 3600_000;

export function useSyncManagedSessions(enabled = true) {
  return useSyncCollection("managedSessions", api.managedSessions.listActiveSessions, enabled ? {} : "skip");
}

const sig = (m: any) =>
  `${m.agent_status ?? ""}|${m.last_heartbeat ?? 0}|${m.current_cpu ?? 0}|${m.current_memory ?? 0}|${m.conversation_title ?? ""}|${m.message_count ?? 0}|${m.is_killed ? 1 : 0}|${m.headline ?? ""}|${m.last_message_preview ?? ""}`;
const byHeartbeatDesc = (a: any, b: any) => (b.last_heartbeat ?? 0) - (a.last_heartbeat ?? 0);

/** Reader: live managed sessions, most recently seen first. */
export function useManagedSessions(): { sessions: any[]; ready: boolean } {
  const { ready } = useSyncManagedSessions();
  const now = useCoarseNow(60_000);
  const where = useMemo(() => (m: any) => (m.last_heartbeat ?? 0) > now - HEARTBEAT_WINDOW_MS, [now]);
  const sessions = useCollectionRows<any>("managedSessions", { where, sig, sort: byHeartbeatDesc });
  return { sessions, ready };
}

/** Feeder + reader: aggregate CPU/memory over the last 2h. */
export function useAggregateMetrics(enabled = true): { metrics: any[] | null; ready: boolean } {
  const { ready } = useSyncCollection("sessionMetricsAggregate", api.managedSessions.getAggregateMetrics, enabled ? {} : "skip");
  const metrics = useInboxStore((s) => s.sessionMetricsAggregate);
  return { metrics, ready };
}
