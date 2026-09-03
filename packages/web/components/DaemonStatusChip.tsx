import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { copyToClipboard } from "../lib/utils";
import { useDaemonHealth, isDegradedDaemonHealth } from "../hooks/useDaemonHealth";
import { useSyncDevices } from "../hooks/useSyncDevices";
import { describeDaemonHealth, type DaemonHealthCopy } from "../lib/daemonHealthCopy";
import { useAppOffline } from "../hooks/useAppOffline";
import { useInboxStore } from "../store/inboxStore";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";

// One pill for every daemon-health surface: the ping dot, the short label,
// click-to-copy of the suggested command. The header fleet chip and the
// per-session remote chip render the same shape so the same problem never
// reads differently on two surfaces.
function DaemonHealthPill({ view, prefix }: { view: DaemonHealthCopy; prefix?: string }) {
  const [copied, setCopied] = useState(false);
  const color = `var(${view.colorVar})`;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(view.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ShortcutTooltip label={`${view.detail} Run ${view.command} to inspect. Click to copy.`}>
      <button
        onClick={handleClick}
        className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-full cursor-pointer select-none transition-all duration-300"
        style={{
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
          boxShadow: `0 0 10px color-mix(in srgb, ${color} 12%, transparent)`,
        }}
      >
        <span className="relative flex h-2 w-2">
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
            style={{ background: color, animationDuration: "2s" }}
          />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: color }} />
        </span>
        <span className="text-[11px] font-mono font-bold whitespace-nowrap" style={{ color }}>
          {copied ? "copied!" : prefix ? `${prefix}: ${view.label}` : view.label}
        </span>
      </button>
    </ShortcutTooltip>
  );
}

export function DaemonStatusChip() {
  // Keep the device roster fed: health is per machine (devices.listDevices),
  // and this chip is the one always-mounted reader.
  useSyncDevices();
  const health = useDaemonHealth();
  // When this client itself is disconnected, daemon_last_seen is stale because
  // WE can't sync — the ConnectionBanner owns that story; a "daemon stale"
  // chip would misattribute it.
  const { offline: appOffline } = useAppOffline();
  const [mounted, setMounted] = useState(false);

  useMountEffect(() => {
    setMounted(true);
  });

  if (!mounted || appOffline) return null;

  const view = describeDaemonHealth(health);
  if (!view) return null;

  return <DaemonHealthPill view={view} prefix={health.device} />;
}

// The conversation header's daemon notice, for sessions that run on a REMOTE
// host. The header fleet chip deliberately leaves remote machines out of its
// verdict (they sleep when idle — see worstDaemonHealth), so the one surface
// that speaks for a remote box's daemon is the session living on it, where a
// degraded daemon actually holds up deliveries. Local machines stay the header
// chip's job; this renders nothing for them.
export function SessionDaemonChip({ conversationId }: { conversationId?: string | null }) {
  useSyncDevices();
  // The machine whose daemon carries this conversation's messages.
  const ownerDeviceId = useInboxStore((s) =>
    conversationId ? (s.sessions[conversationId]?.owner_device_id as string | undefined) : undefined,
  );
  // Display name, and only for a remote row — a signature, not the row ref:
  // the roster rewrites last_seen on every heartbeat.
  const remoteName = useInboxStore((s) => {
    if (!ownerDeviceId) return "";
    // The wire rows carry more than the store's MachineCandidate type declares.
    const d: any = (s.machineRoster ?? []).find((r) => r.device_id === ownerDeviceId);
    return d?.is_remote ? deviceDisplayName({ label: d.label ?? "", platform: d.platform ?? "", is_remote: true }) : "";
  });
  const health = useDaemonHealth(ownerDeviceId);
  const { offline: appOffline } = useAppOffline();
  const [mounted, setMounted] = useState(false);

  useMountEffect(() => {
    setMounted(true);
  });

  // remoteName doubles as the "roster knows this device" gate: without the
  // row, useDaemonHealth has fallen back to the fleet verdict, which must not
  // be pinned on this session's machine.
  if (!mounted || appOffline || !remoteName) return null;
  if (!isDegradedDaemonHealth(health)) return null;
  // A remote host sleeps when idle and wakes on demand, so a quiet or stale
  // heartbeat is its normal parked state, not a fault (the fleet verdict
  // excludes remotes for the same reason). Only trouble on a RUNNING remote —
  // a fresh restart, load, or a sync backlog — is worth pinning on the session.
  if (health.kind === "quiet" || health.kind === "offline") return null;

  const view = describeDaemonHealth(health);
  if (!view) return null;

  return <DaemonHealthPill view={view} prefix={remoteName} />;
}
