// The Ops charts beyond the metric line, each on OpsChart and the app's
// theme: a weekday by hour heatmap, a distribution with its percentiles
// marked, and bars over time (stacked by series) that can be brushed to
// filter what the page lists.
import { useRef } from "react";
import type { ECharts, EChartsOption } from "./echarts";
import { OpsChart } from "./OpsChart";
import { alpha, axisBase, esc, swatch, tipRow, tooltipBase, type ChartTheme } from "./chartTheme";
import type { Distribution } from "../metricEvents";
import { formatValue } from "../metricModel";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);

/** Mean value per weekday and hour, local time. */
export function weekHourCells(points: readonly { at: number; value: number }[]): [number, number, number][] {
  const acc = new Map<number, [number, number]>();
  for (const p of points) {
    const d = new Date(p.at);
    const k = d.getDay() * 24 + d.getHours();
    const a = acc.get(k) ?? [0, 0];
    a[0] += p.value; a[1] += 1;
    acc.set(k, a);
  }
  return [...acc].map(([k, [s, n]]) => [k % 24, Math.floor(k / 24), Math.round((s / n) * 10) / 10]);
}

export function WeekHourHeatmap({ cells, ink = "blue", noun, height = 196, unit }: {
  cells: readonly [number, number, number][];
  ink?: keyof Pick<ChartTheme, "blue" | "cyan" | "magenta" | "violet" | "orange" | "red" | "green">;
  noun: string;
  height?: number;
  unit?: string;
}) {
  const option = (t: ChartTheme): EChartsOption => {
    const max = Math.max(1, ...cells.map(c => c[2]));
    const col = t[ink];
    return {
      animation: false,
      grid: { left: 34, right: 2, top: 2, bottom: 20 },
      xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => String(i)), ...axisBase(t), splitLine: { show: false },
        axisLabel: { ...axisBase(t).axisLabel, interval: 5, formatter: (v: string) => hourLabel(Number(v)) } },
      yAxis: { type: "category", data: DAYS, inverse: true, ...axisBase(t), splitLine: { show: false } },
      visualMap: { show: false, min: 0, max, inRange: { color: [alpha(t.text, t.dark ? 0.06 : 0.045), alpha(col, 0.45), col] } },
      tooltip: { ...tooltipBase(t), formatter: ((p: { value: [number, number, number] }) =>
        `<div style="color:${t.dim};font-size:11px">${DAYS[p.value[1]]} ${hourLabel(p.value[0])}</div><b style="font-family:${t.mono}">${esc(formatValue(p.value[2], unit))}</b> <span style="color:${t.muted}">${esc(noun)} on average</span>`) as never },
      series: [{ type: "heatmap", data: cells as never, itemStyle: { borderColor: t.bg, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } } }],
    };
  };
  return <OpsChart option={option} deps={[cells, ink, noun, unit]} height={height} ariaLabel={`${noun} by weekday and hour`} />;
}

export function DistributionPlot({ d, unit, line, height = 170 }: { d: Distribution; unit?: string; line?: number; height?: number }) {
  const option = (t: ChartTheme): EChartsOption => {
    const n = d.bins.length;
    const w = (d.max - d.min) / n || 1;
    const data = d.bins.map((c, i) => [d.min + w * (i + 0.5), Math.round(c * 10) / 10]);
    const marks: { name: string; xAxis: number; color: string }[] = [
      { name: "p50", xAxis: d.p50, color: t.muted }, { name: "p95", xAxis: d.p95, color: t.muted },
      ...(line !== undefined && line >= d.min && line <= d.max ? [{ name: "line", xAxis: line, color: t.red }] : []),
    ];
    return {
      animation: false,
      grid: { left: 8, right: 16, top: 20, bottom: 20 },
      xAxis: { type: "value", min: d.min, max: d.max === d.min ? d.min + 1 : d.max, ...axisBase(t), splitLine: { show: false }, splitNumber: 4,
        axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => formatValue(v, unit) } },
      yAxis: { type: "value", show: false },
      tooltip: { ...tooltipBase(t), formatter: ((p: { value: [number, number] }) =>
        `<b style="font-family:${t.mono}">${esc(formatValue(p.value[0] - w / 2, unit))} – ${esc(formatValue(p.value[0] + w / 2, unit))}</b><div style="color:${t.muted}">${p.value[1]} of ${d.n} readings</div>`) as never },
      series: [{
        type: "bar", data: data as never, barWidth: "86%", itemStyle: { color: alpha(t.cyan, 0.5), borderRadius: [3, 3, 0, 0] }, emphasis: { itemStyle: { color: t.cyan } },
        markLine: { silent: true, symbol: "none", animation: false,
          data: marks.map(m => ({ xAxis: m.xAxis, name: m.name, lineStyle: { color: m.color, type: [2, 3] }, label: { color: m.color, fontFamily: t.mono, fontSize: 10, formatter: m.name } })) as never },
      }],
    };
  };
  return <OpsChart option={option} deps={[d, unit, line]} height={height} ariaLabel={`Distribution of ${d.n} readings`} />;
}

