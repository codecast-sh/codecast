import { describe, expect, it } from "bun:test";
import {
  computeDaemonHealth,
  OFFLINE_WARN_AFTER_MS,
  OFFLINE_ALERT_AFTER_MS,
  OFFLINE_SEVERE_AFTER_MS,
  SYNC_STALL_AFTER_MS,
  QUIET_AFTER_MS,
  RESTART_CEILING_MS,
  OVERLOADED_FREEZE_MS,
  isDegradedDaemonHealth,
  blocksDelivery,
  sigCell,
  worstDaemonHealth,
  deviceHealthInput,
  ROSTER_CONSIDER_MS,
  OVERLOADED_HOUR_MS,
} from "../useDaemonHealth";
import { describeDaemonHealth, describeDeviceFreeze } from "../../lib/daemonHealthCopy";

const NOW = 1_000_000_000_000;

describe("computeDaemonHealth", () => {
  it("returns unknown when no daemon has ever checked in", () => {
    expect(computeDaemonHealth(null, NOW)).toEqual({ kind: "unknown" });
    expect(computeDaemonHealth({}, NOW)).toEqual({ kind: "unknown" });
  });

  it("is ok for a fresh heartbeat with no backlog", () => {
    const health = computeDaemonHealth({ daemon_last_seen: NOW - 5000 }, NOW);
    expect(health.kind).toBe("ok");
  });

  it("escalates offline tiers by staleness", () => {
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_WARN_AFTER_MS }, NOW)).toMatchObject({ kind: "offline", tier: "warn" });
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_ALERT_AFTER_MS }, NOW)).toMatchObject({ kind: "offline", tier: "alert" });
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_SEVERE_AFTER_MS }, NOW)).toMatchObject({ kind: "offline", tier: "severe" });
  });

  it("falls back to last_heartbeat when daemon_last_seen is missing", () => {
    const health = computeDaemonHealth({ last_heartbeat: NOW - OFFLINE_ALERT_AFTER_MS }, NOW);
    expect(health).toMatchObject({ kind: "offline", tier: "alert" });
  });

  it("flags a sustained sync backlog while the daemon is online", () => {
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - 5000,
        daemon_pending_sync_count: 7,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS + 1000,
        daemon_pending_sync_messages: 56,
        daemon_pending_sync_conversations: 3,
      },
      NOW,
    );
    expect(health).toEqual({
      kind: "sync_stalled",
      pending: 7,
      messages: 56,
      conversations: 3,
      stalledMs: SYNC_STALL_AFTER_MS + 1000,
    });
  });

  it("defaults message/conversation backlog to zero for older daemons", () => {
    // A daemon that predates the honest-backlog fields still reports a stall via
    // pending + oldest; the new counts just fall back to 0.
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - 5000,
        daemon_pending_sync_count: 4,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS + 1,
      },
      NOW,
    );
    expect(health).toEqual({
      kind: "sync_stalled",
      pending: 4,
      messages: 0,
      conversations: 0,
      stalledMs: SYNC_STALL_AFTER_MS + 1,
    });
  });

  it("ignores a transient backlog that hasn't crossed the stall threshold", () => {
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - 5000,
        daemon_pending_sync_count: 3,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS - 1000,
      },
      NOW,
    );
    expect(health.kind).toBe("ok");
  });

  it("prefers offline over sync_stalled when the daemon is also stale", () => {
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - OFFLINE_ALERT_AFTER_MS,
        daemon_pending_sync_count: 42,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS * 10,
      },
      NOW,
    );
    expect(health).toMatchObject({ kind: "offline", tier: "alert" });
  });

  it("suppresses a stale gap during the post-wake grace window", () => {
    // A subscription that froze while we were asleep must not read as offline
    // until the recovery poll has had a chance to refresh the true value.
    const stale = { daemon_last_seen: NOW - OFFLINE_ALERT_AFTER_MS };
    expect(computeDaemonHealth(stale, NOW, { recentlyWoke: true }).kind).toBe("ok");
    expect(computeDaemonHealth(stale, NOW, { recentlyWoke: false })).toMatchObject({
      kind: "offline",
      tier: "alert",
    });
  });

  it("still reports unknown during grace when no daemon ever checked in", () => {
    expect(computeDaemonHealth(null, NOW, { recentlyWoke: true })).toEqual({ kind: "unknown" });
  });
});

