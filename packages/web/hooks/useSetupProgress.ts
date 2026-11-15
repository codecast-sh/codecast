"use client";
// Reads the facts lib/setupProgress needs from the store and the machine
// roster, for every opt-in surface (SetupMeter, SetupNudgeBanner).
import { useMemo } from "react";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useCurrentUser } from "./useCurrentUser";
import { useDevices } from "../components/DeviceBadge";
import { useAvailableAgentFeatures } from "./useAgentFeatureChoice";
import { useOsPermission } from "./useOsPermissions";
import { SETUP_FEATURES } from "./useSetupFeatures";
import { snippetEnabledOn } from "../lib/newSnippets";
import { nativeAppOffer } from "../lib/nativeApps";
import { teamFeatureEnabled } from "@codecast/shared/contracts";
import { TEAM_VISIBILITY_RANK, currentMembershipVisibility } from "../lib/teamVisibility";
import { setupSteps, type SetupFacts, type SetupStep, type SetupTeamFacts } from "../lib/setupProgress";

/** The team the steps are about: the one the person works in now, else
 *  the first they belong to. */
function focusTeam(teams: any[] | undefined, activeId: string | undefined) {
  const list = (teams || []).filter(Boolean);
  return list.find((t) => String(t._id) === String(activeId)) ?? list[0] ?? null;
}

export function useSetupProgress(): { steps: SetupStep[]; done: number; total: number; team: any | null; ready: boolean } {
  const { user } = useCurrentUser();
  const s = useTrackedStore([
    (s) => s.teams,
    (s) => s.clientState.ui?.active_team_id,
    (s) => s.clientState.dismissed?.has_used_desktop,
    (s) => s.clientStateInitialized,
  ]);
  const { devices } = useDevices();
  const features = useAvailableAgentFeatures();
  const { readiness } = useOsPermission("notifications");

  const team = focusTeam(s.teams, s.clientState.ui?.active_team_id);
  const usesDesktop = !!s.clientState.dismissed?.has_used_desktop;

  return useMemo(() => {
    const reporting = devices.filter((d) => !d.is_remote && d.settings);
    const agentsOn = features.filter((f) => reporting.some((d) => snippetEnabledOn(d.settings, f))).length;
    const teamFacts: SetupTeamFacts | null = team
      ? {
          _id: String(team._id),
          name: team.name,
          member_count: team.member_count,
          shared_project_count: team.shared_project_count,
          sharesFull: TEAM_VISIBILITY_RANK[currentMembershipVisibility(team)] >= TEAM_VISIBILITY_RANK.full,
          isAdmin: team.role === "admin",
          // Tasks are always on, so they count toward both sides.
          features: {
            on: SETUP_FEATURES.filter((f) => teamFeatureEnabled(team, f.key)).length + 1,
            total: SETUP_FEATURES.length + 1,
          },
        }
      : null;
    const facts: SetupFacts = {
      connected: !!(user?.cli_version || user?.daemon_last_seen || devices.some((d) => !d.is_remote)),
      team: teamFacts,
      agentFeatures: { on: agentsOn, total: features.length },
      notifications: readiness,
      desktopOffered: nativeAppOffer() === "mac" && !usesDesktop,
    };
    const steps = setupSteps(facts);
    return {
      steps,
      done: steps.filter((x) => x.done).length,
      total: steps.length,
      team,
      ready: !!user && !!s.clientStateInitialized,
    };
  }, [user, devices, features, readiness, team, usesDesktop, s.clientStateInitialized]);
}

/** Close the meter for a week. */
export function snoozeSetupMeter() {
  useInboxStore.getState().updateClientDismissed("setup_meter", Date.now());
}
