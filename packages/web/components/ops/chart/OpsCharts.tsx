// The Ops chart beyond the metric line, on OpsChart and the app's theme: a
// weekday by hour heatmap.
import type { EChartsOption } from "./echarts";
import { OpsChart } from "./OpsChart";
import { alpha, axisBase, esc, tooltipBase, type ChartTheme } from "./chartTheme";
import { formatValue } from "../metricModel";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);

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
