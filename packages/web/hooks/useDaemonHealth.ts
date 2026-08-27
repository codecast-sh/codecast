import { useMemo, useSyncExternalStore } from "react";
import { useInboxStore } from "../store/inboxStore";

const ONE_MIN_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const OFFLINE_WARN_AFTER_MS = 10 * ONE_MIN_MS;
export const OFFLINE_ALERT_AFTER_MS = ONE_HOUR_MS;
export const OFFLINE_SEVERE_AFTER_MS = ONE_DAY_MS;

// A healthy daemon beats every 30s and the server writes daemon_last_seen at
// most every 50s, so a live daemon is never more than ~80s stale. Past 3 min it
// has missed several beats: it is frozen, restarting, or asleep. That is worth
// a chip well before the 10-minute "offline" banner — this is the window in
// which a sent message sits unechoed and the user has no idea why.
export const QUIET_AFTER_MS = 3 * ONE_MIN_MS;

// After a (re)start the daemon spends a minute or more recovering sessions,
// re-attaching watchers and sweeping transcripts before deliveries and echoes
// flow at normal speed. Show "restarted, catching up" for this long after the
// reported boot time.
export const RESTART_SETTLE_MS = 2 * ONE_MIN_MS;

// The daemon reports how many ms its event loop was blocked in the trailing
// minute (freezes of 5s or more). Past this share of the minute, deliveries and
// transcript sync are visibly delayed — call it "under load".
export const OVERLOADED_FREEZE_MS = 10 * 1000;

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
  daemon_started_at?: number | null;
  daemon_loop_freeze_ms?: number | null;
}

export type DaemonHealth =
  // No daemon has ever checked in for this user — nothing to warn about.
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "offline"; tier: OfflineTier; offlineMs: number }
  // Several beats missed but not yet "offline": frozen, restarting or asleep.
  | { kind: "quiet"; quietMs: number }
  // Fresh boot: sessions and watchers still being recovered.
  | { kind: "restarting"; sinceMs: number }
  // Alive and beating, but its event loop was blocked for `freezeMs` of the
  // last minute — deliveries and echoes are delayed, not lost.
  | { kind: "overloaded"; freezeMs: number }
  // `pending` is the logical op count; `messages`/`conversations` are the honest
  // backlog depth so the chip can say "syncing N messages across M convos".
  | { kind: "sync_stalled"; pending: number; messages: number; conversations: number; stalledMs: number };

// Every state in which a pending message may be late because of the DAEMON
// rather than the session. The per-message delivery note reads this to stop
// blaming the session (and offering a kill & restart that goes through the
// very daemon that is struggling).
export const isDegradedDaemonHealth = (h: DaemonHealth): boolean =>
  h.kind === "offline" || h.kind === "quiet" || h.kind === "restarting" || h.kind === "overloaded" || h.kind === "sync_stalled";

// Severity order for picking the machine worth talking about when several
// daemons report: an unreachable daemon outranks a busy one, which outranks
// one that is merely fresh from a restart or behind on sync.
export function daemonHealthSeverity(h: DaemonHealth): number {
  switch (h.kind) {
    case "offline": return h.tier === "severe" ? 7 : h.tier === "alert" ? 6 : 5;
    case "quiet": return 4;
    case "overloaded": return 3;
    case "restarting": return 2;
    case "sync_stalled": return 1;
    default: return 0;
  }
}

// One machine's row from the device roster (devices.listDevices), as the
// heartbeat writes it: last_seen plus the per-device health fields.
export interface DaemonDeviceRow {
  device_id: string;
  label?: string;
  last_seen?: number | null;
  daemon_started_at?: number | null;
  loop_freeze_ms?: number | null;
  pending_sync_count?: number | null;
  oldest_pending_ms?: number | null;
  pending_sync_messages?: number | null;
  pending_sync_conversations?: number | null;
  // A cloud host (`cast browser --remote`, a remote Mac) rather than a machine
  // the user sits at.
  is_remote?: boolean | null;
}

