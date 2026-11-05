// A workspace's flow map (convex flowMap.forTeam, shared/contracts/flowMap.ts):
// its sources, the live flow's lanes and the pipeline header's counts. The
// feeder hands the query's answer to the store as one row keyed by its
// workspace; the reader paints from the store. The query is named by
// reference, so a deployment without it answers an error the feeder keeps to
// itself, and the surfaces it feeds stay empty.
import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const FOR_TEAM = makeFunctionReference<"query">("flowMap:forTeam");
const RUNS_BY_IDS = makeFunctionReference<"query">("workflow_runs:byIds");
/** workflow_runs.byIds answers at most this many (RUNS_BY_IDS_MAX). */
const HEAL_MAX = 200;
const LIVE = new Set(["pending", "running", "paused"]);

/** A short digest of the map's live run ids, so its wake signature never spells them out. */
const idsDigest = (ids: ReadonlyArray<string> | undefined) => {
  if (!ids) return "";
  let h = 0;
  for (const id of ids) for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `${ids.length}:${h}`;
};

type FlowMapRow = FlowMap & { _id: string };

const asRows = (m: FlowMap | null | undefined) => (m ? [{ ...m, _id: m.workspace }] : m);

const mapSig = (m: FlowMapRow) => [
  m.rolledAt ?? "",
  idsDigest(m.liveRunIds),
  Object.values(m.header).join(","),
  m.liveFlow ? `${m.liveFlow.on}|${m.liveFlow.hold?.why ?? ""}|${m.liveFlow.running}|${m.liveFlow.stalled}|${m.liveFlow.queued}|${m.liveFlow.handsToday}|${m.liveFlow.cap}|${m.liveFlow.finishedToday}` : "",
  m.lanes.map((l) => `${l.key}:${l.steps.map((s) => `${s.id}=${s.running}/${s.stalled}/${s.waiting}`).join(",")}`).join(";"),
  `${m.off.running}/${m.off.stalled}:${m.off.steps.map((s) => `${s.id}=${s.running}/${s.stalled}/${s.waiting}`).join(",")}`,
  // A server from before the shipped list sends none; its row still paints.
  (m.shipped ?? []).map((r) => `${r.taskId}|${r.state}|${r.until}|${r.reopenedAt}`).join(";"),
  m.sources.map((s) => `${s.key}|${s.state}|${s.lastAt}|${s.today}|${s.route}|${s.outcomes.total}|${s.unfiled}|${s.escapes}`).join(";"),
].join("\n");

/** Reader: the workspace's flow map as the store holds it (the shell mounts the feeder, useFlowMap). */
export function useFlowMapRow(space: string | null | undefined): FlowMap | null {
  const rows = useWorkspaceCollection<FlowMapRow>("flowMaps", mapSig, space ?? null);
  return rows[0] ?? null;
}

/** Feeder and reader: the workspace's flow map, or null before it answers (or where nobody has rolled one up). */
export function useFlowMap(space: string | null | undefined): FlowMap | null {
  useSyncCollection("flowMaps", FOR_TEAM, space ? { workspace: space } : "skip", { select: asRows });
  const map = useFlowMapRow(space);
  useHealLiveRuns(space, map?.liveRunIds);
  return map;
}

/**
 * The store's runs arrive through windowed delta feeds (listRuns keeps a workspace's newest), so a run that ended after
 * it left every window keeps reading live in the store forever: at a step it adds a run nobody is working, and on a
 * person a wait nobody owes. The flow map names every run the server holds live now; each run the store holds live in
 * the same workspace that the map does not name is asked for again by id, and its row heals in place. Read once per
 * map, never as a store subscription: the walk is over every run.
 */
function useHealLiveRuns(space: string | null | undefined, live: ReadonlyArray<string> | undefined) {
  const key = idsDigest(live);
  const stale = useMemo(() => {
    if (!space || !live) return [];
    const named = new Set(live);
    const runs = ((useInboxStore.getState() as unknown as { workflowRuns?: Record<string, { _id: string; status?: string; workspace?: string }> }).workflowRuns) ?? {};
    const out: string[] = [];
    for (const r of Object.values(runs)) if (r.workspace === space && LIVE.has(r.status ?? "") && !named.has(r._id)) out.push(r._id);
    return out.sort().slice(0, HEAL_MAX);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the digest carries every id the walk reads
  }, [space, key]);
  useSyncCollection("workflowRuns", RUNS_BY_IDS, stale.length ? { ids: stale } : "skip");
}
