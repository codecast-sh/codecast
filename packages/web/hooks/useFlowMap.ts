// A workspace's flow map (convex flowMap.forTeam, shared/contracts/flowMap.ts):
// its sources, the live flow's lanes and the pipeline header's counts. The
// feeder hands the query's answer to the store as one row keyed by its
// workspace; the reader paints from the store. The query is named by
// reference, so a deployment without it answers an error the feeder keeps to
// itself, and the surfaces it feeds stay empty.
import { makeFunctionReference } from "convex/server";
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const FOR_TEAM = makeFunctionReference<"query">("flowMap:forTeam");

type FlowMapRow = FlowMap & { _id: string };

const asRows = (m: FlowMap | null | undefined) => (m ? [{ ...m, _id: m.workspace }] : m);

const mapSig = (m: FlowMapRow) => [
  m.rolledAt ?? "",
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
  return useFlowMapRow(space);
}
