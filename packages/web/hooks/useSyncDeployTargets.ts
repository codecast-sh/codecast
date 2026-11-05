// A team's deploy targets into the store (deploys.md DP10 to DP12): one feed,
// convex deployTargets.view, fanned into two homes. Each target's config and
// waiting queue go to `deployTargets`; every deploy the view names (live,
// going out, history) goes to `teamDeploys` once, with its target and
// repository, so a target's live and open deploy derive from it at read time.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import type { DeployTargetRow, TeamDeployRow } from "../lib/deploys/targets";

const api = _api as any;

/** Feeder: one team's targets and their deploys. Mounted by the Deploys page and by a session whose change has landed. */
export function useSyncDeployTargets(teamId: string | null | undefined) {
  const syncTable = useInboxStore((s) => s.syncTable);
  const { data } = useQueryNoThrow(api.deployTargets.view, teamId ? { team_id: teamId } : "skip");
  useConvexSync(
    data,
    useCallback((d: { team_id?: string; targets?: any[] }) => {
      if (!teamId) return;
      const workspace = `team:${teamId}`;
      const targets: DeployTargetRow[] = [];
      const deploys = new Map<string, TeamDeployRow>();
      for (const t of d.targets ?? []) {
        const { live, open, history, ...rest } = t;
        targets.push({ ...rest, _id: `${t.repository}#${t.name}`, workspace, team_id: teamId });
        for (const dp of [live, open, ...(history ?? [])]) {
          if (!dp?._id) continue;
          const prev = deploys.get(dp._id);
          deploys.set(dp._id, { ...prev, ...dp, ...(dp.steps ? { steps: dp.steps } : {}), workspace, target: t.name, repository: t.repository });
        }
      }
      syncTable("deployTargets", targets, { isDelta: true });
      syncTable("teamDeploys", [...deploys.values()], { isDelta: true });
    }, [syncTable, teamId]),
  );
  const { ready: recordsReady } = useSyncTeamDeployRecords(teamId);
  return { ready: data !== undefined || recordsReady };
}

/** Feeder: a team's deploys by their records, every target, declared or not, with what each carried. The Deploys page
 *  reads them so a team with deploys never reads as empty; inbox cards read them to say which sessions made it out. */
export function useSyncTeamDeployRecords(teamId: string | null | undefined) {
  const syncTable = useInboxStore((s) => s.syncTable);
  const { data } = useQueryNoThrow(api.deployRefs.recentForTeam, teamId ? { team_id: teamId } : "skip");
  useConvexSync(data, useCallback((rows: TeamDeployRow[]) => { syncTable("teamDeploys", rows, { isDelta: true }); }, [syncTable]));
  return { ready: data !== undefined };
}

const targetSig = (t: DeployTargetRow) => `${t.name}|${t.policy}|${t.can_deploy ? 1 : 0}|${t.queue?.head_sha ?? ""}|${t.queue?.commits ?? 0}|${t.queue?.head_ci ?? ""}|${t.queue?.groups?.length ?? 0}|${t.queue?.groups?.map((g) => `${g.key}:${g.commits.length}:${g.ci}`).join(",") ?? ""}`;
const deploySig = (d: TeamDeployRow) => `${d.status}|${d.sha ?? ""}|${d.live_at ?? 0}|${d.finished_at ?? 0}|${d.steps?.map((s) => `${s.id}:${s.status}`).join(",") ?? ""}|${d.note ?? ""}|${d.short_id}|${d.sessions?.length ?? 0}|${d.tasks?.length ?? 0}`;

/** Reader: a team's targets and deploys from the store. */
export function useDeployTargets(teamId: string | null | undefined): { targets: DeployTargetRow[]; deploys: TeamDeployRow[]; ready: boolean } {
  const { ready } = useSyncDeployTargets(teamId);
  const workspace = teamId ? `team:${teamId}` : null;
  const targets = useWorkspaceCollection<DeployTargetRow>("deployTargets", targetSig, workspace);
  const deploys = useWorkspaceCollection<TeamDeployRow>("teamDeploys", deploySig, workspace);
  return useMemo(() => ({ targets, deploys, ready }), [targets, deploys, ready]);
}
