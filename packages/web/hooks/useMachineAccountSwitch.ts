"use client";

// Machine-wide Claude account switch. The store action paints the switch's
// sessionCommands row on the click; the daemon's report settles the command,
// and the heartbeat's active_email confirms the account actually moved. Every
// surface (the header chip, Settings) reads the same row, so neither can toast
// success on queue and a reload keeps the switch in view. The state lives in
// useMachineSwitchState (shared with mobile); this adds the web's toasts.

import { toast } from "sonner";
import { persistentToast } from "../lib/persistentToast";
import { machineSwitchPendingCopy, machineSwitchSuccessCopy, type MachineSwitchPhase } from "../lib/machineAccountSwitch";
import { DISPATCH_REFUSED } from "../lib/sessionCommands";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { useMachineSwitchState, type MachineSwitchOutcome } from "./useMachineSwitchState";

export { machineSwitchStatus, type MachineSwitchOutcome } from "./useMachineSwitchState";

// Each outcome is said once per window, by whichever mounted surface sees it
// first.
const announced = new Set<string>();

export function useMachineAccountSwitch(opts: { deviceId?: string; activeEmail?: string; launchProfile?: string }): {
  switchTo: (profile: string, email?: string) => Promise<void>;
  switching: string | null;
  phase: MachineSwitchPhase;
  outcome: MachineSwitchOutcome | null;
  clearOutcome: () => void;
} {
  const deviceId = opts.deviceId ?? "";
  const state = useMachineSwitchState(opts);
  const { row, resolved, pending, profile } = state;
  const toastId = `acct-switch-${deviceId}`;

  useWatchEffect(() => {
    if (!row) return;
    if (pending) announced.add(`${row._id}:seen`);
    if (resolved.phase === "slow" || resolved.phase === "confirming") {
      const key = `${row._id}:${resolved.phase}`;
      if (announced.has(key)) return;
      announced.add(key);
      toast.message(machineSwitchPendingCopy(resolved.phase, profile), { id: toastId, ...persistentToast });
      return;
    }
    if (resolved.phase === "succeeded") {
      // The account moved: latch it on the row, so a later account change
      // never rereads this switch as a failure.
      if (!row.confirmed_at) useInboxStore.getState().confirmSessionCommand(row._id);
      if (announced.has(`${row._id}:done`)) return;
      announced.add(`${row._id}:done`);
      if (row.confirmed_at) return;
      const copy = machineSwitchSuccessCopy(profile, opts.launchProfile === profile);
      toast.success(copy.title, { id: toastId, description: copy.description });
      return;
    }
    if (resolved.phase === "failed") {
      // Only to someone who watched it pending here, not on every reload.
      if (announced.has(`${row._id}:done`) || !announced.has(`${row._id}:seen`)) return;
      announced.add(`${row._id}:done`);
      // A refusal already raised the dispatch-failure toast: just drop the
      // pending one. A daemon's failure or a give-up replaces it with why.
      if (row.result === DISPATCH_REFUSED) toast.dismiss(toastId);
      else toast.error(resolved.error ?? "Switch failed", { id: toastId });
    }
  }, [row, resolved.phase, resolved.error]);

  const switchTo = async (target: string, email?: string) => {
    if (!deviceId) {
      toast.error("No online daemon to switch accounts");
      return;
    }
    const res = await state.request(target, email, () =>
      toast.message(machineSwitchPendingCopy("waiting", target), { id: toastId, ...persistentToast }));
    if (res === "already") toast.success(`Already on "${target}"`);
  };

  return {
    switchTo,
    switching: state.switching,
    phase: state.phase,
    outcome: state.outcome,
    clearOutcome: state.clearOutcome,
  };
}
