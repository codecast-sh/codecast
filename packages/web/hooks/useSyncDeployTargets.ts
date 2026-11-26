// A team's deploy targets into the store (deploys.md DP10 to DP12): one feed,
// convex deployTargets.view, fanned into three homes. Each target's config and
// waiting queue go to `deployTargets`; every deploy the view names (live,
// going out, history) goes to `teamDeploys` once, with its target and
// repository, so a target's live and open deploy derive from it at read time;
// each repository's production (its pause, DP17) goes to `deployProductions`
// once, and every target of the repository reads it from there.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { mergeDeployRow, type DeployProductionRow, type DeployTargetRow, type TeamDeployRow } from "../lib/deploys/targets";

const api = _api as any;

/** Feeder: one team's targets and their deploys, or only those of one repository (a pull request's page). Mounted by
 *  the Deploys page, a session whose change has landed, and a pull request's page. */
export function useSyncDeployTargets(teamId: string | null | undefined, repository?: string | null) {
  const syncTable = useInboxStore((s) => s.syncTable);
  const { data } = useQueryNoThrow(api.deployTargets.view, teamId ? { team_id: teamId, ...(repository ? { repository } : {}) } : "skip");
  useConvexSync(
    data,
    useCallback((d: { team_id?: string; targets?: any[]; productions?: Array<Omit<DeployProductionRow, "_id" | "workspace" | "team_id">> }) => {
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
      const productions: DeployProductionRow[] = (d.productions ?? []).map((p) => ({ ...p, _id: p.repository, workspace, team_id: teamId }));
      syncTable("deployTargets", targets, { isDelta: true });
      syncTable("teamDeploys", withRecorded([...deploys.values()]), { isDelta: true });
      syncTable("deployProductions", productions, { isDelta: true });
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
  useConvexSync(data, useCallback((rows: TeamDeployRow[] | null) => { syncTable("teamDeploys", withRecorded(rows), { isDelta: true }); }, [syncTable]));
  return { ready: data !== undefined };
}

/** Both feeds write the same rows: each keeps what the other gave a deploy and it lacks (mergeDeployRow). A feed that
 *  answers null or nothing passes through to syncTable untouched, as it did before the merge. */
function withRecorded<R extends TeamDeployRow[] | null | undefined>(rows: R): R {
  if (!Array.isArray(rows)) return rows;
  const held = (useInboxStore.getState() as { teamDeploys?: Record<string, TeamDeployRow> }).teamDeploys ?? {};
  return rows.map((r) => mergeDeployRow(held[r._id], r)) as R;
}

const devPushSig = (p: DeployTargetRow["dev_push"]) => (p ? `${p.sha}:${p.machine}:${p.by ?? ""}:${p.at}:${p.dirty}:${p.adds_count}:${p.drops_count}` : "");
const pauseSig = (p: DeployProductionRow["pause"]) => (p ? `${p.by}:${p.at}:${p.reason}:${p.lifts}:${p.rollback ?? ""}:${p.until ? `${p.until.task ?? ""}:${p.until.kind}:${p.until.migrations.join(",")}:${p.until.commits}` : ""}` : "");
const productionSig = (p: DeployProductionRow) => `${p.repository}|${p.can_pause ? 1 : 0}${p.can_lift ? 1 : 0}|${pauseSig(p.pause)}`;
const targetSig = (t: DeployTargetRow) => `${t.name}|${t.policy}|${t.can_deploy ? 1 : 0}|${t.workflow ?? ""}:${t.rollback_inputs ? 1 : 0}|${devPushSig(t.dev_push)}|${t.queue?.head_sha ?? ""}|${t.queue?.commits ?? 0}|${t.queue?.head_ci ?? ""}|${t.queue?.groups?.length ?? 0}|${t.queue?.groups?.map((g) => `${g.key}:${g.commits.length}:${g.ci}`).join(",") ?? ""}`;
const deploySig = (d: TeamDeployRow) => `${d.status}|${d.sha ?? ""}|${d.live_at ?? 0}|${d.finished_at ?? 0}|${d.steps?.map((s) => `${s.id}:${s.status}`).join(",") ?? ""}|${d.note ?? ""}|${d.short_id}|${d.sessions?.map((x) => `${x.conversation_id}:${x.user_id ?? ""}:${x.task_short_ids?.length ?? ""}`).join(",") ?? ""}|${d.tasks?.length ?? 0}|${d.commit_rows?.map((c) => c.sha).join(",") ?? ""}|${d.pushed_via ?? ""}|${d.machine ?? ""}|${d.dirty ?? 0}|${d.adds_count ?? 0}|${d.drops_count ?? 0}`;

/** Reader: a team's targets, deploys and productions from the store. With a repository, only that one's are fed. */
export function useDeployTargets(teamId: string | null | undefined, repository?: string | null): { targets: DeployTargetRow[]; deploys: TeamDeployRow[]; productions: DeployProductionRow[]; ready: boolean } {
  const { ready } = useSyncDeployTargets(teamId, repository);
  const workspace = teamId ? `team:${teamId}` : null;
  const targets = useWorkspaceCollection<DeployTargetRow>("deployTargets", targetSig, workspace);
  const deploys = useWorkspaceCollection<TeamDeployRow>("teamDeploys", deploySig, workspace);
  const productions = useWorkspaceCollection<DeployProductionRow>("deployProductions", productionSig, workspace);
  return useMemo(() => ({ targets, deploys, productions, ready }), [targets, deploys, productions, ready]);
}
