// One surface over time (docs/architecture/evals-ui.md 4.2): every rep a dot
// in its batch's column, the batch median as a step line, the 0.7 pass mark
// ruled, prompt epochs as alternating bands with a perforation at each
// boundary, and footing changes on the axis. Hand-drawn SVG on the bench
// paper, like the app's other charts.
//
// The columns are shared with the cost track and the ledger (surfaceColumns),
// so a batch sits at one x everywhere. A drag across the plot zooms (the
// day charts' brush); a click pins a column and a shift-click pins a second.

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CommitRef, Epoch, FootingMarker, RunRow } from "@codecast/shared/contracts/evalsApi";
import { BrushRect, useDayBrush } from "./charts/brush";
import { FootingGlyph } from "./charts/ScoreStrip";
import { PASS_MARK, dayList, dayStart, jitter, nearestIndex, scoreScale, stepPath, timeAxisLabels } from "./charts/scale";
import { score2, shortSha, usd, whenLabel } from "./format";
import { useEvalsHost } from "./host";
import { type SurfaceColumn, type SurfaceColumns, HOUR, type EpochBand, epochBandsOf, REP_HATCH_ID, scoredRep, gateDropped, repY, medianOf } from "./seismographModel";

/** Alternating faint bands, a perforation at each boundary and an e1, e2 label along the top. The label opens the epoch's diff when the chart can. */
export function EpochBands({ bands, top, bottom, onOpenEpoch }: { bands: readonly EpochBand[]; top: number; bottom: number; onOpenEpoch?: (n: number) => void }) {
  return (
    <>
      {bands.map((b) => (
        <g key={b.n} data-ev-epoch-band={b.n}>
          <rect x={b.x0} y={top - 4} width={b.x1 - b.x0} height={bottom - top + 4} className={b.n % 2 ? "ev-sf-band" : "ev-sf-band ev-sf-band--alt"} />
          {b.boundary && <line x1={b.x0} x2={b.x0} y1={top - 14} y2={bottom} className="ev-sf-perf" />}
          <g
            className="ev-sf-epoch-label"
            {...(onOpenEpoch
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": `Epoch e${b.n}: open its prompt diff`,
                  onClick: () => onOpenEpoch(b.n),
                  onKeyDown: (e: React.KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpenEpoch(b.n)),
                }
              : { style: { cursor: "default" } })}
            data-ev-epoch-label={b.n}
          >
            <title>{b.n === 1 ? "Epoch e1: the first prompt on record here" : `Epoch e${b.n}: the prompt changed on ${b.changed} freezes.${onOpenEpoch ? " Open the diff." : ""}`}</title>
            <rect x={b.x0 + 3} y={top - 22} width={Math.min(26, b.x1 - b.x0 - 4)} height={15} rx={3} />
            <text x={b.x0 + 8} y={top - 11}>e{b.n}</text>
          </g>
        </g>
      ))}
    </>
  );
}

/** The dirty hatch: yellow at 18% under a dirty rep. Render it once in each chart's defs. */
export function RepHatch() {
  return (
    <pattern id={REP_HATCH_ID} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={3} height={3} style={{ fill: "var(--ev-hatch)" }} />
      <line x1={0} y1={0} x2={0} y2={3} style={{ stroke: "var(--ev-yellow)" }} strokeWidth={1.1} opacity={0.75} />
    </pattern>
  );
}

export type RepTone = "ev-pass" | "ev-fail" | "ev-quiet" | `ev-model-${number}`;

/**
 * One rep as every Evals chart draws it: hatched when dirty, a cross for a
 * crash (or a rep the model was never asked about), a dashed ring when
 * unscored, else the marker filled for pass and hollow for fail, with a red
 * tick under a failed gate. The rest of the props
 * (handlers, data attributes, style) land on the group.
 */
