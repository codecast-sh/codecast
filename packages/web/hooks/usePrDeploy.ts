// Everything a pull request's page says about production (components/pr/PRDeploy draws it), read once for the chip
// and the band. The rule is lib/deploys/prDeploy.
import { useMemo } from "react";
import { useDeployReach } from "./useDeployReach";
import { useDeployTargets } from "./useSyncDeployTargets";
import { teamWorkspaceKey } from "../lib/workspaceScope";
import { useDeployPress } from "./useDeployPress";
import { useCoarseNow } from "./useCoarseNow";
import { repoObjectId } from "../lib/entityLinks";
import { prDeployRows, prReachHeadline, prShipsTo } from "../lib/deploys/prDeploy";

export type PrDeployModel = ReturnType<typeof usePrDeploy>;

/** Everything the page says about production, read once for the chip and the band. */
export function usePrDeploy(pr: any, repository: string, authed: boolean) {
  const merged = pr.state === "merged";
  const open = pr.state === "open";
  const reach = useDeployReach(merged ? repoObjectId({ type: "pr", repository, number: pr.number }) : null);
  // The team's targets carry each one's queue and press. A closed pull request goes nowhere, and a public reader
  // reads no team.
  const teamId = authed && (merged || open) ? ((pr.team_id as string | undefined) ?? null) : null;
  const { targets, deploys, productions } = useDeployTargets(teamWorkspaceKey(teamId), repository);
  const now = useCoarseNow(30_000);
  const { rows, dormant } = useMemo(() => prDeployRows(reach, targets, deploys, repository, now), [reach, targets, deploys, repository, now]);
  const files: string[] | undefined = useMemo(() => pr.files?.map((f: { filename: string }) => f.filename), [pr.files]);
  const shipsTo = useMemo(() => (open ? prShipsTo(targets, deploys, repository, files, now) : null), [open, targets, deploys, repository, files, now]);
  const declares = targets.some((t) => t.repository.toLowerCase() === repository.toLowerCase() && !t.record_only);
  const press = useDeployPress(teamId, deploys, productions);
  return { merged, open, teamId, repository, number: pr.number as number, rows, dormant, shipsTo, declares, headline: prReachHeadline(reach?.state, rows), press, now, mergedAt: (pr.merged_at as number | undefined) ?? null };
}