export function deviceHealthInput(d: DaemonDeviceRow): DaemonHealthInput {
  return {
    daemon_last_seen: d.last_seen,
    daemon_started_at: d.daemon_started_at,
    daemon_loop_freeze_ms: d.loop_freeze_ms,
    daemon_pending_sync_count: d.pending_sync_count,
    daemon_oldest_pending_ms: d.oldest_pending_ms,
    daemon_pending_sync_messages: d.pending_sync_messages,
    daemon_pending_sync_conversations: d.pending_sync_conversations,
  };
}

// A machine silent for longer than this is retired, not in trouble: it must
// not keep the header chip red forever after a laptop is decommissioned.
export const ROSTER_CONSIDER_MS = ONE_DAY_MS;

// The health worth showing for a fleet: the worst machine among those seen
// recently. `device` names the machine when the roster has more than one, so
// "daemon under load" reads as "MacBook: daemon under load".
//
// Remote hosts stay out of the verdict. A cloud box sleeps when idle and wakes
// on demand, so its daemon going silent for hours is its parked state, not an
// outage — and the user is never sitting at it, so "restart with cast restart"
// is advice they cannot act on from where they are. A session that lives on a
// remote host still reports that host's health through useDaemonHealth(owner
// device id) on its own pending messages, which is where it matters.
export type FleetDaemonHealth = DaemonHealth & { device?: string };

export function worstDaemonHealth(
  rows: DaemonDeviceRow[],
  now: number,
  opts?: { recentlyWoke?: boolean },
): FleetDaemonHealth | null {
  const recent = rows.filter((d) => !d.is_remote && (d.last_seen ?? 0) > now - ROSTER_CONSIDER_MS);
  if (recent.length === 0) return null;
  let worst: FleetDaemonHealth | null = null;
  for (const d of recent) {
    const h = computeDaemonHealth(deviceHealthInput(d), now, opts);
    if (!worst || daemonHealthSeverity(h) > daemonHealthSeverity(worst)) {
      worst = recent.length > 1 && d.label ? { ...h, device: d.label } : h;
    }
  }
  return worst;
}

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
  if (offlineMs >= QUIET_AFTER_MS) return { kind: "quiet", quietMs: offlineMs };

  // Beating, but freshly booted: it is still recovering sessions and watchers.
  const startedAt = user?.daemon_started_at ?? 0;
  if (startedAt > 0 && now - startedAt < RESTART_SETTLE_MS) {
    return { kind: "restarting", sinceMs: Math.max(0, now - startedAt) };
  }

  // Beating, but its loop spent a chunk of the last minute frozen.
  const freezeMs = user?.daemon_loop_freeze_ms ?? 0;
  if (freezeMs >= OVERLOADED_FREEZE_MS) return { kind: "overloaded", freezeMs };

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

// One shared observer clock for every reader of daemon health. It advances
// wall-clock on a tick so an offline daemon escalates tiers without a new
// heartbeat (which, by definition, is not coming), and it remembers when THIS
// tab last stopped observing (machine asleep, tab hidden, cold load): that gap
// is our own downtime, not the daemon's silence, and must not count as
// staleness. Shared, not per hook instance: the header chip, the offline
// banner and every pending message bubble read the same clock, so a bubble
// that mounts mid-session sees the true verdict at once instead of a fresh
// 30s "ok" grace, and the page runs one interval instead of one per reader.
type ObserverClock = { now: number; wokeAt: number };
let clock: ObserverClock = { now: Date.now(), wokeAt: Date.now() };
const clockListeners = new Set<() => void>();
let clockStop: (() => void) | null = null;

function publishClock(next: ObserverClock): void {
  clock = next;
  clockListeners.forEach((l) => l());
}

function startObserverClock(): () => void {
  let lastTick = Date.now();
  const observe = () => {
    const t = Date.now();
    // A gap this large between observations means we were suspended
    // (machine asleep, or a heavily throttled background tab).
    const wokeAt = t - lastTick > SLEEP_JUMP_MS ? t : clock.wokeAt;
    lastTick = t;
    publishClock({ now: t, wokeAt });
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
    const wokeAt = hiddenAt && t - hiddenAt > SLEEP_JUMP_MS ? t : clock.wokeAt;
    hiddenAt = 0;
    lastTick = t;
    publishClock({ now: t, wokeAt });
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function subscribeClock(listener: () => void): () => void {
  // Module load is the cold-load grace start; the first observer only starts
  // the ticking (resetting the clock here would tear React's snapshot).
  if (clockListeners.size === 0) clockStop = startObserverClock();
  clockListeners.add(listener);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      clockStop?.();
      clockStop = null;
    }
  };
}
const getClock = () => clock;
const getServerClock = () => clock;