export type BarSeries = { id: string; name: string; ink: keyof Pick<ChartTheme, "blue" | "cyan" | "magenta" | "violet" | "orange" | "red" | "green" | "yellow" | "dim">; data: [number, number][] };

/** Bars over time, stacked by series; brushing a stretch hands it to `onBrush` (null when cleared). */
export function TimeBars({ series, height = 170, onBrush, legend = true, unitNoun = "" }: {
  series: readonly BarSeries[];
  height?: number;
  onBrush?: (range: [number, number] | null) => void;
  legend?: boolean;
  unitNoun?: string;
}) {
  const brush$ = useRef(onBrush);
  brush$.current = onBrush;
  const option = (t: ChartTheme): EChartsOption => ({
    animation: false,
    grid: { left: 30, right: 6, top: legend ? 24 : 8, bottom: 22 },
    legend: legend ? { top: 0, right: 0, icon: "roundRect", itemWidth: 9, itemHeight: 9, itemGap: 14, textStyle: { color: t.muted, fontFamily: t.ui, fontSize: 11.5 } } : undefined,
    xAxis: { type: "time", ...axisBase(t), splitLine: { show: false }, axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true, formatter: "{MMM} {d}" } },
    yAxis: { type: "value", ...axisBase(t), splitNumber: 3, minInterval: 1 },
    tooltip: { ...tooltipBase(t), trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: alpha(t.text, 0.04) } },
      formatter: ((ps: { value: [number, number]; seriesName: string; color: string }[]) => {
        const rows = ps.filter(p => p.value[1]);
        const day = new Date(ps[0]?.value[0] ?? 0).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return `<div style="color:${t.dim};font-size:11px">${esc(day)}</div>` + (rows.length ? rows.map(p => tipRow(t, swatch(p.color), p.seriesName, String(p.value[1]))).join("") : `<div style="color:${t.muted}">none${unitNoun ? ` ${esc(unitNoun)}` : ""}</div>`);
      }) as never },
    toolbox: onBrush ? { show: true, right: -400, feature: { brush: { type: ["lineX"] } } } : undefined,
    brush: onBrush ? { xAxisIndex: 0, brushType: "lineX", brushMode: "single", transformable: false, brushStyle: { color: alpha(t.blue, 0.1), borderColor: alpha(t.blue, 0.45), borderWidth: 1 }, outOfBrush: { colorAlpha: 0.3 } } : undefined,
    series: series.map(s => ({ id: s.id, name: s.name, type: "bar", stack: "all", barMaxWidth: 18, barWidth: "62%", itemStyle: { color: t[s.ink], borderRadius: 2 }, data: s.data as never })),
  });
  const onReady = (c: ECharts) => {
    if (!onBrush) return;
    c.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } });
    c.on("brushEnd", (e: unknown) => {
      const r = (e as { areas?: { coordRange?: [number, number] }[] }).areas?.[0]?.coordRange;
      brush$.current?.(r ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : null);
    });
    c.on("brush", (e: unknown) => { if (!(e as { areas?: unknown[] }).areas?.length) brush$.current?.(null); });
  };
  return <OpsChart option={option} deps={[series, legend, !!onBrush]} height={height} onReady={onReady} />;
}
