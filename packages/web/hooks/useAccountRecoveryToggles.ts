"use client";

// The two device-level limit-recovery flags — auto-switch (rotate the machine's
// login to the freshest saved account) and auto-continue (resume limit-parked
// sessions on the same account once its window resets) — with the optimistic
// echo and toast each toggle needs. Shared by the header chip's panel and the
// Claude Accounts settings page so both render and flip the same state.

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { isAutoContinueEnabled } from "@codecast/convex/convex/ccAccountsShared";

export type RecoveryToggle = {
  on: boolean;
  pending: boolean;
  set: (enabled: boolean) => Promise<void>;
};

export function useAccountRecoveryToggles(device: {
  device_id: string;
  auto_switch: boolean;
  auto_continue?: boolean;
}): { autoSwitch: RecoveryToggle; autoContinue: RecoveryToggle } {
  const setAutoSwitch = useMutation(api.accountSwitch.setAutoSwitchAccounts);
  const setAutoContinue = useMutation(api.accountSwitch.setAutoContinueAccounts);
  // Local echo while a toggle round-trips (the flags live on the device row,
  // so the query refresh is the source of truth once it lands).
  const [pendingSwitch, setPendingSwitch] = useState<boolean | null>(null);
  const [pendingContinue, setPendingContinue] = useState<boolean | null>(null);

  const flip =
    (
      mutate: (args: { device_id: string; enabled: boolean }) => Promise<unknown>,
      setPending: (v: boolean | null) => void,
      label: (enabled: boolean) => string,
    ) =>
    async (enabled: boolean) => {
      setPending(enabled);
      try {
        await mutate({ device_id: device.device_id, enabled });
        toast.success(label(enabled));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Toggle failed");
      } finally {
        setPending(null);
      }
    };

  return {
    autoSwitch: {
      on: pendingSwitch ?? device.auto_switch,
      pending: pendingSwitch !== null,
      set: flip(setAutoSwitch, setPendingSwitch, (on) =>
        on ? "Auto-switch on — limit-parked sessions will hop accounts and continue" : "Auto-switch off",
      ),
    },
    autoContinue: {
      // Unset means on (older query results and fresh device rows alike).
      on: pendingContinue ?? isAutoContinueEnabled({ cc_auto_continue: device.auto_continue }),
      pending: pendingContinue !== null,
      set: flip(setAutoContinue, setPendingContinue, (on) =>
        on
          ? "Resume at reset on — limit-parked sessions continue when their window resets"
          : "Resume at reset off — limit-parked sessions stay parked until you continue them",
      ),
    },
  };
}
