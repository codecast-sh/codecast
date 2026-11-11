// Where a cloud host stands between "asleep" and "taking messages again", read
// from the facts three writers leave on its device row:
//
// - the server stamps `wake_requested_at` when work is queued for a host that
//   is not beating (cloud.requestRemoteWake); the host's next beat clears it;
// - when the server itself starts the host (an allowlisted one, cloudWake.ts),
//   `cloud_wake` says how far that start has got;
// - otherwise the laptop that manages the host starts it, and its report
//   (`cloud_host`) carries the wake as `last_action` and the AWS state.
//
// The daemon's own beat then says the rest: a boot beat is "connecting" (it
// recovers its sessions before it takes messages), a normal beat is awake.
// Pure, so every surface that shows a wake tells the same story.

import { WAKE_PHASES, deviceWakesOnUse, isWakePhase, type CloudHostReport, type WakePhase } from "@codecast/shared/contracts";
import type { DaemonHealth } from "../hooks/useDaemonHealth";

export type HostWakeStage =
  /** Not beating and nothing waiting for it: the next message wakes it. */
  | { stage: "asleep" }
  /** Work is waiting and the wake was asked for; nobody has started the machine yet. */
  | { stage: "requested"; since: number }
  /** The machine is booting. */
  | { stage: "starting"; since: number; attempt?: number; phase?: WakePhase }
  /** The machine is up; its daemon is coming back and recovering sessions. */
  | { stage: "connecting"; since: number; phase?: WakePhase }
  /** The start failed. `retry` is whether a Wake from here can go anywhere. */
  | { stage: "failed"; since: number; error: string; retry: boolean }
  /** Work is waiting but the laptop that starts this host is offline, and nothing else can. */
  | { stage: "no_waker"; since: number; waker: string };

export type HostWakeDevice = {
  is_remote?: boolean;
  platform?: string;
  last_seen?: number | null;
  wake_requested_at?: number;
  cloud_wake?: { request_at: number; status: "pending" | "starting" | "awake" | "failed"; attempt: number; last_error?: string };
  cloud_host?: Pick<CloudHostReport, "state" | "managed_by" | "at" | "last_action">;
};

/** The order a wake moves through; a step's index says which steps are behind it. */
export const WAKE_STEPS = ["requested", "starting", "connecting"] as const;

/** A wake older than this with no outcome is not still running: its runner went away. */
const ACTION_STALE_MS = 10 * 60_000;
/** A Wake pressed in Settings (no message waiting) still shows while it is this fresh. */
const RECENT_ACTION_MS = 10 * 60_000;
/** The roster floors last_seen to the minute (presenceState.bucketTs). */
const LAST_SEEN_BUCKET_MS = 60_000;

const beating = (h: DaemonHealth) => h.kind !== "offline" && h.kind !== "quiet" && h.kind !== "unknown";

export function hostWakeStage(
  d: HostWakeDevice | null | undefined,
  health: DaemonHealth,
  ctx: { now: number; manager?: { online: boolean; name: string } | null },
): HostWakeStage | null {
  if (!d || !deviceWakesOnUse({ is_remote: d.is_remote, platform: d.platform ?? "" })) return null;
  const { now } = ctx;
  const report = d.cloud_host;
  const last = report?.last_action?.action === "wake" ? report.last_action : undefined;

  if (beating(health)) {
    // A Linux host's daemon beats seconds after SSH answers, while the wake
    // that started it is still finding the daemon and copying logins: until
    // that wake ends, it is the story, timed from its start. Up and beating is
    // past "Starting machine" whatever the last phase report said.
    if (last?.status === "running" && now - last.at < ACTION_STALE_MS) {
      const r = running(last.detail, last.at);
      return r.stage === "starting" ? { stage: "connecting", since: last.at } : r;
    }
    // The boot beat after a wake: up, recovering its sessions before it takes
    // messages. A restart with no wake behind it (an update) is the daemon's
    // own story, told by its health chip.
    const wokeAt = last && now - last.at < RECENT_ACTION_MS ? last.at
      : d.cloud_wake && now - d.cloud_wake.request_at < RECENT_ACTION_MS ? d.cloud_wake.request_at : undefined;
    return health.kind === "restarting" && wokeAt !== undefined ? { stage: "connecting", since: wokeAt } : null;
  }

  // The stamp outlives nothing: the host's first beat clears it. Compared on
  // the roster's minute grid, a stamp inside the minute of the last beat may
  // already be answered, and is read as no stamp rather than a phantom wake.
  const lastSeen = d.last_seen ?? 0;
  const requestAt = d.wake_requested_at && d.wake_requested_at >= lastSeen + LAST_SEEN_BUCKET_MS ? d.wake_requested_at : undefined;

  if (requestAt) {
    const server = d.cloud_wake && d.cloud_wake.request_at === requestAt ? d.cloud_wake : undefined;
    if (server) {
      if (server.status === "failed") return { stage: "failed", since: requestAt, error: server.last_error ?? "the machine did not start", retry: false };
      if (server.status === "starting") return { stage: "starting", since: requestAt, attempt: server.attempt };
      if (server.status === "awake") return { stage: "connecting", since: requestAt };
      return { stage: "requested", since: requestAt };
    }
    // The laptop's wake, judged only by what it reported after the stamp.
    const lastAfter = last && last.at >= requestAt - LAST_SEEN_BUCKET_MS ? last : undefined;
    if (lastAfter?.status === "failed") return { stage: "failed", since: requestAt, error: lastAfter.detail ?? "the machine did not start", retry: !!ctx.manager?.online };
    if (lastAfter?.status === "ok") return { stage: "connecting", since: requestAt };
    if (lastAfter?.status === "running" && now - lastAfter.at < ACTION_STALE_MS) return running(lastAfter.detail, requestAt);
    const fresh = report && report.at >= requestAt ? report.state : undefined;
    if (fresh === "pending") return { stage: "starting", since: requestAt };
    if (fresh === "running") return { stage: "connecting", since: requestAt };
    if (report && ctx.manager && !ctx.manager.online) return { stage: "no_waker", since: requestAt, waker: ctx.manager.name };
    return { stage: "requested", since: requestAt };
  }

  // Nothing waiting. A Wake pressed in Settings still shows its progress.
  if (last && now - last.at < RECENT_ACTION_MS) {
    if (last.status === "running") return running(last.detail, last.at);
    if (last.status === "failed") return { stage: "failed", since: last.at, error: last.detail ?? "the machine did not start", retry: !!ctx.manager?.online };
  }
  // A host that stopped answering is asleep once its laptop says so, or once
  // it has been gone long enough to be called offline; a few quiet minutes on
  // a host reported running is a daemon problem, and the health chip says it.
  if (report?.state === "stopped" || report?.state === "stopping" || health.kind === "offline") return { stage: "asleep" };
  return null;
}

/** A running wake: the step its reported phase belongs to, and the phase itself. */
function running(detail: string | undefined, since: number): HostWakeStage {
  if (!isWakePhase(detail)) return { stage: "starting", since };
  return { stage: WAKE_PHASES[detail].step, since, phase: detail };
}

/** "45s", "3m", "1h 5m": how long a wake has run, for a glance. */
export function wakeElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
