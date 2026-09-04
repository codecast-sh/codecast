"use client";
/**
 * Remaining work over time, projected forward to the deadline.
 *
 * Same hand-drawn SVG discipline as ProgressChart (which sits beside it and
 * explains why: no plotting library in app chrome). Where ProgressChart shows
 * how work accumulated, this one answers the sharper question — will it be
 * done by the date? The history is a solid falling line; the future is a
 * dotted line at the current pace; the deadline is a vertical rule. Whether
 * the dotted line reaches the floor before the rule IS the verdict, and the
 * header says it in words.
 *
 * Text stays out of the SVG: preserveAspectRatio="none" would distort glyphs,
 * so labels live in the header and footer rows like every chart here.
 */
import { useMemo } from "react";
import type { Burndown } from "../lib/projectProgress";

const W = 600;
const H = 120;
const DAY = 86_400_000;

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDays(ms: number): string {
  const days = Math.round(Math.abs(ms) / DAY);
  if (days === 0) return "the same day";
  return days === 1 ? "1 day" : `${days} days`;
}

export function BurndownChart({ burndown, className = "" }: { burndown: Burndown; className?: string }) {
  const { points, remaining, deadline, projectedEnd, verdict } = burndown;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const now = points[points.length - 1].t;
    // The frame must hold the whole story: history, the projected landing, and
    // the deadline — plus headroom so neither pins to the right edge. But a
    // crawling pace can put the landing years out, and drawing that would
    // crush the history into a sliver; past the cap the dotted line runs off
    // the frame's edge instead, and the headline still names the date.
    const historySpan = Math.max(now - t0, DAY);
    const horizon = now + historySpan * 2;
    const tEnd = Math.min(Math.max(now, projectedEnd ?? 0, deadline ?? 0), horizon);
    const t1 = tEnd + Math.max((tEnd - t0) * 0.04, DAY / 4);
    const span = Math.max(t1 - t0, 1);
    const maxRemaining = Math.max(1, ...points.map((p) => p.remaining)) * 1.08;
    const x = (t: number) => ((t - t0) / span) * W;
    const y = (v: number) => H - (v / maxRemaining) * H;
    const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.remaining).toFixed(1)}`).join(" L");
    return {
      t0,
      t1,
      now,
      x,
      y,
      remainingLine: `M${line}`,
      remainingArea: `M${line} L${x(now).toFixed(1)},${H} L0,${H} Z`,
    };
  }, [points, deadline, projectedEnd]);

  if (!geom) {
    return (
      <div className={`text-[11px] text-sol-text-dim ${className}`}>
        Not enough history yet — the burndown appears once this project has a day of work behind it.
      </div>
    );
  }

  // The projection's color carries the verdict; everything else stays calm.
  const projColor =
    verdict === "miss" ? "var(--sol-red)" : verdict === "hit" ? "var(--sol-green)" : "var(--sol-text-dim)";

  const headline = (() => {
    switch (verdict) {
      case "done":
        return { text: "Done", detail: "nothing remaining", color: "text-sol-green" };
      case "hit":
        return {
          text: "On track",
          detail: `projected ${fmtDay(projectedEnd!)}, ${fmtDays(deadline! - projectedEnd!)} to spare`,
          color: "text-sol-green",
        };
      case "miss":
        return {
          text: "At risk",
          detail: `projected ${fmtDay(projectedEnd!)}, ${fmtDays(projectedEnd! - deadline!)} past the deadline`,
          color: "text-sol-red",
        };
      case "no_deadline":
        return {
          text: `Projected ${fmtDay(projectedEnd!)}`,
          detail: "set a deadline to judge it against",
          color: "text-sol-text",
        };
      case "no_velocity":
        return {
          text: "Stalled",
          detail: "nothing finished in the last two weeks, so there is no pace to project",
          color: "text-sol-yellow",
        };
    }
  })();

  return (
    <div className={className}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className={`text-sm font-medium ${headline.color}`}>{headline.text}</span>
        <span className="text-[11px] text-sol-text-dim">
          {headline.detail}
          {remaining > 0 && <span className="tabular-nums"> · {remaining} remaining</span>}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[120px]"
        role="img"
        aria-label={`Burndown: ${remaining} tasks remaining${
          projectedEnd ? `, projected done ${fmtDay(projectedEnd)}` : ""
        }${deadline ? `, deadline ${fmtDay(deadline)}` : ""}`}
      >
        {/* The past: remaining work, falling (one hopes). */}
        <path d={geom.remainingArea} fill="var(--sol-blue)" fillOpacity={0.12} />
        <path
          d={geom.remainingLine}
          fill="none"
          stroke="var(--sol-blue)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {/* The future: current pace carried forward, dotted because it is a
            guess. Its color is the verdict. */}
        {projectedEnd !== undefined && remaining > 0 && (() => {
          // When the landing sits past the clamped frame, draw the same slope
          // up to the frame's edge — the line stays honest, just cut off.
          const xNow = geom.x(geom.now);
          const yNow = geom.y(remaining);
          const xLand = geom.x(projectedEnd);
          const clip = Math.min(xLand, W);
          const yEnd = xLand <= W ? H : yNow + ((H - yNow) * (clip - xNow)) / (xLand - xNow || 1);
          return (
            <path
              d={`M${xNow.toFixed(1)},${yNow.toFixed(1)} L${clip.toFixed(1)},${yEnd.toFixed(1)}`}
              fill="none"
              stroke={projColor}
              strokeWidth={1.5}
              strokeDasharray="1 5"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })()}
        {/* The date: a vertical rule. The one hard fact on the chart. */}
        {deadline !== undefined && (
          <line
            // A deadline outside the frame (already passed before the project
            // began, or past the clamped horizon) pins to the nearest edge so
            // the legend's swatch always points at a visible rule.
            x1={Math.min(Math.max(geom.x(deadline), 1), W - 1).toFixed(1)}
            y1={0}
            x2={Math.min(Math.max(geom.x(deadline), 1), W - 1).toFixed(1)}
            y2={H}
            stroke="var(--sol-amber)"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* Today: the hinge between fact and forecast. */}
        <circle
          cx={geom.x(geom.now).toFixed(1)}
          cy={geom.y(remaining).toFixed(1)}
          r={2.5}
          fill="var(--sol-blue)"
        />
      </svg>
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[10px] text-sol-text-dim">
            <span className="w-2.5 h-0.5 rounded-sm flex-shrink-0" style={{ background: "var(--sol-blue)" }} />
            Remaining
            <span className="tabular-nums text-sol-text-muted">{remaining}</span>
          </span>
          {projectedEnd !== undefined && remaining > 0 && (
            <span className="flex items-center gap-1.5 text-[10px] text-sol-text-dim">
              <span
                className="w-2.5 h-0.5 rounded-sm flex-shrink-0"
                style={{
                  background: `repeating-linear-gradient(90deg, ${projColor} 0 2px, transparent 2px 4px)`,
                }}
              />
              Projection
              <span className="tabular-nums text-sol-text-muted">{fmtDay(projectedEnd)}</span>
            </span>
          )}
          {deadline !== undefined && (
            <span className="flex items-center gap-1.5 text-[10px] text-sol-text-dim">
              <span className="w-2.5 h-0.5 rounded-sm flex-shrink-0" style={{ background: "var(--sol-amber)" }} />
              Deadline
              <span className="tabular-nums text-sol-text-muted">{fmtDay(deadline)}</span>
            </span>
          )}
        </div>
        <span className="text-[10px] text-sol-text-dim tabular-nums">
          {fmtDay(geom.t0)} → {fmtDay(geom.t1)}
        </span>
      </div>
    </div>
  );
}
