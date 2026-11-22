// Where a session's work is on its way to production, for its inbox card
// (lib/ship/sessionShip): the team's sessions' newest change runs and the
// team's deploy records, fed once for the shell (useSyncTeamShipFeeds, in
// HostFeeders), and one map of every session's state built once per change of
// either collection, which each card reads its own entry of through its one
// store subscription (SessionCard), as a signature string.
import { useMemo } from "react";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { activeTeamIdOf } from "../lib/activeTeam";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useSyncTeamDeployRecords } from "./useSyncDeployTargets";
import { workspaceRows } from "./useWorkspaceCollection";
import { activeWorkspaceKeyOf } from "../lib/workspaceScope";
import { landedShas, sessionShips, type SessionShip } from "../lib/ship/sessionShip";
import type { TeamDeployRow } from "../lib/deploys/targets";
import { cachedAt, pinDetailRows } from "../lib/detailRows";
import { useWatchEffect } from "./useWatchEffect";
import type { DeployReachRow } from "./useDeployReach";

const api = _api as any;

/** Feeder: the active team's sessions' change runs and its deploy records. Mounted once, on the sync host. */
export function useSyncTeamShipFeeds() {
  // isConvexId: a just-created team holds a "team-stub-…" id until its
  // create echoes, and both queries take an Id<"teams">; skip until it is real.
  const teamId = useInboxStore((s) => {
    const id = activeTeamIdOf(s);
    return id && isConvexId(id) ? id : null;
  });
  useSyncCollection("workflowRuns", api.sessionFlowRuns.forTeam, teamId ? { team_id: teamId } : "skip");
  useSyncTeamDeployRecords(teamId);
}

/** The landed runs' commits, sorted and joined: the feeder's args change only when the set does. */
let landedMemo: { runs: unknown; workspace: string | null; key: string } | null = null;
const landedKey = (s: ShipState): string => {
  // The cards on screen are the active workspace's: its runs only.
  const workspace = activeWorkspaceKeyOf(s);
  if (!landedMemo || landedMemo.runs !== s.workflowRuns || landedMemo.workspace !== workspace) {
    const runs = Object.values(s.workflowRuns ?? {}).filter((r: any) => !workspace || !r.workspace || r.workspace === workspace);
    landedMemo = { runs: s.workflowRuns, workspace, key: landedShas(runs).join(",") };
  }
  return landedMemo.key;
};

/**
 * Feeder: how far each change a session's newest run landed has gone toward production (deployReach.many), so its card
 * says "Not live yet", "Deploying" or "Live" from the deploy records rather than from the run. Every window feeds its own
 * (deployReach is per-window), from the runs replication already gives it; the rows are pinned while they are asked for.
 */
export function useSyncLandedReach() {
  const key = useInboxStore((s) => landedKey(s as unknown as ShipState));
  const { refs, opts } = useMemo(() => {
    const refs = key ? key.split(",") : [];
    const asked = new Set(refs);
    return {
      refs,
      opts: {
        select: (rows: DeployReachRow[] | null) => rows?.map((r) => ({ ...r, _cachedAt: cachedAt(useInboxStore.getState().deployReach?.[r._id] as DeployReachRow | undefined, Date.now()) })),
        // The answer is the whole truth about the refs asked: one it leaves out touches no target, or is not on main yet.
        dropAbsent: (row: { _id: string }) => asked.has(row._id),
      },
    };
  }, [key]);
  useSyncCollection("deployReach", api.deployReach.many, refs.length ? { refs } : "skip", opts);
  useWatchEffect(() => (refs.length ? pinDetailRows("deployReach", refs) : undefined), [key]);
}

type ShipState = {
  workflowRuns?: Record<string, any>;
  teamDeploys?: Record<string, TeamDeployRow>;
  deployReach?: Record<string, DeployReachRow>;
  clientState: { ui?: { active_team_id?: string | null } };
  currentUser?: { _id?: unknown } | null;
};

let memo: { runs: unknown; deploys: unknown; reach: unknown; workspace: string | null; map: Map<string, SessionShip> } | null = null;

function shipMap(s: ShipState): Map<string, SessionShip> {
  const workspace = activeWorkspaceKeyOf(s);
  if (memo && memo.runs === s.workflowRuns && memo.deploys === s.teamDeploys && memo.reach === s.deployReach && memo.workspace === workspace) return memo.map;
  const deploys = workspaceRows<TeamDeployRow>("teamDeploys", s.teamDeploys ?? {}, workspace);
  const map = sessionShips(Object.values(s.workflowRuns ?? {}), deploys, s.deployReach ?? {});
  memo = { runs: s.workflowRuns, deploys: s.teamDeploys, reach: s.deployReach, workspace, map };
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
