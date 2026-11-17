"use client";

// The person's recovery mode (users.cc_recovery_mode): what codecast does when
// a session stops on its own, on every machine they run. One control for the
// header chip's panel, the Claude Accounts settings page and the park card.

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { recoveryModeOf, type RecoveryMode } from "@codecast/convex/convex/ccAccountsShared";

// What each mode does, in the words the selector shows. One definition so the
// header panel and the settings page describe the same behavior.
export const RECOVERY_MODE_COPY: Record<RecoveryMode, { label: string; short: string; detail: string }> = {
  off: {
    short: "Auto-resume off",
    label: "Never continue for me",
    detail: "Codecast never types into your sessions. A session that stopped waits until you continue it.",
  },
  resume: {
    short: "Auto-resume on",
    label: "Continue on this account",
    detail:
      "Never change accounts. Codecast sends \"continue\" once a usage limit resets, after an API or connection error, and when the agent crashed mid-turn.",
  },
  ask: {
    short: "Ask to switch",
    label: "Continue, and ask before switching accounts",
    detail:
      "Same as above. On a usage limit, also recommend the saved account with the most headroom and wait for you to approve.",
  },
  auto: {
    short: "Auto-switch",
    label: "Continue, and switch accounts automatically",
    detail:
      "Same as above. On a usage limit, move this machine to the saved account with the most headroom and continue without asking.",
  },
};

export type RecoveryModeControl = {
  mode: RecoveryMode;
  pending: boolean;
  set: (mode: RecoveryMode) => Promise<void>;
};

export function useAccountRecoveryToggles(device: {
  auto_switch: boolean;
  auto_continue?: boolean;
  ask_first?: boolean;
}): { recovery: RecoveryModeControl } {
  const setMode = useMutation(api.accountSwitch.setRecoveryMode);
  // Local echo while the choice round-trips; the roster query is the source
  // of truth once it lands.
  const [pendingMode, setPendingMode] = useState<RecoveryMode | null>(null);

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
          await setMode({ mode });
          toast.success(RECOVERY_MODE_COPY[mode].label);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not change the recovery mode");
        } finally {
          setPendingMode(null);
        }
      },
    },
  };
}
