// A surface's recent history in one row: batch medians as a step line over
// faint rep dots, the 0.7 pass mark as a hairline, prompt epochs as notches on
// the baseline, and footing changes on the axis (a diamond where the model
// moved, a violet slash where the judge's ruler moved). A batch the model was
// never asked about (BatchStats.unasked) is a crash cross on the axis, never a
// median of 0.
//
// On a worse row the strip says where the verdict looked: the baseline
// batches carry cyan ticks on the axis, bracketed, under a dashed cyan level
// at their median, and the red batch is a magenta step and ring with a dotted
// drop from that level, so the fall reads at a glance. The newest batch always
// gets a step wide enough to see.
//
// The cursor is shared: the wall holds one time under the pointer and hands it
// to every strip (the HealthStrip pattern), so each strip only reports where
// the pointer is and draws where the cursor is.

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { PASS_MARK, jitter, linear, nearestIndex, scoreScale, stepPath } from "../../client";
import type { BatchStats, Epoch, FootingMarker, RunRowStatus } from "../../contract";
import { useEvalsHost } from "../hooks";

export interface StripDot {
  batch: string;
  at: string;
  score: number | null;
  status: RunRowStatus;
}

export interface ScoreStripProps {
  strip: BatchStats[];
  dots?: StripDot[];
  epochs?: Epoch[];
  footing?: FootingMarker[];
  /** The window, ms. */
  from: number;
  to: number;
  width: number;
  height?: number;
  /** The shared cursor, ms; null hides it. */
  cursor?: number | null;
  onCursor?: (at: number | null) => void;
  /** A click picks the batch nearest the pointer. */
  onPick?: (batch: string) => void;
  /** A batch drawn as pinned. */
  pinned?: string | null;
  /** The tooltip for the batch under the pointer, shown only on the strip the pointer is on. */
  tip?: (batch: BatchStats) => ReactNode;
  /** The draw-in delay, for staggered rows. */
  delayMs?: number;
  label?: string;
  /** A worse verdict to draw: its batch (the red one) and the baseline batches it was weighed against. */
  emphasis?: { batch: string; baseline: readonly string[] } | null;
}

const PAD_TOP = 3;
const AXIS = 7;
/** The newest batch's step, at least: a batch landing near the right edge still reads as a step, not a sliver. */
const NEWEST_STEP = 12;

/** A footing change on a time axis: a diamond where the model moved, a dashed violet slash where the judge's ruler moved. */
export function FootingGlyph({ marker, x, y, scale = 1 }: { marker: FootingMarker; x: number; y: number; scale?: number }) {
  const d = 3.2 * scale;
  return marker.kind === "model" ? (
    <g className="ev-quiet" data-ev-footing="model">
      <title>{`Model moved from ${marker.from ?? "none"} to ${marker.to ?? "none"}`}</title>
      <path d={`M${x},${y - d} L${x + d},${y} L${x},${y + d} L${x - d},${y} Z`} style={{ fill: "var(--ev-bg)" }} stroke="currentColor" strokeWidth={1.1} />
    </g>
  ) : (
    <g className="ev-ruler" data-ev-footing="judge">
      <title>{`Judge ruler moved from ${marker.from ?? "none"} to ${marker.to ?? "none"}`}</title>
      <line x1={x - 0.8125 * d} x2={x + 0.8125 * d} y1={y + d} y2={y - d} stroke="currentColor" strokeWidth={1.4} strokeDasharray="1.6 1" />
    </g>
  );
}