// The 2026-08-16 incident: the daemon restarted twice after a lid-close, then
// its event loop froze 5–48s at a time under machine load. Heartbeats never
// went 10 minutes stale, so the header showed nothing while every sent message
// sat unechoed and the bubble blamed the session ("hasn't reached the agent",
// kill & restart). These states are what the header and the bubble now read.
describe("computeDaemonHealth: quiet / restarting / overloaded", () => {
  it("is quiet after several missed beats, before the offline banner", () => {
    const health = computeDaemonHealth({ daemon_last_seen: NOW - QUIET_AFTER_MS }, NOW);
    expect(health).toEqual({ kind: "quiet", quietMs: QUIET_AFTER_MS });
    // A live daemon is never more than ~80s stale (30s beat + 50s server throttle).
    expect(computeDaemonHealth({ daemon_last_seen: NOW - 90_000 }, NOW).kind).toBe("ok");
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_WARN_AFTER_MS }, NOW).kind).toBe("offline");
  });

  // The chip clears on the daemon's next beat, not on a timer. The boot beat
  // stamps last_seen a second or two after daemon_started_at; the server then
  // throttles last_seen to one write per 45 to 50 seconds, so a last_seen well
  // past the boot stamp can only be a later beat.
  it("is restarting while the beat we hold is the boot beat", () => {
    const bootBeat = { daemon_last_seen: NOW - 38_000, daemon_started_at: NOW - 40_000 };
    expect(computeDaemonHealth(bootBeat, NOW)).toEqual({ kind: "restarting", sinceMs: 40_000 });
  });

  it("clears on the next beat after the boot beat", () => {
    const laterBeat = { daemon_last_seen: NOW - 1000, daemon_started_at: NOW - 51_000 };
    expect(computeDaemonHealth(laterBeat, NOW).kind).toBe("ok");
  });

  // The two cases where the beat rule and the 45s timer it replaced disagree.
  // Without these, every restart case in this file also passes on the timer,
  // and the change would have no test behind it.
  it("still says restarting when the boot beat is older than the timer it replaced", () => {
    // 60s after boot with no second beat yet: the old fixed 45s window had
    // already expired while the daemon was still recovering.
    const slowBoot = { daemon_last_seen: NOW - 58_000, daemon_started_at: NOW - 60_000 };
    expect(computeDaemonHealth(slowBoot, NOW)).toEqual({ kind: "restarting", sinceMs: 60_000 });
  });

  it("clears on a second beat that lands inside the timer it replaced", () => {
    // A beat 44s past boot is past the grace, so it is a later beat and the
    // daemon is beating normally; the old timer would still have said
    // restarting for another second.
    const earlySecondBeat = { daemon_last_seen: NOW - 500, daemon_started_at: NOW - 44_000 };
    expect(computeDaemonHealth(earlySecondBeat, NOW).kind).toBe("ok");
  });

  // The device roster floors last_seen to the minute and sends
  // daemon_started_at raw, so subtracting one from the other carries up to a
  // minute of error. A machine that booted 55s into a minute is the worst
  // case: its next beat lands only 5s past its boot stamp once floored.
  it("compares roster stamps on the roster's own grid", () => {
    const bootedAt = Math.floor(NOW / 60_000) * 60_000 - 5_000; // 55s into a minute
    const bucket = (t: number) => Math.floor(t / 60_000) * 60_000;
    const bootBeat = { device_id: "r", last_seen: bucket(bootedAt + 2_000), daemon_started_at: bootedAt };
    expect(computeDaemonHealth(deviceHealthInput(bootBeat), bootedAt + 3_000).kind).toBe("restarting");

    const nextBeat = { ...bootBeat, last_seen: bucket(bootedAt + 60_000) };
    expect(computeDaemonHealth(deviceHealthInput(nextBeat), bootedAt + 61_000).kind).toBe("ok");
  });

  it("stops claiming restarting once the boot beat is older than the ceiling", () => {
    // A daemon that booted and then died: offline and quiet take it from here.
    const stuck = { daemon_last_seen: NOW - RESTART_CEILING_MS + 1000, daemon_started_at: NOW - RESTART_CEILING_MS };
    expect(computeDaemonHealth(stuck, NOW).kind).not.toBe("restarting");
  });

  it("is overloaded when the loop was frozen for a chunk of the last minute", () => {
    const busy = { daemon_last_seen: NOW - 1000, daemon_loop_freeze_ms: 31_000 };
    expect(computeDaemonHealth(busy, NOW)).toEqual({ kind: "overloaded", freezeMs: 31_000 });
    const light = { daemon_last_seen: NOW - 1000, daemon_loop_freeze_ms: OVERLOADED_FREEZE_MS - 1 };
    expect(computeDaemonHealth(light, NOW).kind).toBe("ok");
  });

  it("is overloaded when the trailing hour is over the SLO even if the minute is quiet", () => {
    // A machine that freezes hard every few minutes reads as fine in any one
    // minute, which is exactly the case the hour tier exists for.
    const bursty = {
      daemon_last_seen: NOW - 1000,
      daemon_loop_freeze_ms: 0,
      daemon_loop_freeze_1h_ms: 215_000,
      daemon_loop_freeze_max_ms: 42_000,
      daemon_loop_freeze_top: "walk@recursiveWatcher.ts:138 60%",
    };
    expect(computeDaemonHealth(bursty, NOW)).toEqual({
      kind: "overloaded",
      freezeMs: 0,
      hourMs: 215_000,
      maxMs: 42_000,
      topCause: "walk@recursiveWatcher.ts:138 60%",
    });
    const quietHour = { daemon_last_seen: NOW - 1000, daemon_loop_freeze_1h_ms: OVERLOADED_HOUR_MS - 5_000 };
    expect(computeDaemonHealth(quietHour, NOW).kind).toBe("ok");
  });

  // The hour total is a record of the last sixty minutes, so a machine that
  // froze at breakfast carries it until lunch. Reporting it over a live backlog
  // would hide the count of waiting messages for that whole hour, and because
  // the hour tier alone does not block delivery the backlog would go unnamed on
  // every surface.
  it("a live sync backlog outranks the hour tier, and still blames the daemon", () => {
    const both = {
      daemon_last_seen: NOW - 1000,
      daemon_loop_freeze_ms: 0,
      daemon_loop_freeze_1h_ms: 215_000,
      daemon_pending_sync_count: 40,
      daemon_pending_sync_messages: 40,
      daemon_pending_sync_conversations: 3,
      daemon_oldest_pending_ms: 10 * 60_000,
    };
    const health = computeDaemonHealth(both, NOW);
    expect(health).toEqual({
      kind: "sync_stalled",
      pending: 40,
      messages: 40,
      conversations: 3,
      stalledMs: 10 * 60_000,
    });
    expect(blocksDelivery(health)).toBe(true);
  });

  it("a freeze happening right now outranks the backlog it causes", () => {
    const frozenNow = {
      daemon_last_seen: NOW - 1000,
      daemon_loop_freeze_ms: 31_000,
      daemon_loop_freeze_1h_ms: 215_000,
      daemon_pending_sync_count: 40,
      daemon_oldest_pending_ms: 10 * 60_000,
    };
    expect(computeDaemonHealth(frozenNow, NOW)).toEqual({
      kind: "overloaded",
      freezeMs: 31_000,
      hourMs: 215_000,
    });
  });

  it("names the top cause when the hour tier fired, and keeps the minute wording otherwise", () => {
    const hourTier = describeDaemonHealth({
      kind: "overloaded",
      freezeMs: 0,
      hourMs: 215_000,
      maxMs: 42_000,
      topCause: "walk@recursiveWatcher.ts:138 60%",
    });
    expect(hourTier?.label).toBe("daemon under load");
    expect(hourTier?.detail).toContain("215s in the last hour");
    expect(hourTier?.detail).toContain("worst freeze 42s");
    expect(hourTier?.detail).toContain("Top cause: walk@recursiveWatcher.ts:138 60%");

    const minuteTier = describeDaemonHealth({ kind: "overloaded", freezeMs: 31_000 });
    expect(minuteTier?.detail).toContain("31s of the last minute");

    // Both tiers at once. This is the only verdict the note on a stuck message
    // renders, so it has to keep the live sentence; the hour follows it.
    const bothTiers = describeDaemonHealth({
      kind: "overloaded",
      freezeMs: 31_000,
      hourMs: 215_000,
      maxMs: 42_000,
      topCause: "walk@recursiveWatcher.ts:138 60%",
    });
    expect(bothTiers?.detail).toContain("31s of the last minute");
    expect(bothTiers?.detail).toContain("215s in the last hour");
    expect(bothTiers?.detail).toContain("Top cause: walk@recursiveWatcher.ts:138 60%");
  });

  it("the devices page line names the hour, the worst freeze and the cause", () => {
    expect(
      describeDeviceFreeze({
        online: true,
        loop_freeze_1h_ms: 215_000,
        loop_freeze_max_ms: 42_000,
        loop_freeze_top: "walk@recursiveWatcher.ts:138 60%",
      }),
    ).toEqual({
      text: "frozen 215s/h, worst 42s · walk@recursiveWatcher.ts:138 60%",
      colorVar: "--sol-orange",
    });
    // Under the bar the machine still reports, dimly rather than in alarm.
    expect(describeDeviceFreeze({ online: true, loop_freeze_1h_ms: 30_000 })?.colorVar).toBe("--sol-text-dim");
    // A machine that has reported no freeze shows no line at all.
    expect(describeDeviceFreeze({ online: true })).toBeNull();
    expect(describeDeviceFreeze({ online: true, loop_freeze_1h_ms: 0 })).toBeNull();
    // A machine that stopped beating keeps its last number to itself: it says
    // nothing about how that machine is doing now.
    expect(describeDeviceFreeze({ online: false, loop_freeze_1h_ms: 215_000 })).toBeNull();
  });

  it("silence outranks a fresh boot or load (those need a live beat to mean anything)", () => {
    const h = computeDaemonHealth(
      { daemon_last_seen: NOW - QUIET_AFTER_MS, daemon_started_at: NOW - 10_000, daemon_loop_freeze_ms: 50_000 },
      NOW,
    );
    expect(h.kind).toBe("quiet");
  });

  it("restart outranks load, load outranks a sync backlog", () => {
    const boot = computeDaemonHealth(
      { daemon_last_seen: NOW - 1000, daemon_started_at: NOW - 10_000, daemon_loop_freeze_ms: 50_000 },
      NOW,
    );
    expect(boot.kind).toBe("restarting");
    const load = computeDaemonHealth(
      { daemon_last_seen: NOW - 1000, daemon_loop_freeze_ms: 50_000, daemon_pending_sync_count: 4, daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS },
      NOW,
    );
    expect(load.kind).toBe("overloaded");
  });

  it("every non-ok, non-unknown state counts as degraded for delivery notes", () => {
    expect(isDegradedDaemonHealth({ kind: "ok" })).toBe(false);
    expect(isDegradedDaemonHealth({ kind: "unknown" })).toBe(false);
    expect(isDegradedDaemonHealth({ kind: "quiet", quietMs: 1 })).toBe(true);
    expect(isDegradedDaemonHealth({ kind: "restarting", sinceMs: 1 })).toBe(true);
    expect(isDegradedDaemonHealth({ kind: "overloaded", freezeMs: 1 })).toBe(true);
    expect(isDegradedDaemonHealth({ kind: "offline", tier: "warn", offlineMs: 1 })).toBe(true);
    expect(isDegradedDaemonHealth({ kind: "sync_stalled", pending: 1, messages: 1, conversations: 1, stalledMs: 1 })).toBe(true);
  });

  // The hour tier reports an SLO, not a live symptom. Letting it decide the
  // delivery verdict hid the stuck-message note and its kill & restart button
  // for a whole hour after two minutes of freeze anywhere inside it.
  it("the hour tier alone does not blame the daemon for a late message", () => {
    const hourOnly = { kind: "overloaded" as const, freezeMs: 0, hourMs: 200_000, maxMs: 40_000 };
    expect(isDegradedDaemonHealth(hourOnly)).toBe(true);
    expect(blocksDelivery(hourOnly)).toBe(false);
    // A minute the loop really is frozen in still does.
    expect(blocksDelivery({ kind: "overloaded", freezeMs: OVERLOADED_FREEZE_MS })).toBe(true);
    expect(blocksDelivery({ kind: "quiet", quietMs: 1 })).toBe(true);
    expect(blocksDelivery({ kind: "offline", tier: "warn", offlineMs: 1 })).toBe(true);
    expect(blocksDelivery({ kind: "ok" })).toBe(false);
  });
});

