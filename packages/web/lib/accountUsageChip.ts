// Which device and provider the header account chip should show. The chip is
// a status control, not a liveness one: last-known accounts stay visible while
// the daemon is quiet or offline (switch stays blocked there). Remotes mirror
// the primary, so they never win the pick.

import type { CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { profileIsCurrentLogin } from "./machineAccountSwitch";

export type AccountChipProfile = {
  name: string;
  email?: string;
  usage?: CcUsage;
};

export type AccountChipDevice = {
  is_remote: boolean;
  online?: boolean;
  active_email?: string;
  profiles: AccountChipProfile[];
  codex_accounts?: {
    active_email?: string;
    profiles: AccountChipProfile[];
  };
};

export function pickAccountChipDevice<T extends AccountChipDevice>(
  devices: T[] | undefined,
): T | undefined {
  if (!devices?.length) return undefined;
  const primaries = devices.filter((d) => !d.is_remote);
  return primaries.find((d) => d.online !== false) ?? primaries[0];
}

export function matchProfile<T extends AccountChipProfile>(
  profiles: T[],
  email?: string,
): T | undefined {
  return profiles.find((p) => profileIsCurrentLogin(p, email));
}

export function claudeChipLabel(
  active: AccountChipProfile | undefined,
  activeEmail?: string,
  profiles: AccountChipProfile[] = [],
): string {
  if (active?.name) return active.name;
  if (activeEmail) {
    const local = activeEmail.split("@")[0];
    return local || activeEmail;
  }
  return profiles[0]?.name ?? "claude";
}

export function accountChipProvider(opts: {
  currentAgentType: string | null;
  lastShown: "claude" | "codex" | null;
  hasClaude: boolean;
  hasCodex: boolean;
}): "claude" | "codex" | null {
  if (!opts.hasClaude && !opts.hasCodex) return null;
  const sessionProvider =
    opts.currentAgentType === "codex" || opts.currentAgentType === "codex_cli"
      ? "codex"
      : opts.currentAgentType === "claude_code"
        ? "claude"
        : null;
  if (sessionProvider === "codex" && opts.hasCodex) return "codex";
  if (sessionProvider === "claude" && opts.hasClaude) return "claude";
  if (opts.lastShown === "codex" && opts.hasCodex) return "codex";
  if (opts.lastShown === "claude" && opts.hasClaude) return "claude";
  if (opts.hasClaude) return "claude";
  return "codex";
}

export function resolveAccountChip<T extends AccountChipDevice>(opts: {
  devices: T[] | undefined;
  currentAgentType: string | null;
  lastShown: "claude" | "codex" | null;
}): {
  device: T;
  active: T["profiles"][number] | undefined;
  activeCodex: NonNullable<T["codex_accounts"]>["profiles"][number] | undefined;
  shown: "claude" | "codex";
  claudeLabel: string;
} | null {
  const device = pickAccountChipDevice(opts.devices);
  if (!device) return null;
  const profiles = device.profiles ?? [];
  const active = matchProfile(profiles, device.active_email);
  const codexProfiles = device.codex_accounts?.profiles ?? [];
  const activeCodex =
    matchProfile(codexProfiles, device.codex_accounts?.active_email) ?? codexProfiles[0];
  const hasClaude = profiles.length > 0 || !!device.active_email;
  const hasCodex = !!activeCodex;
  const shown = accountChipProvider({
    currentAgentType: opts.currentAgentType,
    lastShown: opts.lastShown,
    hasClaude,
    hasCodex,
  });
  if (!shown) return null;
  return {
    device,
    active,
    activeCodex,
    shown,
    claudeLabel: claudeChipLabel(active, device.active_email, profiles),
  };
}
