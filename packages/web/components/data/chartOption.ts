// A chart block's ECharts option, from the evaluated rows (shared
// evaluateChart) and the app's chart theme. Pure: the dashboard grid, the
// Scrollyteller and the Visual short all draw through it, so a chart reads
// the same in every format.
import type { EChartsOption } from "../ops/chart/echarts";
import { alpha, axisBase, resolveColor, swatch, tipRow, tooltipBase, esc, type ChartTheme } from "../ops/chart/chartTheme";
import { dashboard } from "@codecast/shared/artifacts";

type ChartOk = Extract<dashboard.ChartEval, { state: "ok" }>;

/** The series colors, in order: the first series is the story, the rest support it. Neighbors differ in hue (green and yellow sit far apart). */
export function seriesColors(t: ChartTheme): string[] {
  return distinct([t.blue, t.orange, t.green, t.magenta, t.cyan, t.yellow, t.violet, t.red]);
}

const rgb = (c: string) => (resolveColor(c).match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
/**
 * The palette with look-alikes moved to the back: a theme may tune two tokens
 * close together (a dark theme's magenta and violet), and two people must never
 * share a color while a distinct one goes unused.
 */
function distinct(colors: string[]): string[] {
  const keep: string[] = [];
  const later: string[] = [];
  for (const c of colors) {
    const [r, g, b] = rgb(c);
    const near = keep.some((k) => {
      const [r2, g2, b2] = rgb(k);
      // Weighted RGB distance: under 75 two chart colors read as one at a glance (a dark theme puts magenta and violet at 38, blue and cyan at 68).
      return Math.sqrt(2 * (r - r2) ** 2 + 4 * (g - g2) ** 2 + 3 * (b - b2) ** 2) < 75;
    });
    (near ? later : keep).push(c);
  }
  return [...keep, ...later];
}

/** Value columns ("opened", "merged") are measures, not people: their own hues, so a measure never reads as the person who shares its color. */
export function measureColors(t: ChartTheme): string[] {
  return [t.cyan, t.violet, t.orange, t.green];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-07" → "Nov 7"; an hour bucket → "14:00"; anything else as is. */
export function axisLabel(x: string): string {
  if (DAY.test(x)) return `${MONTHS[Number(x.slice(5, 7)) - 1]} ${Number(x.slice(8, 10))}`;
  const hour = x.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):00/);
  if (hour) return `${hour[1]}:00`;
  if (/^\d{12,13}$/.test(x)) {
    const d = new Date(Number(x));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  // A code from the data ("in_progress") reads as words ("in progress").
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(x) ? x.replace(/_/g, " ") : x;
}

/** A column name as a person reads it: "last_year" → "Last year". A value from the data (a person, a flavor) stays as written. */
export function seriesLabel(name: string): string {
  return /^[a-z0-9_]+$/.test(name) && name.includes("_") ? name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ") : name;
}

export type ChartLook = {
  /** Tight axes and no legend: a tile in the grid. False: a story's big chart. */
  compact?: boolean;
  /** Under ~420px wide: no room to label line ends. */
  narrow?: boolean;
  /** Draw in over this many ms (the story reveal); 0 for none. */
  revealMs?: number;
  /** The dashboard's color slot for a series name, so one person or column keeps one color across every chart. */
  slotOf?: (name: string) => number | undefined;
  /** The series are value columns (several y), not the values of a split column. */
  measures?: boolean;
  /** Mark the lead series' peak with its value: a story's chart points at the moment that matters. */
  annotate?: boolean;
};

export function chartOption(ev: ChartOk, t: ChartTheme, look: ChartLook = {}): EChartsOption {
  const colors = look.measures && ev.series.length > 1 ? measureColors(t) : seriesColors(t);
  const fmt = (v: unknown) => dashboard.formatValue(v as number, ev.format === "number" ? "compact" : ev.format);
  const fmtFull = (v: unknown) => dashboard.formatValue(v as number, ev.format);
  const multi = ev.series.length > 1;
  const anim = look.revealMs ? { animation: true, animationDuration: look.revealMs, animationEasing: "cubicOut" as const } : { animation: false };
  const tooltip = {
    ...tooltipBase(t),
    trigger: "axis" as const,
    axisPointer: { type: (ev.type === "line" || ev.type === "area" ? "line" : "shadow") as "line" | "shadow", lineStyle: { color: t.line }, shadowStyle: { color: t.hover } },
    formatter: (params: any) => {
      const list = Array.isArray(params) ? params : [params];
      const head = `<div style="color:${t.muted};font-family:${t.mono};font-size:11px">${esc(axisLabel(String(list[0]?.axisValue ?? list[0]?.name ?? "")))}</div>`;
      const rows = list.map((p: any) => tipRow(t, swatch(p.color), multi ? String(p.seriesName) : "", fmtFull(p.value))).join("");
      const nums = list.map((p: any) => (typeof p.value === "number" ? p.value : null));
      // A stack reads as parts of a whole: say the whole. Two lines side by side invite "how far apart": say that.
      if (ev.type === "stacked" && list.length > 1) return head + rows + tipRow(t, "", "Total", fmtFull(nums.reduce((a: number, v: number | null) => a + (v ?? 0), 0)));
      const gap = list.length === 2 && ev.type !== "stacked" && nums[0] !== null && nums[1] !== null ? tipRow(t, "", "Gap", fmtFull(nums[0] - nums[1])) : "";
      return head + rows + gap;
    },
  };

  if (ev.type === "hbar") {
    // A ranking compares its bars, so every label speaks the scale of the largest one: "$18K, $4.9K, <$0.1K", never "$18K, $4,896, $35.01".
    const top = Math.max(0, ...ev.series[0].values.map((v) => Math.abs(v ?? 0)));
    const unit = top >= 1e9 ? { d: 1e9, s: "B" } : top >= 1e6 ? { d: 1e6, s: "M" } : top >= 1e4 ? { d: 1e3, s: "K" } : null;
    const rankFmt = (v: unknown) => {
      if (typeof v !== "number" || !unit) return fmtFull(v);
      const cur = ev.format === "usd" ? "$" : "";
      // Under one unit, the amount reads plainly: "$600", "<$100", never "$0.6K".
      if (Math.abs(v) < unit.d) return Math.abs(v) < 100 && v !== 0 ? `<${cur}100` : `${cur}${Math.round(v / 10) * 10}`;
      return `${cur}${(v / unit.d).toFixed(1).replace(/\.0$/, "")}${unit.s}`;
    };
    const s = ev.series[0];
    const n = ev.x.length;
    return {
      ...anim,
      grid: { left: 4, right: 56, top: 4, bottom: 4, containLabel: true },
      // The bars carry their values as labels; a tooltip would only repeat them over the next bar.
      tooltip: { show: false },
      xAxis: { type: "value", show: false, max: (v: { max: number }) => v.max * 1.02 },
      yAxis: {
        type: "category",
        inverse: true,
        data: ev.x.map(axisLabel),
        ...axisBase(t),
        axisLabel: { color: t.text2, fontFamily: t.ui, fontSize: look.compact ? 12 : 14, margin: 10, width: look.compact ? 112 : 180, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          name: s.name,
          data: s.values.map((v, i) => ({ value: v, itemStyle: { color: i === 0 ? colors[0] : alpha(colors[0], 0.34), borderRadius: [0, 4, 4, 0] } })),
          barMaxWidth: look.compact ? 22 : 34,
          barCategoryGap: n > 8 ? "28%" : "36%",
          label: { show: true, position: "right", color: t.text, fontFamily: t.mono, fontSize: look.compact ? 11.5 : 13, formatter: (p: any) => rankFmt(p.value) },
        },
      ],
    } as EChartsOption;
  }

  const bars = ev.type === "bar" || ev.type === "stacked";
  const stacked = ev.type === "stacked";
  // A few lines read best labelled at their ends, the way a person annotates a trend; more need a legend.
  const ends = !bars && !look.narrow && (!look.compact || ev.series.length <= 3);
  const legend = multi && !ends;
  // The legend wraps rather than pages (a paged legend hides a series); room for each extra line it is likely to take, by its words against the width bucket.
  const legendWidth = look.narrow ? 360 : look.compact ? 560 : 860;
  const legendText = ev.series.reduce((a, s) => a + seriesLabel(s.name).length * 7 + 28, 0);
  const legendExtra = legend ? (Math.ceil(legendText / legendWidth) - 1) * 18 : 0;
  const lastIdx = ev.x.length - 1;
  const slot = (i: number) => look.slotOf?.(ev.series[i].name) ?? i;
  const ink = (i: number) => (multi || bars ? colors[slot(i) % colors.length] : colors[0]);
  return {
    ...anim,
    grid: look.compact
      ? { left: 4, right: ends ? (multi ? 132 : 72) : 16, top: 14, bottom: legend ? 30 + legendExtra : 4, containLabel: true }
      : { left: 8, right: ends ? (multi ? 128 : 80) : 24, top: 24, bottom: legend ? 54 + legendExtra : 10, containLabel: true },
    tooltip,
    legend: legend
      ? { bottom: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 3, itemGap: 14, textStyle: { color: t.muted, fontFamily: t.ui, fontSize: 11.5 }, type: "plain" }
      : // A redraw merges into the last option: a legend dropped here must be hidden, not left out.
        { show: false },
    xAxis: {
      type: "category",
      data: ev.x,
      boundaryGap: bars,
      ...axisBase(t),
      splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, formatter: (v: string) => axisLabel(v), hideOverlap: true },
    },
    yAxis: {
      type: "value",
      ...axisBase(t),
      splitNumber: look.compact ? 3 : 4,
      axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => fmt(v) },
    },
    series: ev.series.map((s, i) => {
      const color = ink(i);
      // A stack's peak is the total's, not one layer's; only an unstacked lead series is marked.
      const peak = look.annotate && i === 0 && !stacked && s.values.some((v) => v !== null)
        ? { markPoint: { symbol: "circle", symbolSize: 9, itemStyle: { color, borderColor: t.card, borderWidth: 2 }, data: [{ type: "max" as const, name: "Peak" }], label: { show: true, position: "top" as const, distance: 8, color: t.text, fontFamily: t.mono, fontSize: 12, fontWeight: 600, formatter: (p: any) => `peak ${fmtFull(p.value)}` } } }
        : {};
      if (bars) {
        return {
          type: "bar" as const,
          name: seriesLabel(s.name),
          data: s.values,
          stack: stacked ? "total" : undefined,
          barMaxWidth: 28,
          // Dense days need fat bars: a month of two series in a third of a row must not draw as hairlines.
          barCategoryGap: ev.x.length > 14 ? "12%" : "30%",
          barGap: "6%",
          itemStyle: { color, borderRadius: stacked ? (i === ev.series.length - 1 ? [3, 3, 0, 0] : 0) : [3, 3, 0, 0] },
          emphasis: { focus: "series" as const },
          ...peak,
        };
      }
      const primary = i === 0;
      return {
        type: "line" as const,
        name: seriesLabel(s.name),
        data: s.values,
        // Straight segments: daily counts are whole steps, and a curve draws values between days that never happened.
        smooth: false,
        showSymbol: false,
        symbol: "circle",
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { width: primary ? 2.25 : 1.75, color },
        itemStyle: { color },
        areaStyle: ev.type === "area" ? { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(color, primary ? 0.28 : 0.14) }, { offset: 1, color: alpha(color, 0) }] } } : undefined,
        emphasis: { focus: "series" as const },
        // The end of each line carries its name and value, the way a person annotates a trend.
        endLabel: ends
          ? { show: s.values[lastIdx] !== null && s.values[lastIdx] !== undefined, color, fontFamily: t.mono, fontSize: look.compact ? 11 : 12.5, formatter: (p: any) => `${multi ? `${seriesLabel(s.name)} ` : ""}${fmtFull(p.value)}`, distance: 6 }
          : undefined,
        labelLayout: { moveOverlap: "shiftY" as const },
        ...peak,
      };
    }),
  } as EChartsOption;
}
