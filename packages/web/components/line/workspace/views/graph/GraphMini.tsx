"use client";
// The line's graph for the chat and a `line` fence (line-workspace.md LW3):
// the Graph view's own drawing, Essence, folded narrower and fitted to the
// column it sits in. Static: no pan or zoom, a click opens the step.
import { memo, useId, useMemo } from "react";
import type { LineModel, LineRunModel } from "../../../../../lib/line/lineModel";
import { GraphCanvas, GraphDefs } from "./GraphCanvas";
import { litRun } from "./litRun";
import { graphLayout } from "./graphLayout";

/** Rows fold narrower than the view's, so a chat column reads the cards at about two thirds of their size. */
const MINI_WRAP = 1080;

export type GraphMiniProps = { model: LineModel; run?: LineRunModel | null; selectedStep?: string | null; onOpen: (id: string) => void };

export const GraphMini = memo(function GraphMini({ model, run, selectedStep = null, onOpen }: GraphMiniProps) {
  const layout = useMemo(() => graphLayout(model.graph, { mode: "essence", wrap: MINI_WRAP }), [model.graph]);
  const lit = useMemo(() => litRun(run), [run]);
  const uid = `lwgm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const b = layout.bounds;
  return (
    <svg className="lwg-mini" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} role="group" aria-label={`${model.title}: ${model.graph.nodes.length} steps`} data-line-graph-mini="">
      <GraphDefs uid={uid} />
      <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={`url(#${uid}-dots)`} />
      <GraphCanvas model={model} layout={layout} uid={uid} lit={lit} selected={selectedStep} onOpen={onOpen} />
    </svg>
  );
});
