"use client";
// The setup flow's Features step state (components/onboarding/FeatureStep),
// shared with the footer that offers to turn every one of them on: the new
// team flow, and an existing team's setup page.
import { TEAM_FEATURES, teamFeatureEnabled } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

/** The team features the setup flow offers: the ones a new team starts with. */
export const SETUP_FEATURES = TEAM_FEATURES.filter((f) => f.onByDefault);

/** `teamId` null while a create is in flight: the store's active team is then
 *  the stub row, which already carries the defaults. Tasks are always on and
 *  count toward the total, so "all on" reads the way the cards do. */
export function useSetupFeatures(teamId: string | null) {
  const team = useInboxStore((s) => {
    const id = teamId ?? s.clientState.ui?.active_team_id;
    return (s.teams || []).find((t: any) => t && String(t._id) === String(id));
  });
  const off = SETUP_FEATURES.filter((f) => !teamFeatureEnabled(team, f.key));
  return {
    team,
    total: SETUP_FEATURES.length + 1,
    onCount: SETUP_FEATURES.length + 1 - off.length,
    allOn: off.length === 0,
    turnAllOn: () => {
      if (!teamId) return;
      const st = useInboxStore.getState();
      for (const f of off) st.setTeamFeature(teamId, f.key, true);
    },
  };
}
