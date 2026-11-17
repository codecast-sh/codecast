// The wake stage of the cloud host a conversation runs on (lib/hostWake), for
// the surfaces that show it: the pending message and the session header.
// Subscribes to a short signature of the fields the stage reads, so a host
// beating every 30s re-renders nothing while its wake has not changed.
import { useMemo } from "react";
import { RUN_LIMIT_WARN_MINUTES, deviceDisplayName, runMinutesLeft } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";
import { useDaemonHealth, useObserverSettling } from "./useDaemonHealth";
import { hostWakeStage, type HostWakeDevice, type HostWakeStage } from "../lib/hostWake";

/** A manager whose minute-floored beat is this recent is online (DEVICE_ONLINE_MS plus the floor). */
const MANAGER_ONLINE_MS = 3 * 60_000;

type RosterRow = HostWakeDevice & { device_id: string; label?: string; host_readiness?: { run_ends_at?: number } };

export type HostWake = HostWakeStage & { deviceId: string; host: string; now: number };

export function useHostWake(deviceId: string | null | undefined): HostWake | null {
  const sig = useInboxStore((s) => {
    // Only a roster this page load has heard live: a cached one can say a
    // host that woke an hour ago is still asleep.
    if (!deviceId || !s.machineRosterLive) return "";
    const roster = s.machineRoster as RosterRow[];
    const d = roster.find((r) => r.device_id === deviceId);
    if (!d || !d.is_remote) return "";
    const mgr = d.cloud_host ? roster.find((r) => r.device_id === d.cloud_host!.managed_by) : undefined;
    return JSON.stringify([
      d.label, d.platform, d.last_seen, d.wake_requested_at, d.cloud_wake,
      d.cloud_host && { state: d.cloud_host.state, managed_by: d.cloud_host.managed_by, at: d.cloud_host.at, last_action: d.cloud_host.last_action },
      mgr && [mgr.label, mgr.platform, mgr.is_remote, mgr.last_seen],
    ]);
  });
  // No grace on the health: a wake in progress is on record, not inferred,
  // and shows at once. Only "asleep", read from silence alone, waits out the
  // grace after this tab slept, when the roster it holds may be stale.
  const health = useDaemonHealth(sig ? deviceId : null, { grace: false });
  const settling = useObserverSettling();
  // Seconds matter while a machine boots; an idle asleep host needs no clock.
  const parsed = useMemo(() => (sig ? JSON.parse(sig) : null), [sig]);
  const waking = !!parsed && (!!parsed[3] || parsed[5]?.last_action?.status === "running" || health.kind === "restarting");
  const now = useCoarseNow(waking ? 5_000 : 60_000);
  return useMemo(() => {
    if (!parsed || !deviceId) return null;
    const [label, platform, last_seen, wake_requested_at, cloud_wake, cloud_host, mgr] = parsed;
    const manager = mgr
      ? { online: now - (mgr[3] ?? 0) < MANAGER_ONLINE_MS, name: deviceDisplayName({ label: mgr[0] ?? "", platform: mgr[1] ?? "", is_remote: !!mgr[2] }) }
      : null;
    const stage = hostWakeStage({ is_remote: true, platform, last_seen, wake_requested_at, cloud_wake, cloud_host }, health, { now, manager });
    if (!stage || (stage.stage === "asleep" && settling)) return null;
    return { ...stage, deviceId, host: deviceDisplayName({ label: label ?? "", platform: platform ?? "", is_remote: true }), now };
  }, [parsed, deviceId, health, now, settling]);
}

export function useHostRunLimit(deviceId: string | null | undefined): number | null {
  const endsAt = useInboxStore((s) => {
    if (!deviceId || !s.machineRosterLive) return 0;
    const d = (s.machineRoster as RosterRow[]).find((r) => r.device_id === deviceId);
    return d?.is_remote ? d.host_readiness?.run_ends_at ?? 0 : 0;
  });
  const now = useCoarseNow(endsAt ? 30_000 : 600_000);
  if (!endsAt || endsAt <= now) return null;
  const left = runMinutesLeft(endsAt, now);
  return left < RUN_LIMIT_WARN_MINUTES ? left : null;
}
