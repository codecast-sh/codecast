"use client";

import { useState } from "react";
import { Check, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { deviceDisplayName, type Device } from "../DeviceBadge";
import { TeamIcon } from "../TeamIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type Team = { _id: string; name: string; icon?: string | null; icon_color?: string | null };

/** The teams a machine is open to, as the viewer's team rows (unknown ids,
 *  a team since left, drop out). */
export function sharedTeamsOf(d: Pick<Device, "shared_team_ids">, teams: Team[]): Team[] {
  const ids = new Set(d.shared_team_ids ?? []);
  return teams.filter((t) => ids.has(String(t._id)));
}

function useMyTeams(): Team[] {
  return (useInboxStore((s) => s.teams) ?? []) as Team[];
}

/**
 * Who may start sessions on this machine: one pill per team you are on. A
 * filled pill is open to that team, a dashed one is not. Opening asks once,
 * because it lets teammates run agents under your account; closing is
 * immediate. Renders nothing for someone on no team.
 */
export function DeviceShareControl({ d }: { d: Device }) {
  const teams = useMyTeams();
  const setDeviceShares = useInboxStore((s) => s.setDeviceShares);
  const [asking, setAsking] = useState<Team | null>(null);
  if (teams.length === 0) return null;

  const shared = new Set(d.shared_team_ids ?? []);
  const openTo = sharedTeamsOf(d, teams);
  const name = deviceDisplayName(d);

  const write = (next: Set<string>) => setDeviceShares(d.device_id, [...next]);
  const open = (t: Team) => {
    write(new Set([...shared, String(t._id)]));
    toast.success(`${t.name} can start sessions on ${name}`);
  };
  const close = (t: Team) => {
    const next = new Set(shared);
    next.delete(String(t._id));
    write(next);
    toast(`${name} is no longer shared with ${t.name}`);
  };

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
          {teams.map((t) => {
            const on = shared.has(String(t._id));
            return (
              <button
                key={String(t._id)}
                type="button"
                aria-pressed={on}
                onClick={() => (on ? close(t) : setAsking(t))}
                title={on ? `Stop sharing with ${t.name}` : `Share with ${t.name}`}
                className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95 ${
                  on
                    ? "border-sol-cyan/60 bg-sol-cyan/15 text-sol-text shadow-[0_0_0_3px_color-mix(in_srgb,var(--sol-cyan)_10%,transparent)]"
                    : "border-dashed border-sol-border text-sol-text-muted hover:border-sol-text-muted hover:text-sol-text"
                }`}
              >
                <TeamIcon icon={t.icon} color={t.icon_color} className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[10rem]">{t.name}</span>
                {on ? (
                  <Check className="h-3 w-3 shrink-0 text-sol-cyan animate-in zoom-in-50 duration-200" />
                ) : (
                  <Plus className="h-3 w-3 shrink-0 opacity-60 transition-transform group-hover:rotate-90" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-sol-text-dim">
        {openTo.length ? (
          <>
            {listNames(openTo)} can start sessions here. They run as you, with this machine&apos;s logins and
            checkouts.
          </>
        ) : (
          <>Private. Only you can run sessions here.</>
        )}
      </p>

      <Dialog open={asking !== null} onOpenChange={(v) => !v && setAsking(null)}>
        <DialogContent className="bg-sol-bg border-sol-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sol-text">
              {asking && <TeamIcon icon={asking.icon} color={asking.icon_color} className="h-4 w-4" />}
              Share {name} with {asking?.name}?
            </DialogTitle>
            <DialogDescription className="text-sol-text-muted">
              Teammates can then pick it as the machine for a new session.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm text-sol-text-secondary">
            <Point>Sessions they start here run as you: your agent logins, your git credentials, your files.</Point>
            <Point>They see this machine&apos;s name, whether it is online, and the folders it has checked out.</Point>
            <Point>Stop sharing whenever you like. New launches and their terminal access stop at once.</Point>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>Cancel</Button>
            <Button
              variant="cyan"
              onClick={() => {
                if (asking) open(asking);
                setAsking(null);
              }}
            >
              Share with {asking?.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-sol-cyan" />
      <span>{children}</span>
    </li>
  );
}

function listNames(teams: Team[]): string {
  const names = teams.map((t) => t.name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "shared with Acme" for a one-line row, or null when private. */
export function useSharedWithLabel(d: Device): string | null {
  const openTo = sharedTeamsOf(d, useMyTeams());
  return openTo.length ? `shared with ${listNames(openTo)}` : null;
}
