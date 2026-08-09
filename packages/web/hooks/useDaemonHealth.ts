import { useEffect, useMemo, useRef, useState } from "react";
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

// How often we re-evaluate wall-clock so an offline daemon escalates tiers
// without a new heartbeat (which, by definition, isn't coming).
const TICK_MS = 30 * 1000;

// A tick that lands much later than its period means our own process was
// suspended (machine asleep) or heavily throttled (backgrounded tab). The
// wall-clock that elapsed is time WE weren't listening, not time the daemon
// was silent — so it must not count as staleness.
const SLEEP_JUMP_MS = 2 * TICK_MS;

// After we (re)start observing — fresh mount or waking from a sleep/background
// gap — suppress the offline verdict for one recovery cycle. The currentUser
// subscription that feeds `daemon_last_seen` can stall while we're suspended;
// useRecoveryPoll re-fetches the true value within ~10-15s of resuming, so this
// just covers the visual gap before that lands. A genuinely dead daemon stays
// stale past the grace and the banner returns; a healthy one never flashes.
const OBSERVE_GRACE_MS = 30 * 1000;

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
  daemon_pending_sync_messages?: number | null;
  daemon_pending_sync_conversations?: number | null;
}

export type DaemonHealth =
  // No daemon has ever checked in for this user — nothing to warn about.
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "offline"; tier: OfflineTier; offlineMs: number }
  // `pending` is the logical op count; `messages`/`conversations` are the honest
  // backlog depth so the chip can say "syncing N messages across M convos".
  | { kind: "sync_stalled"; pending: number; messages: number; conversations: number; stalledMs: number };

export function computeDaemonHealth(
  user: DaemonHealthInput | null | undefined,
  now: number,
  opts?: { recentlyWoke?: boolean },
): DaemonHealth {
  const lastSeen = user?.daemon_last_seen || user?.last_heartbeat;
  if (!lastSeen) return { kind: "unknown" };

  // Just started observing: the daemon hasn't had its heartbeat cycle to
  // re-check-in and the value we hold may predate a sleep. Don't alarm on a gap
  // we can't yet attribute to the daemon rather than to our own downtime.
  if (opts?.recentlyWoke) return { kind: "ok" };

  const offlineMs = now - lastSeen;
  const tier = offlineTierFor(offlineMs);
  if (tier) return { kind: "offline", tier, offlineMs };

  // Daemon is online (fresh heartbeat) but data may not be flowing. Surface a
  // sustained retry backlog as a distinct "sync stalled" state.
  const pending = user?.daemon_pending_sync_count ?? 0;
  const oldest = user?.daemon_oldest_pending_ms ?? 0;
  if (pending > 0 && oldest >= SYNC_STALL_AFTER_MS) {
    return {
      kind: "sync_stalled",
      pending,
      messages: user?.daemon_pending_sync_messages ?? 0,
      conversations: user?.daemon_pending_sync_conversations ?? 0,
      stalledMs: oldest,
    };
  }

  return { kind: "ok" };
}

// Re-evaluates as wall-clock advances so an offline daemon escalates tiers even
// without a new heartbeat. Crucially, it ignores wall-clock that elapsed while
// this tab wasn't observing (sleep, backgrounding, or a cold mount): that gap
// reflects our own downtime, not the daemon's silence, and would otherwise fire
// a false "offline" banner on every wake.
export function useDaemonHealth(): DaemonHealth {
  // Depend on the six fields health actually reads, not the whole user doc:
  // currentUser's identity churns on unrelated field changes (device rows
  // flapping autostart_enabled/daemon_pid), and this hook backs three
  // always-mounted components. The joined-string dep keeps them quiet unless a
  // health input really moved.
  const healthSig = useInboxStore((s) => {
    const u = s.currentUser as DaemonHealthInput | null | undefined;
    if (!u) return "";
    return `${u.daemon_last_seen ?? ""}|${u.last_heartbeat ?? ""}|${u.daemon_pending_sync_count ?? ""}|${u.daemon_oldest_pending_ms ?? ""}|${u.daemon_pending_sync_messages ?? ""}|${u.daemon_pending_sync_conversations ?? ""}`;
  });
  const user = useMemo<DaemonHealthInput | null>(() => {
    if (!healthSig) return null;
    const [a, b, c, d, e, f] = healthSig.split("|").map((v) => (v === "" ? null : Number(v)));
    return {
      daemon_last_seen: a, last_heartbeat: b, daemon_pending_sync_count: c,
      daemon_oldest_pending_ms: d, daemon_pending_sync_messages: e,
      daemon_pending_sync_conversations: f,
    };
  }, [healthSig]);
  const [now, setNow] = useState(() => Date.now());
  // Mount counts as a fresh start of observation, so grace applies immediately.
  const wokeAtRef = useRef(Date.now());
  const lastTickRef = useRef(Date.now());

  useEffect(() => {
    const observe = () => {
      const t = Date.now();
      if (t - lastTickRef.current > SLEEP_JUMP_MS) {
        // A gap this large between observations means we were suspended
        // (machine asleep, or a heavily throttled background tab).
        wokeAtRef.current = t;
      }
      lastTickRef.current = t;
      setNow(t);
    };

    const id = setInterval(observe, TICK_MS);

    // A backgrounded tab pauses its subscription without our interval seeing a
    // gap. Only count it as a wake if we were hidden long enough for the value
    // to have plausibly gone stale — a quick tab-switch must not reset grace.
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const t = Date.now();
      if (hiddenAt && t - hiddenAt > SLEEP_JUMP_MS) wokeAtRef.current = t;
      hiddenAt = 0;
      lastTickRef.current = t;
      setNow(t);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const recentlyWoke = now - wokeAtRef.current < OBSERVE_GRACE_MS;
  return computeDaemonHealth(
    user as DaemonHealthInput | null | undefined,
    now,
    { recentlyWoke },
  );
}
