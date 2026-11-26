import { StatusDot } from "./StatusDot";
import { TopbarButton, TopbarChip } from "./TopbarButton";
import { Check, TriangleAlert, Unplug } from "lucide-react";
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { copyToClipboard } from "../lib/utils";
import { useDaemonHealth, blocksDelivery } from "../hooks/useDaemonHealth";
import { beating } from "../lib/hostWake";
import { useLocalDaemonHealth } from "../hooks/useLocalDaemonHealth";
import { useLocalDeviceId } from "../hooks/useLocalDeviceId";
import { useSyncDevices } from "../hooks/useSyncDevices";
import { describeDaemonHealth, type DaemonHealthCopy } from "../lib/daemonHealthCopy";
import { useAppOffline } from "../hooks/useAppOffline";
import { useInboxStore } from "../store/inboxStore";
import { deviceDisplayName, isRemoteHost } from "@codecast/shared/contracts";
import { HoverCard } from "./ui/HoverCard";
import { StatusPanelHeader, StatusPanelSection } from "./StatusPanel";
import { useHooksReminderHidden } from "../lib/hooksReminder";
import { useHostRunLimit, useHostWake } from "../hooks/useHostWake";
import { useConversationOwnerDevice } from "../hooks/useConversationOwnerDevice";
import { SessionHostWakeChip, SessionRunLimitChip } from "./HostWakeStatus";

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
// replaces the dot, and the word that says what happened floats beside the
// pill for a moment instead of changing its text. A glyph swap alone went
// unseen (ct-102050: three presses for one copy), so the float names the
// command it copied, or, when the clipboard refuses, the command to type.
type CopyResult = "copied" | "failed" | null;

function CopyNotice({ result, command }: { result: CopyResult; command: string }) {
  if (!result) return null;
  return (
    <span
      role="status"
      data-daemon-pill-notice={result}
      className="pointer-events-none absolute right-full top-1/2 z-50 mr-1.5 -translate-y-1/2 whitespace-nowrap rounded-md border border-sol-border bg-sol-bg px-2 py-0.5 text-meta font-medium text-sol-text shadow-md"
    >
      {result === "copied" ? "Copied " : "Couldn't copy · run "}
      <code className="font-mono">{command}</code>
    </span>
  );
}

