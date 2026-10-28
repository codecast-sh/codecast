// What a team's managed policy (Team settings > Managed devices) locks, read
// where a person meets the locked control. The server enforces every key
// (convex lib/teamPolicyGuard.ts); these hooks only make the lock visible
// before a press, in the same words the refusal uses
// (shared/contracts/managedPolicy.ts policyBlockedMessage). The teams feed
// carries each team's policy to every member.
import {
  MANAGED_POLICY,
  parseTeamPolicy,
  policyBlockedMessage,
  type TeamPolicy,
  type TeamPolicyKey,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import type { Device } from "../components/DeviceBadge";

export type RestrictionKey = Extract<TeamPolicyKey, `${string}_disabled`>;

export interface TeamPolicyView {
  team_id: string;
  team_name: string;
  policy: TeamPolicy;
}

function useTeamPolicyView(teamId: string | null | undefined): TeamPolicyView | null {
  const team = useInboxStore((s) => (teamId ? (s.teams ?? []).find((t: any) => t && String(t._id) === teamId) : undefined));
  return team ? { team_id: String(team._id), team_name: team.name, policy: parseTeamPolicy((team as any).policy) } : null;
}

function refusal(view: TeamPolicyView | null, key: RestrictionKey): string | null {
  if (!view || view.policy[key] !== true) return null;
  return policyBlockedMessage(key, { kind: "team", team_id: view.team_id, team_name: view.team_name });
}

/** Why `key` is off for a row in this team (policyTeamOf), or null when it is allowed. */
export function usePolicyRefusal(key: RestrictionKey, teamId: string | null | undefined): string | null {
  return refusal(useTeamPolicyView(teamId), key);
}

/** The policy of the team a device is enrolled in; null for an unmanaged or removed device. */
export function useDevicePolicy(d: Device | null | undefined): TeamPolicyView | null {
  return useTeamPolicyView(d?.managed?.state === "managed" ? d.managed.team_id : null);
}

/** Why an agent feature is held off on a device by its team, or null. */
export function featureLock(view: TeamPolicyView | null, featureSlug: string): string | null {
  const d = MANAGED_POLICY.find((p) => p.feature === featureSlug);
  return d ? refusal(view, d.key as RestrictionKey) : null;
}

/** The automatic-update value a device's team forces, with the words for it; null when the person decides. */
export function autoUpdateLock(view: TeamPolicyView | null): { on: boolean; message: string } | null {
  const value = view?.policy.auto_update;
  if (!view || !value) return null;
  return { on: value === "on", message: `${value === "on" ? "On" : "Off"}, set by ${view.team_name}'s admins.` };
}
