import { useMemo, useSyncExternalStore } from "react";
import { PRESENCE_BUCKET_MS } from "@codecast/convex/convex/presenceState";
import { useInboxStore } from "../store/inboxStore";

const ONE_MIN_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const OFFLINE_WARN_AFTER_MS = 10 * ONE_MIN_MS;
export const OFFLINE_ALERT_AFTER_MS = ONE_HOUR_MS;
export const OFFLINE_SEVERE_AFTER_MS = ONE_DAY_MS;

// A healthy daemon beats every 30s and the server writes daemon_last_seen at
// most every 50s, so a live daemon is never more than ~80s stale. A throttled
// background tab, a skipped write cycle and a brief laptop nap each add a
// minute or two on top without anything being wrong, so the chip waits five
// minutes: by then it has missed many beats and is frozen, restarting, or
// asleep. Still well before the 10-minute "offline" banner — this is the
// window in which a sent message sits unechoed and the user has no idea why.
export const QUIET_AFTER_MS = 5 * ONE_MIN_MS;

// After a (re)start the daemon recovers sessions, re-attaches watchers and
// sweeps transcripts before deliveries and echoes flow at normal speed. Show
// "restarted, catching up" until the daemon says it is past that, rather than
// for a fixed stretch of time.
//
// The evidence is in the beat itself. The boot beat carries daemon_started_at
// and a last_seen stamped a second or two later, and the server then throttles
// last_seen to one write per 45 to 50 seconds (HEARTBEAT_WRITE_THROTTLE_MS in
// convex/users.ts, DEVICE_WRITE_THROTTLE_MS for the device row). So a last_seen
// well past the boot stamp can only come from a LATER beat, which is the proof
// the daemon came back and is beating normally. Anything within this grace of
// the boot stamp is still the boot beat.
//
// The grace sits above the 30s beat interval so a failed first write still
// reads as the boot beat, and below the 45s server throttle so a genuine later
// beat never does.
export const RESTART_BEAT_GRACE_MS = 35 * 1000;

// A daemon that booted and then died would otherwise pin the chip on
// "restarting" forever, so the evidence expires. Offline and quiet outrank
// restarting anyway; this only bounds the gap before they take over.
export const RESTART_CEILING_MS = 2 * ONE_MIN_MS;

// The daemon reports how many ms its event loop was blocked in the trailing
// minute (freezes of 5s or more). A busy machine (a build, a big transcript
// sweep) freezes it for a few seconds routinely; only once half the minute was
// spent frozen are deliveries and transcript sync visibly delayed — call that
// "under load".
export const OVERLOADED_FREEZE_MS = 30 * 1000;

// The same idea over an hour, and the SLO the server alerts on: a machine that
// spent more than two minutes of the last hour frozen is under load even when
// the current minute happens to be quiet. Mirrors LOOP_FREEZE_ALERT_MS in
// convex/daemonLogs.ts.
export const OVERLOADED_HOUR_MS = 120 * 1000;

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
// just covers the visual gap before that lands, plus one full heartbeat cycle
// so a daemon that is itself waking from the same sleep gets to check in. A
// genuinely dead daemon stays stale past the grace and the banner returns; a
// healthy one never flashes.
const OBSERVE_GRACE_MS = 60 * 1000;

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
  daemon_loop_freeze_1h_ms?: number | null;
  daemon_loop_freeze_max_ms?: number | null;
  daemon_loop_freeze_top?: string | null;
  /** Set when the two stamps above were floored to a grid before they reached
   *  us, so the restart rule can compare them on that same grid. The device
   *  roster floors last_seen to the minute (bucketTs in convex/presenceState.ts)
   *  to stop a 30s heartbeat re-pushing every row. */
  stamp_bucket_ms?: number;
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
  // `hourMs`, `maxMs` and `topCause` are present only when the hour tier fired,
  // so the object stays exactly {kind, freezeMs} on the minute tier.
  | { kind: "overloaded"; freezeMs: number; hourMs?: number; maxMs?: number; topCause?: string }
  // `pending` is the logical op count; `messages`/`conversations` are the honest
  // backlog depth so the chip can say "syncing N messages across M convos".
  | { kind: "sync_stalled"; pending: number; messages: number; conversations: number; stalledMs: number };

// Every state in which a pending message may be late because of the DAEMON
// rather than the session. The per-message delivery note reads this to stop
// blaming the session (and offering a kill & restart that goes through the
// very daemon that is struggling).
export const isDegradedDaemonHealth = (h: DaemonHealth): boolean =>
  h.kind === "offline" || h.kind === "quiet" || h.kind === "restarting" || h.kind === "overloaded" || h.kind === "sync_stalled";

// Narrower than degraded: the states in which a message is late RIGHT NOW.
// The hour tier reports an SLO, not a live symptom — a machine that froze for
// two minutes at breakfast is fine by lunch — so it colours the header chip but
// must not hide the note that says a message is stuck, or the kill and restart
// button on it, for the rest of the hour. Everything else that degrades still
// does.
export const blocksDelivery = (h: DaemonHealth): boolean =>
  isDegradedDaemonHealth(h) && !(h.kind === "overloaded" && h.freezeMs < OVERLOADED_FREEZE_MS);

