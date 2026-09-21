import { StatusDot } from "./StatusDot";
import { TopbarButton } from "./TopbarButton";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { copyToClipboard } from "../lib/utils";
import { useDaemonHealth, blocksDelivery } from "../hooks/useDaemonHealth";
import { useLocalDaemonHealth } from "../hooks/useLocalDaemonHealth";
import { useLocalDeviceId } from "../hooks/useLocalDeviceId";
import { useSyncDevices } from "../hooks/useSyncDevices";
import { describeDaemonHealth, type DaemonHealthCopy } from "../lib/daemonHealthCopy";
import { useAppOffline } from "../hooks/useAppOffline";
import { useInboxStore } from "../store/inboxStore";
import { deviceDisplayName, isRemoteHost } from "@codecast/shared/contracts";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";

// Two shapes for one story. The pill, with its glow and pulsing dot, is for a
// daemon that is making a message late right now: it has to be seen. The
// quiet shape is a warning glyph with the same tooltip, for a record that
// nothing is wrong with at this moment (the hour tier: a machine that froze at
// breakfast is fine by lunch, and a pulsing pill for the rest of the hour
// reads as an outage that is not happening).
function DaemonHealthPill({ view, prefix, quiet = false }: { view: DaemonHealthCopy; prefix?: string; quiet?: boolean }) {
  const [copied, setCopied] = useState(false);
  const color = `var(${view.colorVar})`;
  const label = prefix ? `${prefix}: ${view.label}` : view.label;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(view.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (quiet) {
    return (
      <ShortcutTooltip label={copied ? `Copied ${view.command}` : `${label}. ${view.detail} Run ${view.command} to inspect. Click to copy.`}>
        <TopbarButton desktopOnly aria-label={label} onClick={handleClick} style={{ color }} className="hover:text-current">
          <TriangleAlert />
        </TopbarButton>
      </ShortcutTooltip>
    );
  }

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
        <StatusDot color={color} ping />
        <span className="text-[11px] font-mono font-bold whitespace-nowrap" style={{ color }}>
          {copied ? "copied!" : label}
        </span>
      </button>
    </ShortcutTooltip>
  );
}

export function DaemonStatusChip() {
  // Keep the device roster fed: health is per machine (devices.listDevices),
  // and this chip is the one always-mounted reader.
  useSyncDevices();
  const health = useLocalDaemonHealth();
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

  // The pill only while a message is late right now; the hour record gets the
  // quiet glyph. Same line blocksDelivery draws for the delivery note.
  return <DaemonHealthPill view={view} prefix={health.device} quiet={!blocksDelivery(health)} />;
}

export function SessionDaemonChip({ conversationId }: { conversationId?: string | null }) {
  useSyncDevices();
  const localDeviceId = useLocalDeviceId(true);
  const ownerDeviceId = useInboxStore((s) =>
    conversationId ? (s.sessions[conversationId]?.owner_device_id as string | undefined) : undefined,
  );
  const ownerName = useInboxStore((s) => {
    if (!ownerDeviceId) return "";
    const d: ((typeof s.machineRoster)[number] & { label?: string }) | undefined = s.machineRoster.find((r) => r.device_id === ownerDeviceId);
    if (!d) return "";
    return deviceDisplayName({ label: d.label ?? "", platform: d.platform ?? "", is_remote: isRemoteHost(d) });
  });
  const health = useDaemonHealth(ownerDeviceId);
  const { offline: appOffline } = useAppOffline();
  const [mounted, setMounted] = useState(false);

  useMountEffect(() => {
    setMounted(true);
  });

  if (!mounted || appOffline || !ownerName || ownerDeviceId === localDeviceId) return null;
  // blocksDelivery, not merely degraded: this chip sits on ONE session and says
  // its messages are running late, so it may only fire on a live symptom. An
  // hour total past the SLO belongs on the header chip and the devices page.
  if (!blocksDelivery(health)) return null;

  const view = describeDaemonHealth(health);
  if (!view) return null;

  return <DaemonHealthPill view={view} prefix={ownerName} />;
}
