// A watched metric over time: the line against real timestamps, joined at
// the series' own cadence (a weekly series is one line through its weeks
// with a marker on each value; a gap far longer than the spacing around it
// is a hole, not a slope; a value standing alone is a short tick; the
// previous period and a query's preview follow the same rule), the
// threshold dashed across with its alerting side shaded, the line red only
// where it is past it, the stretches it spent past the line as red bands,
// an optional dashed previous period, ships as ticks on the time axis
// (clustered when close, the nearest one drawn full height while hovered),
// and a crosshair that reads time, value and distance to the line. The full
// chart adds axes, drag-to-zoom on the time axis and a threshold you can
// drag; the spark is the same picture at card size. SVG for marks (scaled,
// non-scaling strokes), HTML for every label, dot and tooltip so nothing
// stretches.
import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, BellOff } from "lucide-react";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { OpsWatch } from "./opsTypes";
import {
  COARSE_STEP, HEALTH_LOOK, alertBands, cutHoles, dataHoles, splitAtHoles, clipRunToWindow, alertSince, crosses, durationShort, formatValue, isMutedAt, watchHealth, inWindow, lineRuns, niceTicks,
  spanLabel, stampLabel, tickLabels, ticksOf, timeTicks, valueNear, yDomain, type DataHole, type Direction, type Pt, type Win,
} from "./metricModel";
import { type SeriesPt } from "./metricSeries";
import { bandsFromTransitions, clusterShips, type ChartMark, type ShipCluster } from "./metricEvents";
import { bandAt, roundToScale } from "./metricEditing";

const W = 1000;

export type MetricChartProps = {
  points: SeriesPt[];
  win: Win;
  interval_ms: number;
  threshold?: number;
  /** A warning level short of the line, drawn as its own dashed line. */
  warn?: number;
  direction: Direction;
  unit?: string;
  /** Moments drawn as vertical markers (full charts only). */
  marks?: ChartMark[];
  /** Ships in the window, drawn as ticks on the time axis and clustered where close (full charts only). */
  ships?: ChartMark[];
  /** The previous period, already moved onto this window. */
  compare?: Pt[];
  height?: number;
  /** Axes, zoom and the draggable line. */
  full?: boolean;
  paused?: boolean;
  /** Ink of the line; the alert red stays the alert's. */
  ink?: string;
  onZoom?: (win: Win) => void;
  onResetZoom?: () => void;
  /** A dragged line, on release. */
  onThreshold?: (value: number) => void;
  label?: string;
  /** The window's values are still on their way: a loading bar, and nothing drawn that could be read as the answer. */
  loading?: boolean;
  /** Values for the window are drawn but a finer answer is on its way: the loading bar over the drawing. */
  stale?: boolean;
  /** Values a query being edited answers, drawn over the chart before it is saved. */
  preview?: Pt[];
  /** A line being typed, drawn where it would sit before it is saved. */
  ghostLine?: number;
  /** A card's chart names the moment it starts at, bottom left. */
  axisStart?: boolean;
  /** The stretch with no values held (the watch page's All reaching back to its first alert), drawn hatched with `gapAction` on it. */
  gap?: Win | null;
  gapAction?: ReactNode;
  /** The alert's announced episodes: the strip under the plot, and the bands where no values are held. */
  episodes?: Win[];
  /** The transitions the page lists, each drawn at the value that caused it (full charts only): filled when announced, hollow when read off the values. */
  transitions?: readonly { at: number; kind: "crossed" | "recovered"; value: number | null; inferred?: boolean }[];
  /** The watch's poll, to count the polls a stretch with no values missed (full charts); the drawing's step when absent. */
  poll_ms?: number;
  /** A value read just now, past the series' newest point: the newest dot, joined to the series by a dashed segment. */
  live?: Pt | null;
};

type Hover = { frac: number; pt: Pt | null; prev: Pt | null; apart: number | null; band: (Win & { open: boolean }) | null; hole: DataHole | null };

