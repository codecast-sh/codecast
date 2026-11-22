// The whole loop of a workspace (the Flows page's Loop view, lib/line/flowLoop.ts):
// read from the store's flow map, runs, library, role-owned flows and deploys,
// with the measured rates (landedChanges.summary, ct-87140) where the backend
// has them. The deploys are fed here too, so the loop's counts do not wait on
// the Deploys page having been opened.
import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import { flowLoop, type FlowLoop } from "../lib/line/flowLoop";
import type { RegretSummary, RegretThrough, StationRow } from "@codecast/shared/contracts/regretRates";
import type { LoopRates, Measured } from "../components/line/workspace/views/flows/FlowLoop";
import type { LineWorkspace } from "./useLineWorkspace";
import { useFlowLibrary } from "./useFlowLibrary";
import { useFlowMapRow } from "./useFlowMap";
import { useOwnedFlows } from "./useOwnedFlows";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useSyncDeployTargets } from "./useSyncDeployTargets";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const RATES = makeFunctionReference<"query">("landedChanges:summary");

type Deploy = { status: string; live_at?: number | null; created_at: number };
const deploySig = (d: Deploy) => `${d.status}|${d.live_at ?? ""}`;

/** A sample measured: changes merged, how many have settled (their window has passed), and the share of those no later fix traced back to. */
const measure = (rows: ReadonlyArray<{ merged?: number; passed?: number; settled: number; regretted: number }>): Measured => {
  const n = rows.reduce((t, r) => t + (r.merged ?? r.passed ?? 0), 0);
  const settled = rows.reduce((t, r) => t + r.settled, 0);
  const regretted = rows.reduce((t, r) => t + r.regretted, 0);
  return { n, settled, rate: settled ? (settled - regretted) / settled : null };
};

export function useFlowLoop(space: string | null | undefined, workspace: LineWorkspace): { loop: FlowLoop; rates: LoopRates } {
  const team = space?.startsWith("team:") ? space.slice(5) : null;
  const { flows, runsOf, live } = useFlowLibrary(space);
  const map = useFlowMapRow(space);
  const owned = useOwnedFlows(workspace);
  useSyncDeployTargets(team);
  const deploys = useWorkspaceCollection<Deploy>("teamDeploys", deploySig, space ?? null);
  // The rates enrich two places (autonomy, each check); a backend without them answers nothing and the places stay empty.
  const { data } = useQueryNoThrow(RATES, team ? { team_id: team } : "skip");
  const now = workspace.now;
  const queued = live?.queue.length ?? 0;
  const loop = useMemo(() => flowLoop({ map, runs: [...runsOf.values()].flat(), library: flows, owned, deploys, queued, now }), [map, runsOf, flows, owned, deploys, queued, now]);
  const rates = useMemo<LoopRates>(() => {
    const d = data as RegretSummary | null | undefined;
    if (!d?.changes) return null;
    const through = (t: RegretThrough) => measure(d.changes.filter((c) => c.through === t));
    // A check's sample, by the segment it belongs to (review__review is Review's), its rate the share it missed.
    const bySeg = new Map<string, StationRow[]>();
    for (const st of d.stations ?? []) { const seg = st.node_id.split("__")[0]; bySeg.set(seg, [...(bySeg.get(seg) ?? []), st]); }
    const checks = new Map([...bySeg].map(([seg, rows]) => { const m = measure(rows); return [seg, { ...m, rate: m.rate == null ? null : 1 - m.rate }]; }));
    return { windowDays: d.window_days, line: through("line"), person: through("session_flow"), outside: through("outside"), checks };
  }, [data]);
  return { loop, rates };
}
