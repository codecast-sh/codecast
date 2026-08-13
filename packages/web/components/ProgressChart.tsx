"use client";
/**
 * Completion over time: scope, started and done.
 *
 * Hand-drawn SVG rather than a plotting library, on purpose. The app already
 * lazy-loads Observable Plot for agent-authored canvases inside a shadow root —
 * reaching for it here would drag an async boundary and a resize observer into a
 * header panel to draw three monotone lines. A viewBox scales for free, the
 * solarized tokens theme it live, and it renders on the first frame.
 *
 * The three series carry different weight because they answer different
 * questions. Scope is a ceiling, so it is a thin dim line with no fill. Done is
 * the answer you came for, so it is the filled band. Started sits between them,
 * and the gap between started and done IS the work in flight — which is why they
 * are drawn as lines you can see between, not as stacked areas that merge.
 */
import { useMemo } from "react";
import type { ProgressSeries } from "../lib/projectProgress";

// Viewbox is deliberately close to the rendered aspect so `preserveAspectRatio:
// none` distorts only mildly; strokes stay true via non-scaling-stroke.
const W = 600;
const H = 120;

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ProgressChart({ series, className = "" }: { series: ProgressSeries; className?: string }) {
  const { points } = series;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    // Scope is the tallest series by construction, so it sets the scale. The
    // headroom keeps the top line off the frame's edge.
    const max = Math.max(1, points[points.length - 1].scope) * 1.08;
    const x = (t: number) => ((t - t0) / span) * W;
    const y = (v: number) => H - (v / max) * H;
    const line = (get: (p: (typeof points)[number]) => number) =>
      points.map((p) => `${x(p.t).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" L");
    const doneLine = line((p) => p.done);
    return {
      t0,
      t1,
      scope: `M${line((p) => p.scope)}`,
      started: `M${line((p) => p.started)}`,
      done: `M${doneLine}`,
      doneArea: `M${doneLine} L${W},${H} L0,${H} Z`,
    };
  }, [points]);

  if (!geom) {
    return (
      <div className={`text-[11px] text-sol-text-dim ${className}`}>
        Not enough history yet — the chart appears once this project has a day of work behind it.
      </div>
    );
  }

  const pct = series.scope > 0 ? Math.round((series.done / series.scope) * 100) : 0;

  return (
    <div className={className}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-lg font-medium text-sol-text tabular-nums">{pct}%</span>
        <span className="text-[11px] text-sol-text-dim tabular-nums">
          {series.done} of {series.scope} done
          {series.started > series.done && ` · ${series.started - series.done} in flight`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[120px]"
        role="img"
        aria-label={`Completion over time: ${series.done} of ${series.scope} done, ${series.started} started`}
      >
        {/* Done — the filled band, because it is the question being asked. */}
        <path d={geom.doneArea} fill="var(--sol-green)" fillOpacity={0.18} />
        <path
          d={geom.done}
          fill="none"
          stroke="var(--sol-green)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {/* Started — the frontier of work picked up. */}
        <path
          d={geom.started}
          fill="none"
          stroke="var(--sol-yellow)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {/* Scope — a ceiling, drawn dashed so a rising one reads as scope growth
            rather than as another kind of progress. */}
        <path
          d={geom.scope}
          fill="none"
          stroke="var(--sol-text-dim)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-3">
          {[
            { label: "Done", color: "var(--sol-green)", value: series.done },
            { label: "Started", color: "var(--sol-yellow)", value: series.started },
            { label: "Scope", color: "var(--sol-text-dim)", value: series.scope },
          ].map((band) => (
            <span key={band.label} className="flex items-center gap-1.5 text-[10px] text-sol-text-dim">
              <span className="w-2.5 h-0.5 rounded-sm flex-shrink-0" style={{ background: band.color }} />
              {band.label}
              <span className="tabular-nums text-sol-text-muted">{band.value}</span>
            </span>
          ))}
        </div>
        <span className="text-[10px] text-sol-text-dim tabular-nums">
          {fmtDay(geom.t0)} → {fmtDay(geom.t1)}
        </span>
      </div>
    </div>
  );
}
