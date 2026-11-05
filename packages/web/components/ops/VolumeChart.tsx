// Count over time as stacked bars, the chart every tool in this space leads
// with, drawn by ECharts like the metric chart (chart/OpsChart). A count
// scale on the left and time ticks under it stay HTML, so the Timeline's
// lanes below line up with them to the pixel; hover a bar for its time and
// each series' count; drag across it to pick a range (the stream below
// narrows to it). Deploys stand as lines over the bars, merged into one
// "3 deploys" mark where their labels would collide. A span nothing recorded
// (before a counter's first day) is shaded and named, never drawn as zero.
import { useRef, type ReactNode } from "react";
import Link from "next/link";
import { clusterByPixels, isMidnight, niceMax, rangeTicks, seriesLabel, stackKeys, STACK_INK, tickBudget, unknownUntil, type HistBin } from "./timelineModel";
import { MARK_PX, endAnchored, mergeFacing, useWidth } from "./volumeChartLayout";
import { tickLabel } from "./timelineTabModel";
import { OpsChart } from "./chart/OpsChart";
import { alpha, esc, resolveColor, tipRow, tooltipBase, type ChartTheme } from "./chart/chartTheme";
import type { ECharts, EChartsOption } from "./chart/echarts";
import "./sourceView.css";

export type ChartMark = { at: number; label: string; href?: string; title?: string };