// Health is judged PER MACHINE from the device roster. The user-doc fields are
// last-writer across daemons, so with a laptop and a remote Mac both beating,
// the laptop's silence was masked by the Mac's heartbeats.
// The roster signature is one string: fields joined with "|", rows with
// newlines, decoded back by position. A machine label or a top cause carrying
// either character would shift every field after it, on every device in the
// roster.
describe("sigCell", () => {
  it("strips the separators the roster decode reads by position", () => {
    expect(sigCell("walk@recursiveWatcher.ts:138 60%")).toBe("walk@recursiveWatcher.ts:138 60%");
    expect(sigCell("a|b")).toBe("a b");
    expect(sigCell("two\nlines")).toBe("two lines");
    expect(sigCell("carriage\r\nreturn")).toBe("carriage return");
  });

  it("writes an empty cell for nothing and keeps a real zero", () => {
    expect(sigCell(null)).toBe("");
    expect(sigCell(undefined)).toBe("");
    expect(sigCell(false)).toBe("");
    expect(sigCell(0)).toBe("0");
  });
});

describe("worstDaemonHealth", () => {
  const laptop = { device_id: "a", label: "MacBook", last_seen: NOW - QUIET_AFTER_MS };
  const cloud = { device_id: "b", label: "Cloud Mac", last_seen: NOW - 1000 };

  it("names the machine in trouble instead of averaging it away", () => {
    expect(worstDaemonHealth([laptop, cloud], NOW)).toEqual({ kind: "quiet", quietMs: QUIET_AFTER_MS, device: "MacBook" });
  });

  it("does not name the device when there is only one machine", () => {
    expect(worstDaemonHealth([laptop], NOW)).toEqual({ kind: "quiet", quietMs: QUIET_AFTER_MS });
  });

  it("ignores retired machines and reports null for an empty roster", () => {
    const retired = { device_id: "c", label: "Old Mini", last_seen: NOW - ROSTER_CONSIDER_MS - 1 };
    expect(worstDaemonHealth([retired, cloud], NOW)).toEqual({ kind: "ok" });
    expect(worstDaemonHealth([retired], NOW)).toBeNull();
    expect(worstDaemonHealth([], NOW)).toBeNull();
  });

  // A cloud host sleeps when idle: its hours of silence are its parked state,
  // and the viewer is never sitting at it to run the suggested restart.
  it("leaves remote hosts out of the fleet verdict", () => {
    const asleepLinux = { device_id: "f", label: "Linux - ip-172-31-40-243", last_seen: NOW - 10 * 60 * 60 * 1000, is_remote: true };
    expect(worstDaemonHealth([cloud, asleepLinux], NOW)).toEqual({ kind: "ok" });
    expect(worstDaemonHealth([asleepLinux], NOW)).toBeNull();
  });

  it("ranks unreachable above busy above restarting", () => {
    const busy = { device_id: "d", label: "Busy", last_seen: NOW - 1000, loop_freeze_ms: 40_000 };
    const fresh = { device_id: "e", label: "Fresh", last_seen: NOW - 1000, daemon_started_at: NOW - 5000 };
    expect(worstDaemonHealth([fresh, busy], NOW)?.kind).toBe("overloaded");
    expect(worstDaemonHealth([fresh, busy, laptop], NOW)?.kind).toBe("quiet");
  });

  // The same ordering computeDaemonHealth applies inside one machine, applied
  // across machines. The hour total sticks for a full hour where a live freeze
  // lasts about a minute, so ranking it above a stuck queue would leave the
  // header chip saying "daemon under load" while 40 messages sat unnamed on
  // another machine for the rest of that hour.
  it("puts a machine with a stuck queue ahead of one that only missed the hour SLO", () => {
    const hourOnly = { device_id: "g", label: "MacBook", last_seen: NOW - 1000, loop_freeze_ms: 0, loop_freeze_1h_ms: 215_000 };
    const backlog = {
      device_id: "h",
      label: "Studio",
      last_seen: NOW - 1000,
      pending_sync_count: 40,
      pending_sync_messages: 40,
      pending_sync_conversations: 3,
      oldest_pending_ms: 10 * 60_000,
    };
    expect(worstDaemonHealth([hourOnly, backlog], NOW)).toEqual({
      kind: "sync_stalled",
      pending: 40,
      messages: 40,
      conversations: 3,
      stalledMs: 10 * 60_000,
      device: "Studio",
    });
    // The hour tier still outranks a healthy machine, so the chip does report
    // it when nothing louder is happening.
    expect(worstDaemonHealth([hourOnly, cloud], NOW)?.kind).toBe("overloaded");
    // And a freeze happening right now still outranks the stuck queue.
    const frozenNow = { ...hourOnly, loop_freeze_ms: 40_000 };
    expect(worstDaemonHealth([frozenNow, backlog], NOW)?.kind).toBe("overloaded");
  });
});
