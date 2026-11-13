"use client";

import { useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import type { ShareTeam } from "../../hooks/useDeviceSharing";
import { TeamIcon } from "../TeamIcon";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

export type ShareConfirm = {
  title: (team: ShareTeam) => ReactNode;
  description: ReactNode;
  points: ReactNode[];
  confirmLabel: (team: ShareTeam) => string;
};

/**
 * One pill per team: filled when the thing is shared with that team, dashed
 * when not. Opening asks once (the confirm says what sharing hands over);
 * closing is one press. Shared by a machine's team access (DeviceShareControl)
 * and an account's pool (AccountPoolPill), so the two behave the same.
 * `single` draws one team's pill as Share / Shared beside a row's name.
 */
export function TeamSharePills({
  teams,
  shared,
  onOpen,
  onClose,
  confirm,
  single,
}: {
  teams: ShareTeam[];
  shared: Set<string>;
  onOpen: (team: ShareTeam) => void;
  onClose: (team: ShareTeam) => void;
  confirm: ShareConfirm;
  single?: boolean;
}) {
  const [asking, setAsking] = useState<ShareTeam | null>(null);
  return (
    <>
      {teams.map((t) => {
        const on = shared.has(String(t._id));
        return (
          <button
            key={String(t._id)}
            type="button"
            aria-pressed={on}
            onClick={() => (on ? onClose(t) : setAsking(t))}
            title={on ? `Stop sharing with ${t.name}` : `Share with ${t.name}`}
            className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-95 ${
              on
                ? "border-sol-cyan/60 bg-sol-cyan/15 text-sol-text shadow-[0_0_0_3px_color-mix(in_srgb,var(--sol-cyan)_10%,transparent)]"
                : "border-dashed border-sol-border text-sol-text-muted hover:border-sol-text-muted hover:text-sol-text"
            }`}
          >
            {!single && <TeamIcon icon={t.icon} color={t.icon_color} className="h-3 w-3 shrink-0" />}
            <span className="truncate max-w-[10rem]">{single ? (on ? "Shared" : "Share") : t.name}</span>
            {on ? (
              <Check className="h-3 w-3 shrink-0 text-sol-cyan animate-in zoom-in-50 duration-200" />
            ) : (
              <Plus className="h-3 w-3 shrink-0 opacity-60 transition-transform group-hover:rotate-90" />
            )}
          </button>
        );
      })}
      <Dialog open={asking !== null} onOpenChange={(v) => !v && setAsking(null)}>
        <DialogContent className="bg-sol-bg border-sol-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sol-text">
              {asking && <TeamIcon icon={asking.icon} color={asking.icon_color} className="h-4 w-4" />}
              {asking && confirm.title(asking)}
            </DialogTitle>
            <DialogDescription className="text-sol-text-muted">{confirm.description}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm text-sol-text-secondary">
            {confirm.points.map((p, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-sol-cyan" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>Cancel</Button>
            <Button
              variant="cyan"
              onClick={() => {
                if (asking) onOpen(asking);
                setAsking(null);
              }}
            >
              {asking ? confirm.confirmLabel(asking) : "Share"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