export function RepMark({
  row,
  cx,
  y,
  r,
  shape = "circle",
  tone,
  unasked = false,
  children,
  ...group
}: { row: RunRow; cx: number; y: (v: number) => number; r: number; shape?: (typeof SHAPES)[number]; tone?: RepTone; unasked?: boolean; children?: ReactNode } & Omit<React.SVGProps<SVGGElement>, "children" | "className" | "cx" | "y" | "r" | "shape" | "unasked">) {
  // A rep in a batch the model was never asked about (BatchStats.unasked) is drawn as a crash: its 0 is the harness's, not a score.
  const gate = !unasked && gateDropped(row);
  const unscored = !scoredRep(row);
  const cy = repY(row, y);
  const t = tone ?? (row.status === "pass" ? "ev-pass" : unscored ? "ev-quiet" : "ev-fail");
  return (
    <g className="ev-sf-dot ev-settle" data-ev-dot={row.status} data-ev-dirty={row.dirty || undefined} {...group}>
      {row.dirty && <circle cx={cx} cy={cy} r={r + 2.4} fill={`url(#${REP_HATCH_ID})`} />}
      {row.status === "crash" || unasked ? (
        <path d={`M${cx - 2.4},${cy - 2.4} L${cx + 2.4},${cy + 2.4} M${cx + 2.4},${cy - 2.4} L${cx - 2.4},${cy + 2.4}`} className="ev-quiet" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
      ) : unscored ? (
        <circle cx={cx} cy={cy} r={r - 0.4} className="ev-quiet" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="1.4 1.4" />
      ) : (
        <Marker shape={shape} cx={cx} cy={cy} r={r} filled={row.status === "pass"} className={t} />
      )}
      {gate && <line x1={cx} x2={cx} y1={cy + r + 1} y2={cy + r + 6} className="ev-gate" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" data-ev-gate-tick />}
      {children}
    </g>
  );
}

const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** What a column's tooltip says: when, which batch, the median and reps, the spend and the heads it ran on. */
export function BatchTip({ col }: { col: SurfaceColumn }) {
  const s = col.stats;
  return (
    <div className="ev-sf-tip" data-ev-tip={s.batch}>
      <div>
        <b>{whenLabel(col.at)}</b> {s.cadence ?? "by hand"}
        {s.dry ? ", dry render" : ""}
        {s.unasked ? ", never reached the model (nothing spent, every rep failed)" : ""}
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
  /** Commits that touched the surface's declared sources in the window: a tick each on the time axis. */
  commits?: readonly CommitRef[];
  onOpenCommit?: (sha: string) => void;
  /** The batches the latest verdict was weighed against (SurfaceResponse.latest.baseline): a cyan bracket under the axis. */
  baseline?: readonly string[];
}

const TOP = 26;
const LANE_ONE = 220;
const LANE_FACET = 138;
const LANE_GAP = 14;
const AXIS_H = 34;
const SHAPES = ["circle", "square", "diamond"] as const;

/** A model's marker: circle, square or diamond, filled for pass and hollow for fail. */
function Marker({ shape, cx, cy, r, filled, className }: { shape: (typeof SHAPES)[number]; cx: number; cy: number; r: number; filled: boolean; className: string }) {
  const paint = filled ? { fill: "currentColor" } : { fill: "var(--ev-bg)", stroke: "currentColor", strokeWidth: 1.2 };
  if (shape === "square") return <rect x={cx - r * 0.88} y={cy - r * 0.88} width={r * 1.76} height={r * 1.76} className={className} {...paint} />;
  if (shape === "diamond") return <path d={`M${cx},${cy - r * 1.15} L${cx + r * 1.15},${cy} L${cx},${cy + r * 1.15} L${cx - r * 1.15},${cy} Z`} className={className} {...paint} />;
  return <circle cx={cx} cy={cy} r={r} className={className} {...paint} />;
}

export function Seismograph({ cols, runs, epochs, footing, facet, pinned, compare, hover, onHover, onPick, onZoom, onOpenRun, onOpenEpoch, commits = [], onOpenCommit, baseline = [] }: SeismographProps) {
  const { HoverTip } = useEvalsHost().ui;
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
  const [commitTip, setCommitTip] = useState<{ c: CommitRef; x: number; y: number } | null>(null);

  const svgX = (e: React.MouseEvent<SVGElement>) => {
    const box = (e.currentTarget.ownerSVGElement ?? (e.currentTarget as SVGSVGElement)).getBoundingClientRect();
    return box.width > 0 ? ((e.clientX - box.left) / box.width) * w : e.clientX - box.left;
  };
  const colAt = (px: number) => nearestIndex(xs, px);

  const epochBands = useMemo(() => epochBandsOf(cols, epochs), [epochs, cols]);

  const axisLabels = useMemo(() => {
    if (!list.length) return [];
    if (cols.axis === "time") {
      // Ends on the last batch's own day: a midnight past it would label a day with no data.
      const days = dayList(list[0].at - 12 * HOUR, list[list.length - 1].at);
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
  // A pin's number shares the date row, so a date it would sit on gives way to it.
  const shownLabels = axisLabels.filter((l) => !pinnedCols.some((c) => Math.abs(c.x - l.x) < 14));

  return (
    <div className="ev-sf-seis ev-bench" data-ev-seismograph data-ev-lanes={lanes.length}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Every rep over time" className="ev-sf-seis-svg">
        <defs>
          <RepHatch />
        </defs>

        <EpochBands bands={epochBands} top={TOP} bottom={plotBottom} onOpenEpoch={onOpenEpoch} />

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
        {shownLabels.map((l, i) => (
          <text key={i} x={l.x} y={plotBottom + 26} textAnchor="middle" className="ev-sf-xlabel">
            {l.label}
          </text>
        ))}
        {/* The latest verdict's baseline: which batches the wall's "vs 3 nights" weighed, bracketed under the axis. */}
        {(() => {
          const xs = baseline.flatMap((b) => {
            const c = cols.byBatch.get(b);
            return c && c.x >= padL && c.x <= w - padR ? [c.x] : [];
          });
          if (!xs.length) return null;
          const by = plotBottom + 15;
          return (
            <g className="ev-pass ev-sf-pass-through" data-ev-baseline={xs.length}>
              <title>{`The latest verdict's baseline: ${xs.length === 1 ? "1 batch" : `${xs.length} batches`}`}</title>
              {xs.length > 1 && <line x1={Math.min(...xs)} x2={Math.max(...xs)} y1={by} y2={by} stroke="currentColor" strokeWidth={1} opacity={0.45} />}
              {xs.map((x) => (
                <line key={x} x1={x} x2={x} y1={by - 3} y2={by + 3} stroke="currentColor" strokeWidth={2} strokeLinecap="round" opacity={0.8} />
              ))}
            </g>
          );
        })()}
        {/* A prompt commit lands as a tick on the axis, beside the drop it may explain; a click opens its diff. */}
        {commits.map((c) => {
          const cx = cols.xOfTime(Date.parse(c.at));
          if (!(cx >= padL && cx <= w - padR)) return null;
          return (
            <g
              key={c.sha}
              className="ev-sf-commit"
              data-ev-commit-tick={c.sha}
              role="link"
              aria-label={`Commit ${shortSha(c.sha)}: ${c.subject}`}
              onClick={() => onOpenCommit?.(c.sha)}
              onMouseEnter={(e) => setCommitTip({ c, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setCommitTip(null)}
            >
              <rect x={cx - 4} y={plotBottom + 1} width={8} height={10} fill="transparent" />
              <line x1={cx} x2={cx} y1={plotBottom + 2} y2={plotBottom + 9} />
            </g>
          );
        })}
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
            .filter((c) => !c.stats.unasked)
            .map((c) => ({ x: c.x, m: medianOf(laneRows(byBatch.get(c.batch) ?? []).filter(scoredRep).map((r) => r.score as number)) }))
            .filter((p): p is { x: number; m: number } => p.m !== null);
          return (
            <g key={key} data-ev-lane-dots={key}>
              {list.map((c, ci) =>
                laneRows(byBatch.get(c.batch) ?? []).map((row) => (
                  <RepMark
                    key={row.id}
                    row={row}
                    cx={c.x + jitter(row.id, spread)}
                    y={y}
                    r={r}
                    shape={lane ? SHAPES[modelIndex % 3] : "circle"}
                    tone={lane ? `ev-model-${modelIndex % 3}` : undefined}
                    unasked={!!c.stats.unasked}
                    style={{ "--ev-delay": `${list.length * 10 + ci * 6}ms` } as CSSProperties}
                    onClick={(e) => (e.stopPropagation(), onOpenRun(row.id))}
                    onMouseEnter={(e) => setDotTip({ row, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setDotTip(null)}
                  />
                )),
              )}
              {medians.length > 0 && <path d={stepPath(medians.map((p) => ({ x: p.x, y: y(p.m) })), Math.min(w - padR, medians[medians.length - 1].x + 8))} className="ev-sf-median" data-ev-median />}
            </g>
          );
        })}

        <BrushRect drag={brush.drag} toX={(i) => list[i]?.x ?? 0} top={TOP - 4} height={plotBottom - TOP + 4} />
      </svg>
      {commitTip ? (
        <HoverTip x={commitTip.x} y={commitTip.y - 10}>
          <div className="ev-sf-tip">
            <div>
              <b className="ev-mono">{shortSha(commitTip.c.sha)}</b> {commitTip.c.subject}
            </div>
            <div className="ev-sf-tip-dim">
              {commitTip.c.author}, {whenLabel(commitTip.c.at)}
            </div>
            <div className="ev-sf-tip-dim">touched the declared sources; click to open the diff</div>
          </div>
        </HoverTip>
      ) : dotTip ? (
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

/** What a rep's tooltip says: its freeze, seed and verdict, the model and head it ran on, and what a click does. */
export function RepTip({ row, hint = "click to open the run" }: { row: RunRow; hint?: string }): ReactNode {
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
      <div className="ev-sf-tip-dim">{hint}</div>
    </div>
  );
}
