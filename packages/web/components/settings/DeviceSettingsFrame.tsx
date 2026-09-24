"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { SettingsPanel, SettingsSection } from "./ui";
import { DevicePanelHeader } from "./DevicePanelHeader";
import type { Device } from "../DeviceBadge";
import type { useDeviceSettingsPanel } from "./useDeviceSettingsPanel";

/**
 * The frame of a device-scoped settings panel: the machine picker, and the two
 * states every such panel has before it has anything to show: no machine has
 * a daemon yet, or the chosen machine's CLI is too old to report what this
 * panel reads. `children` renders the panel for the chosen machine.
 */
export function DeviceSettingsFrame({
  panel,
  title,
  icon,
  reports = (d) => !!d.settings,
  children,
}: {
  panel: ReturnType<typeof useDeviceSettingsPanel>;
  title: string;
  icon: LucideIcon;
  /** Has this machine's daemon reported what the panel needs? */
  reports?: (d: Device) => boolean;
  children: (d: Device) => ReactNode;
}) {
  const { devices, selected, select, localDeviceId } = panel;
  if (!selected) {
    return (
      <SettingsPanel>
        <SettingsSection title={title} icon={icon} padded>
          <p className="text-center text-sm text-sol-text-muted">
            No devices yet. Start the daemon with{" "}
            <code className="font-mono text-sol-text">cast daemon</code> on a machine to manage it here.
          </p>
        </SettingsSection>
      </SettingsPanel>
    );
  }
  return (
    <SettingsPanel>
      <DevicePanelHeader devices={devices} selected={selected} onSelect={select} localDeviceId={localDeviceId} />
      {reports(selected) ? (
        children(selected)
      ) : (
        <SettingsSection title={title} icon={icon} padded>
          <p className="text-sm text-sol-text-muted">
            This machine&apos;s CLI is too old to report this. Update it with{" "}
            <code className="font-mono text-sol-text">cast update</code>, and it will show up here.
          </p>
        </SettingsSection>
      )}
    </SettingsPanel>
  );
}
