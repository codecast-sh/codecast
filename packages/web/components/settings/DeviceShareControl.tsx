"use client";

import { Lock } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { teamMachineOfDevice } from "../../lib/teamMachines";
import { listTeamNames, sharedTeamsOf, useMyTeams, type ShareTeam } from "../../hooks/useDeviceSharing";
import { deviceDisplayName, type Device } from "../DeviceBadge";
import { TeamSharePills } from "./TeamSharePills";

/**
 * Who may start sessions on this machine: one pill per team you are on
 * (TeamSharePills). Opening asks once, because it lets teammates run agents
 * under your account; closing is immediate. Renders nothing for someone on no team.
 */
export function DeviceShareControl({ d, teamId }: { d: Device; teamId?: string }) {
  const allTeams = useMyTeams();
  const teams = teamId ? allTeams.filter((t) => String(t._id) === teamId) : allTeams;
  const setDeviceShares = useInboxStore((s) => s.setDeviceShares);
  // A device on a team machine already belongs to its team: teammates join the
  // machine as themselves instead of borrowing this login.
  const onMachine = useInboxStore((s) => teamMachineOfDevice(s.teamMachines, d.device_id, s.currentUser?._id));
  if (onMachine) {
    return <span className="text-[11px] text-sol-text-muted" data-device-team-machine>{onMachine.team_name} team machine</span>;
  }
  if (teams.length === 0) return null;

  const shared = new Set(d.shared_team_ids ?? []);
  const openTo = sharedTeamsOf(d, teams);
  const name = deviceDisplayName(d);

  const write = (next: Set<string>) => setDeviceShares(d.device_id, [...next]);
  const open = (t: ShareTeam) => {
    write(new Set([...shared, String(t._id)]));
    toast.success(`${t.name} can start sessions on ${name}`);
  };
  const close = (t: ShareTeam) => {
    const next = new Set(shared);
    next.delete(String(t._id));
    write(next);
    toast(`${name} is no longer shared with ${t.name}`);
  };

  const pills = (
    <TeamSharePills
      teams={teams}
      shared={shared}
      single={!!teamId}
      onOpen={open}
      onClose={close}
      confirm={{
        title: (t) => <>Share {name} with {t.name}?</>,
        description: "Teammates can then pick it as the machine for a new session.",
        points: [
          "Sessions they start here run as you: your agent logins, your git credentials, your files.",
          <>They see this machine&apos;s name, whether it is online, and the folders it has checked out.</>,
          "Stop sharing whenever you like. New launches and their terminal access stop at once.",
        ],
        confirmLabel: (t) => `Share with ${t.name}`,
      }}
    />
  );

  // One team (Settings → Team): the pill alone, beside the machine's name.
  if (teamId) {
    return (
      <>
        <div className="flex gap-1.5">{pills}</div>
      </>
    );
  }

  return (
    <div
      className={`mt-3 rounded-lg border px-3 py-2.5 transition-colors duration-300 ${
        openTo.length
          ? "border-sol-cyan/30 bg-sol-cyan/[0.06]"
          : "border-sol-border/60 bg-sol-bg-alt/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-sol-text-muted">
          {openTo.length ? null : <Lock className="h-3 w-3" />}
          Team access
        </span>
        <div className="flex flex-wrap gap-1.5">
          {pills}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-sol-text-dim">
        {openTo.length ? (
          <>
            {listTeamNames(openTo)} can start sessions here. They run as you, with this machine&apos;s logins and
            checkouts.
          </>
        ) : (
          <>Private. Only you can run sessions here.</>
        )}
      </p>
    </div>
  );
}
