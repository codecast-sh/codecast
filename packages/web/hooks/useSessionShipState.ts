// Where a session's work is on its way to production, for its inbox card
// (lib/ship/sessionShip): the team's sessions' newest change runs and the
// team's deploy records, fed once for the shell (useSyncTeamShipFeeds, in
// HostFeeders), and one map of every session's state built once per change of
// either collection, which each card reads its own entry of through its one
// store subscription (SessionCard), as a signature string.
import { useInboxStore } from "../store/inboxStore";
import { activeTeamIdOf } from "../lib/activeTeam";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useSyncTeamDeployRecords } from "./useSyncDeployTargets";
import { workspaceRows } from "./useWorkspaceCollection";
import { activeWorkspaceKeyOf } from "../lib/workspaceScope";
import { sessionShips, type SessionShip } from "../lib/ship/sessionShip";
import type { TeamDeployRow } from "../lib/deploys/targets";

const api = _api as any;

/** Feeder: the active team's sessions' change runs and its deploy records. Mounted once, on the sync host. */
export function useSyncTeamShipFeeds() {
  const teamId = useInboxStore((s) => activeTeamIdOf(s) ?? null);
  useSyncCollection("workflowRuns", api.sessionFlowRuns.forTeam, teamId ? { team_id: teamId } : "skip");
  useSyncTeamDeployRecords(teamId);
}

type ShipState = {
  workflowRuns?: Record<string, any>;
  teamDeploys?: Record<string, TeamDeployRow>;
  clientState: { ui?: { active_team_id?: string | null } };
  currentUser?: { _id?: unknown } | null;
};

let memo: { runs: unknown; deploys: unknown; workspace: string | null; map: Map<string, SessionShip> } | null = null;

function shipMap(s: ShipState): Map<string, SessionShip> {
  const workspace = activeWorkspaceKeyOf(s);
  if (memo && memo.runs === s.workflowRuns && memo.deploys === s.teamDeploys && memo.workspace === workspace) return memo.map;
  const deploys = workspaceRows<TeamDeployRow>("teamDeploys", s.teamDeploys ?? {}, workspace);
  const map = sessionShips(Object.values(s.workflowRuns ?? {}), deploys);
  memo = { runs: s.workflowRuns, deploys: s.teamDeploys, workspace, map };
  return map;
}

/** One session's ship state as a string, "" when nothing of its work is on its way or out: a dep for the card's subscription, so it wakes only when the words change. */
export function sessionShipSig(s: ShipState, conversationId: string | null | undefined): string {
  const v = conversationId ? shipMap(s).get(conversationId) : undefined;
  return v ? `${v.tone}\u0000${v.words}\u0000${v.deploy ?? ""}\u0000${v.run ?? ""}` : "";
}

/** The ship state a signature from sessionShipSig spells, or null for "". */
export function sessionShipFromSig(sig: string): SessionShip | null {
  if (!sig) return null;
  const [tone, words, deploy, run] = sig.split("\u0000");
  return { tone: tone as SessionShip["tone"], words, deploy: deploy || null, run: run || null };
}

/** One session's ship state, for a list row that has no card subscription to fold it into (mobile's SessionItem). */
export function useSessionShip(conversationId: string | null | undefined): SessionShip | null {
  const sig = useInboxStore((s) => sessionShipSig(s as unknown as ShipState, conversationId));
  return sessionShipFromSig(sig);
}
