// Regulated health data (HIPAA) as the client sees it: whether any of the
// viewer's teams sets regulated_data in its managed policy. A leaf over the
// store and the shared contract, so the phone's analytics can import it too.
import { parseTeamPolicy, teamsHoldRegulatedData } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

/** Calls `onChange` with the viewer's regulated-data state now and whenever the teams feed changes it. */
export function watchRegulatedData(onChange: (on: boolean) => void): () => void {
  let last: boolean | null = null;
  const check = (teams: Parameters<typeof teamsHoldRegulatedData>[0]) => {
    const on = teamsHoldRegulatedData(teams);
    if (on === null || on === last) return;
    last = on;
    onChange(on);
  };
  check(useInboxStore.getState().teams as any);
  return useInboxStore.subscribe((s, prev) => {
    if (s.teams !== prev.teams) check(s.teams as any);
  });
}

/** Whether `teamId` is one of the viewer's teams and sets regulated_data. */
export function viewerTeamIsRegulated(teamId: string | null | undefined): boolean {
  if (!teamId) return false;
  const teams = (useInboxStore.getState().teams ?? []) as Array<{ _id?: string; policy?: unknown } | null>;
  return teams.some((t) => !!t && String(t._id) === String(teamId) && parseTeamPolicy(t.policy).regulated_data === true);
}
