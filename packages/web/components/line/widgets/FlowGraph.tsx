"use client";
// A flow of the pool drawn as the line is drawn (docs/architecture/flows.md
// FL6): the Graph view's own drawing over the flow's stations, a segment as
// one station when folded, and a run's path lit on the expanded graph. Every
// surface that shows a flow (the Flows view, a `flow` fence, the card of a
// `cast flow run`) draws it here.
import { memo, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { buildLineModel, type LineRunModel } from "../../../lib/line/lineModel";
import type { MapRun } from "../../../lib/line/lineMap";
import { flowGraphSource, type ShippedFlow } from "../../../lib/line/flowPool";
import { lineWorkspaceHref } from "../../../lib/line/lineWorkspaceUrl";
import { graphKeyOf } from "../../../lib/line/lineGraphs";
import { GraphMini } from "../workspace/views/graph/GraphMini";

export type FlowGraphProps = {
  flow: ShippedFlow;
  /** A run of this flow: its path lights, station by station. Draws the expanded graph. */
  run?: MapRun | null;
  /** Folded (each segment one station) unless a run is shown. */
  mode?: "folded" | "expanded";
  /** A click on a station; by default it opens the flow on the Line page at that station. */
  onOpen?: (stationId: string) => void;
};

export const FlowGraph = memo(function FlowGraph({ flow, run = null, mode, onOpen }: FlowGraphProps) {
  const drawn = mode ?? (run ? "expanded" : "folded");
  const model = useMemo(
    () => buildLineModel({ runs: run ? [run] : [], tasks: [], graph: flowGraphSource(flow, drawn) }, run ? graphKeyOf(run) : flow.slug),
    [flow, run, drawn],
  );
  const lit: LineRunModel | null = run ? model.runs.find((r) => r.id === run._id) ?? null : null;
  const router = useRouter();
  const open = useCallback(
    (id: string) => (onOpen ? onOpen(id) : router.push(lineWorkspaceHref(null, { view: "process", graph: flow.slug, step: id } as any))),
    [onOpen, router, flow.slug],
  );
  return (
    <div className="lw-flow-graph" data-flow-graph={flow.slug} data-flow-mode={drawn}>
      <GraphMini model={model} run={lit} onOpen={open} />
    </div>
  );
});
