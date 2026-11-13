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
import { listedMachines } from "../lib/machinePicker";
import { formatHostLoad, type HostLoad } from "../lib/hostLoad";

export type MachineChipsProps = {
  machines: SessionMachine[];
  selectedDeviceId: string | null;
  open: boolean;
  onOpen: () => void;
  onPick: (d: SessionMachine) => void;
  /** Opens the place where your own machines are shared (Settings → Devices). */
  onShare?: () => void;
  /** Each cloud host's current load, by device id: free memory beside its name, yellow when tight. */
  loads?: ReadonlyMap<string, HostLoad>;
  /** Team machines you are not on yet, by name; a chip opens where you join one. */
  joinable?: ReadonlyArray<{ id: string; name: string }>;
  onJoin?: (id: string) => void;
  /** Why the session's team turns cloud hosting off: cloud host chips are locked. */
  cloudRefusal?: string | null;
};

/** A machine someone on your team opened to you, or an agent box. */
const isTeamMachine = (d: SessionMachine) => d.bot_name !== undefined;

function chipLabel(d: SessionMachine, roster: SessionMachine[], load?: HostLoad) {
  const note = machineChipNote(d, roster);
  return (
    <>
      {deviceDisplayName(d)}
      {d.bot_name !== undefined && ` · ${d.runner_name || d.bot_name || "agent box"}`}
      {note && <span className={note === "gone" ? "text-sol-red/80" : "opacity-70"}>{` · ${note}`}</span>}
      {load && <span className={load.tight || load.busy ? "text-sol-yellow" : "opacity-70"} title={formatHostLoad(load)}>{load.busy ? ` · CPU ${load.cpuPct}%` : ` · ${load.freeGb < 10 ? load.freeGb.toFixed(1) : Math.round(load.freeGb)} GB free`}</span>}
    </>
  );
}

export function MachineChips({ machines: roster, selectedDeviceId, open, onOpen, onPick, onShare, loads, joinable = [], onJoin, cloudRefusal }: MachineChipsProps) {
  // Notes and titles judge each chip against the whole roster (a host is
  // "gone" relative to its siblings); only the row leaves dead machines out.
  const machines = listedMachines(roster, selectedDeviceId);
  const routedMachine = machines.find((d) => d.device_id === selectedDeviceId) ?? machines[0];
  const joins = onJoin ? joinable : [];
  if ((machines.length <= 1 && joins.length === 0) || !routedMachine) return null;
  if (open) {
    const chip = (d: SessionMachine) => {
      const selected = d.device_id === selectedDeviceId;
      const locked = !selected && d.is_remote && !!cloudRefusal;
      return (
        <button
          key={d.device_id}
          onClick={() => onPick(d)}
          disabled={locked}
          title={locked ? cloudRefusal! : machineChipTitle(d, roster)}
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border transition-all ${
            selected
              ? `${deviceAccentClasses(d)} font-medium !border-current`
              : `border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70 disabled:cursor-not-allowed disabled:line-through disabled:hover:text-sol-text-dim ${d.online && !locked ? "" : "opacity-50"}`
          }`}
        >
          <DeviceIcon d={d} className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[16rem]">{chipLabel(d, roster, d.is_remote ? loads?.get(d.device_id) : undefined)}</span>
          <DeviceDot online={d.online} />
        </button>
      );
    };
    const own = machines.filter((d) => !isTeamMachine(d));
    const team = machines.filter(isTeamMachine);
    const joinChips = joins.map((j) => (
      <button
        key={`join:${j.id}`}
        type="button"
        onClick={() => onJoin?.(j.id)}
        title={`Join ${j.name}: a user of your own on your team's machine`}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-sol-cyan/50 px-2 py-0.5 text-[11px] text-sol-cyan/90 hover:border-sol-cyan hover:text-sol-cyan"
        data-machine-join={j.name}
      >
        + {j.name}
      </button>
    ));
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
        {(team.length > 0 || joinChips.length > 0) && (
          <div className="flex basis-full flex-wrap items-center justify-end gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] text-sol-cyan/80" title="Machines your team runs sessions on">
              <Users className="w-3 h-3" />
              team
            </span>
            {team.map(chip)}
            {joinChips}
            {shareLink}
          </div>
        )}
        {team.length === 0 && joinChips.length === 0 && shareLink}
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
      <span className="truncate max-w-[14rem]">{chipLabel(routedMachine, roster)}</span>
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
