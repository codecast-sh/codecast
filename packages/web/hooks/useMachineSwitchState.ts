// The machine-wide Claude account switch's state, without any UI: the
// sessionCommands row the store action paints on the click, its phase from the
// daemon's report and the machine's reported account, and the request itself.
// Web (useMachineAccountSwitch, toasts) and mobile (its Accounts screen) both
// render from this.

import {
  humanizeSwitchError,
  profileIsFleetAccount,
  resolveMachineSwitch,
  type MachineSwitchPhase,
} from "../lib/machineAccountSwitch";
import { DISPATCH_REFUSED, latestSessionCommand, requestAccountSwitchCommand, type SessionCommandRow } from "../lib/sessionCommands";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";

export type MachineSwitchOutcome = {
  kind: "success" | "error";
  profile: string;
  email?: string;
  message: string;
};

export type MachineSwitchFleet = { activeEmail?: string; launchProfile?: string };

const machineSwitchRow = (deviceId: string) => (row: SessionCommandRow) =>
  row.kind === "switch" && row.device_id === deviceId && !!(row.profile || row.email);

/** A switch's phase from its row and the machine's reported account. */
export function machineSwitchStatus(
  row: SessionCommandRow | undefined,
  fleet: MachineSwitchFleet,
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

const isPendingPhase = (phase: MachineSwitchPhase) => phase === "waiting" || phase === "slow" || phase === "confirming";

export function useMachineSwitchState(opts: { deviceId?: string } & MachineSwitchFleet) {
  const deviceId = opts.deviceId ?? "";
  const fleet: MachineSwitchFleet = { activeEmail: opts.activeEmail, launchProfile: opts.launchProfile };
  const row = useInboxStore((s) => (deviceId ? latestSessionCommand(s.sessionCommands, machineSwitchRow(deviceId)) : undefined));
  const settled = !row || !!row.confirmed_at || row.result === DISPATCH_REFUSED || !!row.error;
  const now = useCoarseNow(settled ? 30_000 : 1_000);
  const resolved = machineSwitchStatus(row, fleet, now);
  const pending = !!row && isPendingPhase(resolved.phase);
  const profile = row?.profile ?? row?.email ?? "";

  const outcome: MachineSwitchOutcome | null =
    !row || pending ? null
    : resolved.phase === "failed" ? { kind: "error", profile, message: resolved.error ?? "Switch failed" }
    : resolved.phase === "succeeded" && profileIsFleetAccount({ name: profile, email: row.email }, fleet)
      ? { kind: "success", profile, email: row.email, message: `Now using ${profile}` }
      : null;

  /** Queue the switch; `onQueued` runs just before it goes out. "busy": one is already in flight; "already": the machine is on it. */
  const request = async (target: string, email?: string, onQueued?: () => void): Promise<"sent" | "busy" | "already" | "no_device"> => {
    if (!deviceId) return "no_device";
    const cur = latestSessionCommand(useInboxStore.getState().sessionCommands, machineSwitchRow(deviceId));
    if (cur && isPendingPhase(machineSwitchStatus(cur, fleet, Date.now()).phase)) return "busy";
    if (profileIsFleetAccount({ name: target, email }, fleet)) return "already";
    onQueued?.();
    // A refusal settles the row failed; a parked request stays pending until
    // the outbox delivers it.
    await requestAccountSwitchCommand({ profile: target, device_id: deviceId, continue_blocked: false }, { profile: target, email })
      .catch(() => {});
    return "sent";
  };

  return {
    row,
    resolved,
    pending,
    profile,
    outcome,
    request,
    switching: pending ? profile : null,
    phase: (pending ? resolved.phase : outcome?.kind === "error" ? "failed" : outcome?.kind === "success" ? "succeeded" : "idle") as MachineSwitchPhase,
    clearOutcome: () => {
      if (row && !pending) useInboxStore.getState().dismissSessionCommand(row._id);
    },
  };
}
