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
import { isAutoContinueEnabled, recoveryModeOf, type RecoveryMode } from "@codecast/convex/convex/ccAccountsShared";

export type RecoveryToggle = {
  on: boolean;
  pending: boolean;
  set: (enabled: boolean) => Promise<void>;
};

// What each mode does, in the words the selector shows. One definition so the
// header panel and the settings page describe the same behavior.
export const RECOVERY_MODE_COPY: Record<RecoveryMode, { label: string; detail: string }> = {
  ask: {
    label: "Ask before switching",
    detail:
      "On a usage limit, recommend the saved account with the most headroom and wait for you to approve. Sessions still resume on their own once the window resets.",
  },
  auto: {
    label: "Switch automatically",
    detail:
      "On a usage limit, move this machine to the saved account with the most headroom and continue the parked sessions without asking.",
  },
  resume: {
    label: "Resume at reset only",
    detail:
      "Never change accounts. Parked sessions continue on their own once this account's window resets.",
  },
  off: {
    label: "Do nothing",
    detail: "Parked sessions stay parked until you continue them yourself.",
  },
};

export type RecoveryModeControl = {
  mode: RecoveryMode;
  pending: boolean;
  set: (mode: RecoveryMode) => Promise<void>;
};

export function useAccountRecoveryToggles(device: {
  device_id: string;
  auto_switch: boolean;
  auto_continue?: boolean;
  ask_first?: boolean;
}): { autoSwitch: RecoveryToggle; autoContinue: RecoveryToggle; recovery: RecoveryModeControl } {
  const setAutoSwitch = useMutation(api.accountSwitch.setAutoSwitchAccounts);
  const setAutoContinue = useMutation(api.accountSwitch.setAutoContinueAccounts);
  const setMode = useMutation(api.accountSwitch.setRecoveryMode);
  const [pendingMode, setPendingMode] = useState<RecoveryMode | null>(null);
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

  const serverMode = recoveryModeOf({
    cc_auto_switch: device.auto_switch,
    cc_recovery_ask: device.ask_first,
    cc_auto_continue: device.auto_continue,
  });

  return {
    recovery: {
      mode: pendingMode ?? serverMode,
      pending: pendingMode !== null,
      set: async (mode: RecoveryMode) => {
        setPendingMode(mode);
        try {
          await setMode({ device_id: device.device_id, mode });
          toast.success(RECOVERY_MODE_COPY[mode].label);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not change the recovery mode");
        } finally {
          setPendingMode(null);
        }
      },
    },
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
