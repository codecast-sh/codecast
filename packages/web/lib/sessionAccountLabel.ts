// Which Claude or Codex account a session is spending. Distinct from the
// machine's current login and from the Codecast user who owns the session.
// A cloud session billed to an API key names no plan account.

import { planAgentType } from "./accountUsageChip";
import { profileIsCurrentLogin, profileIsFleetAccount } from "./machineAccountSwitch";

export type SessionAccountProfile = { name: string; email?: string | null };

export type SessionAccountInput = {
  agentType?: string | null;
  sessionId?: string | null;
  model?: string | null;
  ccAccount?: string | null;
  codexAccount?: string | null;
  claude?: {
    activeEmail?: string | null;
    launchProfile?: string | null;
    profiles?: SessionAccountProfile[] | null;
  } | null;
  codex?: {
    activeEmail?: string | null;
    profiles?: SessionAccountProfile[] | null;
  } | null;
};

export type SessionAccountLabel = {
  provider: "claude" | "codex";
  /** The email when the machine's profile list has one, else the recorded name. */
  label: string;
  /** Hover text. Says whether this is the session's own account or the machine's login. */
  title: string;
};

function matchNamed(profiles: SessionAccountProfile[], pin: string): SessionAccountProfile | undefined {
  const want = pin.trim().toLowerCase();
  return profiles.find((p) => p.name.toLowerCase() === want || (!!p.email && p.email.toLowerCase() === want));
}

function providerOf(agentType: string): "claude" | "codex" | null {
  if (agentType === "codex" || agentType === "codex_cli") return "codex";
  if (agentType === "claude_code") return "claude";
  return null;
}

export function sessionAccountLine(account: SessionAccountLabel): string {
  return `${account.provider === "codex" ? "Codex" : "Claude"} · ${account.label}`;
}

/**
 * The account line for one session.
 *
 * Claude with no pin runs on the machine's fleet login, and that login is
 * what the line shows. Codex with no recorded account must not be presented
 * as the process's login: a switch leaves the process on the account it
 * started with, so the line shows the machine's current Codex login and says
 * the session never recorded its own.
 */
export function sessionAccountLabel(row: SessionAccountInput): SessionAccountLabel | null {
  const agent = planAgentType({ agent_type: row.agentType, session_id: row.sessionId, model: row.model });
  if (!agent) return null;
  const provider = providerOf(agent);
  if (provider === "codex") {
    const profiles = row.codex?.profiles ?? [];
    const pin = row.codexAccount?.trim();
    if (pin) {
      const label = matchNamed(profiles, pin)?.email || pin;
      return { provider, label, title: `This session's Codex process is signed in as ${label}` };
    }
    const active = row.codex?.activeEmail?.trim();
    const matched = active ? matchNamed(profiles, active) : undefined;
    const label = matched?.email || active || profiles.find((p) => p.email)?.email || profiles[0]?.name;
    if (!label) return null;
    return {
      provider,
      label,
      title: `This machine's Codex login is ${label}. This session did not record which account it started on.`,
    };
  }
  if (provider === "claude") {
    const profiles = row.claude?.profiles ?? [];
    const pin = row.ccAccount?.trim();
    if (pin) {
      const label = matchNamed(profiles, pin)?.email || pin;
      return { provider, label, title: `This session runs on the Claude account ${label}` };
    }
    const launch = row.claude?.launchProfile?.trim();
    if (launch) {
      const fleet = profiles.find((p) => p.name === launch);
      const label = fleet?.email || launch;
      return { provider, label, title: `This machine's Claude login is ${label}. This session is not pinned to another profile.` };
    }
    const fleet = profiles.find((p) =>
      profileIsFleetAccount(
        { name: p.name, email: p.email ?? undefined },
        { activeEmail: row.claude?.activeEmail, launchProfile: row.claude?.launchProfile },
      ) || profileIsCurrentLogin({ name: p.name, email: p.email ?? undefined }, row.claude?.activeEmail),
    );
    const label = fleet?.email || row.claude?.activeEmail?.trim() || fleet?.name;
    if (!label) return null;
    return { provider, label, title: `This machine's Claude login is ${label}. This session is not pinned to a saved profile.` };
  }
  return null;
}
