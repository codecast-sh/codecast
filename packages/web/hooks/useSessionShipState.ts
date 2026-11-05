// Where a session's work is on its way to production, for its inbox card
// (lib/ship/sessionShip): the team's sessions' newest change runs and the
// team's deploy records, fed once for the shell (useSyncTeamShipFeeds, in
// HostFeeders), and one map of every session's state built once per change of
// either collection, which each card reads its own entry of.
import { useInboxStore } from "../store/inboxStore";
import { activeTeamIdOf } from "../lib/activeTeam";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useSyncTeamDeployRecords } from "./useSyncDeployTargets";
import { sessionShips, type SessionShip } from "../lib/ship/sessionShip";
import type { TeamDeployRow } from "../lib/deploys/targets";

const api = _api as any;

/** Feeder: the active team's sessions' change runs and its deploy records. Mounted once, on the sync host. */
export function useSyncTeamShipFeeds() {
  const teamId = useInboxStore((s) => activeTeamIdOf(s) ?? null);
  useSyncCollection("workflowRuns", api.sessionFlowRuns.forTeam, teamId ? { team_id: teamId } : "skip");
  useSyncTeamDeployRecords(teamId);
}

let memo: { runs: unknown; deploys: unknown; map: Map<string, SessionShip> } | null = null;

function shipMap(s: { workflowRuns?: Record<string, any>; teamDeploys?: Record<string, TeamDeployRow> }): Map<string, SessionShip> {
  if (memo && memo.runs === s.workflowRuns && memo.deploys === s.teamDeploys) return memo.map;
  const map = sessionShips(Object.values(s.workflowRuns ?? {}), Object.values(s.teamDeploys ?? {}));
  memo = { runs: s.workflowRuns, deploys: s.teamDeploys, map };
  return map;
}

/** Reader: one session's ship state, or null when nothing of its work is on its way or out. Re-renders only when its words change. */
export function useSessionShip(conversationId: string | null | undefined): SessionShip | null {
  const key = useInboxStore((s) => {
    const v = conversationId ? shipMap(s as any).get(conversationId) : undefined;
    return v ? `${v.tone}\u0000${v.words}\u0000${v.deploy ?? ""}\u0000${v.run ?? ""}` : "";
  });
  if (!key) return null;
  const [tone, words, deploy, run] = key.split("\u0000");
  return { tone: tone as SessionShip["tone"], words, deploy: deploy || null, run: run || null };
}
