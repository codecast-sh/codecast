// One surface over time (docs/architecture/evals-ui.md 4.2): every rep a dot
// in its batch's column, the batch median as a step line, the 0.7 pass mark
// ruled, prompt epochs as alternating bands with a perforation at each
// boundary, and footing changes on the axis. Hand-drawn SVG on the bench
// paper, like the app's other charts.
//
// The columns are shared with the cost track and the ledger (surfaceColumns),
// so a batch sits at one x everywhere. A drag across the plot zooms (the
// ActivityCharts brush); a click pins a column and a shift-click pins a second.

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BatchStats, Epoch, FootingMarker, RunRow } from "@codecast/shared/contracts/evalsApi";
import { HoverTip } from "../ActivityHeatmap";
import { BrushRect, timeAxisLabels, useDayBrush } from "../ActivityCharts";
import { FootingGlyph } from "./charts/ScoreStrip";
import { PASS_MARK, dayList, dayStart, jitter, linear, nearestIndex, scoreScale, stepPath } from "./charts/scale";
import { score2, shortSha, usd } from "./parts";

// ── Columns: one x per batch, shared by every track on the page ─────────────

export type SurfaceAxis = "time" | "ordinal";

export interface SurfaceColumn {
  batch: string;
  at: number;
  x: number;
  stats: BatchStats;
}

export interface SurfaceColumns {
  list: SurfaceColumn[];
  /** By batch name. */
  byBatch: Map<string, SurfaceColumn>;
  /** The x of a time; in ordinal mode, the x of the column at or after it. */
  xOfTime: (at: number) => number;
  /** A typical distance between neighbouring columns, px. */
  gap: number;
  width: number;
  padL: number;
  padR: number;
  axis: SurfaceAxis;
}

export const SEIS_PAD_L = 38;
export const SEIS_PAD_R = 14;
const HOUR = 3_600_000;

/** Where each batch sits across `width`: by when it began, or evenly by order. */
export function surfaceColumns(batches: readonly BatchStats[], axis: SurfaceAxis, width: number, padL = SEIS_PAD_L, padR = SEIS_PAD_R): SurfaceColumns {
  const sorted = [...batches].sort((a, b) => Date.parse(a.batchAt) - Date.parse(b.batchAt));
  const ats = sorted.map((b) => Date.parse(b.batchAt));
  const inner = Math.max(40, width - padL - padR);
  let xs: number[];
  let xOfTime: (at: number) => number;
  if (axis === "time" && sorted.length > 0) {
    const span = ats[ats.length - 1] - ats[0];
    const margin = Math.max(span * 0.02, 2 * HOUR);
    const x = linear(ats[0] - margin, ats[ats.length - 1] + margin, padL, padL + inner);
    xs = ats.map(x);
    xOfTime = x;
  } else {
    const step = inner / Math.max(1, sorted.length);
    xs = sorted.map((_, i) => padL + (i + 0.5) * step);
    xOfTime = (at) => {
      const i = ats.findIndex((t) => t >= at);
      return i < 0 ? padL + inner : xs[i];
    };
  }
  const gaps = xs.slice(1).map((v, i) => v - xs[i]).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : inner;
  const list = sorted.map((stats, i) => ({ batch: stats.batch, at: ats[i], x: xs[i], stats }));
  return { list, byBatch: new Map(list.map((c) => [c.batch, c])), xOfTime, gap, width, padL, padR, axis };
}

/** The x where an epoch begins: halfway between the last column before it and its first. Null when it begins after the window. */
export function epochStartX(cols: SurfaceColumns, epoch: Pick<Epoch, "firstBatch" | "firstBatchAt">): number | null {
  const at = Date.parse(epoch.firstBatchAt);
  const i = cols.list.findIndex((c) => c.batch === epoch.firstBatch || c.at >= at);
  if (i < 0) return null;
  if (i === 0) return cols.padL;
  return (cols.list[i - 1].x + cols.list[i].x) / 2;
}

const fmtWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** What a column's tooltip says: when, which batch, the median and reps, the spend and the heads it ran on. */
export function BatchTip({ col }: { col: SurfaceColumn }) {
  const s = col.stats;
  return (
    <div className="ev-sf-tip" data-ev-tip={s.batch}>
      <div>
        <b>{fmtWhen(col.at)}</b> {s.cadence ?? "by hand"}
        {s.dry ? ", dry render" : ""}
      </div>
      <div className="ev-sf-tip-dim">batch {s.batch}</div>
      <div>
        median {score2(s.median)}, {s.passed} of {s.reps} passed{s.crashes ? `, ${s.crashes} crashed` : ""}, {usd(s.costUsd + s.judgeCostUsd)}
      </div>
      <div className="ev-sf-tip-dim">
        on {s.gitHeads.map((h) => shortSha(h)).join(", ") || "no head"}
        {s.dirtyReps ? `, ${s.dirtyReps} dirty` : ""}
      </div>
    </div>
  );
}

// ── The chart ───────────────────────────────────────────────────────────────

export interface SeismographProps {
  cols: SurfaceColumns;
  runs: readonly RunRow[];
  epochs: readonly Epoch[];
  footing: readonly FootingMarker[];
  /** One lane per model, told apart by marker shape and colour. */
  facet: boolean;
  /** The pinned batch, and the second one pinned to compare against it. */
  pinned: string | null;
  compare: string | null;
  /** The column under the pointer on any track, shared with the cost track. */
  hover: string | null;
  onHover: (batch: string | null) => void;
  /** A click pins a column; a shift-click pins it as the second. */
  onPick: (batch: string, second: boolean) => void;
  /** A drag across two or more columns. */
  onZoom: (fromBatch: string, toBatch: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenEpoch: (n: number) => void;
}

const TOP = 26;
const LANE_ONE = 220;
const LANE_FACET = 138;
const LANE_GAP = 14;
const AXIS_H = 34;
const SHAPES = ["circle", "square", "diamond"] as const;

/** A model's marker: circle, square or diamond, filled for pass and hollow for fail. */
function Marker({ shape, cx, cy, r, filled, className }: { shape: (typeof SHAPES)[number]; cx: number; cy: number; r: number; filled: boolean; className: string }) {
  const paint = filled ? { fill: "currentColor" } : { fill: "var(--sol-bg)", stroke: "currentColor", strokeWidth: 1.2 };
  if (shape === "square") return <rect x={cx - r * 0.88} y={cy - r * 0.88} width={r * 1.76} height={r * 1.76} className={className} {...paint} />;
  if (shape === "diamond") return <path d={`M${cx},${cy - r * 1.15} L${cx + r * 1.15},${cy} L${cx},${cy + r * 1.15} L${cx - r * 1.15},${cy} Z`} className={className} {...paint} />;
  return <circle cx={cx} cy={cy} r={r} className={className} {...paint} />;
}

const scored = (r: RunRow) => r.score !== null && (r.status === "pass" || r.status === "fail");

function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function Seismograph({ cols, runs, epochs, footing, facet, pinned, compare, hover, onHover, onPick, onZoom, onOpenRun, onOpenEpoch }: SeismographProps) {
  const { list, width: w, padL, padR } = cols;
  const models = useMemo(() => {
    const seen: string[] = [];
    for (const r of runs) if (r.model && !seen.includes(r.model)) seen.push(r.model);
    return seen;
  }, [runs]);
  const lanes: (string | null)[] = facet && models.length > 1 ? models : [null];
  const laneH = lanes.length > 1 ? LANE_FACET : LANE_ONE;
  const plotBottom = TOP + lanes.length * laneH + (lanes.length - 1) * LANE_GAP;
  const laneGeo = lanes.map((lane, li) => {
    const top = TOP + li * (laneH + LANE_GAP);
    return { key: lane ?? "all", top, y: scoreScale(top + 6, top + laneH - 6), lane, modelIndex: lane ? models.indexOf(lane) : -1 };
  });
  const height = plotBottom + AXIS_H;
  const spread = Math.max(1.5, Math.min(7, cols.gap * 0.28));
  const r = Math.max(2.1, Math.min(3.1, cols.gap * 0.22));

  const byBatch = useMemo(() => {
    const m = new Map<string, RunRow[]>();
    for (const row of runs) if (row.batch && cols.byBatch.has(row.batch)) (m.get(row.batch) ?? m.set(row.batch, []).get(row.batch)!).push(row);
    return m;
  }, [runs, cols]);

  const xs = useMemo(() => list.map((c) => c.x), [list]);
  const brush = useDayBrush((a, b) => onZoom(list[a].batch, list[b].batch));
  const down = useRef<{ i: number; shift: boolean } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [dotTip, setDotTip] = useState<{ row: RunRow; x: number; y: number } | null>(null);

  const svgX = (e: React.MouseEvent<SVGElement>) => {
    const box = (e.currentTarget.ownerSVGElement ?? (e.currentTarget as SVGSVGElement)).getBoundingClientRect();
    return box.width > 0 ? ((e.clientX - box.left) / box.width) * w : e.clientX - box.left;
  };
  const colAt = (px: number) => nearestIndex(xs, px);

  const epochBands = useMemo(() => {
    const sorted = [...epochs].sort((a, b) => a.n - b.n);
    const out: Array<{ n: number; x0: number; x1: number; boundary: boolean; changed: number }> = [];
    sorted.forEach((e, i) => {
      const start = epochStartX(cols, e);
      if (start === null) return;
      const next = sorted[i + 1] ? epochStartX(cols, sorted[i + 1]) : null;
      const x0 = Math.max(padL, start);
      const x1 = Math.min(w - padR, next ?? w - padR);
      if (x1 <= padL || x0 >= w - padR || x1 - x0 < 1) return;
      const firstCol = list.find((c) => c.batch === e.firstBatch || c.at >= Date.parse(e.firstBatchAt));
      out.push({ n: e.n, x0, x1, boundary: e.n > 1 && !!firstCol && firstCol !== list[0], changed: e.changedFreezes.length });
    });
    return out;
  }, [epochs, cols, list, padL, padR, w]);

  const axisLabels = useMemo(() => {
    if (!list.length) return [];
    if (cols.axis === "time") {
      const days = dayList(list[0].at - 12 * HOUR, list[list.length - 1].at + 12 * HOUR);
      return timeAxisLabels(days, (i) => cols.xOfTime(dayStart(days[i]))).filter((l) => l.x >= padL && l.x <= w - padR);
    }
    const every = Math.max(1, Math.ceil(54 / Math.max(1, cols.gap)));
    return list.filter((_, i) => i % every === 0).map((c) => ({ label: fmtDay(c.at), x: c.x }));
  }, [list, cols, padL, padR, w]);

  // Numbered by time, as the compare drawer numbers them: the earlier pin is 1.
  const pinnedCols = [pinned, compare]
    .map((b) => (b ? cols.byBatch.get(b) ?? null : null))
    .filter((c): c is SurfaceColumn => !!c)
    .sort((a, b) => a.at - b.at);
  const hoverCol = hover ? cols.byBatch.get(hover) ?? null : null;

  return (
    <div className="ev-sf-seis ev-bench" data-ev-seismograph data-ev-lanes={lanes.length}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Every rep over time" className="block overflow-visible">
        <defs>
          <pattern id="ev-sf-hatch" width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={3} height={3} style={{ fill: "color-mix(in srgb, var(--sol-yellow) 18%, transparent)" }} />
            <line x1={0} y1={0} x2={0} y2={3} style={{ stroke: "var(--sol-yellow)" }} strokeWidth={1.1} opacity={0.75} />
          </pattern>
        </defs>

        {epochBands.map((b) => (
          <g key={b.n} data-ev-epoch-band={b.n}>
            <rect x={b.x0} y={TOP - 4} width={b.x1 - b.x0} height={plotBottom - TOP + 4} className={b.n % 2 ? "ev-sf-band" : "ev-sf-band ev-sf-band--alt"} />
            {b.boundary && <line x1={b.x0} x2={b.x0} y1={TOP - 14} y2={plotBottom} className="ev-sf-perf" />}
            <g
              className="ev-sf-epoch-label"
              role="button"
              tabIndex={0}
              aria-label={`Epoch e${b.n}: open its prompt diff`}
              onClick={() => onOpenEpoch(b.n)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpenEpoch(b.n))}
              data-ev-epoch-label={b.n}
            >
              <title>{b.n === 1 ? "Epoch e1: the first prompt on record here" : `Epoch e${b.n}: the prompt changed on ${b.changed} freezes. Open the diff.`}</title>
              <rect x={b.x0 + 3} y={4} width={Math.min(26, b.x1 - b.x0 - 4)} height={15} rx={3} />
              <text x={b.x0 + 8} y={15}>e{b.n}</text>
            </g>
          </g>
        ))}

        {laneGeo.map(({ key, top, y, lane, modelIndex }) => (
          <g key={key} data-ev-lane={key}>
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} className="ev-sf-gridline" />
                <text x={padL - 8} y={y(v) + 3.5} className="ev-sf-ylabel" textAnchor="end">{v}</text>
              </g>
            ))}
            <line x1={padL} x2={w - padR} y1={y(PASS_MARK)} y2={y(PASS_MARK)} className="ev-sf-passmark" data-ev-passmark />
            <text x={padL - 8} y={y(PASS_MARK) + 3.5} className="ev-sf-ylabel ev-sf-ylabel--mark" textAnchor="end">{PASS_MARK}</text>
            {lane && (
              <g className={`ev-model-${modelIndex % 3}`} data-ev-lane-label>
                <Marker shape={SHAPES[modelIndex % 3]} cx={padL + 8} cy={top + 1} r={3.2} filled className="" />
                <text x={padL + 16} y={top + 4.5} className="ev-sf-lane-label">{lane}</text>
              </g>
            )}
          </g>
        ))}

        <line x1={padL} x2={w - padR} y1={plotBottom + 1} y2={plotBottom + 1} className="ev-sf-axis" />
        {axisLabels.map((l, i) => (
          <text key={i} x={l.x} y={plotBottom + 26} textAnchor="middle" className="ev-sf-xlabel">
            {l.label}
          </text>
        ))}
        {footing.map((m, i) => {
          const c = cols.byBatch.get(m.batch);
          const fx = c ? c.x : cols.xOfTime(Date.parse(m.batchAt));
          if (fx < padL || fx > w - padR) return null;
          // A rule through the plot shows which reps sit on either side of the move; the glyph on the axis names it.
          return (
            <g key={i} data-ev-footing-mark={m.kind}>
              <line x1={fx} x2={fx} y1={TOP - 4} y2={plotBottom} className={m.kind === "judge" ? "ev-sf-footing-rule ev-ruler" : "ev-sf-footing-rule ev-quiet"} />
              <FootingGlyph marker={m} x={fx} y={plotBottom + 11} scale={1.8} />
            </g>
          );
        })}

        {/* The hit area sits under the dots: the space between them pins and brushes, a dot opens its run. */}
        <rect
          x={padL}
          y={TOP - 4}
          width={Math.max(0, w - padL - padR)}
          height={plotBottom - TOP + 4}
          className="ev-sf-hit"
          data-ev-seis-hit
          onMouseDown={(e) => {
            if (!list.length || e.button !== 0) return;
            const i = colAt(svgX(e));
            down.current = { i, shift: e.shiftKey };
            brush.start(i);
          }}
          onMouseMove={(e) => {
            if (!list.length) return;
            const i = colAt(svgX(e));
            brush.move(i);
            onHover(list[i].batch);
            setPointer({ x: e.clientX, y: (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect().top + TOP });
          }}
          onMouseUp={(e) => {
            const d = down.current;
            down.current = null;
            if (!d || !list.length) return brush.cancel();
            const i = colAt(svgX(e));
            if (i === d.i) {
              brush.cancel();
              onPick(list[i].batch, d.shift || e.shiftKey);
            } else brush.end();
          }}
          onMouseLeave={() => {
            down.current = null;
            brush.cancel();
            onHover(null);
            setPointer(null);
          }}
        />

        {pinnedCols.map((c, i) => (
          <g key={c.batch} data-ev-pin={i + 1} className="ev-sf-pass-through">
            <rect x={c.x - 6} y={TOP - 4} width={12} height={plotBottom - TOP + 4} rx={3} className="ev-sf-pin" />
            <text x={c.x} y={plotBottom + 30} textAnchor="middle" className="ev-sf-pin-letter">{i + 1}</text>
          </g>
        ))}
        {hoverCol && <line x1={hoverCol.x} x2={hoverCol.x} y1={TOP - 4} y2={plotBottom} className="ev-sf-cursor" />}

        {laneGeo.map(({ key, y, lane, modelIndex }) => {
          const laneRows = (rows: RunRow[]) => (lane ? rows.filter((r) => r.model === lane) : rows);
          const medians = list
            .map((c) => ({ x: c.x, m: medianOf(laneRows(byBatch.get(c.batch) ?? []).filter(scored).map((r) => r.score as number)) }))
            .filter((p): p is { x: number; m: number } => p.m !== null);
          return (
            <g key={key} data-ev-lane-dots={key}>
              {list.map((c, ci) =>
                laneRows(byBatch.get(c.batch) ?? []).map((row) => {
                  const cx = c.x + jitter(row.id, spread);
                  const gate = row.status === "fail" && row.gatesFailed.length > 0;
                  const unscored = !scored(row);
                  const cy = unscored ? y(0) + 9 : y(gate ? 0 : (row.score as number));
                  const tone = lane ? `ev-model-${modelIndex % 3}` : row.status === "pass" ? "ev-pass" : unscored ? "ev-quiet" : "ev-fail";
                  return (
                    <g
                      key={row.id}
                      className="ev-sf-dot ev-settle"
                      style={{ "--ev-delay": `${list.length * 10 + ci * 6}ms` } as CSSProperties}
                      data-ev-dot={row.status}
                      data-ev-dirty={row.dirty || undefined}
                      onClick={(e) => (e.stopPropagation(), onOpenRun(row.id))}
                      onMouseEnter={(e) => setDotTip({ row, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setDotTip(null)}
                    >
                      {row.dirty && <circle cx={cx} cy={cy} r={r + 2.4} fill="url(#ev-sf-hatch)" />}
                      {row.status === "crash" ? (
                        <path d={`M${cx - 2.4},${cy - 2.4} L${cx + 2.4},${cy + 2.4} M${cx + 2.4},${cy - 2.4} L${cx - 2.4},${cy + 2.4}`} className="ev-quiet" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
                      ) : unscored ? (
                        <circle cx={cx} cy={cy} r={r - 0.4} className="ev-quiet" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="1.4 1.4" />
                      ) : (
                        <Marker shape={lane ? SHAPES[modelIndex % 3] : "circle"} cx={cx} cy={cy} r={r} filled={row.status === "pass"} className={tone} />
                      )}
                      {gate && <line x1={cx} x2={cx} y1={cy + r + 1} y2={cy + r + 6} className="ev-gate" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" data-ev-gate-tick />}
                    </g>
                  );
                }),
              )}
              {medians.length > 0 && <path d={stepPath(medians.map((p) => ({ x: p.x, y: y(p.m) })), Math.min(w - padR, medians[medians.length - 1].x + 8))} className="ev-sf-median" data-ev-median />}
            </g>
          );
        })}

        <BrushRect drag={brush.drag} toX={(i) => list[i]?.x ?? 0} top={TOP - 4} height={plotBottom - TOP + 4} />
      </svg>
      {dotTip ? (
        <HoverTip x={dotTip.x} y={dotTip.y - 10}>
          <RepTip row={dotTip.row} />
        </HoverTip>
      ) : (
        pointer &&
        hoverCol && (
          <HoverTip x={pointer.x} y={pointer.y}>
            <BatchTip col={hoverCol} />
          </HoverTip>
        )
      )}
    </div>
  );
}

function RepTip({ row }: { row: RunRow }): ReactNode {
  return (
    <div className="ev-sf-tip">
      <div>
        <b>{row.freezeName}</b> seed {row.seed}, {row.status === "pass" || row.status === "fail" ? `${row.status}ed ${score2(row.score)}` : row.status}
      </div>
      <div className="ev-sf-tip-dim">
        {row.model ?? "no model"} on {shortSha(row.gitHead)}
        {row.dirty ? ", dirty" : ""}
        {row.gatesFailed.length ? `, gate ${row.gatesFailed.join(", ")} failed` : ""}
      </div>
      <div className="ev-sf-tip-dim">click to open the run</div>
    </div>
  );
}
