"use client";

/**
 * The composer's machine row: a single pill naming where the session will
 * run, unfolding into one chip per machine on click. Presentational —
 * selection lives in ProjectSwitcher (ConversationView), which portals this
 * into NewSessionView's Context line. No store access, so it tests with a
 * plain render.
 */

import { ChevronDown, Users } from "lucide-react";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { DeviceDot, DeviceIcon, deviceAccentClasses } from "./DeviceBadge";
import { machineChipNote, machineChipTitle, type SessionMachine } from "../lib/sessionMachines";

export type MachineChipsProps = {
  machines: SessionMachine[];
  selectedDeviceId: string | null;
  open: boolean;
  onOpen: () => void;
  onPick: (d: SessionMachine) => void;
  /** Opens the place where your own machines are shared (Settings → Devices). */
  onShare?: () => void;
};

/** A machine someone on your team opened to you, or an agent box. */
const isTeamMachine = (d: SessionMachine) => d.bot_name !== undefined;

function chipLabel(d: SessionMachine, machines: SessionMachine[]) {
  const note = machineChipNote(d, machines);
  return (
    <>
      {deviceDisplayName(d)}
      {d.bot_name !== undefined && ` · ${d.runner_name || d.bot_name || "agent box"}`}
      {note && <span className={note === "gone" ? "text-sol-red/80" : "opacity-70"}>{` · ${note}`}</span>}
    </>
  );
}

export function MachineChips({ machines, selectedDeviceId, open, onOpen, onPick, onShare }: MachineChipsProps) {
  const routedMachine = machines.find((d) => d.device_id === selectedDeviceId) ?? machines[0];
  if (machines.length <= 1 || !routedMachine) return null;
  if (open) {
    const chip = (d: SessionMachine) => {
      const selected = d.device_id === selectedDeviceId;
      return (
        <button
          key={d.device_id}
          onClick={() => onPick(d)}
          title={machineChipTitle(d, machines)}
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border transition-all ${
            selected
              ? `${deviceAccentClasses(d)} font-medium !border-current`
              : `border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70 ${d.online ? "" : "opacity-50"}`
          }`}
        >
          <DeviceIcon d={d} className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[14rem]">{chipLabel(d, machines)}</span>
          <DeviceDot online={d.online} />
        </button>
      );
    };
    const own = machines.filter((d) => !isTeamMachine(d));
    const team = machines.filter(isTeamMachine);
    const shareLink = onShare && (
      <button
        type="button"
        onClick={onShare}
        className="px-1 text-[10px] text-sol-text-dim underline decoration-dotted underline-offset-2 hover:text-sol-cyan"
      >
        share yours
      </button>
    );
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-w-[26rem]">
        {own.map(chip)}
        {team.length > 0 && (
          <div className="flex basis-full flex-wrap items-center justify-end gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] text-sol-cyan/80" title="Machines your team shared with you">
              <Users className="w-3 h-3" />
              team
            </span>
            {team.map(chip)}
            {shareLink}
          </div>
        )}
        {team.length === 0 && shareLink}
      </div>
    );
  }
  const teamCount = machines.filter(isTeamMachine).length;
  return (
    <button
      onClick={onOpen}
      title={`Runs on ${deviceDisplayName(routedMachine)}. Click to choose a machine${teamCount ? ` (your team shared ${teamCount} more)` : ""}`}
      className="group/machine inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70 hover:bg-sol-bg-alt/50 transition-all"
    >
      <DeviceIcon d={routedMachine} className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[14rem]">{chipLabel(routedMachine, machines)}</span>
      <DeviceDot online={routedMachine.online} />
      {teamCount > 0 && !isTeamMachine(routedMachine) && (
        <span className="inline-flex items-center gap-0.5 text-sol-cyan/80" title={`${teamCount} team machine${teamCount === 1 ? "" : "s"} you can run on`}>
          <Users className="w-3 h-3" />
          {teamCount}
        </span>
      )}
      <ChevronDown className="w-3 h-3 shrink-0 opacity-50 group-hover/machine:opacity-100 transition-opacity" />
    </button>
  );
}
