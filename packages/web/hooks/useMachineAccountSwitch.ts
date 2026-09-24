"use client";

// Machine-wide Claude account switch. The mutation only queues a daemon
// command; this hook watches that command (and the heartbeat's active_email)
// and holds "switching" until the swap lands or fails. Shared by the header
// chip and Settings so neither surface can toast success on queue.

import { create } from "zustand";
import { captureException } from "@sentry/react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { persistentToast } from "../lib/persistentToast";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  machineSwitchPendingCopy,
  machineSwitchSuccessCopy,
  profileIsFleetAccount,
  resolveMachineSwitch,
  type MachineSwitchPhase,
} from "../lib/machineAccountSwitch";
import { useCoarseNow } from "./useCoarseNow";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

export type MachineSwitchOutcome = {
  kind: "success" | "error";
  profile: string;
  email?: string;
  message: string;
};

type PendingSwitch = {
  profile: string;
  email?: string;
  commandId: Id<"daemon_commands"> | null;
  startedAt: number;
  toastId: string;
  requestId: string;
  announcedPhase?: MachineSwitchPhase;
};

type SwitchState = { pending: PendingSwitch | null; outcome: MachineSwitchOutcome | null };
const idle: SwitchState = { pending: null, outcome: null };
const useSwitchState = create<Record<string, SwitchState>>(() => ({}));

export function useMachineAccountSwitch(opts: { deviceId?: string; activeEmail?: string; launchProfile?: string }): {
  switchTo: (profile: string, email?: string) => Promise<void>;
  switching: string | null;
  phase: MachineSwitchPhase;
  outcome: MachineSwitchOutcome | null;
  clearOutcome: () => void;
} {
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const deviceId = opts.deviceId ?? "";
  const state = useSwitchState((s) => s[deviceId] ?? idle);
  const { pending } = state;
  const fleet = { activeEmail: opts.activeEmail, launchProfile: opts.launchProfile };
  const outcome = state.outcome?.kind === "success" &&
    !profileIsFleetAccount({ name: state.outcome.profile, email: state.outcome.email }, fleet)
    ? null : state.outcome;
  const { data: cmd } = useQueryNoThrow(
    api.users.getCommandResult,
    pending?.commandId ? { command_id: pending.commandId } : "skip",
  );
  const now = useCoarseNow(pending ? 1_000 : 30_000);
  const resolved = resolveMachineSwitch({
    pending,
    activeEmail: opts.activeEmail,
    launchProfile: opts.launchProfile,
    command: cmd ?? undefined,
    now,
  });

  useWatchEffect(() => {
    if (!pending || useSwitchState.getState()[deviceId]?.pending !== pending) return;
    if (resolved.phase === "slow" || resolved.phase === "confirming") {
      if (pending.announcedPhase === resolved.phase) return;
      useSwitchState.setState({ [deviceId]: { ...state, pending: { ...pending, announcedPhase: resolved.phase } } });
      toast.message(machineSwitchPendingCopy(resolved.phase, pending.profile), { id: pending.toastId, ...persistentToast });
      return;
    }
    if (resolved.phase === "succeeded") {
      useSwitchState.setState({ [deviceId]: {
        pending: null,
        outcome: { kind: "success", profile: pending.profile, email: pending.email, message: `Now using ${pending.profile}` },
      } });
      const copy = machineSwitchSuccessCopy(pending.profile, opts.launchProfile === pending.profile);
      toast.success(copy.title, { id: pending.toastId, description: copy.description });
      return;
    }
    if (resolved.phase === "failed") {
      const message = resolved.error ?? "Switch failed";
      useSwitchState.setState({ [deviceId]: {
        pending: null,
        outcome: { kind: "error", profile: pending.profile, message },
      } });
      toast.error(message, { id: pending.toastId, duration: 12_000 });
    }
  }, [deviceId, state, pending, resolved.phase, resolved.error]);

  const switchTo = async (profile: string, email?: string) => {
    if (!deviceId) {
      toast.error("No online daemon to switch accounts");
      return;
    }
    if (useSwitchState.getState()[deviceId]?.pending) return;
    if (profileIsFleetAccount({ name: profile, email }, fleet)) {
      toast.success(`Already on "${profile}"`);
      useSwitchState.setState({ [deviceId]: { pending: null, outcome: { kind: "success", profile, email, message: `Already using ${profile}` } } });
      return;
    }
    const toastId = `acct-switch-${deviceId}`;
    const requestId = crypto.randomUUID();
    useSwitchState.setState({ [deviceId]: {
      pending: { profile, email, commandId: null, startedAt: Date.now(), toastId, requestId },
      outcome: null,
    } });
    toast.message(machineSwitchPendingCopy("waiting", profile), { id: toastId, ...persistentToast });
    try {
      const res = await requestSwitch({
        profile,
        device_id: deviceId,
        continue_blocked: false,
      });
      const commandId = (res.command_ids?.[0] ?? null) as Id<"daemon_commands"> | null;
      const current = useSwitchState.getState()[deviceId];
      if (current?.pending?.requestId !== requestId) return;
      if (!commandId) throw new Error("No daemon accepted the account switch");
      useSwitchState.setState({ [deviceId]: { ...current, pending: { ...current.pending, commandId } } });
    } catch (err) {
      captureException(err);
      if (useSwitchState.getState()[deviceId]?.pending?.requestId !== requestId) return;
      const message = err instanceof Error ? err.message : "Switch failed";
      toast.error(message, { id: toastId, duration: 12_000 });
      useSwitchState.setState({ [deviceId]: { pending: null, outcome: { kind: "error", profile, message } } });
    }
  };

  return {
    switchTo,
    switching: pending?.profile ?? null,
    phase: pending ? resolved.phase : outcome?.kind === "error" ? "failed" : outcome?.kind === "success" ? "succeeded" : "idle",
    outcome,
    clearOutcome: () => {
      const current = useSwitchState.getState()[deviceId];
      if (current?.outcome) useSwitchState.setState({ [deviceId]: { ...current, outcome: null } });
    },
  };
}