function DaemonHealthPill({ view, machine, quiet = false }: { view: DaemonHealthCopy; machine?: string; quiet?: boolean }) {
  const [result, setResult] = useState<CopyResult>(null);
  const copied = result === "copied";
  const color = `var(${view.colorVar})`;
  const label = machine ? `${machine}: ${view.label}` : view.label;
  // The pill reads as a status badge; its tooltip (and accessible
  // description) says what a click does.
  const hint = `Click to copy ${view.command}`;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    let next: CopyResult = "copied";
    try {
      await copyToClipboard(view.command);
    } catch {
      next = "failed";
    }
    setResult(next);
    setTimeout(() => setResult(null), next === "copied" ? 2000 : 6000);
  };

  const panel = (
    <div className="min-w-0">
      <StatusPanelHeader kicker="CLI daemon" color={color} headline={view.label} sub={machine} />
      <StatusPanelSection>
        <p className="text-xs leading-snug text-sol-text-dim">{view.detail}</p>
      </StatusPanelSection>
      <StatusPanelSection className="p-0">
        <button type="button" onClick={handleClick} className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-sol-bg-alt/60">
          <code className="rounded border border-sol-border/60 bg-sol-bg-alt px-1.5 py-px font-mono text-meta text-sol-text">{view.command}</code>
          <span className="ml-auto shrink-0 text-meta text-sol-text-dim group-hover:text-sol-text">{copied ? "Copied" : result === "failed" ? "Copy by hand" : "Copy"}</span>
        </button>
      </StatusPanelSection>
    </div>
  );

  if (quiet) {
    return (
      <HoverCard card={panel} side="bottom" align="end" className="w-[280px]" focusable>
        <TopbarButton desktopOnly data-daemon-pill="quiet" aria-label={label} title={hint} onClick={handleClick} style={{ color }} className="relative h-6 w-6 rounded-full hover:text-current [&>svg]:h-3.5 [&>svg]:w-3.5">
          {copied ? <Check /> : <TriangleAlert />}
          <CopyNotice result={result} command={view.command} />
        </TopbarButton>
      </HoverCard>
    );
  }

  return (
    <HoverCard card={panel} side="bottom" align="end" className="w-[280px]" focusable>
      <TopbarChip
        data-daemon-pill="pill"
        aria-label={label}
        title={hint}
        onClick={handleClick}
        tone={color}
        alert
        className="relative hidden md:flex cursor-pointer"
      >
        {copied ? <Check className="h-2.5 w-2.5 shrink-0" /> : <StatusDot color={color} ping />}
        <span className="max-w-[112px] truncate">{view.short}</span>
        <CopyNotice result={result} command={view.command} />
      </TopbarChip>
    </HoverCard>
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
  const ownerDeviceId = useConversationOwnerDevice(conversationId);
  const ownerName = useInboxStore((s) => {
    if (!ownerDeviceId) return "";
    const d: ((typeof s.machineRoster)[number] & { label?: string }) | undefined = s.machineRoster.find((r) => r.device_id === ownerDeviceId);
    if (!d) return "";
    return deviceDisplayName({ label: d.label ?? "", platform: d.platform ?? "", is_remote: isRemoteHost(d) });
  });
  const health = useDaemonHealth(ownerDeviceId);
  const wake = useHostWake(ownerDeviceId);
  const minutesLeft = useHostRunLimit(beating(health) ? ownerDeviceId : null);
  const limitChip = minutesLeft === null ? null : <SessionRunLimitChip minutesLeft={minutesLeft} />;
  const { offline: appOffline } = useAppOffline();
  const [mounted, setMounted] = useState(false);

  useMountEffect(() => {
    setMounted(true);
  });

  if (!mounted || appOffline || !ownerName || ownerDeviceId === localDeviceId) return null;
  // A cloud host asleep or waking is not a broken daemon: its own chip.
  if (wake) return <SessionHostWakeChip wake={wake} />;
  // blocksDelivery, not merely degraded: this chip sits on ONE session and says
  // its messages are running late, so it may only fire on a live symptom. An
  // hour total past the SLO belongs on the header chip and the devices page.
  if (!blocksDelivery(health)) return limitChip;

  const view = describeDaemonHealth(health);
  if (!view) return limitChip;

  return <>{limitChip}<DaemonHealthPill view={view} machine={ownerName} /></>;
}

/**
 * A quiet mark on a session whose machine has codecast's hooks turned off:
 * that session's status and delivery run on slower fallbacks, so the header
 * says why and where to turn them back on. Never a pill and never pulsing: the
 * person may have turned them off on purpose, and they can hide the mark for
 * that machine in Settings > Harness.
 */
export function SessionHooksOffChip({ conversationId }: { conversationId?: string | null }) {
  useSyncDevices();
  const deviceId = useConversationOwnerDevice(conversationId);
  const hooksOff = useInboxStore((s) => {
    if (!deviceId) return false;
    const d = s.machineRoster.find((r) => r.device_id === deviceId) as { settings?: { hooks_enabled?: boolean } } | undefined;
    return d?.settings?.hooks_enabled === false;
  });
  const hidden = useHooksReminderHidden(deviceId);
  if (!hooksOff || hidden) return null;

  const panel = (
    <div className="min-w-0">
      <StatusPanelHeader kicker="Codecast hooks" color="var(--sol-text-muted)" headline="Off on this machine" />
      <StatusPanelSection>
        <p className="text-xs leading-snug text-sol-text-dim">
          Status for this session comes from its transcript and terminal instead, so it can lag, and messages to a
          session you started yourself may not arrive. Click to turn the hooks back on, or to hide this mark.
        </p>
      </StatusPanelSection>
    </div>
  );
  return (
    <HoverCard card={panel} side="bottom" align="end" className="w-[280px]" focusable>
      <TopbarButton
        desktopOnly
        data-hooks-off
        aria-label="Codecast hooks are off on this machine"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          useInboxStore.getState().openSettingsModal("harness");
        }}
        className="text-sol-text-dim hover:text-sol-text-muted"
      >
        <Unplug />
      </TopbarButton>
    </HoverCard>
  );
}