export function MetricChart({
  points, win, interval_ms, threshold, warn, direction, unit, marks, ships, compare, height = 64, full = false, paused = false, ink, onZoom, onResetZoom, onThreshold, label, loading = false, stale = false, preview, ghostLine, axisStart = false, gap, gapAction, episodes, transitions, poll_ms, live,
}: MetricChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const clipId = `mxclip${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [hover, setHover] = useState<Hover | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const frozen = useRef<[number, number] | null>(null);
  // The plot's width in pixels, for clustering ships that would overlap; a card's spark never needs it.
  const [plotW, setPlotW] = useState(1000);
  useMountEffect(() => {
    const el = ref.current;
    if (!el || !full || typeof ResizeObserver === "undefined") return;
    const apply = (w: number) => setPlotW((p) => (!w || Math.abs(p - w) < 16 ? p : Math.round(w)));
    apply(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  });

  const visible = useMemo(() => (loading ? [] : inWindow(points, win)), [points, win, loading]);
  const shownPreview = useMemo(() => (preview ? inWindow(preview, win) : []), [preview, win]);
  const prev = useMemo(() => (compare ? compare.filter((p) => p.at >= win.from && p.at <= win.to) : []), [compare, win]);
  // The value each listed transition was read at: a folded bucket's mean can sit far from it, so it is drawn where the list says.
  const turns = useMemo(
    () => (full && !loading && transitions ? transitions.filter((t): t is typeof t & { value: number } => t.value !== null && t.at >= win.from && t.at <= win.to) : []),
    [full, loading, transitions, win],
  );
  const line = drag ?? threshold;
  const shownLive = live && !loading && live.at >= win.from && live.at <= win.to ? live : null;
  const pad = full ? 10 : 5;
  const span = win.to - win.from || 1;
  const X = (at: number) => ((at - win.from) / span) * W;

  // At card size a short hole reads as noise: a card breaks its line only where a gap is far past the spacing around it.
  const joinAt = full ? undefined : CARD_JOIN;
  const runs = useMemo(() => lineRuns(visible, interval_ms, joinAt), [visible, interval_ms, joinAt]);
  // The runs keep the neighbours just outside the window (so a hole is judged against them), and each is drawn cut at the window's edges: nothing paints past the plot.
  // Stretches the source sent nothing for, several times its own spacing: hatched, named on hover, and never shaded as alerting.
  // Judged on the whole series, never the window's slice: a range, a zoom and the overview's card mark the same stretches.
  const holes = useMemo(() => (full && !loading ? dataHoles(points, interval_ms, poll_ms ?? interval_ms).filter((h) => h.to > win.from && h.from < win.to) : []), [full, loading, points, interval_ms, poll_ms, win.from, win.to]);
  const segs = useMemo(() => runs.filter((r) => !r.sparse).flatMap((r) => splitAtHoles(r.points, holes)).map((pts) => clipRunToWindow(pts, win)).filter((s) => s.length > 0), [runs, holes, win]);
  const sparse = useMemo(() => runs.filter((r) => r.sparse), [runs]);
  // The y axis fits what the window draws: the values inside it, the line as cut at its edges, and each folded bucket's extremes inside it.
  // The neighbours kept just outside it (a lone value weeks before the rest) never stretch it.
  const extremes = useMemo(() => visible.flatMap((p) => (p.at >= win.from && p.at <= win.to && p.min !== undefined && p.max !== undefined ? [{ at: p.at, value: p.min }, { at: p.at, value: p.max }] : [])), [visible, win.from, win.to]);
  const drawnVals = useMemo(() => [...visible.filter((p) => p.at >= win.from && p.at <= win.to), ...segs.flat()], [visible, segs, win.from, win.to]);
  const [lo, hi] = frozen.current ?? yDomain([drawnVals, prev, extremes, shownPreview, turns, shownLive ? [shownLive] : [], warn === undefined ? [] : [{ at: win.to, value: warn }], ghostLine === undefined ? [] : [{ at: win.to, value: ghostLine }]], threshold, unit);
  const Y = (v: number) => pad + (1 - (v - lo) / (hi - lo || 1)) * (height - pad * 2);
  const valueAtY = (y: number) => lo + (1 - (y - pad) / (height - pad * 2)) * (hi - lo);
  const within = (p: Pt) => p.at >= win.from && p.at <= win.to;
  // A run read far apart on screen (a daily or weekly series) marks each value on its line, as a trend chart does.
  const marked = useMemo(() => runs.filter((r) => !r.sparse && (r.step / (win.to - win.from || 1)) * W >= 9).flatMap((r) => r.points).filter((p) => p.at >= win.from && p.at <= win.to), [runs, win.from, win.to]);
  // A value standing alone is a tick, never joined: the same rule for the value, the previous period and a query's preview.
  const minHalf = span * 0.004;
  // A lone value's dash stops at the edge of a hole beside it, so it never reads as values held across the stretch.
  const ticks = useMemo(
    () => ticksOf(sparse.flatMap((r) => r.points).filter((p) => p.at >= win.from && p.at <= win.to), minHalf, visible).map((t) => ({
      ...t,
      from: holes.some((h) => h.to === t.pt.at) ? Math.max(t.from, t.pt.at - minHalf) : t.from,
      to: holes.some((h) => h.from === t.pt.at) ? Math.min(t.to, t.pt.at + minHalf) : t.to,
    })),
    [sparse, minHalf, visible, win.from, win.to, holes],
  );
  const prevRuns = useMemo(() => lineRuns(prev, interval_ms), [prev, interval_ms]);
  const prevSegs = useMemo(() => prevRuns.filter((r) => !r.sparse).map((r) => r.points), [prevRuns]);
  const prevTicks = useMemo(() => ticksOf(prevRuns.filter((r) => r.sparse).flatMap((r) => r.points), minHalf, prev), [prevRuns, minHalf, prev]);
  const previewRuns = useMemo(() => lineRuns(shownPreview, interval_ms), [shownPreview, interval_ms]);
  const previewSegs = useMemo(() => previewRuns.filter((r) => !r.sparse).map((r) => clipRunToWindow(r.points, win)).filter((s) => s.length > 0), [previewRuns, win]);
  const previewTicks = useMemo(() => ticksOf(previewRuns.filter((r) => r.sparse).flatMap((r) => r.points).filter((p) => p.at >= win.from && p.at <= win.to), minHalf, shownPreview), [previewRuns, minHalf, shownPreview, win.from, win.to]);
  // With the page's transitions, the bands run from a crossing to the recovery the list names, so the shading and the list agree on when an episode ended; a window that opens past the line with nothing listed before it still shades that stretch.
  // A value read just now past the line is banded like any other: a preview that would alert on its first poll says so in red.
  const banded = useMemo(() => (shownLive && (!visible.length || shownLive.at > visible[visible.length - 1].at) ? [...visible, shownLive] : visible), [visible, shownLive]);
  const valueBands = useMemo(() => {
    const own = alertBands(banded, threshold, direction, win.to);
    if (!transitions) return cutHoles(own, holes);
    const listed = bandsFromTransitions(transitions, win.to).filter((b) => b.to >= win.from && b.from <= win.to);
    const head = own[0] && banded[0] && own[0].from === banded[0].at && !listed.some((b) => b.from <= own[0].from && b.to >= own[0].from) ? [own[0]] : [];
    return cutHoles([...head, ...listed], holes);
  }, [banded, threshold, direction, win.from, win.to, transitions, holes]);
  // Where no values are held, the announced episodes stand in for the values' own bands.
  const gapBands = useMemo(() => (gap && episodes ? episodes.filter((e) => e.from < gap.to).map((e) => ({ from: e.from, to: Math.min(e.to, gap.to) })) : []), [gap, episodes]);
  const bands = useMemo(() => [...gapBands, ...valueBands], [gapBands, valueBands]);
  // The strip under the plot says "past the line" only where values were held: the announced episodes are cut at each hole too.
  const strip = useMemo(() => (episodes ? cutHoles(episodes, holes) : valueBands), [episodes, holes, valueBands]);
  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.value).toFixed(1)}${pts.length === 1 ? "h0.01" : ""}`).join("");
  // A folded bucket's min to max, as a faint band behind the line.
  const range = (pts: SeriesPt[]) => {
    const r = pts.filter((p) => p.min !== undefined && p.max !== undefined && p.max > p.min);
    if (r.length < 2) return "";
    const top = r.map((p, i) => `${i ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.max!).toFixed(1)}`).join("");
    const bottom = [...r].reverse().map((p) => `L${X(p.at).toFixed(1)},${Y(p.min!).toFixed(1)}`).join("");
    return `${top}${bottom}Z`;
  };
  const area = (pts: Pt[]) => (pts.length > 1 ? `${path(pts)}L${X(pts[pts.length - 1].at).toFixed(1)},${height - pad}L${X(pts[0].at).toFixed(1)},${height - pad}Z` : "");
  const dotsPath = (pts: Pt[]) => pts.map((p) => `M${X(p.at).toFixed(1)},${Y(p.value).toFixed(1)}h0.01`).join("");
  const ticksPath = (ts: { pt: Pt; from: number; to: number }[]) => ts.map((t) => `M${X(t.from).toFixed(1)},${Y(t.pt.value).toFixed(1)}H${X(t.to).toFixed(1)}`).join("");
  // The newest value inside the window: a neighbour past either edge is only there to carry the line to it.
  const last = useMemo(() => [...visible].reverse().find(within) ?? null, [visible, win.from, win.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const alerting = last && threshold !== undefined && crosses(last.value, threshold, direction);
  // The line keeps its own ink; only the stretches past the line turn red (clipped to the alerting side), the way Grafana colours by threshold.
  const stroke = paused ? "var(--sol-text-dim)" : ink ?? "var(--sol-cyan)";
  const ty = line === undefined ? null : Y(line);
  const clip = ty === null || paused ? null : direction === "above" ? { y: -height, h: ty + height } : { y: ty, h: height * 2 - ty };
  const gy = ghostLine === undefined || ghostLine === threshold ? null : Y(ghostLine);
  const wy = warn === undefined ? null : Y(warn);
  const yTicks = full && !loading ? niceTicks(lo, hi, 4) : [];
  const yLabels = yTicks.map((t) => formatValue(t, unit));
  // The gutter fits the widest label, so a unit like "/day" never runs past the card.
  const gutter = `${Math.max(3, ...yLabels.map((l) => l.length)) * 0.62 + 0.4}em`;
  const xTicks = full && !loading ? timeTicks(win, 6) : [];
  const xLabels = useMemo(() => tickLabels(xTicks, win), [xTicks.join(","), win.from, win.to]); // eslint-disable-line react-hooks/exhaustive-deps
  // The window's end is always named (the newest values sit against it), unless a tick already stands close to it.
  const endLabel = full && !loading && (!xTicks.length || win.to - xTicks[xTicks.length - 1] > span * 0.12) ? endStamp(win) : null;
  // A tick label that would run into the end's label is dropped (labels are about 6px a character, the end's right-aligned, a tick's centred).
  const xKept = xLabels.map((l, i) => !endLabel || ((win.to - xTicks[i]) / span) * plotW > (endLabel.length + l.length / 2) * 6 + 6);
  // The draggable line's value sits in a gutter right of the plot, never over the newest values.
  const handle = ty !== null && onThreshold && full ? formatValue(line!, unit) : null;
  const rightGutter = handle ? `${handle.length * 0.62 + 1.6}em` : undefined;
  const shownMarks = full ? (marks ?? []).filter((m) => m.at >= win.from && m.at <= win.to) : [];
  const shipClusters = useMemo(() => (full && ships?.length ? clusterShips(ships, win, plotW) : []), [full, ships, win, plotW]);

  const fracOf = (e: { clientX: number }) => {
    const r = ref.current?.getBoundingClientRect();
    return r && r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
  };
  const near = (frac: number): Hover => {
    const at = win.from + frac * span;
    const tol = Math.max(interval_ms * 1.5, span / 40);
    const pt = valueNear(visible, at, tol) ?? (sparse.length ? valueNear(sparse.flatMap((r) => r.points), at, span / 12) : null);
    // The spacing the value was read at, when it is coarser than the polls: "one value per 7d".
    const run = pt ? runs.find((r) => r.points.includes(pt as SeriesPt)) : undefined;
    const apart = run && !run.sparse && run.step >= Math.max(2 * interval_ms, COARSE_STEP) ? run.step : null;
    const band = bandAt(strip, at);
    // Inside a stretch with no values, the tip names the stretch, not the value at its edge.
    const hole = holes.find((h) => at > h.from && at < h.to) ?? null;
    const shownPt = hole && pt && Math.abs(pt.at - at) > interval_ms * 1.5 ? null : pt;
    return { frac, pt: shownPt, prev: valueNear(prev, at, tol), apart: shownPt ? apart : null, band: band ? { ...band, open: band.to >= win.to - 60_000 } : null, hole: shownPt ? null : hole };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (drag !== null) {
      const r = ref.current!.getBoundingClientRect();
      setDrag(valueAtY(((e.clientY - r.top) / r.height) * height));
      return;
    }
    const f = fracOf(e);
    if (sel) setSel({ ...sel, b: f });
    setHover(near(f));
  };
  const onDown = (e: ReactPointerEvent) => {
    if (!full || !onZoom || e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const f = fracOf(e);
    setSel({ a: f, b: f });
  };
  const onUp = () => {
    if (drag !== null) {
      const v = roundToScale(drag, hi - lo);
      frozen.current = null;
      setDrag(null);
      if (onThreshold && v !== threshold) onThreshold(v);
      return;
    }
    if (sel && onZoom && Math.abs(sel.b - sel.a) > 0.015) {
      const [a, b] = sel.a < sel.b ? [sel.a, sel.b] : [sel.b, sel.a];
      onZoom({ from: Math.round(win.from + a * span), to: Math.round(win.from + b * span) });
    }
    setSel(null);
  };
  const startLineDrag = (e: ReactPointerEvent) => {
    if (!onThreshold || line === undefined) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    frozen.current = [lo, hi];
    setDrag(line);
  };

  const pct = (x: number) => `${(x / W) * 100}%`;
  const hoverPt = hover?.pt ?? null;
  // Only the ship nearest the pointer stands full height, so the overlay never hides the values.
  const hoverShip = hover && !sel && shipClusters.length ? nearestShip(shipClusters, win.from + hover.frac * span, (24 / plotW) * span) : null;

  return (
    <div className="mx-chart" style={rightGutter ? { paddingRight: rightGutter } : undefined} data-full={full ? "" : undefined} data-paused={paused ? "" : undefined} data-dragging={drag !== null ? "" : undefined}>
      {full && (
        <div className="mx-y" aria-hidden style={{ height, width: gutter }}>
          {yTicks.map((t, i) => <span key={t} style={{ top: Y(t) }}>{yLabels[i]}</span>)}
        </div>
      )}
      <div
        ref={ref}
        className="mx-plot"
        style={{ height }}
        role="img"
        aria-label={label ?? `${visible.length} values${threshold === undefined ? "" : `, alerts ${direction} ${threshold}`}`}
        onPointerMove={onMove}
        onPointerLeave={() => { if (drag === null && !sel) setHover(null); }}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onDoubleClick={onResetZoom}
        data-zoomable={full && onZoom ? "" : undefined}
      >
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height}>
          {full && yTicks.map((t) => <line key={t} x1={0} x2={W} y1={Y(t)} y2={Y(t)} className="mx-grid" vectorEffect="non-scaling-stroke" />)}
          {full && xTicks.map((t) => <line key={t} x1={X(t)} x2={X(t)} y1={0} y2={height} className="mx-grid" vectorEffect="non-scaling-stroke" />)}
          {gap && gap.to > win.from && <rect x={X(Math.max(gap.from, win.from))} width={Math.max(0, X(Math.min(gap.to, win.to)) - X(Math.max(gap.from, win.from)))} y={0} height={height} className="mx-gap" data-metric-gap />}
          {bands.map((b) => (
            <rect key={b.from} x={X(Math.max(b.from, win.from))} width={Math.max(1.5, X(Math.min(b.to, win.to)) - X(Math.max(b.from, win.from)))} y={0} height={height} className="mx-band" />
          ))}
          {ty !== null && <rect x={0} y={direction === "above" ? 0 : ty} width={W} height={Math.max(0, direction === "above" ? ty : height - ty)} className="mx-side" />}
          {full && segs.map((s, i) => <path key={`r${i}`} d={range(s)} className="mx-range" style={{ fill: `color-mix(in srgb, ${stroke} 12%, transparent)` }} />)}
          {prevSegs.map((s, i) => <path key={`p${i}`} d={path(s)} className="mx-prev" vectorEffect="non-scaling-stroke" />)}
          {prevTicks.length > 0 && <path d={ticksPath(prevTicks)} className="mx-prev" data-prev-tick="" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          {full && segs.map((s, i) => <path key={`a${i}`} d={area(s)} className="mx-area" style={{ fill: `color-mix(in srgb, ${stroke} 10%, transparent)` }} />)}
          {clip && <clipPath id={clipId}><rect x={0} width={W} y={clip.y} height={Math.max(0, clip.h)} /></clipPath>}
          <clipPath id={`${clipId}p`}><rect x={0} width={W} y={-height} height={height * 3} /></clipPath>
          {[false, true].map((past) => (past && !clip ? null : (
            <g key={String(past)} clipPath={past ? `url(#${clipId})` : `url(#${clipId}p)`} data-past={past ? "" : undefined}>
              {ticks.length > 0 && (
                <g>
                  {/* A card draws a lone value as a dot alone; a dash at that size reads as noise. */}
                  {full && <path d={ticksPath(ticks)} className="mx-line" data-sparse-tick="" style={{ stroke: past ? "var(--sol-red)" : stroke }} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
                  <path d={dotsPath(ticks.map((t) => t.pt))} className="mx-line" data-sparse-dot="" style={{ stroke: past ? "var(--sol-red)" : stroke }} strokeWidth={full ? 4.5 : 3.5} vectorEffect="non-scaling-stroke" />
                </g>
              )}
              {segs.map((s, i) => <path key={i} d={path(s)} className="mx-line" style={{ stroke: past ? "var(--sol-red)" : stroke }} strokeWidth={s.length === 1 ? 4 : full ? 1.75 : 1.5} vectorEffect="non-scaling-stroke" />)}
              {marked.length > 0 && <path d={dotsPath(marked)} className="mx-line" data-point-marker="" style={{ stroke: past ? "var(--sol-red)" : stroke }} strokeWidth={full ? 5 : 3.5} vectorEffect="non-scaling-stroke" />}
              {shownLive && last && shownLive.at > last.at && <path d={path([last, shownLive])} className="mx-line mx-live-join" style={{ stroke: past ? "var(--sol-red)" : stroke }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" data-live-join={past ? "past" : ""} />}
            </g>
          )))}
          {previewSegs.map((s, i) => <path key={`v${i}`} d={path(s)} className="mx-line mx-preview-line" strokeWidth={s.length === 1 ? 5 : 1.5} vectorEffect="non-scaling-stroke" />)}
          {previewTicks.length > 0 && <path d={`${ticksPath(previewTicks)}${dotsPath(previewTicks.map((t) => t.pt))}`} className="mx-line mx-preview-line" data-preview-tick="" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
          {gy !== null && <line x1={0} x2={W} y1={gy} y2={gy} className="mx-ghost" vectorEffect="non-scaling-stroke" data-ghost-line />}
          {wy !== null && <line x1={0} x2={W} y1={wy} y2={wy} className="mx-warn" vectorEffect="non-scaling-stroke" />}
          {ty !== null && <line x1={0} x2={W} y1={ty} y2={ty} className="mx-threshold" vectorEffect="non-scaling-stroke" />}
          {sel && <rect x={Math.min(sel.a, sel.b) * W} width={Math.abs(sel.b - sel.a) * W} y={0} height={height} className="mx-sel" />}
          {hoverShip && <line x1={X(hoverShip.at)} x2={X(hoverShip.at)} y1={0} y2={height} className="mx-ship-line" vectorEffect="non-scaling-stroke" data-ship-line />}
          {hover && !sel && <line x1={hover.frac * W} x2={hover.frac * W} y1={0} y2={height} className="mx-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {full && gap && gap.to > win.from && X(Math.min(gap.to, win.to)) - X(Math.max(gap.from, win.from)) > W * 0.08 && (
          <span className="mx-gap-label" style={{ left: pct(X(Math.max(gap.from, win.from))), width: pct(X(Math.min(gap.to, win.to)) - X(Math.max(gap.from, win.from))) }} onPointerDown={(e) => e.stopPropagation()} data-metric-gap-label>
            <span>no values held</span>
            {gapAction}
          </span>
        )}
        {holes.map((h) => (
          <span key={`h${h.from}`} className="mx-hole" aria-hidden style={{ left: pct(X(Math.max(h.from, win.from))), width: pct(Math.max(0, X(Math.min(h.to, win.to)) - X(Math.max(h.from, win.from)))) }} data-metric-hole={h.missed} />
        ))}
        {full && strip.filter((b) => (b.to ?? win.to) >= win.from && b.from <= win.to).map((b) => (
          <span key={`s${b.from}`} className="mx-band-strip" style={{ left: pct(X(Math.max(b.from, win.from))), width: pct(Math.max(1.5, X(Math.min(b.to, win.to)) - X(Math.max(b.from, win.from)))) }} />
        ))}
        {shownMarks.map((m) => (
          <span key={`${m.kind}${m.at}`} className="mx-mark" data-kind={m.kind} style={{ left: pct(X(m.at)) }} onPointerDown={(e) => e.stopPropagation()} data-metric-mark={m.kind}>
            {m.href && m.external ? <a href={m.href} target="_blank" rel="noreferrer" className="mx-mark-head" aria-label={m.label} />
              : m.href ? <Link href={m.href} className="mx-mark-head" aria-label={m.label} />
              : <span className="mx-mark-head" tabIndex={0} aria-label={m.label} />}
            <span className="mx-mark-card" data-side={X(m.at) > W * 0.6 ? "left" : "right"}>
              <b>{m.label}</b>
              <span>{stampLabel(m.at)}</span>
              {m.sub && <span>{m.sub}</span>}
              {(m.also || (m.href && m.kind === "deploy")) && (
                <span className="mx-mark-links">
                  {m.href && m.kind === "deploy" && <a href={m.href} target="_blank" rel="noreferrer">Commit</a>}
                  {m.also && <Link href={m.also.href}>{m.also.label}</Link>}
                </span>
              )}
            </span>
          </span>
        ))}
        {shipClusters.map((c) => <ShipMarker key={`${c.at}`} cluster={c} left={pct(X(c.at))} side={X(c.at) > W * 0.6 ? "left" : "right"} hot={c === hoverShip} />)}
        {turns.map((t) => (
          <span
            key={`t${t.at}${t.kind}`}
            className="mx-turn"
            data-kind={t.kind}
            data-inferred={t.inferred ? "" : undefined}
            style={{ left: pct(X(t.at)), top: Y(t.value) }}
            title={`${t.kind} ${formatValue(t.value, unit)} · ${stampLabel(t.at)}${t.inferred ? " · not announced" : ""}`}
            data-metric-turn={t.kind}
          />
        ))}
        {(shownLive ?? last) && !hover && (() => {
          const dot = shownLive ?? last!;
          const hot = threshold !== undefined && !paused && crosses(dot.value, threshold, direction);
          return <span className="mx-dot" style={{ left: pct(X(dot.at)), top: Y(dot.value), background: (shownLive ? hot : alerting && !paused) ? "var(--sol-red)" : stroke }} data-live-dot={shownLive ? "" : undefined} />;
        })()}
        {hoverPt && <span className="mx-dot" data-hover="" style={{ left: pct(X(hoverPt.at)), top: Y(hoverPt.value), background: threshold !== undefined && !paused && crosses(hoverPt.value, threshold, direction) ? "var(--sol-red)" : stroke }} />}
        {handle !== null && (
          <span className="mx-handle" style={{ top: ty! }} onPointerDown={startLineDrag} title="Drag to move the line" aria-label="Threshold">
            <b>{handle}</b>
          </span>
        )}
        {hover && !sel && drag === null && (
          <Tip hover={hover} threshold={threshold} direction={direction} unit={unit} />
        )}
        {drag !== null && <span className="mx-tip" style={{ left: "50%", top: Math.max(0, Y(drag) - 30) }}>line {direction} {formatValue(roundToScale(drag, hi - lo), unit)}</span>}
        {loading || stale ? <span className="mx-loading" role="progressbar" aria-label="Loading values" data-metric-loading /> : visible.length === 0 && !gap && <span className="mx-empty">no values in this window</span>}
        {axisStart && !full && <span className="mx-spark-start" data-axis-start>{shortStamp(win.from)}</span>}
      </div>
      {full && (
        <div className="mx-x" aria-hidden>
          {xTicks.map((t, i) => (xKept[i] ? <span key={t} style={{ left: pct(X(t)) }}>{xLabels[i]}</span> : null))}
          {endLabel && <span data-x-end="" style={{ left: "100%" }}>{endLabel}</span>}
        </div>
      )}
    </div>
  );
}

const SHIP_LIST_MAX = 8;
/** How far past the spacing around it a gap must run before a card's line breaks there (the full chart breaks at 2.2). */
const CARD_JOIN = 6;

/** The ship cluster nearest a moment, within `reach`. */
function nearestShip(clusters: readonly ShipCluster[], at: number, reach: number): ShipCluster | null {
  let best: ShipCluster | null = null;
  for (const c of clusters) if (Math.abs(c.at - at) <= reach && (!best || Math.abs(c.at - at) < Math.abs(best.at - at))) best = c;
  return best;
}

/** One ship, or several close together, as a tick on the time axis: a count when clustered, and a card listing each with its commit and session. */
function ShipMarker({ cluster, left, side, hot }: { cluster: ShipCluster; left: string; side: "left" | "right"; hot: boolean }) {
  const n = cluster.marks.length;
  const first = cluster.marks[0];
  const lastAt = cluster.marks[n - 1].at;
  return (
    <span className="mx-ship" style={{ left }} onPointerDown={(e) => e.stopPropagation()} data-hot={hot ? "" : undefined} data-metric-ship={n}>
      <span className="mx-ship-head" tabIndex={0} aria-label={n === 1 ? first.label : `${n} ships`}>{n > 1 ? n : null}</span>
      <span className="mx-mark-card mx-ship-card" data-side={side}>
        <b>{n === 1 ? first.label : `${n} ships`}</b>
        <span className="ops-num">{n === 1 || lastAt === first.at ? stampLabel(first.at) : `${stampLabel(first.at)} – ${stampLabel(lastAt)}`}</span>
        {n === 1 ? (
          <>
            {first.sub && <span>{first.sub}</span>}
            {(first.href || first.also) && (
              <span className="mx-mark-links">
                {first.href && <a href={first.href} target="_blank" rel="noreferrer">Commit</a>}
                {first.also && <Link href={first.also.href}>{first.also.label}</Link>}
              </span>
            )}
          </>
        ) : (
          <ul className="mx-ship-list">
            {cluster.marks.slice(0, SHIP_LIST_MAX).map((m) => (
              <li key={`${m.at}${m.label}`}>
                {m.href ? <a href={m.href} target="_blank" rel="noreferrer" title={m.label}>{m.label}</a> : <span title={m.label}>{m.label}</span>}
                {m.also && <Link href={m.also.href} className="ops-dim">{m.also.label}</Link>}
              </li>
            ))}
            {n > SHIP_LIST_MAX && <li className="ops-dim">{n - SHIP_LIST_MAX} more</li>}
          </ul>
        )}
      </span>
    </span>
  );
}

function Tip({ hover, threshold, direction, unit }: { hover: Hover; threshold?: number; direction: Direction; unit?: string }) {
  const b = hover.pt as SeriesPt | null;
  const p = hover.pt;
  const right = hover.frac > 0.6;
  const style = right ? { right: `${(1 - hover.frac) * 100}%` } : { left: `${hover.frac * 100}%` };
  if (!p && !hover.prev && !hover.band && !hover.hole) return null;
  const vs = p && threshold !== undefined ? p.value - threshold : null;
  const past = p && threshold !== undefined && crosses(p.value, threshold, direction);
  return (
    <span className="mx-tip" data-side={right ? "left" : "right"} style={style}>
      {p && <span className="mx-tip-time">{stampLabel(p.at)}</span>}
      {p && <b className="ops-num">{formatValue(p.value, unit)}</b>}
      {b && b.min !== undefined && b.max !== undefined && b.max > b.min && <span className="ops-num mx-tip-prev">{formatValue(b.min, unit)} – {formatValue(b.max, unit)}</span>}
      {vs !== null && <span className="ops-num" data-past={past ? "" : undefined}>{vs >= 0 ? "+" : ""}{formatValue(vs, unit)} vs line</span>}
      {hover.prev && <span className="ops-num mx-tip-prev">prior {formatValue(hover.prev.value, unit)}</span>}
      {hover.apart && <span className="mx-tip-prev" data-tip-sparse>one value per {spanLabel(hover.apart)} here</span>}
      {hover.hole && (
        <span className="mx-tip-hole" data-tip-hole>
          <b>no values</b>
          <span className="ops-num">{stampLabel(hover.hole.from)} – {stampLabel(hover.hole.to)}</span>
          <span className="ops-num mx-tip-prev">{durationShort(hover.hole.to - hover.hole.from)}{hover.hole.missed ? ` · ${hover.hole.missed.toLocaleString()} ${hover.hole.missed === 1 ? "poll" : "polls"} missed` : ""}</span>
        </span>
      )}
      {hover.band && <span className="mx-tip-band" data-tip-band>alerting {hover.band.open ? `since ${stampLabel(hover.band.from)}` : `${stampLabel(hover.band.from)} to ${stampLabel(hover.band.to)}`}</span>}
    </span>
  );
}

/** A watch's state as a pill: how long an alert has run, a read error's glyph, nothing for a plain series that is reading. */
export function HealthPill({ watch, now, since: episodeSince }: { watch: OpsWatch; now: number; /** When the running alert began (metricModel currentEpisodeSince); the values' own run when absent. */ since?: number | null }) {
  const h = watchHealth(watch);
  const muted = isMutedAt(watch, now);
  if (h === "series" && !muted) return null;
  const look = HEALTH_LOOK[h];
  const since = h === "alert" ? (episodeSince ?? alertSince(watch)) : null;
  return (
    <span className="mx-health" style={{ ["--ink" as string]: look.ink }} title={h === "error" || h === "retrying" ? watch.last_error : muted ? `Muted until ${stampLabel(watch.muted_until!)}` : undefined} data-health={h} data-muted={muted ? "" : undefined}>
      {h === "error" && <AlertTriangle aria-hidden />}
      {muted && <BellOff aria-label="muted" />}
      {h === "series" ? "Muted" : look.label}{since ? ` ${durationShort(now - since)}` : ""}
    </span>
  );
}

/** The window's end on the time axis: its date for a window of days, its time for a shorter one. */
function endStamp(win: Win): string {
  const d = new Date(win.to);
  return win.to - win.from >= 2 * 86_400_000
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A moment as a card's axis names it: the date, or the time when it is today. */
function shortStamp(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