export function ScoreStrip({ strip, dots = [], epochs = [], footing = [], from, to, width, height = 44, cursor = null, onCursor, onPick, pinned = null, tip, delayMs = 0, label, emphasis = null }: ScoreStripProps) {
  const { HoverTip } = useEvalsHost().ui;
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const w = Math.max(width, 40);
  const x = linear(from, to, 2, w - 2 - NEWEST_STEP);
  const plotBottom = height - AXIS;
  const y = scoreScale(PAD_TOP, plotBottom - 2);
  const batches = strip.filter((b) => !b.dry && !b.unasked && b.median !== null);
  const unasked = strip.filter((b) => b.unasked);
  const unaskedNames = new Set(unasked.map((b) => b.batch));
  const at = (b: { batchAt: string }) => Date.parse(b.batchAt);
  const xs = batches.map((b) => x(at(b)));
  const line = stepPath(
    batches.map((b, i) => ({ x: xs[i], y: y(b.median as number) })),
    batches.length ? Math.min(w - 2, xs[xs.length - 1] + NEWEST_STEP) : undefined,
  );
  // The worse verdict's two sides, when the row has one.
  const redAt = emphasis ? batches.findIndex((b) => b.batch === emphasis.batch) : -1;
  const base = emphasis ? batches.filter((b) => emphasis.baseline.includes(b.batch)) : [];
  const baseLevel = base.length ? [...base.map((b) => b.median as number)].sort((p, q) => p - q)[Math.floor((base.length - 1) / 2)] : null;
  const red = redAt >= 0 ? { x0: xs[redAt], x1: redAt + 1 < xs.length ? xs[redAt + 1] : Math.min(w - 2, xs[redAt] + NEWEST_STEP), y: y(batches[redAt].median as number) } : null;
  const cursorX = cursor === null ? null : x(cursor);
  const hotIndex = cursorX === null ? -1 : nearestIndex(xs, cursorX);
  const hot = hotIndex >= 0 && Math.abs(xs[hotIndex] - (cursorX as number)) < 14 ? batches[hotIndex] : null;

  const move = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * w;
    onCursor?.(x.invert(px));
    setPointer({ x: e.clientX, y: box.top });
  };
  const leave = () => {
    onCursor?.(null);
    setPointer(null);
  };
  const click = () => {
    if (hot) onPick?.(hot.batch);
  };

  return (
    <>
      <svg className="ev-strip" width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label ?? "score history"} data-ev-strip>
        <line x1={0} x2={w} y1={y(PASS_MARK)} y2={y(PASS_MARK)} className="ev-strip-mark" />
        {dots.map((d, i) => {
          if (d.score === null || d.status === "dry" || unaskedNames.has(d.batch)) return null;
          const cx = x(Date.parse(d.at)) + jitter(`${d.batch}:${i}`, 1.6);
          const cy = y(d.status === "fail" && d.score === 0 ? 0 : d.score);
          return d.status === "pass" ? (
            <circle key={i} cx={cx} cy={cy} r={1.6} className="ev-pass" fill="currentColor" opacity={0.42} />
          ) : (
            <circle key={i} cx={cx} cy={cy} r={1.6} className="ev-fail" fill="none" stroke="currentColor" strokeWidth={0.8} opacity={0.6} />
          );
        })}
        {pinned && batches.some((b) => b.batch === pinned) && (
          <rect x={x(at(batches.find((b) => b.batch === pinned)!)) - 3} y={PAD_TOP - 2} width={6} height={plotBottom - PAD_TOP + 2} rx={2} style={{ fill: "var(--ev-cyan)", opacity: 0.16 }} />
        )}
        {line && <path d={line} pathLength={1} className="ev-strip-median ev-draw" style={{ "--ev-delay": `${delayMs}ms` } as CSSProperties} />}
        {base.length > 0 && (
          <g className="ev-pass" data-ev-strip-baseline={base.length}>
            {baseLevel !== null && red && <line x1={x(at(base[0])) - 3} x2={red.x1} y1={y(baseLevel)} y2={y(baseLevel)} stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" opacity={0.55} />}
            {/* On the axis, bracketed as the surface page's seismograph draws its baseline. */}
            {base.length > 1 && <line x1={x(at(base[0]))} x2={x(at(base[base.length - 1]))} y1={plotBottom + 3} y2={plotBottom + 3} stroke="currentColor" strokeWidth={1} opacity={0.5} />}
            {base.map((b) => (
              <line key={b.batch} x1={x(at(b))} x2={x(at(b))} y1={plotBottom} y2={height - 1} stroke="currentColor" strokeWidth={2} strokeLinecap="round" opacity={0.85} />
            ))}
          </g>
        )}
        {red && (
          <g className="ev-fail" data-ev-strip-red>
            {baseLevel !== null && <line x1={red.x0} x2={red.x0} y1={y(baseLevel)} y2={red.y} stroke="currentColor" strokeWidth={1} strokeDasharray="1.5 1.5" />}
            <line x1={red.x0} x2={red.x1} y1={red.y} y2={red.y} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
            <circle cx={red.x0} cy={red.y} r={3} style={{ fill: "var(--ev-bg)" }} stroke="currentColor" strokeWidth={1.6} />
          </g>
        )}
        {epochs
          .filter((e) => e.n > 1)
          .map((e) => {
            const ex = x(Date.parse(e.firstBatchAt));
            return ex >= 0 && ex <= w ? (
              <g key={e.n} data-ev-epoch={e.n}>
                <title>{`Epoch e${e.n}: the prompt changed on ${e.changedFreezes.length} freezes`}</title>
                <line x1={ex} x2={ex} y1={plotBottom} y2={height - 1} className="ev-strip-notch" />
              </g>
            ) : null;
          })}
        {unasked.map((b) => {
          const ux = x(at(b));
          return (
            <g key={b.batch} className="ev-quiet" data-ev-strip-unasked={b.batch}>
              <title>{`${b.reps} reps never reached the model: nothing was spent and every one failed, so the harness answered, not the prompt`}</title>
              <path d={`M${ux - 2.2},${plotBottom - 4.4} L${ux + 2.2},${plotBottom} M${ux + 2.2},${plotBottom - 4.4} L${ux - 2.2},${plotBottom}`} stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
            </g>
          );
        })}
        {footing.map((m, i) => (
          <FootingGlyph key={i} marker={m} x={x(Date.parse(m.batchAt))} y={height - 3.5} />
        ))}
        {cursorX !== null && cursorX >= 0 && cursorX <= w && <line x1={cursorX} x2={cursorX} y1={0} y2={plotBottom} className="ev-strip-cursor" />}
        {hot && <circle cx={x(at(hot))} cy={y(hot.median as number)} r={2.6} style={{ fill: "var(--ev-bg)", stroke: "var(--ev-text)" }} strokeWidth={1.25} />}
        <rect x={0} y={0} width={w} height={height} className="ev-strip-hit" onMouseMove={move} onMouseLeave={leave} onClick={click} />
      </svg>
      {tip && pointer && hot && (
        <HoverTip x={pointer.x} y={pointer.y - 4}>
          {tip(hot)}
        </HoverTip>
      )}
    </>
  );
}
