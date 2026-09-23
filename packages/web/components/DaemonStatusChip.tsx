import { StatusDot } from "./StatusDot";
import { TopbarButton } from "./TopbarButton";
import { Check, TriangleAlert } from "lucide-react";
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
import { StatusPanelHeader, StatusPanelSection } from "./StatusPanel";

// Two shapes for one story. The pill, with its glow and pulsing dot, is for a
// daemon that is making a message late right now: it has to be seen. The
// quiet shape is a warning glyph with the same hover panel, for a record that
// nothing is wrong with at this moment (the hour tier: a machine that froze at
// breakfast is fine by lunch, and a pulsing pill for the rest of the hour
// reads as an outage that is not happening).
//
// The pill carries only the short state ("stalled · 365"), never the machine
// name or the word "daemon": the header has no room for a sentence, and the
// panel says both. Its width holds steady through a copy too: the check
// replaces the dot, not the text.
function DaemonHealthPill({ view, machine, quiet = false }: { view: DaemonHealthCopy; machine?: string; quiet?: boolean }) {
  const [copied, setCopied] = useState(false);
  const color = `var(${view.colorVar})`;
  const label = machine ? `${machine}: ${view.label}` : view.label;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(view.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const panel = (
    <div className="min-w-0">
      <StatusPanelHeader kicker="CLI daemon" color={color} headline={view.label} sub={machine} />
      <StatusPanelSection>
        <p className="text-xs leading-snug text-sol-text-dim">{view.detail}</p>
      </StatusPanelSection>
      <StatusPanelSection className="flex items-center gap-2">
        <code className="rounded border border-sol-border/60 bg-sol-bg-alt px-1.5 py-px font-mono text-[11px] text-sol-text">{view.command}</code>
        <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim">{copied ? "Copied" : "Click to copy"}</span>
      </StatusPanelSection>
    </div>
  );

  if (quiet) {
    return (
      <ShortcutTooltip label={panel} panel align="end">
        <TopbarButton desktopOnly data-daemon-pill="quiet" aria-label={label} onClick={handleClick} style={{ color }} className="hover:text-current">
          {copied ? <Check /> : <TriangleAlert />}
        </TopbarButton>
      </ShortcutTooltip>
    );
  }

  return (
    <ShortcutTooltip label={panel} panel align="end">
      <button
        type="button"
        data-daemon-pill="pill"
        aria-label={label}
        onClick={handleClick}
        className="hidden md:flex h-7 items-center gap-1.5 rounded-full px-2 cursor-pointer select-none transition-all duration-300"
        style={{
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
          boxShadow: `0 0 10px color-mix(in srgb, ${color} 12%, transparent)`,
        }}
      >
        {copied ? <Check className="h-2.5 w-2.5 shrink-0" style={{ color }} /> : <StatusDot color={color} ping />}
        <span className="max-w-[112px] truncate font-mono text-[11px] font-bold" style={{ color }}>
          {view.short}
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
  return <DaemonHealthPill view={view} machine={health.device} quiet={!blocksDelivery(health)} />;
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

  return <DaemonHealthPill view={view} machine={ownerName} />;
}
