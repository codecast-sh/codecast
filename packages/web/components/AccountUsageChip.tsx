"use client";

// Header chip: the live usage state of the machine's ACTIVE Claude account —
// account name + a meter of its most-utilized limit window, always visible so
// a session-limit surprise never is one. Opens a popover with every saved
// account's meters, the auto-switch toggle, and the path to Settings.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { KeyRound, Zap } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Switch } from "./ui/switch";
import { useCoarseNow } from "../hooks/useCoarseNow";
import {
  AccountUsageBars,
  formatAgo,
  usageTone,
  worstUsagePercent,
  type CcUsage,
} from "./AccountUsageMeter";

type ProfileRow = {
  name: string;
  email?: string;
  tier?: string;
  subscription?: string;
  usage?: CcUsage;
};

function MiniMeter({ percent }: { percent: number }) {
  const tone = usageTone(percent);
  return (
    <span className="inline-block h-[5px] w-14 overflow-hidden rounded-full bg-sol-bg-inset align-middle">
      <span
        className="block h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(2, percent))}%`, background: tone }}
      />
    </span>
  );
}

export function AccountUsageChip() {
  const data = useQuery(api.accountSwitch.listAccountProfiles, {});
  const setAutoSwitch = useMutation(api.accountSwitch.setAutoSwitchAccounts);
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const [open, setOpen] = useState(false);
  // Local echo while the toggle round-trips (the flag lives on the device row,
  // so the query refresh is the source of truth once it lands).
  const [pendingToggle, setPendingToggle] = useState<boolean | null>(null);

  // The primary (non-remote) machine is the one whose login rotates through
  // profiles; remotes mirror it, so their meters would be duplicates.
  const device = data?.devices.find((d) => !d.is_remote);
  const profiles: ProfileRow[] = device?.profiles ?? [];
  const active = profiles.find((p) => p.email && p.email === device?.active_email);
  if (!device || !active) return null;

  const worst = worstUsagePercent(active.usage);
  const tone = worst != null ? usageTone(worst) : "var(--sol-text-dim)";
  const others = profiles.filter((p) => p !== active);
  const autoOn = pendingToggle ?? device.auto_switch;
  const state = device.auto_switch_state;
  const exhausted = !!state?.exhausted_at;

  const handleToggle = async (enabled: boolean) => {
    setPendingToggle(enabled);
    try {
      await setAutoSwitch({ device_id: device.device_id, enabled });
      toast.success(
        enabled
          ? "Auto-switch on — limit-parked sessions will hop accounts and continue"
          : "Auto-switch off",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Toggle failed");
    } finally {
      setPendingToggle(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="hidden md:flex items-center gap-2 rounded-full px-2 py-0.5 select-none transition-all duration-300 cursor-pointer"
          style={{
            background: `color-mix(in srgb, ${tone} 10%, transparent)`,
            border: `1px solid color-mix(in srgb, ${tone} 25%, transparent)`,
          }}
          title={`Claude account "${active.name}" — worst limit window at ${worst != null ? Math.round(worst) : "?"}%. Click for all accounts.`}
        >
          <KeyRound className="h-3 w-3" style={{ color: tone }} />
          <span className="max-w-[88px] truncate font-mono text-[11px] font-bold" style={{ color: tone }}>
            {active.name}
          </span>
          {worst != null && (
            <>
              <MiniMeter percent={worst} />
              <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: tone }}>
                {Math.round(worst)}%
              </span>
            </>
          )}
          {autoOn && (
            <Zap
              className="h-3 w-3"
              style={{ color: exhausted ? "var(--sol-red)" : "var(--sol-cyan)" }}
              aria-label="Auto-switch enabled"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[320px] p-0">
        <div className="border-b border-sol-border/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sol-text">
            <KeyRound className="h-3.5 w-3.5 text-sol-cyan" />
            Claude account usage
            <span className="ml-auto font-normal text-[10px] text-sol-text-dim">{device.label}</span>
          </div>
        </div>

        <div className="max-h-[340px] space-y-3 overflow-y-auto px-3 py-2.5">
          <div className="rounded-md border border-sol-green/25 bg-sol-green/[0.04] p-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-sol-green" />
              <span className="text-xs font-medium text-sol-text">{active.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-sol-text-dim">{active.email}</span>
              <span className="text-[10px] font-medium text-sol-green">active</span>
            </div>
            <AccountUsageBars usage={active.usage} now={now} />
          </div>

          {others.map((p) => (
            <div key={p.name} className="rounded-md border border-sol-border/50 p-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-sol-border" />
                <span className="text-xs font-medium text-sol-text">{p.name}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-sol-text-dim">{p.email}</span>
              </div>
              <AccountUsageBars usage={p.usage} now={now} />
            </div>
          ))}
        </div>

        <div className="border-t border-sol-border/60 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Zap className={`h-3.5 w-3.5 ${autoOn ? "text-sol-cyan" : "text-sol-text-dim"}`} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-sol-text">Auto-switch on limits</div>
              <div className="text-[10px] leading-snug text-sol-text-dim">
                Hop to the freshest account and continue limit-parked sessions until everything is
                unblocked or every account is spent.
              </div>
            </div>
            <Switch checked={autoOn} onCheckedChange={handleToggle} disabled={pendingToggle !== null} />
          </div>
          {autoOn && exhausted && (
            <div className="mt-1.5 rounded bg-sol-red/10 px-2 py-1 text-[10px] text-sol-red">
              All accounts are at their limits — will retry at the next window reset.
            </div>
          )}
          {autoOn && !exhausted && state?.last_action && state.last_action_at && (
            <div className="mt-1.5 text-[10px] text-sol-text-dim">
              Last action: {state.last_action.replace("switch:", "switched to ")}{" "}
              {formatAgo(now - state.last_action_at)}
            </div>
          )}
          <button
            onClick={() => {
              setOpen(false);
              router.push("/settings/claude-accounts");
            }}
            className="mt-2 text-[11px] text-sol-cyan hover:underline"
          >
            Manage accounts →
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
