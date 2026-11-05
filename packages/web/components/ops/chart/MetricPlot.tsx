// A watched metric over time, drawn with ECharts: the line against real
// timestamps (broken where the source sent nothing, a value standing alone
// a short dash), red only where it is past the alert line, the time past
// the line shaded and stripped along the floor, the previous period dashed,
// a query's preview in violet, ships and moments as markers on the time
// axis. The full chart adds axes, a drag-to-zoom brush, a line you drag by
// its tab in the right gutter, and a tip that reads the value, its distance
// to the line, the prior period and any stretch the moment falls in. Same
// props as the SVG MetricChart it replaces; plotModel works out what to draw.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { ECharts, EChartsOption } from "./echarts";
import { OpsChart } from "./OpsChart";
import { alpha, axisBase, esc, resolveColor, swatch, tipRow, tooltipBase, type ChartTheme } from "./chartTheme";
import { hoverAt, plotModel, splitAtLine, type PlotInput, type Seg, type Tick } from "./metricPlotModel";
import { crosses, durationShort, formatValue, spanLabel, stampLabel, type Direction, type Pt } from "../metricModel";
import { clusterShips, type ChartMark, type ShipCluster } from "../metricEvents";
import { roundToScale } from "../metricEditing";
import type { MetricChartProps } from "../MetricChart";
import "./metricPlot.css";

const SHIP_LIST_MAX = 8;
const AXIS_LEFT = 46;
const GUTTER = 50;

/** Runs as one series' data, a null between runs so the line breaks there. */
function joined(segs: Seg[]): ([number, number] | [number, null])[] {
  const out: ([number, number] | [number, null])[] = [];
  segs.forEach((s, i) => {
    if (i) out.push([s[0].at, null]);
    for (const p of s) out.push([p.at, p.value]);
  });
  return out;
}
const tickSegs = (ts: Tick[]): Seg[] => ts.map(t => [{ at: t.from, value: t.pt.value }, { at: t.to, value: t.pt.value }]);

