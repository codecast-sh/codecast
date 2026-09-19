// Pure state for a machine-wide Claude account switch. The web queues a
// daemon command and only learns the real outcome when that command executes
// (or the heartbeat's active_email moves). Callers must not treat "command
// inserted" as success — that is what made Switch look like a no-op.

export const MACHINE_SWITCH_TIMEOUT_MS = 90_000;
export const MACHINE_SWITCH_SLOW_MS = 12_000;

export type SwitchBlock = "active" | "offline" | "remote" | "login_expired";

export function machineSwitchBlock(opts: {
  isActive: boolean;
  online?: boolean;
  isRemote?: boolean;
  loginExpired?: boolean;
  thisProfile: string;
}): { block: SwitchBlock; label: string } | null {
  if (opts.isActive) return { block: "active", label: "This machine is already on this account" };
  if (opts.isRemote) {
    return { block: "remote", label: "Remote machines mirror the primary — switch there" };
  }
  if (opts.online === false) return { block: "offline", label: "The daemon on this machine is offline" };
  if (opts.loginExpired) {
    return {
      block: "login_expired",
      label: "Sign in again first — this saved login no longer works",
    };
  }
  return null;
}

/** True when this saved profile is the machine's current Claude login.
 *  Email is the real identity; a snapshot that never stored one still
 *  matches when its name is the current email's local part — that is how
 *  the chip labels an unsaved login, and how a click on that row used
 *  to queue a switch to the account already in use. */
export function profileIsCurrentLogin(
  profile: { name: string; email?: string },
  activeEmail?: string | null,
): boolean {
  if (!activeEmail) return false;
  if (profile.email && profile.email === activeEmail) return true;
  if (!profile.email && profile.name === activeEmail.split("@")[0]) return true;
  return false;
}

export type MachineSwitchPhase = "idle" | "waiting" | "slow" | "succeeded" | "failed";

export type MachineSwitchCommand = {
  executed_at?: number | null;
  error?: string | null;
};

export function resolveMachineSwitch(opts: {
  pending: { profile: string; email?: string; startedAt: number } | null;
  activeEmail?: string | null;
  command?: MachineSwitchCommand | null;
  now: number;
  timeoutMs?: number;
  slowMs?: number;
}): { phase: MachineSwitchPhase; error?: string } {
  if (!opts.pending) return { phase: "idle" };
  const timeoutMs = opts.timeoutMs ?? MACHINE_SWITCH_TIMEOUT_MS;
  const slowMs = opts.slowMs ?? MACHINE_SWITCH_SLOW_MS;
  const age = opts.now - opts.pending.startedAt;
  if (
    profileIsCurrentLogin(
      { name: opts.pending.profile, email: opts.pending.email },
      opts.activeEmail,
    )
  ) {
    return { phase: "succeeded" };
  }
  if (opts.command?.error) {
    return { phase: "failed", error: humanizeSwitchError(opts.command.error) };
  }
  if (opts.command?.executed_at) return { phase: "succeeded" };
  if (age >= timeoutMs) {
    return {
      phase: "failed",
      error: `The daemon didn't switch to "${opts.pending.profile}" in time — is that machine online?`,
    };
  }
  if (age >= slowMs) return { phase: "slow" };
  return { phase: "waiting" };
}

export function stripSwitchPrefix(msg: string): string {
  return msg.replace(/^Account switch failed:\s*/i, "");
}

export function humanizeSwitchError(msg: string): string {
  const stripped = stripSwitchPrefix(msg);
  if (/unusable credential|logged-out|login expired/i.test(stripped)) {
    return "This saved login no longer works. Sign in again on this account, then switch.";
  }
  return stripped;
}

export function machineSwitchPendingCopy(phase: MachineSwitchPhase, profile: string, deviceLabel?: string): string {
  const where = deviceLabel ? ` on ${deviceLabel}` : "";
  if (phase === "slow") return `Still waiting${where} to switch to "${profile}"…`;
  return `Switching this machine to "${profile}"…`;
}

export function machineSwitchSuccessCopy(profile: string): { title: string; description: string } {
  return {
    title: `This machine is now "${profile}"`,
    description: "New and resumed sessions will use it. Running sessions keep the account they started on.",
  };
}
