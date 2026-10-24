"use client";
// The flows app's header is the pipeline (doc "Signals to shipped: one
// pipeline"): Signals, Problems, Flows, Decisions, Shipped, each one number and
// its state, each the way into its view, the open one marked. G then the
// stage's key opens it too. A number the map has not answered yet shows as a
// dash, never as a zero that would read as settled.
import { memo } from "react";
import { KeyCap } from "../../KeyCap";
import { PIPELINE_KEYS, PIPELINE_LABELS, PIPELINE_STAGES, type PipelineStage, type StageFigure } from "../../../lib/line/pipeline";
import "./pipeline.css";

export const PipelineHeader = memo(function PipelineHeader({ figures, at, open }: { figures: Record<PipelineStage, StageFigure>; at: PipelineStage | null; open: (stage: PipelineStage) => void }) {
  return (
    <nav className="pl" aria-label="Pipeline" data-pipeline>
      {PIPELINE_STAGES.map((stage) => {
        const f = figures[stage];
        return (
          <button key={stage} type="button" className="pl-stage" aria-current={at === stage ? "page" : undefined} aria-keyshortcuts={`G ${PIPELINE_KEYS[stage].toUpperCase()}`} onClick={() => open(stage)} data-pipeline-stage={stage}>
            <span className="pl-label">
              {PIPELINE_LABELS[stage]}
              <span className="pl-key" aria-hidden><KeyCap size="xs">G</KeyCap><KeyCap size="xs">{PIPELINE_KEYS[stage].toUpperCase()}</KeyCap></span>
            </span>
            <span className="pl-fig"><b className="lw-num">{f.n == null ? "–" : f.n.toLocaleString()}</b> {f.unit}</span>
            <span className="pl-state">
              {f.state.map((s, i) => <span key={i} className="pl-word" data-tone={s.tone}><i aria-hidden />{s.words}</span>)}
            </span>
          </button>
        );
      })}
    </nav>
  );
});
