"use client";

// The blocked banner's account picker: which Claude account the parked
// sessions continue on. The trigger names both ends of the move (what the
// machines run now, and where the continue lands), so it never reads as a
// statement of where you are. The panel shows each machine's current account
// with its meters, then every account you can move to, ranked by room left,
// each with the same meters the header chip draws.

import { useState } from "react";
import { Check, ChevronDown, ArrowRight } from "lucide-react";
import type { CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { AccountUsageBars } from "./AccountUsageMeter";

export type PickerMachine = {
  deviceId: string;
  label: string;
  isLocal: boolean;
  email?: string;
  usage?: CcUsage;
  sessions: number;
};

export type PickerAccount = {
  key: string;
  name: string;
  email?: string;
  usage?: CcUsage;
  missingOn: string[];
};

const shortEmail = (email?: string) => email?.split("@")[0];

export function ContinueAccountPicker({
  machines,
  accounts,
  unavailable,
  value,
  recommendedKey,
  onChange,
  disabled,
  now,
}: {
  machines: PickerMachine[];
  accounts: PickerAccount[];
  unavailable: Array<[email: string, why: string]>;
  value: string;
  recommendedKey?: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const target = accounts.find((a) => a.key === value);
  const currentEmails = [...new Set(machines.map((m) => m.email).filter((e): e is string => !!e))];
  const from = currentEmails.length <= 2 ? currentEmails.map(shortEmail).join(" + ") || "current" : `${currentEmails.length} accounts`;
  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded border border-amber-500/25 bg-sol-bg px-2 py-0.5 text-meta text-sol-text hover:border-amber-500/50 focus:border-amber-500 focus:outline-none disabled:opacity-60"
        >
          <span className={`truncate ${target ? "text-sol-text-dim" : ""}`}>{from}</span>
          {target && (
            <>
              <ArrowRight className="h-3 w-3 shrink-0 text-sol-text-dim" />
              <span className="truncate font-medium">{shortEmail(target.email) ?? target.name}</span>
            </>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 text-sol-text-dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] p-0">
        <div className="max-h-[min(560px,calc(100dvh-8rem))] overflow-y-auto">
          <Section title="Now">
            {machines.map((m) => (
              <div key={m.deviceId} className="px-3 py-1.5">
                <div className="mb-1 flex items-baseline gap-1.5 text-meta">
                  <span className="truncate font-medium text-sol-text">{m.email ?? "unknown account"}</span>
                  <span className="ml-auto shrink-0 text-sol-text-dim">
                    {m.isLocal ? "this machine" : m.label} · {m.sessions} blocked
                  </span>
                </div>
                <AccountUsageBars usage={m.usage} now={now} />
              </div>
            ))}
          </Section>
          <Section title="Continue on">
            <Option selected={!target} onSelect={() => pick("")}>
              <span className="font-medium text-sol-text">
                {currentEmails.length > 1 ? "Each machine stays on its own" : `Stay on ${currentEmails[0] ?? "the current account"}`}
              </span>
            </Option>
            {accounts.map((a) => (
              <Option key={a.key} selected={a.key === value} onSelect={() => pick(a.key)}>
                <div className="mb-1 flex items-baseline gap-1.5">
                  <span className="truncate font-medium text-sol-text">{a.email ?? a.name}</span>
                  {a.key === recommendedKey && <span className="shrink-0 text-sol-yellow">asked</span>}
                  {a.missingOn.length > 0 && (
                    <span className="ml-auto shrink-0 text-sol-text-dim">not on {a.missingOn.join(", ")}</span>
                  )}
                </div>
                <AccountUsageBars usage={a.usage} now={now} />
              </Option>
            ))}
          </Section>
          {unavailable.length > 0 && (
            <Section title="Out of room">
              {unavailable.map(([email, why]) => (
                <div key={email} className="flex items-baseline gap-1.5 px-3 py-0.5 text-meta text-sol-text-dim">
                  <span className="truncate">{email}</span>
                  <span className="ml-auto shrink-0">{why}</span>
                </div>
              ))}
            </Section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-sol-border/50 py-1 last:border-b-0">
      <div className="px-3 pb-0.5 pt-1 text-mark uppercase tracking-wider text-sol-text-dim">{title}</div>
      {children}
    </div>
  );
}

function Option({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-meta hover:bg-sol-bg-alt ${selected ? "bg-sol-bg-alt/60" : ""}`}
    >
      <Check className={`mt-0.5 h-3 w-3 shrink-0 ${selected ? "text-sol-green" : "invisible"}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </button>
  );
}
