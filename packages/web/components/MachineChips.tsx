"use client";

/**
 * The composer's machine row: a single pill naming where the session will
 * run, unfolding into one chip per machine on click. Presentational —
 * selection lives in ProjectSwitcher (ConversationView), which portals this
 * into NewSessionView's Context line. No store access, so it tests with a
 * plain render.
 */

import { ChevronDown } from "lucide-react";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { DeviceDot, DeviceIcon, deviceAccentClasses } from "./DeviceBadge";
import { machineChipTitle, type SessionMachine } from "../lib/sessionMachines";

export type MachineChipsProps = {
  machines: SessionMachine[];
  selectedDeviceId: string | null;
  open: boolean;
  onOpen: () => void;
  onPick: (d: SessionMachine) => void;
};

function chipLabel(d: SessionMachine) {
  return <>{deviceDisplayName(d)}{d.bot_name !== undefined && ` · ${d.bot_name || "agent box"}`}</>;
}

export function MachineChips({ machines, selectedDeviceId, open, onOpen, onPick }: MachineChipsProps) {
  const routedMachine = machines.find((d) => d.device_id === selectedDeviceId) ?? machines[0];
  if (machines.length <= 1 || !routedMachine) return null;
  if (open) {
    return (
      <div className="flex flex-wrap justify-end gap-1.5 max-w-[26rem]">
        {machines.map((d) => {
          const selected = d.device_id === selectedDeviceId;
          return (
            <button
              key={d.device_id}
              onClick={() => onPick(d)}
              title={machineChipTitle(d)}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border transition-all ${
                selected
                  ? `${deviceAccentClasses(d)} font-medium`
                  : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70"
              } ${d.online ? "" : "opacity-50"}`}
            >
              <DeviceIcon d={d} className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[14rem]">{chipLabel(d)}</span>
              <DeviceDot online={d.online} />
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <button
      onClick={onOpen}
      title={`Runs on ${deviceDisplayName(routedMachine)} — click to choose a machine`}
      className="group/machine inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70 hover:bg-sol-bg-alt/50 transition-all"
    >
      <DeviceIcon d={routedMachine} className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[14rem]">{chipLabel(routedMachine)}</span>
      <DeviceDot online={routedMachine.online} />
      <ChevronDown className="w-3 h-3 shrink-0 opacity-50 group-hover/machine:opacity-100 transition-opacity" />
    </button>
  );
}