// Severity order for picking the machine worth talking about when several
// daemons report: an unreachable daemon outranks a busy one, which outranks
// one that is merely fresh from a restart or behind on sync.
//
// "overloaded" splits by liveness, the same rule computeDaemonHealth applies
// within one machine. A loop blocked in the last minute is the loudest thing
// short of a silent daemon. An hour total on its own is a record: it lasts a
// full hour where the minute tier lasts about a minute, so ranking it above a
// live sync backlog would hide a real stuck queue on another machine for the
// rest of that hour. It sorts below sync_stalled and above ok.
export function daemonHealthSeverity(h: DaemonHealth): number {
  switch (h.kind) {
    case "offline": return h.tier === "severe" ? 7 : h.tier === "alert" ? 6 : 5;
    case "quiet": return 4;
    case "overloaded": return h.freezeMs >= OVERLOADED_FREEZE_MS ? 3 : 0.5;
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
  loop_freeze_1h_ms?: number | null;
  loop_freeze_max_ms?: number | null;
  loop_freeze_top?: string | null;
  pending_sync_count?: number | null;
  oldest_pending_ms?: number | null;
  pending_sync_messages?: number | null;
  pending_sync_conversations?: number | null;
  // A cloud host (`cast browser --remote`, a remote Mac) rather than a machine
  // the user sits at.
  is_remote?: boolean | null;
}

// The grid the device roster query floors last_seen onto, straight from the
// server module that does the flooring.
const DEVICE_STAMP_BUCKET_MS = PRESENCE_BUCKET_MS;

// Floors a stamp onto the grid the caller declared. No grid means the stamps
// arrived raw and are already comparable.
function stampFloor(bucketMs: number | undefined): (ts: number) => number {
  if (!bucketMs || bucketMs <= 0) return (ts) => ts;
  return (ts) => Math.floor(ts / bucketMs) * bucketMs;
}

export function deviceHealthInput(d: DaemonDeviceRow): DaemonHealthInput {
  return {
    daemon_last_seen: d.last_seen,
    daemon_started_at: d.daemon_started_at,
    // The roster's last_seen arrives floored to the minute while
    // daemon_started_at arrives raw, so their difference carries up to a minute
    // of quantization error. Say so, and the restart rule compares them on the
    // grid instead of subtracting a bucket from a raw stamp.
    stamp_bucket_ms: DEVICE_STAMP_BUCKET_MS,
    daemon_loop_freeze_ms: d.loop_freeze_ms,
    daemon_loop_freeze_1h_ms: d.loop_freeze_1h_ms,
    daemon_loop_freeze_max_ms: d.loop_freeze_max_ms,
    daemon_loop_freeze_top: d.loop_freeze_top,
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

  // Beating, but the beat we hold IS the boot beat: it is still recovering
  // sessions and watchers. The next beat clears this, not a timer.
  const startedAt = user?.daemon_started_at ?? 0;
  const onGrid = stampFloor(user?.stamp_bucket_ms);
  if (
    startedAt > 0 &&
    onGrid(lastSeen) - onGrid(startedAt) < RESTART_BEAT_GRACE_MS &&
    now - startedAt < RESTART_CEILING_MS
  ) {
    // sinceMs and the ceiling stay on the raw stamp: only the comparison of
    // two stamps against each other needs the grid.
    return { kind: "restarting", sinceMs: Math.max(0, now - startedAt) };
  }

  // Beating, but its loop spent a chunk of the last minute frozen, or a chunk
  // of the last hour. The hour tier catches a machine that freezes hard every
  // few minutes, which the minute window shows only while a freeze sits inside
  // it.
  const freezeMs = user?.daemon_loop_freeze_ms ?? 0;
  const hourMs = user?.daemon_loop_freeze_1h_ms ?? 0;
  const hourTier = hourMs >= OVERLOADED_HOUR_MS;
  const maxMs = user?.daemon_loop_freeze_max_ms ?? 0;
  const topCause = user?.daemon_loop_freeze_top || "";
  const hourFields = hourTier
    ? { hourMs, ...(maxMs > 0 ? { maxMs } : {}), ...(topCause ? { topCause } : {}) }
    : {};

  // The minute tier outranks a sync backlog: the loop is blocked right now, so
  // the backlog is a symptom of it.
  if (freezeMs >= OVERLOADED_FREEZE_MS) return { kind: "overloaded", freezeMs, ...hourFields };

  // Daemon is online (fresh heartbeat) but data may not be flowing. Surface a
  // sustained retry backlog as a distinct "sync stalled" state.
  //
  // This sits ABOVE the hour tier on purpose. The hour total is a record of the
  // last sixty minutes, and a machine that froze for two minutes at breakfast
  // carries it until lunch. Reporting it over a live backlog would hide the
  // count of waiting messages for that whole hour, which is the half a person
  // can act on.
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

  // Nothing is late right now, but the hour missed its SLO. This colours the
  // header chip and names the top cause.
  if (hourTier) return { kind: "overloaded", freezeMs, ...hourFields };

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
  // Appended at the END on purpose: the decode below reads by index, so a new
  // field inserted anywhere else silently shifts every other one.
  "loop_freeze_1h_ms", "loop_freeze_max_ms", "loop_freeze_top",
];

// One cell of the roster signature: never empty of meaning, never carrying a
// separator. Exported so the decode's contract can be tested directly.
export const sigCell = (v: unknown): string =>
  v === null || v === undefined || v === false ? "" : String(v).replace(/[|\n\r]+/g, " ");

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
    // The separators are stripped from every field on the way in. The decode
    // below reads by position, so one row carrying a "|" or a newline in a
    // string field (a machine label, a top cause) would misread every OTHER
    // device in the roster, not only its own.
    return rows
      .map((d) => ROSTER_SIG_FIELDS.map((f) => (d[f] === true ? "1" : sigCell(d[f]))).join("|"))
      .join("\n");
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
        loop_freeze_1h_ms: num(10), loop_freeze_max_ms: num(11),
        loop_freeze_top: v[12] || undefined,
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