export function MetricPlot(props: MetricChartProps) {
  const {
    points, win, interval_ms, threshold, warn, direction, unit, marks, ships, compare, height = 64, full = false, paused = false, ink,
    onZoom, onResetZoom, onThreshold, label, loading = false, stale = false, preview, ghostLine, axisStart = false, gap, gapAction,
    episodes, transitions, poll_ms, live,
  } = props;
  const input: PlotInput = { points, win, interval_ms, threshold, warn, direction, compare, full, loading, preview, ghostLine, gap, episodes, transitions, poll_ms, live };
  const model = useMemo(() => plotModel(input), [points, win.from, win.to, interval_ms, threshold, warn, direction, compare, full, loading, preview, ghostLine, gap, episodes, transitions, poll_ms, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drag, setDrag] = useState<number | null>(null);
  const [plotW, setPlotW] = useState(800);
  const wrap = useRef<HTMLDivElement>(null);
  // Handlers bound once on mount read the latest window and callbacks through here.
  const live$ = useRef({ win, onZoom, onResetZoom });
  live$.current = { win, onZoom, onResetZoom };
  const line = drag ?? threshold;
  const handle = full && onThreshold && threshold !== undefined;
  const left = full ? AXIS_LEFT : 0;
  const right = full ? (handle ? GUTTER : 14) : 0;

  useEffect(() => {
    const el = wrap.current;
    if (!el || !full) return;
    const ro = new ResizeObserver(e => {
      const w = Math.round((e[0]?.contentRect.width ?? 0) - left - right);
      setPlotW(p => (w > 0 && Math.abs(p - w) >= 16 ? w : p));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [full, left, right]);

  const shipClusters = useMemo(() => (full && ships?.length ? clusterShips(ships, win, plotW) : []), [full, ships, win, plotW]);
  const shownMarks = full ? (marks ?? []).filter(m => m.at >= win.from && m.at <= win.to) : [];
  const span = win.to - win.from || 1;
  const frac = (at: number) => `${((at - win.from) / span) * 100}%`;

  const option = (t: ChartTheme): EChartsOption => {
    const stroke = paused ? t.dim : resolveColor(ink ?? "var(--sol-cyan)");
    const red = paused ? t.dim : t.red;
    const { safe, past } = splitAtLine(model.segs, paused ? undefined : line, direction);
    const [lo, hi] = model.y;
    const dot = model.live ?? model.last;
    const dotPast = !!dot && line !== undefined && !paused && crosses(dot.value, line, direction);
    const markLines: { yAxis: number; lineStyle: object; label?: object }[] = [];
    if (line !== undefined) markLines.push({ yAxis: line, lineStyle: { color: red, type: [3, 4], width: 1.2 }, label: { show: false } });
    if (warn !== undefined) markLines.push({ yAxis: warn, lineStyle: { color: t.yellow, type: [3, 4], width: 1 } });
    if (ghostLine !== undefined && ghostLine !== threshold) markLines.push({ yAxis: ghostLine, lineStyle: { color: t.violet, type: [2, 3], width: 1.2 } });
    const side = line === undefined || paused ? [] : [[{ yAxis: direction === "above" ? line : lo }, { yAxis: direction === "above" ? hi : line }]];
    const turnColor = (k: string) => (k === "crossed" ? t.red : t.green);
    return {
      animation: false,
      grid: full ? { left, right, top: 10, bottom: 24 } : { left: 1, right: 1, top: 4, bottom: 4 },
      xAxis: {
        type: "time", min: win.from, max: win.to, show: full, ...axisBase(t), splitLine: { show: false },
        axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true, formatter: { year: "{yyyy}", month: "{MMM}", day: "{MMM} {d}", hour: "{HH}:{mm}", minute: "{HH}:{mm}" } as never },
        axisPointer: { label: { show: false } },
      },
      yAxis: [
        { type: "value", min: lo, max: hi, show: full, ...axisBase(t), splitNumber: 4, axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => formatValue(v, unit) } },
        { type: "value", min: 0, max: 1, show: false },
      ],
      tooltip: {
        ...tooltipBase(t), trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: alpha(t.text, 0.25), width: 1 } },
        formatter: ((ps: { axisValue: number }[]) => {
          const h = hoverAt(model, input, Number(ps[0]?.axisValue));
          if (!h.pt && !h.prev && !h.band && !h.hole) return "";
          let s = "";
          if (h.pt) {
            const isPast = line !== undefined && !paused && crosses(h.pt.value, line, direction);
            s += `<div style="color:${t.dim};font-size:11px">${esc(stampLabel(h.pt.at))}</div>`;
            s += `<div style="font-family:${t.mono};font-size:17px;font-weight:600;letter-spacing:-.02em;margin:1px 0 3px;color:${isPast ? t.red : t.text}">${esc(formatValue(h.pt.value, unit))}</div>`;
            const b = h.pt as Pt & { min?: number; max?: number };
            if (b.min !== undefined && b.max !== undefined && b.max > b.min) s += tipRow(t, "", "range", `${formatValue(b.min, unit)} – ${formatValue(b.max, unit)}`);
            if (line !== undefined) { const d = h.pt.value - line; s += tipRow(t, swatch(t.red, true), "vs line", `${d >= 0 ? "+" : ""}${formatValue(d, unit)}`); }
          }
          if (h.prev) s += tipRow(t, swatch(t.dim, true), "prior", formatValue(h.prev.value, unit));
          if (h.apart) s += `<div style="color:${t.dim};margin-top:4px">one value per ${esc(spanLabel(h.apart))} here</div>`;
          if (h.hole) s += `<div style="margin-top:2px"><b>no values</b><div style="color:${t.dim};font-family:${t.mono};font-size:11px">${esc(stampLabel(h.hole.from))} – ${esc(stampLabel(h.hole.to))} · ${esc(durationShort(h.hole.to - h.hole.from))}${h.hole.missed ? ` · ${h.hole.missed.toLocaleString()} ${h.hole.missed === 1 ? "poll" : "polls"} missed` : ""}</div></div>`;
          if (h.band) s += `<div style="margin-top:5px;color:${t.red}">alerting ${h.band.open ? `since ${esc(stampLabel(h.band.from))}` : `${esc(stampLabel(h.band.from))} to ${esc(stampLabel(h.band.to))}`}</div>`;
          return s;
        }) as never,
      },
      toolbox: full && onZoom ? { show: true, right: -400, feature: { brush: { type: ["lineX"] } } } : undefined,
      brush: full && onZoom ? { xAxisIndex: 0, brushType: "lineX", brushMode: "single", transformable: false, throttleType: "debounce", throttleDelay: 0, brushStyle: { color: alpha(t.blue, 0.1), borderColor: alpha(t.blue, 0.45), borderWidth: 1 }, outOfBrush: { colorAlpha: 1 } } : undefined,
      series: [
        // Shading first: the side past the line, the bands, the holes, the gap, the strip on the floor.
        { id: "shade", type: "line", data: [], silent: true,
          markArea: { silent: true, data: [
            ...side.map(([a, b]) => [{ ...a, itemStyle: { color: alpha(t.red, t.dark ? 0.05 : 0.035) } }, b]),
            ...model.bands.map(b => [{ xAxis: Math.max(b.from, win.from), itemStyle: { color: alpha(t.red, t.dark ? 0.13 : 0.09) } }, { xAxis: Math.min(b.to, win.to) }]),
            ...model.holes.map(h => [{ xAxis: Math.max(h.from, win.from), itemStyle: { color: alpha(t.dim, 0.09) } }, { xAxis: Math.min(h.to, win.to) }]),
            ...(gap && gap.to > win.from ? [[{ xAxis: Math.max(gap.from, win.from), itemStyle: { color: alpha(t.dim, 0.08) } }, { xAxis: Math.min(gap.to, win.to) }]] : []),
          ] as never },
          markLine: markLines.length ? { silent: true, symbol: "none", animation: false, data: markLines as never } : undefined,
        },
        { id: "strip", type: "line", yAxisIndex: 1, data: [], silent: true,
          markArea: full ? { silent: true, data: model.strip.filter(b => b.to >= win.from && b.from <= win.to).map(b => [{ xAxis: Math.max(b.from, win.from), yAxis: 0, itemStyle: { color: t.red } }, { xAxis: Math.min(b.to, win.to), yAxis: 0.018 }]) as never } : undefined },
        // The folded buckets' spread, as a faint band behind the line.
        { id: "rangeLo", type: "line", stack: "range", data: joined(model.ranges.map(r => r.map(p => ({ at: p.at, value: (p as { min: number }).min })))), symbol: "none", silent: true, lineStyle: { opacity: 0 }, tooltip: { show: false } },
        { id: "range", type: "line", stack: "range", data: joined(model.ranges.map(r => r.map(p => ({ at: p.at, value: (p as { max: number }).max - (p as { min: number }).min })))), symbol: "none", silent: true, lineStyle: { opacity: 0 }, areaStyle: { color: alpha(stroke, 0.12) }, tooltip: { show: false } },
        { id: "prev", type: "line", data: joined([...model.prevSegs, ...tickSegs(model.prevTicks)]), symbol: "none", silent: true, lineStyle: { color: t.dim, width: 1.25, type: [4, 3], opacity: 0.85 } },
        { id: "area", type: "line", data: joined(model.segs), symbol: "none", silent: true, lineStyle: { opacity: 0 }, areaStyle: full ? { color: alpha(stroke, t.dark ? 0.14 : 0.1) } : { color: alpha(stroke, 0.08) } },
        { id: "value", type: "line", data: joined([...safe, ...(full ? tickSegs(model.ticks) : [])]), symbol: "none", connectNulls: false, lineStyle: { color: stroke, width: full ? 1.8 : 1.5 }, emphasis: { disabled: true }, z: 3 },
        { id: "past", type: "line", data: joined(past), symbol: "none", connectNulls: false, lineStyle: { color: red, width: full ? 2 : 1.6 }, emphasis: { disabled: true }, silent: true, z: 4 },
        { id: "dots", type: "scatter", silent: true, z: 5, symbolSize: full ? 5 : 3.5,
          data: [...model.marked, ...model.ticks.map(x => x.pt)].map(p => ({ value: [p.at, p.value], itemStyle: { color: line !== undefined && !paused && crosses(p.value, line, direction) ? red : stroke } })) },
        { id: "preview", type: "line", data: joined([...model.previewSegs, ...tickSegs(model.previewTicks)]), symbol: "none", silent: true, lineStyle: { color: t.violet, width: 1.5, type: [5, 3] }, z: 4 },
        { id: "live", type: "line", data: model.live && model.last && model.live.at > model.last.at ? [[model.last.at, model.last.value], [model.live.at, model.live.value]] : [], symbol: "none", silent: true, lineStyle: { color: dotPast ? red : stroke, width: 1.5, type: [3, 3] }, z: 4 },
        { id: "turns", type: "scatter", z: 6, silent: true, symbol: "diamond", symbolSize: 9,
          data: model.turns.map(x => ({ value: [x.at, x.value], itemStyle: x.inferred ? { color: t.card, borderColor: turnColor(x.kind), borderWidth: 1.5 } : { color: turnColor(x.kind), borderColor: t.card, borderWidth: 1.5 } })) },
        { id: "now", type: "scatter", z: 7, silent: true, symbolSize: full ? 8 : 6,
          data: dot ? [{ value: [dot.at, dot.value], itemStyle: { color: dotPast ? red : stroke, borderColor: t.card, borderWidth: 2 } }] : [] },
      ],
    };
  };

  // The tab that moves the line sits in the right gutter, at the line's height.
  const placeHandle = (c: ECharts, t: ChartTheme) => {
    if (!handle || line === undefined) { c.setOption({ graphic: [] }, { replaceMerge: ["graphic"] }); return; }
    const y = c.convertToPixel({ yAxisIndex: 0 }, line) as number;
    if (!Number.isFinite(y)) return;
    const w = c.getWidth();
    const text = formatValue(line, unit);
    const tw = Math.max(30, text.length * 7 + 12);
    c.setOption({ graphic: [{
      id: "line-handle", type: "group", x: 0, y, draggable: "vertical", z: 100, cursor: "ns-resize",
      children: [
        { type: "rect", shape: { x: left, y: -6, width: w - left - right, height: 12 }, style: { fill: "rgba(0,0,0,0)" }, cursor: "ns-resize" },
        { type: "rect", shape: { x: w - right + 6, y: -10, width: tw, height: 20, r: 6 }, style: { fill: t.red }, cursor: "ns-resize" },
        { type: "text", x: w - right + 6 + tw / 2, y: 0, style: { text, fill: "#fff", font: `600 11px ${t.mono}`, align: "center", verticalAlign: "middle" }, cursor: "ns-resize" },
      ],
      ondrag(this: { y: number }) {
        const [lo, hi] = model.y;
        const v = roundToScale(Math.min(hi, Math.max(lo, c.convertFromPixel({ yAxisIndex: 0 }, this.y) as number)), hi - lo);
        setDrag(v);
      },
      ondragend(this: { y: number }) {
        const [lo, hi] = model.y;
        const v = roundToScale(c.convertFromPixel({ yAxisIndex: 0 }, this.y) as number, hi - lo);
        setDrag(null);
        if (onThreshold && v !== threshold) onThreshold(v);
      },
    }] } as never, { replaceMerge: ["graphic"] });
  };

  const onReady = (c: ECharts) => {
    if (!full) return;
    if (live$.current.onZoom) {
      c.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } });
      c.on("brushEnd", (e: unknown) => {
        const r = (e as { areas?: { coordRange?: [number, number] }[] }).areas?.[0]?.coordRange;
        c.dispatchAction({ type: "brush", areas: [] });
        const { win: w, onZoom: zoom } = live$.current;
        if (r && zoom && Math.abs(r[1] - r[0]) > (w.to - w.from) * 0.015) zoom({ from: Math.round(Math.min(r[0], r[1])), to: Math.round(Math.max(r[0], r[1])) });
      });
    }
    c.getZr().on("dblclick", () => live$.current.onResetZoom?.());
  };

  const empty = !loading && model.visible.length === 0 && !gap;
  return (
    <div ref={wrap} className="mp" data-full={full ? "" : undefined} data-paused={paused ? "" : undefined} data-dragging={drag !== null ? "" : undefined} data-metric-chart="">
      <OpsChart
        option={option}
        deps={[model, line, paused, ink, unit, full, gap, onZoom ? 1 : 0, handle]}
        height={height}
        onReady={onReady}
        onDraw={placeHandle}
        ariaLabel={label ?? `${model.visible.length} values${threshold === undefined ? "" : `, alerts ${direction} ${threshold}`}`}
      />
      <div className="mp-over" style={{ left, right, bottom: full ? 24 : 4, top: full ? 10 : 4 }}>
        {full && gap && gap.to > win.from && (gap.to - Math.max(gap.from, win.from)) / span > 0.08 && (
          <span className="mp-gap" style={{ left: frac(Math.max(gap.from, win.from)), width: `${((Math.min(gap.to, win.to) - Math.max(gap.from, win.from)) / span) * 100}%` }} data-metric-gap-label>
            <span>no values held</span>
            {gapAction}
          </span>
        )}
        {shownMarks.map(m => <MarkPin key={`${m.kind}${m.at}`} mark={m} left={frac(m.at)} side={(m.at - win.from) / span > 0.6 ? "left" : "right"} />)}
        {shipClusters.map(c => <ShipPin key={c.at} cluster={c} left={frac(c.at)} side={(c.at - win.from) / span > 0.6 ? "left" : "right"} />)}
        {drag !== null && <span className="mp-drag">line {direction} {formatValue(drag, unit)}</span>}
        {(loading || stale) && <span className="mp-loading" role="progressbar" aria-label="Loading values" data-metric-loading />}
        {empty && <span className="mp-empty">no values in this window</span>}
        {axisStart && !full && <span className="mp-start" data-axis-start>{shortStamp(win.from)}</span>}
      </div>
    </div>
  );
}

