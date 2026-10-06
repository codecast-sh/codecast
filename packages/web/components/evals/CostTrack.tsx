// A thin bar per batch under the seismograph, split into what the model cost
// and what the judge cost (index costUsd and judgeCostUsd, never spend.jsonl).
// It shares the chart's columns and hover, so a bar sits under its batch.

import { useState } from "react";
import { axisUsd, niceCeil, usd, type SurfaceColumns } from "@platform/evals/client";
import { useEvalsHost } from "./host";

const H = 46;
const TOP = 6;

export function CostTrack({ cols, hover, onHover, pinned, compare }: { cols: SurfaceColumns; hover: string | null; onHover: (batch: string | null) => void; pinned: string | null; compare: string | null }) {
  const { list, width: w, padL, padR } = cols;
  const { HoverTip } = useEvalsHost().ui;
  const [tipAt, setTipAt] = useState<{ x: number; y: number } | null>(null);
  // The top is a round number, so its label stays short enough for the gutter.
  const max = niceCeil(Math.max(0.0001, ...list.map((c) => c.stats.costUsd + c.stats.judgeCostUsd)));
  const barW = Math.max(2, Math.min(10, cols.gap * 0.55));
  const h = (v: number) => (v / max) * (H - TOP - 2);
  const total = list.reduce((s, c) => s + c.stats.costUsd + c.stats.judgeCostUsd, 0);
  const hoverCol = hover ? cols.byBatch.get(hover) ?? null : null;
  return (
    <div className="ev-sf-cost" data-ev-cost>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`Spend per batch, ${usd(total)} in view`} className="ev-strip">
        <text x={padL - 8} y={TOP + 7} textAnchor="end" className="ev-sf-ylabel">{axisUsd(max)}</text>
        <text x={padL - 8} y={H - 2} textAnchor="end" className="ev-sf-ylabel">$0</text>
        <line x1={padL} x2={w - padR} y1={H - 1} y2={H - 1} className="ev-sf-axis" />
        {list.map((c) => {
          const model = h(c.stats.costUsd);
          const judge = h(c.stats.judgeCostUsd);
          const on = c.batch === hover || c.batch === pinned || c.batch === compare;
          return (
            <g
              key={c.batch}
              data-ev-cost-bar={c.batch}
              opacity={hover && !on ? 0.55 : 1}
              onMouseEnter={(e) => {
                onHover(c.batch);
                setTipAt({ x: e.clientX, y: (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect().top });
              }}
              onMouseLeave={() => {
                onHover(null);
                setTipAt(null);
              }}
            >
              <rect x={c.x - barW / 2 - 1} y={0} width={barW + 2} height={H} fill="transparent" />
              <rect x={c.x - barW / 2} y={H - 1 - model} width={barW} height={model} rx={1} className="ev-sf-cost-model" />
              <rect x={c.x - barW / 2} y={H - 1 - model - judge} width={barW} height={judge} rx={1} className="ev-sf-cost-judge" />
            </g>
          );
        })}
      </svg>
      {tipAt && hoverCol && (
        <HoverTip x={tipAt.x} y={tipAt.y}>
          <div className="ev-sf-tip">
            <div>
              <b>{usd(hoverCol.stats.costUsd + hoverCol.stats.judgeCostUsd)}</b> this batch
            </div>
            <div className="ev-sf-tip-dim">
              model {usd(hoverCol.stats.costUsd)}, judge {usd(hoverCol.stats.judgeCostUsd)}
            </div>
          </div>
        </HoverTip>
      )}
    </div>
  );
}