const ROSTER_SIG_FIELDS: Array<keyof DaemonDeviceRow> = [
  "device_id", "label", "last_seen", "daemon_started_at", "loop_freeze_ms",
  "pending_sync_count", "oldest_pending_ms", "pending_sync_messages", "pending_sync_conversations",
  "is_remote",
];

// Health of the daemon on `deviceId` (a session's owner_device_id), or — with
// no device named — the worst machine in the roster. Falls back to the
// user-doc fields when the roster is empty or does not know the device (a
// daemon that predates device rows).
export function useDaemonHealth(deviceId?: string | null): FleetDaemonHealth {
  // Roster subscription keyed on the health fields only: the roster rows carry
  // project roots, capability settings and model inventories that change for
  // reasons this hook does not care about.
  const rosterSig = useInboxStore((s) => {
    const rows = (s.machineRoster ?? []) as DaemonDeviceRow[];
    return rows.map((d) => ROSTER_SIG_FIELDS.map((f) => (d[f] === true ? "1" : d[f] || "")).join("|")).join("\n");
  });
  const roster = useMemo<DaemonDeviceRow[]>(() => {
    if (!rosterSig) return [];
    return rosterSig.split("\n").map((line) => {
      const v = line.split("|");
      const num = (i: number) => (v[i] === "" ? null : Number(v[i]));
      return {
        device_id: v[0], label: v[1] || undefined, last_seen: num(2), daemon_started_at: num(3),
        loop_freeze_ms: num(4), pending_sync_count: num(5), oldest_pending_ms: num(6),
        pending_sync_messages: num(7), pending_sync_conversations: num(8),
        is_remote: v[9] === "1",
      };
    });
  }, [rosterSig]);
  // Depend on the fields health actually reads, not the whole user doc:
  // currentUser's identity churns on unrelated field changes (device rows
  // flapping autostart_enabled/daemon_pid), and this hook backs several
  // always-mounted components. The joined-string dep keeps them quiet unless a
  // health input really moved.
  const healthSig = useInboxStore((s) => {
    const u = s.currentUser as DaemonHealthInput | null | undefined;
    if (!u) return "";
    return [
      u.daemon_last_seen, u.last_heartbeat, u.daemon_pending_sync_count, u.daemon_oldest_pending_ms,
      u.daemon_pending_sync_messages, u.daemon_pending_sync_conversations,
      u.daemon_started_at, u.daemon_loop_freeze_ms,
    ].map((v) => v ?? "").join("|");
  });
  const user = useMemo<DaemonHealthInput | null>(() => {
    if (!healthSig) return null;
    const [a, b, c, d, e, f, g, h] = healthSig.split("|").map((v) => (v === "" ? null : Number(v)));
    return {
      daemon_last_seen: a, last_heartbeat: b, daemon_pending_sync_count: c,
      daemon_oldest_pending_ms: d, daemon_pending_sync_messages: e,
      daemon_pending_sync_conversations: f, daemon_started_at: g, daemon_loop_freeze_ms: h,
    };
  }, [healthSig]);
  const { now, wokeAt } = useSyncExternalStore(subscribeClock, getClock, getServerClock);
  const recentlyWoke = now - wokeAt < OBSERVE_GRACE_MS;
  return useMemo(() => {
    const opts = { recentlyWoke };
    if (deviceId) {
      const row = roster.find((d) => d.device_id === deviceId);
      if (row) return computeDaemonHealth(deviceHealthInput(row), now, opts);
    }
    return worstDaemonHealth(roster, now, opts) ?? computeDaemonHealth(user, now, opts);
  }, [deviceId, roster, user, now, recentlyWoke]);
}
