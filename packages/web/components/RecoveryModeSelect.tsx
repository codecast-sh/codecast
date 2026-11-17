"use client";

// How codecast recovers a session that stopped on its own (a usage limit, an
// API error, a crash) on every machine the person runs: one mutually exclusive
// choice, rendered identically in the header panel, the Claude Accounts
// settings page and the park card's picker. A radio group rather than two switches
// because the modes exclude each other: "ask before switching" and "switch
// automatically" cannot both be on, and two independent toggles let them be.
//
// It also states what the machine LAST did and why (describeDecision), so an
// account change is explained where the setting that caused it lives.

import { useState } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { describeDecision, formatAgo, type RecoveryDecision } from "@codecast/shared/contracts";
import type { RecoveryMode } from "@codecast/convex/convex/ccAccountsShared";
import { RECOVERY_MODE_COPY, type RecoveryModeControl } from "../hooks/useAccountRecoveryToggles";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

// From least to most done on the person's behalf.
const ORDER: RecoveryMode[] = ["off", "resume", "ask", "auto"];

export function RecoveryModeSelect({
  control,
  compact = false,
}: {
  control: RecoveryModeControl;
  compact?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="When a session stops on its own" className={compact ? "space-y-0.5" : "space-y-1"}>
      {ORDER.map((mode) => {
        const copy = RECOVERY_MODE_COPY[mode];
        const selected = control.mode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={control.pending}
            onClick={() => void control.set(mode)}
            className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
              selected ? "bg-sol-cyan/10" : "hover:bg-sol-bg-alt"
            }`}
          >
            <span
              aria-hidden
              className={`mt-[3px] h-3 w-3 shrink-0 rounded-full border ${
                selected ? "border-sol-cyan bg-sol-cyan" : "border-sol-border"
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className={`block text-xs font-medium ${selected ? "text-sol-text" : "text-sol-text-muted"}`}>
                {copy.label}
              </span>
              {!compact && (
                <span className="mt-0.5 block text-meta leading-relaxed text-sol-text-dim">{copy.detail}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The mode as a small button that opens the selector, for surfaces where a
 * stopped session is shown (the park card). Picking a mode closes it. */
export function RecoveryModePicker({ control }: { control: RecoveryModeControl }) {
  const [open, setOpen] = useState(false);
  const on = control.mode !== "off";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-meta font-semibold ${
            on ? "border-sol-cyan/40 text-sol-cyan hover:bg-sol-cyan/10" : "border-sol-border text-sol-text-muted hover:bg-sol-bg-alt"
          }`}
        >
          <Zap className="h-3 w-3" />
          {RECOVERY_MODE_COPY[control.mode].short}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-1.5">
        <RecoveryModeSelect
          control={{ ...control, set: async (mode) => { setOpen(false); await control.set(mode); } }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** What the machine last did about a limit, and why. Renders nothing until a
 * decision has been recorded. A pending proposal reads as the ask it is. */
export function RecoveryDecisionNote({
  decision,
  now,
  className,
}: {
  decision?: RecoveryDecision | null;
  now: number;
  className?: string;
}) {
  const text = describeDecision(decision);
  if (!text || !decision) return null;
  const proposing = decision.kind === "propose";
  return (
    <div
      className={`text-meta leading-relaxed ${proposing ? "text-sol-yellow" : "text-sol-text-dim"} ${className ?? ""}`}
    >
      {text} <span className="text-sol-text-dim">{formatAgo(now - decision.at)}</span>
    </div>
  );
}
