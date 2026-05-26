import { useEffect, useState } from "react";
import { useInboxStore } from "../store/inboxStore";

const ONE_MIN_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const OFFLINE_WARN_AFTER_MS = 10 * ONE_MIN_MS;
export const OFFLINE_ALERT_AFTER_MS = ONE_HOUR_MS;
export const OFFLINE_SEVERE_AFTER_MS = ONE_DAY_MS;

// The retry backlog must persist past this before we call it a stall. A few
// failed ops that clear within a couple of minutes are normal transient
// retries, not a sync problem worth alarming the user about.
export const SYNC_STALL_AFTER_MS = 2 * ONE_MIN_MS;

export type OfflineTier = "warn" | "alert" | "severe";

export function offlineTierFor(offlineMs: number): OfflineTier | null {
  if (offlineMs >= OFFLINE_SEVERE_AFTER_MS) return "severe";
  if (offlineMs >= OFFLINE_ALERT_AFTER_MS) return "alert";
  if (offlineMs >= OFFLINE_WARN_AFTER_MS) return "warn";
  return null;
}

export function formatDuration(ms: number): string {
  if (ms >= ONE_DAY_MS) {
    const days = Math.floor(ms / ONE_DAY_MS);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= ONE_HOUR_MS) {
    const hours = Math.floor(ms / ONE_HOUR_MS);
    return `${hours}h`;
  }
  const mins = Math.max(1, Math.floor(ms / ONE_MIN_MS));
  return `${mins} min`;
}

export interface DaemonHealthInput {
  daemon_last_seen?: number | null;
  last_heartbeat?: number | null;
  daemon_pending_sync_count?: number | null;
  daemon_oldest_pending_ms?: number | null;
}

export type DaemonHealth =
  // No daemon has ever checked in for this user — nothing to warn about.
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "offline"; tier: OfflineTier; offlineMs: number }
  | { kind: "sync_stalled"; pending: number; stalledMs: number };

export function computeDaemonHealth(
  user: DaemonHealthInput | null | undefined,
  now: number,
): DaemonHealth {
  const lastSeen = user?.daemon_last_seen || user?.last_heartbeat;
  if (!lastSeen) return { kind: "unknown" };

  const offlineMs = now - lastSeen;
  const tier = offlineTierFor(offlineMs);
  if (tier) return { kind: "offline", tier, offlineMs };

  // Daemon is online (fresh heartbeat) but data may not be flowing. Surface a
  // sustained retry backlog as a distinct "sync stalled" state.
  const pending = user?.daemon_pending_sync_count ?? 0;
  const oldest = user?.daemon_oldest_pending_ms ?? 0;
  if (pending > 0 && oldest >= SYNC_STALL_AFTER_MS) {
    return { kind: "sync_stalled", pending, stalledMs: oldest };
  }

  return { kind: "ok" };
}

// Re-evaluates as wall-clock advances so an offline daemon escalates tiers even
// without a new heartbeat (which, by definition, isn't coming).
export function useDaemonHealth(): DaemonHealth {
  const user = useInboxStore((s) => s.currentUser);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  return computeDaemonHealth(user as DaemonHealthInput | null | undefined, now);
}