const when = (at: number, span: number) =>
  new Date(at).toLocaleString([], span > 3 * 86_400_000 ? { month: "short", day: "numeric", hour: "numeric" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A bin's own span as a person reads it: a day's bar is that day, an hour's is its hour. */
const binWhen = (b: HistBin) => {
  const w = b.to - b.from;
  if (w >= 86_400_000) return new Date(b.from).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const t = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${new Date(b.from).toLocaleDateString([], { month: "short", day: "numeric" })}, ${t(b.from)} to ${t(b.to)}`;
};
const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
/** The grid reaches this far above the plot, so the top tick's label is not cut in half. */
const GRID_PAD = 8;

export function VolumeChart({
  bins,
  range,
  marks = [],
  onBrush,
  height = 72,
  ink = (k) => STACK_INK[k] ?? "var(--sol-text-muted)",
  name = seriesLabel,
  empty,
  label,
  silence,
  dated,
}: {
  bins: HistBin[];
  range: { from: number; to: number };
  marks?: ChartMark[];
  onBrush?: (from: number, to: number) => void;
  height?: number;
  ink?: (key: string) => string;
  /** A series' name for the legend and the tooltip. */
  name?: (key: string) => string;
  /** Shown over a chart with nothing in it. */
  empty?: ReactNode;
  label?: string;
  /** A source known to have sent nothing since `from`: drawn as a flat, named stretch to the right edge rather than as missing data. */
  silence?: { from: number; label: string } | null;
  /** The window needs its date (windowDated): the first tick and each midnight name the day. */
  dated?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const keys = stackKeys(bins);
  const max = niceMax(Math.max(1, ...bins.map((b) => b.total)));
  const span = Math.max(1, range.to - range.from);
  const total = bins.reduce((n, b) => n + b.total, 0);
  const xOf = (t: number) => Math.min(1, Math.max(0, (t - range.from) / span));
  const groups = mergeFacing(clusterByPixels(marks.filter((m) => m.at >= range.from && m.at <= range.to).map((m) => ({ ...m, x: xOf(m.at) })), width, MARK_PX), width);
  const ticks = rangeTicks(range, tickBudget(width));
  const unknownTo = unknownUntil(bins);
  const known = bins.filter((b) => !b.unknown);
  // Handlers bound once on mount read the latest range and callback through here.
  const live$ = useRef({ range, onBrush });
  live$.current = { range, onBrush };
  const mid = (b: HistBin) => (b.from + b.to) / 2;
  const binAt = (at: number) => bins.find((b) => at >= b.from && at < b.to) ?? bins.reduce<HistBin | null>((best, b) => (!best || Math.abs(mid(b) - at) < Math.abs(mid(best) - at) ? b : best), null);
  const color = (k: string) => { const css = ink(k); return css.includes("transparent") ? alpha(css, 0.45) : resolveColor(css); };

  const option = (t: ChartTheme): EChartsOption => ({
    animation: false,
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: "time", min: range.from, max: range.to, show: false, axisPointer: { label: { show: false } } },
    yAxis: { type: "value", min: 0, max, show: false },
    tooltip: {
      ...tooltipBase(t), trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: alpha(t.text, 0.05) } },
      formatter: ((ps: { axisValue: number }[]) => {
        const b = binAt(Number(ps[0]?.axisValue));
        if (!b) return "";
        let s = `<div style="color:${t.dim};font-size:11px">${esc(binWhen(b))}</div>`;
        if (b.unknown) return s + `<div style="color:${t.muted}">No data recorded</div>`;
        s += `<div style="font-family:${t.mono};font-size:16px;font-weight:600;margin:1px 0 2px">${b.estimated ? "≥ " : ""}${b.total.toLocaleString()}</div>`;
        if (b.estimated) return s + `<div style="color:${t.dim};max-width:220px;white-space:normal">no counter here; drawn from the issues and replays kept</div>`;
        return s + keys.filter((k) => b.parts[k]).map((k) => tipRow(t, `<i style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${color(k)}"></i>`, name(k), b.parts[k].toLocaleString())).join("");
      }) as never,
    },
    toolbox: onBrush ? { show: true, right: -400, feature: { brush: { type: ["lineX"] } } } : undefined,
    brush: onBrush ? { xAxisIndex: 0, brushType: "lineX", brushMode: "single", transformable: false, brushStyle: { color: alpha(t.blue, 0.12), borderColor: alpha(t.blue, 0.5), borderWidth: 1 }, outOfBrush: { colorAlpha: 1 } } : undefined,
    series: [
      // Every bin as a point, so the tip lands on a bin nothing was counted in, or nothing recorded.
      { id: "bins", type: "line", data: bins.map((b) => [mid(b), 0]), symbol: "none", silent: true, lineStyle: { opacity: 0 }, tooltip: { show: true } },
      ...keys.map((k) => ({
        id: k, name: name(k), type: "bar" as const, stack: "all", barWidth: "86%", silent: true,
        itemStyle: { color: color(k), borderRadius: 1.5 },
        data: bins.map((b) => [mid(b), b.unknown ? null : b.parts[k] || null]),
      })),
    ] as never,
  });

  const onReady = (c: ECharts) => {
    if (!live$.current.onBrush) return;
    c.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } });
    c.on("brushEnd", (e: unknown) => {
      const r = (e as { areas?: { coordRange?: [number, number] }[] }).areas?.[0]?.coordRange;
      c.dispatchAction({ type: "brush", areas: [] });
      const { range: w, onBrush: pick } = live$.current;
      if (!r || !pick) return;
      const lo = Math.max(w.from, Math.min(r[0], r[1]));
      const hi = Math.min(w.to, Math.max(r[0], r[1]));
      if (hi - lo > (w.to - w.from) * 0.01) pick(lo, hi);
    });
  };

  return (
    <div className="ovc" data-ops-volume={label ?? ""}>
      <div ref={ref} className="ovc-plot" style={{ height }} aria-label={`${label ?? "Volume"}: ${total.toLocaleString()} in range`} data-brush={onBrush ? "true" : undefined}>
        {/* No axis over nothing: a count scale on an empty chart is a made-up number. */}
        {total > 0 && (
          <div className="ovc-grid" aria-hidden>
            <span className="ovc-y ops-num" style={{ top: GRID_PAD }}>{compact(max)}</span>
            {/* Counts are whole: the halfway line is labelled only when it falls on a whole number. */}
            {Number.isInteger(max / 2) && <span className="ovc-y ops-num" style={{ top: `calc(50% + ${GRID_PAD / 2}px)` }}>{compact(max / 2)}</span>}
          </div>
        )}
        <OpsChart className="ovc-canvas" option={option} deps={[bins, range.from, range.to, max, keys.join(), !!onBrush]} height="100%" onReady={onReady} ariaLabel={`${label ?? "Volume"}: ${total.toLocaleString()} in range`} />
        {unknownTo !== null && (
          <div className="ovc-nodata" style={{ width: unknownTo === Infinity ? "100%" : `${xOf(unknownTo) * 100}%` }} data-ops-nodata>
            {/* An empty range says so once, centred over the whole chart, rather than two labels fighting for a strip. */}
            {!(total === 0 && empty && known.length > 0) && (unknownTo === Infinity || width === 0 || xOf(unknownTo) * width > 150) && <span>{unknownTo === Infinity ? "No data recorded for this range" : `No data before ${new Date(unknownTo).toLocaleDateString([], { month: "short", day: "numeric" })}`}</span>}
          </div>
        )}
        {total === 0 && empty && known.length > 0 && unknownTo !== Infinity ? <div className="ovc-empty" data-ops-empty>{empty}</div> : null}
        {silence && silence.from < range.to && (
          <div className="ovc-silence" style={{ left: `${xOf(silence.from) * 100}%` }} data-ops-silence>
            {(width === 0 || (1 - xOf(silence.from)) * width > 90) && <span>{silence.label}</span>}
          </div>
        )}
        {groups.map((g) => {
          const one = g.marks.length === 1 ? g.marks[0] : null;
          const tip = g.marks.map((m) => `${m.label}  ${when(m.at, span)}`).join("\n");
          return (
            <div key={g.marks[0].at} className="ovc-mark" style={{ left: `${g.x * 100}%` }} data-edge={endAnchored(g.x, width) ? "end" : undefined}>
              {one?.href ? (
                <Link href={one.href} className="ovc-mark-label ops-mono" title={one.title ?? tip}>{one.label}</Link>
              ) : (
                <span className="ovc-mark-label ops-mono" title={tip} data-many={one ? undefined : "true"}>{one ? one.label : `${g.marks.length} deploys`}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="ovc-x" aria-hidden>
        {ticks.map((t, i) => <span key={t.at} className="ovc-tick ops-num" style={{ left: `${t.x * 100}%` }}>{tickLabel(t.at, span, !!dated && (i === 0 || isMidnight(t.at)))}</span>)}
      </div>
      {(keys.length > 1 || keys.includes("estimated")) && (
        <div className="ovc-legend">
          {keys.map((k) => <span key={k}><i style={{ background: ink(k) }} data-estimated={k === "estimated" ? "true" : undefined} />{name(k)}</span>)}
        </div>
      )}
    </div>
  );
}
