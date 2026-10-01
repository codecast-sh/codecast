"use client";

// Machine-wide Claude account switch. The store action paints the switch's
// sessionCommands row on the click; the daemon's report settles the command,
// and the heartbeat's active_email confirms the account actually moved. Every
// surface (the header chip, Settings) reads the same row, so neither can toast
// success on queue and a reload keeps the switch in view.

import { toast } from "sonner";
import { persistentToast } from "../lib/persistentToast";
import {
  humanizeSwitchError,
  machineSwitchPendingCopy,
  machineSwitchSuccessCopy,
  profileIsFleetAccount,
  resolveMachineSwitch,
  type MachineSwitchPhase,
} from "../lib/machineAccountSwitch";
import { DISPATCH_REFUSED, latestSessionCommand, requestAccountSwitchCommand, type SessionCommandRow } from "../lib/sessionCommands";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";
import { useWatchEffect } from "./useWatchEffect";

export type MachineSwitchOutcome = {
  kind: "success" | "error";
  profile: string;
  email?: string;
  message: string;
};

const machineSwitchRow = (deviceId: string) => (row: SessionCommandRow) =>
  row.kind === "switch" && row.device_id === deviceId && !!(row.profile || row.email);

/** A switch's phase from its row and the machine's reported account. */
export function machineSwitchStatus(
  row: SessionCommandRow | undefined,
  fleet: { activeEmail?: string; launchProfile?: string },
  now: number,
): { phase: MachineSwitchPhase; error?: string } {
  if (!row) return { phase: "idle" };
  if (row.result === DISPATCH_REFUSED || (row.error && !row.confirmed_at)) {
    return { phase: "failed", error: humanizeSwitchError(row.error ?? "Switch failed") };
  }
  if (row.confirmed_at) return { phase: "succeeded" };
  return resolveMachineSwitch({
    pending: { profile: row.profile ?? row.email ?? "", email: row.email, startedAt: row.requested_at },
    activeEmail: fleet.activeEmail,
    launchProfile: fleet.launchProfile,
    command: row,
    now,
  });
}

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
  const fleet = { activeEmail: opts.activeEmail, launchProfile: opts.launchProfile };
  const row = useInboxStore((s) => (deviceId ? latestSessionCommand(s.sessionCommands, machineSwitchRow(deviceId)) : undefined));
  const settled = !row || !!row.confirmed_at || row.result === DISPATCH_REFUSED || !!row.error;
  const now = useCoarseNow(settled ? 30_000 : 1_000);
  const resolved = machineSwitchStatus(row, fleet, now);
  const pending = !!row && (resolved.phase === "waiting" || resolved.phase === "slow" || resolved.phase === "confirming");
  const profile = row?.profile ?? row?.email ?? "";
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

  const outcome: MachineSwitchOutcome | null =
    !row || pending ? null
    : resolved.phase === "failed" ? { kind: "error", profile, message: resolved.error ?? "Switch failed" }
    : resolved.phase === "succeeded" && profileIsFleetAccount({ name: profile, email: row.email }, fleet)
      ? { kind: "success", profile, email: row.email, message: `Now using ${profile}` }
      : null;

  const switchTo = async (target: string, email?: string) => {
    if (!deviceId) {
      toast.error("No online daemon to switch accounts");
      return;
    }
    const cur = latestSessionCommand(useInboxStore.getState().sessionCommands, machineSwitchRow(deviceId));
    if (cur && ["waiting", "slow", "confirming"].includes(machineSwitchStatus(cur, fleet, Date.now()).phase)) return;
    if (profileIsFleetAccount({ name: target, email }, fleet)) {
      toast.success(`Already on "${target}"`);
      return;
    }
    toast.message(machineSwitchPendingCopy("waiting", target), { id: toastId, ...persistentToast });
    // A refusal settles the row failed and the effect above says why; a
    // parked request stays pending until the outbox delivers it.
    await requestAccountSwitchCommand({ profile: target, device_id: deviceId, continue_blocked: false }, { profile: target, email })
      .catch(() => {});
  };

  return {
    switchTo,
    switching: pending ? profile : null,
    phase: pending ? resolved.phase : outcome?.kind === "error" ? "failed" : outcome?.kind === "success" ? "succeeded" : "idle",
    outcome,
    clearOutcome: () => {
      if (row && !pending) useInboxStore.getState().dismissSessionCommand(row._id);
    },
  };
}
