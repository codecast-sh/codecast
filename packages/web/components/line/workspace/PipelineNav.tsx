"use client";
// The flows app's left nav (doc "Signals to shipped: one pipeline"): For you
// first, the decisions waiting on the viewer with their count, then the
// whole line at a glance (Volume), then the pipeline's stages in the order work moves through them, Signals, Problems,
// Flows and Shipped, joined by a rail. Each shows its number and its state and
// opens its view; the open one is marked. G then the stage's key opens it too.
// A number the map has not answered yet shows as a dash, never as a zero that
// would read as settled.
import { memo } from "react";
import Link from "next/link";
import { AlertCircle, BarChart3, GitMerge, Inbox, Rocket, Rss, Workflow, type LucideIcon } from "lucide-react";
import { KeyCap } from "../../KeyCap";
import { PIPELINE_KEYS, PIPELINE_LABELS, PIPELINE_RAIL, type PipelineStage, type StageFigure } from "../../../lib/line/pipeline";
import "./pipeline.css";

const ICONS: Record<PipelineStage, LucideIcon> = { decisions: Inbox, signals: Rss, problems: AlertCircle, flows: Workflow, shipped: Rocket, volume: BarChart3 };

/** `pipelines`: the team's pipelines are open (the app's landing, pipeline.md PL6), the nav's first item. */
export const PipelineNav = memo(function PipelineNav({ figures, at, open, settling, pipelines = false }: { figures: Record<PipelineStage, StageFigure>; at: PipelineStage | null; open: (stage: PipelineStage) => void; settling?: boolean; pipelines?: boolean }) {
  const item = (stage: PipelineStage) => {
    const f = figures[stage];
    const Icon = ICONS[stage];
    // Its name stays on the button when a narrow window folds the nav to icons (pipeline.css hides the label).
    const name = [PIPELINE_LABELS[stage], f.n?.toLocaleString(), stage !== "decisions" ? f.unit : null, ...f.state.map((s) => s.words)].filter(Boolean).join(" ");
    return (
      <button key={stage} type="button" className="pn-item" aria-label={name} title={PIPELINE_LABELS[stage]} aria-current={at === stage ? "page" : undefined} aria-keyshortcuts={`G ${PIPELINE_KEYS[stage].toUpperCase()}`} onClick={() => open(stage)} data-pipeline-stage={stage}>
        <Icon className="pn-icon" aria-hidden />
        <span className="pn-label">{PIPELINE_LABELS[stage]}</span>
        <b className="pn-n lw-num" data-tone={stage === "decisions" && f.n ? "ask" : undefined}>{f.n == null ? "–" : f.n.toLocaleString()}</b>
        <span className="pn-key" aria-hidden><KeyCap size="xs">G</KeyCap><KeyCap size="xs">{PIPELINE_KEYS[stage].toUpperCase()}</KeyCap></span>
        {/* What the number counts (For you's label already says it), then the stage's state. */}
        <span className="pn-state">
          {stage !== "decisions" ? <span className="pn-unit">{f.unit}</span> : null}
          {f.state.map((s, i) => <span key={i} className="pl-word" data-tone={s.tone} title={s.words}><i aria-hidden /><span className="pl-word-t">{s.words}</span></span>)}
        </span>
      </button>
    );
  };
  return (
    <nav className="pn" aria-label="Flows" data-pipeline data-settling={settling ? "" : undefined}>
      <Link href="/flows" className="pn-item" aria-label="Pipelines" title="Pipelines" aria-current={pipelines ? "page" : undefined} data-pipelines-link>
        <GitMerge className="pn-icon" aria-hidden />
        <span className="pn-label">Pipelines</span>
      </Link>
      {item("decisions")}
      {item("volume")}
      <div className="pn-rail" data-pipeline-rail>{PIPELINE_RAIL.map(item)}</div>
    </nav>
  );
});
