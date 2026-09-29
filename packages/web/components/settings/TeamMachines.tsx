"use client";

import { useMemo } from "react";
import { Bot, MonitorSmartphone } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { splitStaleMachines } from "../../lib/staleMachines";
import { DeviceDot, DeviceIcon, deviceDisplayName, useDevices, type Device } from "../DeviceBadge";
import { DeviceShareControl } from "./DeviceShareControl";
import { SettingsSection } from "./ui";

type TeamMachine = Device & { team_id: string; bot_name: string | null; runner_name?: string | null; is_bot?: boolean };

/**
 * Settings → Team: the machines this team can run sessions on, and a one-pill
 * share control for each of yours. The same facts Settings → Devices shows
 * (devices.listAgentBoxes, the roster's shared_team_ids), grouped by team, so
 * the choice is in reach from wherever someone thinks about their team.
 */
export function TeamMachines({ teamId }: { teamId: string }) {
  const { devices } = useDevices();
  const shared = ((useSettingsData("agentBoxes").data ?? []) as TeamMachine[]).filter((m) => String(m.team_id) === teamId);
  const mine = useMemo(() => splitStaleMachines(devices, Date.now()).current, [devices]);
  if (mine.length === 0 && shared.length === 0) return null;
  return (
    <SettingsSection
      title="Machines"
      icon={MonitorSmartphone}
      description="Where this team can run sessions. Share one of yours and teammates can pick it when they start a session; it runs as you."
      actions={
        <button
          type="button"
          onClick={() => useInboxStore.getState().openSettingsModal("devices")}
          className="text-[11px] text-sol-text-muted hover:text-sol-text"
        >
          All devices
        </button>
      }
    >
      {shared.map((m) => (
        <Row key={`${m.team_id}:${m.device_id}`} d={m} note={m.is_bot === false ? `${m.runner_name ?? "A teammate"}'s` : `agent box · ${m.bot_name ?? "bot"}`} bot={m.is_bot !== false} />
      ))}
      {mine.map((d) => (
        <Row key={d.device_id} d={d} note="yours">
          <DeviceShareControl d={d} teamId={teamId} />
        </Row>
      ))}
    </SettingsSection>
  );
}

function Row({ d, note, bot, children }: { d: Device; note: string; bot?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
      <span className="text-sol-text-muted">{bot ? <Bot className="h-4 w-4" /> : <DeviceIcon d={d} className="h-4 w-4" />}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-sol-text">
        {deviceDisplayName(d)} <span className="text-[11px] text-sol-text-dim">{note}</span>
      </span>
      <DeviceDot online={d.online} />
      {children}
    </div>
  );
}