function MarkPin({ mark: m, left, side }: { mark: ChartMark; left: string; side: "left" | "right" }) {
  const head = m.href && m.external ? <a href={m.href} target="_blank" rel="noreferrer" className="mp-pin-head" aria-label={m.label} />
    : m.href ? <Link href={m.href} className="mp-pin-head" aria-label={m.label} />
    : <span className="mp-pin-head" tabIndex={0} aria-label={m.label} />;
  return (
    <span className="mp-pin" data-kind={m.kind} style={{ left }} data-metric-mark={m.kind}>
      {head}
      <Card side={side} title={m.label} when={stampLabel(m.at)}>
        {m.sub && <span>{m.sub}</span>}
        {(m.also || (m.href && m.kind === "deploy")) && (
          <span className="mp-card-links">
            {m.href && m.kind === "deploy" && <a href={m.href} target="_blank" rel="noreferrer">Commit</a>}
            {m.also && <Link href={m.also.href}>{m.also.label}</Link>}
          </span>
        )}
      </Card>
    </span>
  );
}

function ShipPin({ cluster, left, side }: { cluster: ShipCluster; left: string; side: "left" | "right" }) {
  const n = cluster.marks.length;
  const first = cluster.marks[0];
  const lastAt = cluster.marks[n - 1].at;
  return (
    <span className="mp-ship" style={{ left }} data-metric-ship={n}>
      <span className="mp-ship-head" tabIndex={0} aria-label={n === 1 ? first.label : `${n} ships`}>{n > 1 ? n : null}</span>
      <Card side={side} title={n === 1 ? first.label : `${n} ships`} when={n === 1 || lastAt === first.at ? stampLabel(first.at) : `${stampLabel(first.at)} – ${stampLabel(lastAt)}`}>
        {n === 1 ? (
          <>
            {first.sub && <span>{first.sub}</span>}
            {(first.href || first.also) && (
              <span className="mp-card-links">
                {first.href && <a href={first.href} target="_blank" rel="noreferrer">Commit</a>}
                {first.also && <Link href={first.also.href}>{first.also.label}</Link>}
              </span>
            )}
          </>
        ) : (
          <ul className="mp-ship-list">
            {cluster.marks.slice(0, SHIP_LIST_MAX).map(m => (
              <li key={`${m.at}${m.label}`}>
                {m.href ? <a href={m.href} target="_blank" rel="noreferrer" title={m.label}>{m.label}</a> : <span title={m.label}>{m.label}</span>}
                {m.also && <Link href={m.also.href} className="mp-dim">{m.also.label}</Link>}
              </li>
            ))}
            {n > SHIP_LIST_MAX && <li className="mp-dim">{n - SHIP_LIST_MAX} more</li>}
          </ul>
        )}
      </Card>
    </span>
  );
}

function Card({ side, title, when, children }: { side: "left" | "right"; title: string; when: string; children?: ReactNode }) {
  return (
    <span className="mp-card" data-side={side}>
      <b>{title}</b>
      <span className="mp-num">{when}</span>
      {children}
    </span>
  );
}

/** A moment as a card's axis names it: the date, or the time when it is today. */
function shortStamp(at: number): string {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
