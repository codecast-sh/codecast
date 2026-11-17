"use client";
// The sidebar's standing reminder of what is still off: a segmented bar and
// "Setup 4/9" that opens the checklist, one row per step with the press that
// finishes it. It stays until every step is done; closing it hides it for a
// week (lib/setupProgress METER_SNOOZE_MS), then it returns.

import { useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useSetupProgress, snoozeSetupMeter } from "../../hooks/useSetupProgress";
import { METER_SNOOZE_MS, nextStep, stepReady, type SetupStep } from "../../lib/setupProgress";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { SetupStepAction } from "./SetupStepAction";
import { cn } from "../../lib/utils";

/** Progress as segments filled from the left: one per step, done first. */
export function SetupBar({ steps, className }: { steps: SetupStep[]; className?: string }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <span className={cn("flex gap-[3px]", className)} aria-hidden>
      {steps.map((s, i) => (
        <i key={s.key} className={cn("h-1 flex-1 rounded-full", i < done ? "bg-sol-cyan" : "bg-sol-text-dim/25")} />
      ))}
    </span>
  );
}

export function SetupMeter() {
  const { steps, done, total, team, ready } = useSetupProgress();
  const snoozedAt = useInboxStore((s) => s.clientState.dismissed?.setup_meter ?? 0);
  const [open, setOpen] = useState(false);
  const next = nextStep(steps);

  // A press that finishes the last step leaves the open list up, every row
  // checked, so the person sees it land; the meter goes once they close it.
  if (!ready || (done >= total && !open)) return null;
  if (!open && snoozedAt > 0 && Date.now() - snoozedAt < METER_SNOOZE_MS) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-setup-meter
          className="group mx-2 mt-2 flex w-[calc(100%-1rem)] flex-col gap-1.5 rounded-md border border-sol-cyan/25 bg-sol-cyan/[0.06] px-2.5 py-2 text-left transition-colors hover:border-sol-cyan/50 hover:bg-sol-cyan/10"
        >
          <span className="flex w-full items-center gap-2.5">
            <span className="text-xs font-medium text-sol-text">Setup</span>
            <SetupBar steps={steps} className="min-w-0 flex-1" />
            <span className="font-mono text-xs tabular-nums text-sol-cyan">{done}/{total}</span>
          </span>
          {next && (
            <span className="flex w-full items-center gap-1.5 text-meta text-sol-text-muted group-hover:text-sol-text">
              <span className="truncate">{next.label}</span>
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-sol-cyan" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={10}
        className="w-[380px] p-0"
        // A review or invite dialog opened from a row lives outside the
        // popover's DOM; pressing inside it must not close the list under it.
        onInteractOutside={(e) => {
          if ((e.target as Element | null)?.closest?.('[role="dialog"],[role="alertdialog"]')) e.preventDefault();
        }}
      >
        <SetupChecklist steps={steps} team={team} done={done} total={total} onHide={() => { snoozeSetupMeter(); setOpen(false); }} />
      </PopoverContent>
    </Popover>
  );
}

export function SetupChecklist({ steps, team, done, total, onHide }: {
  steps: SetupStep[];
  team: any | null;
  done: number;
  total: number;
  onHide?: () => void;
}) {
  const next = nextStep(steps)?.key;
  return (
    <div data-setup-checklist>
      <div className="flex items-baseline justify-between px-4 pt-3.5">
        <span className="text-sm font-semibold text-sol-text">Set up Codecast</span>
        <span className="font-mono text-xs tabular-nums text-sol-text-muted">{done} of {total}</span>
      </div>
      <SetupBar steps={steps} className="mx-4 mt-2.5" />
      <ol className="mt-2 py-1">
        {steps.map((s) => (
          <li
            key={s.key}
            data-setup-step={s.key}
            data-done={s.done || undefined}
            className={cn(
              "flex items-center gap-3 px-4",
              s.done ? "min-h-[28px] py-0.5" : "min-h-[44px] py-1.5",
              s.key === next && "bg-sol-cyan/[0.07]",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border",
                s.done ? "border-sol-cyan/60 bg-sol-cyan/60 text-sol-bg" : s.key === next ? "border-sol-cyan" : "border-sol-text-dim/50",
              )}
            >
              {s.done && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
            </span>
            {s.done ? (
              <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                <span className="truncate text-xs text-sol-text-dim">{s.label}</span>
                <span className="flex-shrink-0 truncate font-mono text-meta text-sol-text-dim/70">{s.state}</span>
              </span>
            ) : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-sol-text">{s.label}</span>
                  <span className="block truncate font-mono text-meta text-sol-text-dim">{s.state}</span>
                </span>
                <span className="flex-shrink-0">
                  {stepReady(steps, s) && <SetupStepAction step={s} team={team} look={s.key === next ? "strip" : "row"} />}
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
      {onHide && (
        <div className="flex justify-end border-t border-sol-border/40 px-2 py-1.5">
          <button type="button" onClick={onHide} className="inline-flex items-center gap-1 rounded px-2 py-1 text-meta text-sol-text-dim hover:text-sol-text">
            <X className="h-3 w-3" /> Hide for a week
          </button>
        </div>
      )}
    </div>
  );
}
