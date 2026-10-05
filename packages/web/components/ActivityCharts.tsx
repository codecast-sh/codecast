"use client";
import { useMemo, useState, useRef } from "react";
import { Activity, ChevronLeft, ChevronRight, Clock, LayoutGrid, MessageSquare, Send, Type, X } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { SegmentedToggle } from "./SegmentedToggle";
import { HEAT_COLORS_LIGHT, HEAT_COLORS_DARK, heatColor, useContainerWidth, HoverTip } from "./ActivityHeatmap";
import { BrushRect as DayBrushRect, useDayBrush } from "./evals/charts/brush";
import { MONTHS, timeAxisLabels } from "./evals/charts/scale";

// The day axis and the brush are the Evals charts' own (components/evals/charts); these charts reuse them.
export { timeAxisLabels, useDayBrush };

// Detailed activity charts (hour-of-day punchcard + per-day/hourly series),
// shared by the team profile Timeline tab (authed punchcard query) and the
// public profile (anonymized punchcard query). Purely presentational: callers
// fetch their own data and pass it in as `punchcard`.

// `sends` (messages the person actually typed) and `words` (the words in
// them) shipped later than the rest — older cached payloads may omit them, so
// consumers treat them as optional zeros.
export type PunchRow = { date: string; hours: number[]; msgs: number[]; sends?: number[]; words?: number[]; sessions: number[]; day_sessions: number };
export type TimelineMetric = "hours" | "msgs" | "sends" | "words";

export function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function fmtDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = today.getTime() - date.getTime();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (diff < 86400000) return `Today, ${dayNames[date.getDay()]}`;
  if (diff < 172800000) return `Yesterday, ${dayNames[date.getDay()]}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
}

const CYAN_COLORS_LIGHT = ["#eee8d5", "#bfe0d8", "#7fcabb", "#3fae9c", "#1d8a7a"];
const CYAN_COLORS_DARK = ["#073642", "#0e4a50", "#15655f", "#1e857a", "#2aa198"];

const METRIC_CFG = {
  hours: {
    label: "Hours",
    heading: "Hours per day",
    line: "#859900",
    light: HEAT_COLORS_LIGHT,
    dark: HEAT_COLORS_DARK,
    fmtVal: (v: number) => `${v.toFixed(1)}h`,
    fmtAxis: (v: number) => `${Math.round(v)}h`,
  },
  msgs: {
    label: "Messages",
    heading: "Messages per day",
    line: "#2aa198",
    light: CYAN_COLORS_LIGHT,
    dark: CYAN_COLORS_DARK,
    fmtVal: (v: number) => `${fmtK(Math.round(v))} msgs`,
    fmtAxis: (v: number) => fmtK(Math.round(v)),
  },
  sends: {
    label: "Typed",
    heading: "Messages typed per day",
    line: "#268bd2",
    light: ["#eee8d5", "#c3d9e8", "#8cbcdd", "#4d9cd4", "#268bd2"] as string[],
    dark: ["#073642", "#0d4a63", "#15618a", "#1d78b1", "#268bd2"] as string[],
    fmtVal: (v: number) => `${fmtK(Math.round(v))} typed`,
    fmtAxis: (v: number) => fmtK(Math.round(v)),
  },
  words: {
    label: "Words",
    heading: "Words typed per day",
    line: "#6c71c4",
    light: ["#eee8d5", "#d6d3e6", "#b3b0dc", "#8f8fd0", "#6c71c4"] as string[],
    dark: ["#073642", "#1f3f63", "#374f84", "#5160a4", "#6c71c4"] as string[],
    fmtVal: (v: number) => `${fmtK(Math.round(v))} words`,
    fmtAxis: (v: number) => fmtK(Math.round(v)),
  },
} as const;

/** The metric switch every activity chart shows. */
export const METRIC_ITEMS = [
  { key: "hours", icon: Clock, label: "Hours", title: "Agent hours" },
  { key: "msgs", icon: MessageSquare, label: "Messages", title: "All session messages" },
  { key: "sends", icon: Send, label: "Typed", title: "Messages the person typed" },
  { key: "words", icon: Type, label: "Words", title: "Words the person typed" },
];

export const fmtMetric = (metric: TimelineMetric, v: number) => METRIC_CFG[metric].fmtVal(v);

// Metric accessor tolerant of payloads that predate the typed counters.
export function metricHours(r: PunchRow, metric: TimelineMetric): number[] {
  if (metric === "hours") return r.hours;
  if (metric === "msgs") return r.msgs;
  return (metric === "sends" ? r.sends : r.words) ?? zeros24();
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}

function shortDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const sameYear = y === new Date().getFullYear();
  return `${MONTHS[m - 1]} ${d}${sameYear ? "" : ` '${String(y).slice(2)}`}`;
}

// The day window every activity chart reads: a trailing preset, or an exact
// span picked by stepping a window back or dragging across a chart.
export type RangePreset = "7d" | "1m" | "3m" | "1y" | "all";
export type DayRange = { preset: RangePreset } | { from: string; to: string };

const RANGE_PRESETS: { key: RangePreset; label: string; title: string; days: number | null }[] = [
  { key: "7d", label: "7D", title: "Last 7 days", days: 7 },
  { key: "1m", label: "1M", title: "Last 30 days", days: 30 },
  { key: "3m", label: "3M", title: "Last 90 days", days: 90 },
  { key: "1y", label: "1Y", title: "Last 365 days", days: 365 },
  { key: "all", label: "All", title: "Everything", days: null },
];

/** Continuous day axis from the first row through today, empty days filled. */
export function fillDays(punchcard: PunchRow[] | undefined): PunchRow[] {
  if (!punchcard || punchcard.length === 0) return [];
  const map = new Map(punchcard.map((r) => [r.date, r]));
  const todayKey = dateKey(new Date());
  const out: PunchRow[] = [];
  for (let key = punchcard[0].date; out.length < 400; key = addDays(key, 1)) {
    out.push(map.get(key) ?? { date: key, hours: zeros24(), msgs: zeros24(), sends: zeros24(), words: zeros24(), sessions: zeros24(), day_sessions: 0 });
    if (key >= todayKey) break;
  }
  return out;
}

export function sliceRange<T extends { date: string }>(days: T[], range: DayRange): T[] {
  if ("from" in range) return days.filter((d) => d.date >= range.from && d.date <= range.to);
  const n = RANGE_PRESETS.find((p) => p.key === range.preset)?.days;
  return n ? days.slice(-n) : days;
}

/** "last 30 days" for a preset, "Sep 12 – Sep 18" for an exact span. */
export function rangeLabel(range: DayRange): string {
  if ("from" in range) return range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} – ${shortDay(range.to)}`;
  return RANGE_PRESETS.find((p) => p.key === range.preset)!.title.toLowerCase();
}

/** Presets, a step back/forward by the window's own length, and the exact
 *  span as a chip that clears back to the last preset. `days` is the filled
 *  axis the range slices, so stepping knows the window and where data ends. */
export function RangeControl({ value, onChange, days }: { value: DayRange; onChange: (r: DayRange) => void; days: { date: string }[] }) {
  const [lastPreset, setLastPreset] = useState<RangePreset>("preset" in value ? value.preset : "1m");
  const span = sliceRange(days, value);
  const first = days[0]?.date;
  const today = dateKey(new Date());
  const from = span[0]?.date;
  const to = span[span.length - 1]?.date;
  const len = span.length;
  const step = (dir: -1 | 1) => {
    if (!from || !to) return;
    let a = addDays(from, dir * len);
    let b = addDays(to, dir * len);
    if (b > today) { b = today; a = addDays(today, -(len - 1)); }
    if (first && a < first) { a = first; b = addDays(first, len - 1); }
    onChange({ from: a, to: b });
  };
  const btn = "h-7 w-6 flex items-center justify-center rounded-md text-sol-text-muted/50 hover:text-sol-text hover:bg-sol-bg-alt/60 disabled:opacity-25 disabled:pointer-events-none transition-colors";
  return (
    <div className="flex items-center gap-1">
      <button className={btn} onClick={() => step(-1)} disabled={!from || from <= (first ?? from)} title="Previous period">
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <button className={btn} onClick={() => step(1)} disabled={!to || to >= today} title="Next period">
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      {"from" in value && (
        <span className="h-7 flex items-center gap-1 pl-2 pr-1 rounded-md border border-sol-cyan/40 bg-sol-cyan/10 text-xs text-sol-cyan tabular-nums whitespace-nowrap">
          {rangeLabel(value)}
          <button
            onClick={() => onChange({ preset: lastPreset })}
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-sol-cyan/20"
            title="Back to a preset range"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      )}
      <SegmentedToggle
        value={"preset" in value ? value.preset : ""}
        onChange={(k) => { setLastPreset(k as RangePreset); onChange({ preset: k as RangePreset }); }}
        items={RANGE_PRESETS.map(({ key, label, title }) => ({ key, label, title }))}
      />
    </div>
  );
}

export function BrushRect(props: { drag: { a: number; b: number } | null; toX: (i: number) => number; top: number; height: number }) {
  return <DayBrushRect {...props} className="fill-sol-cyan/10 stroke-sol-cyan/50" />;
}

const zeros24 = () => new Array(24).fill(0);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "12a";
  if (hh === 12) return "12p";
  return hh < 12 ? `${hh}a` : `${hh - 12}p`;
}

/** `range`/`onRangeChange` make the window controlled by a page that shares
 *  it across sections (and then owns the control); otherwise it's local. */
export function TimelineCharts({
  punchcard,
  range: controlledRange,
  onRangeChange,
}: {
  punchcard: PunchRow[] | undefined;
  range?: DayRange;
  onRangeChange?: (r: DayRange) => void;
}) {
  const [metric, setMetric] = useState<TimelineMetric>("hours");
  const [localRange, setLocalRange] = useState<DayRange>({ preset: "3m" });
  const range = controlledRange ?? localRange;
  const setRange = onRangeChange ?? setLocalRange;
  const [view, setView] = useState<"grid" | "chart">("grid");

  // Continuous day axis from first activity through today — both charts share it.
  const filled = useMemo(() => fillDays(punchcard), [punchcard]);
  const sliced = useMemo(() => sliceRange(filled, range), [filled, range]);

  const daySeries = useMemo(
    () =>
      sliced.map((r) => ({
        date: r.date,
        value: sum(metricHours(r, metric)),
        sessions: r.day_sessions,
      })),
    [sliced, metric]
  );

  // Hourly silhouette: one point per (day × hour) — the same detail the grid
  // shows, unrolled onto a continuous time axis. Zeros included so nights read
  // as troughs between daily pulses. Only built when the chart view is active.
  const hourSeries = useMemo(
    () =>
      view !== "chart"
        ? []
        : sliced.flatMap((r) => {
            const vals = metricHours(r, metric);
            return r.hours.map((_, h) => ({
              date: r.date,
              hour: h,
              hours: r.hours[h],
              msgs: r.msgs[h],
              sessions: r.sessions[h],
              value: vals[h],
            }));
          }),
    [sliced, metric, view]
  );

  const cfg = METRIC_CFG[metric];
  const total = useMemo(() => daySeries.reduce((s, d) => s + d.value, 0), [daySeries]);

  if (punchcard === undefined) {
    return (
      <div className="mt-3 space-y-3 animate-pulse motion-reduce:animate-none">
        <div className="h-44 bg-sol-bg-alt/40 rounded-lg" />
        <div className="h-40 bg-sol-bg-alt/25 rounded-lg" />
      </div>
    );
  }
  if (filled.length === 0) return <div className="text-[11px] text-sol-text-muted/40 text-center py-16">No session data</div>;

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-[9px] text-sol-text-muted/45 uppercase tracking-widest font-bold">{cfg.heading}</span>
        <span className="text-[9px] text-sol-text-muted/40 tabular-nums">{cfg.fmtVal(total)} · {sliced.length} days</span>
        <div className="ml-auto flex items-center gap-1.5 scale-[0.82] origin-right">
          <SegmentedToggle
            value={view}
            onChange={(k) => setView(k as "grid" | "chart")}
            items={[
              { key: "grid", icon: LayoutGrid, title: "Hour-of-day grid" },
              { key: "chart", icon: Activity, title: "Hourly silhouette" },
            ]}
          />
          <SegmentedToggle
            value={metric}
            onChange={(k) => setMetric(k as TimelineMetric)}
            items={METRIC_ITEMS}
          />
          {!controlledRange && <RangeControl value={range} onChange={setRange} days={filled} />}
        </div>
      </div>
      {view === "grid" ? (
        <>
          <PunchcardChart rows={sliced} metric={metric} />
          <div className="mt-4">
            <TimelineChart points={daySeries} cfg={cfg} onPickRange={(from, to) => setRange({ from, to })} />
          </div>
        </>
      ) : (
        <TimelineChart points={hourSeries} cfg={cfg} hourly onPickRange={(from, to) => setRange({ from, to })} />
      )}
    </div>
  );
}

/* Hour-of-day density: one column per day, one row per hour, intensity = metric. */
function PunchcardChart({ rows, metric }: { rows: PunchRow[]; metric: TimelineMetric }) {
  const { theme } = useTheme();
  const cfg = METRIC_CFG[metric];
  const colors = theme === "dark" ? cfg.dark : cfg.light;
  const { ref, width } = useContainerWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ di: number; hr: number; x: number; y: number } | null>(null);

  const padLeft = 32, padRight = 8, padTop = 4, padBottom = 16;
  const cellH = 7;
  const plotW = Math.max(width - padLeft - padRight, 1);
  const plotH = 24 * cellH;
  const chartH = padTop + plotH + padBottom;
  const cellW = plotW / Math.max(rows.length, 1);

  const max = useMemo(() => {
    let m = 0;
    for (const r of rows) for (const v of metricHours(r, metric)) if (v > m) m = v;
    return m || 1;
  }, [rows, metric]);

  // Cells are memoized so hover-state changes don't rebuild thousands of rects.
  const cells = useMemo(
    () => rows.flatMap((r, di) =>
      metricHours(r, metric).map((v, h) =>
        v > 0 ? (
          <rect
            key={`${di}-${h}`}
            x={padLeft + di * cellW}
            y={padTop + h * cellH}
            width={Math.max(cellW - 0.5, 0.5)}
            height={cellH - 0.75}
            rx={1}
            fill={heatColor(v, max, colors)}
          />
        ) : null
      )
    ),
    [rows, metric, max, colors, cellW]
  );

  const xLabels = useMemo(() => timeAxisLabels(rows.map((r) => r.date), (i) => padLeft + i * cellW), [rows, cellW]);

  const hovered = hover ? rows[hover.di] : null;

  return (
    <div ref={ref} className="w-full relative">
      <svg
        ref={svgRef}
        width={width}
        height={chartH}
        className="block cursor-crosshair"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = svgRef.current?.getBoundingClientRect();
          if (!rect) return;
          const di = Math.floor((e.clientX - rect.left - padLeft) / cellW);
          const hr = Math.floor((e.clientY - rect.top - padTop) / cellH);
          if (di < 0 || di >= rows.length || hr < 0 || hr > 23) { setHover(null); return; }
          setHover({ di, hr, x: rect.left + padLeft + (di + 0.5) * cellW, y: rect.top + padTop + hr * cellH });
        }}
      >
        {/* level-0 backdrop so inactive hours read as empty cells */}
        <rect x={padLeft} y={padTop} width={plotW} height={plotH} fill={colors[0]} opacity={0.35} rx={2} />
        {/* hour-of-day guides + labels */}
        {[0, 6, 12, 18].map((h) => (
          <g key={h}>
            <text x={padLeft - 4} y={padTop + h * cellH + cellH + 1} textAnchor="end" className="fill-sol-base01/25" style={{ fontSize: 8 }}>{hourLabel(h)}</text>
            {h > 0 && <line x1={padLeft} x2={padLeft + plotW} y1={padTop + h * cellH - 0.5} y2={padTop + h * cellH - 0.5} stroke="currentColor" className="text-sol-border/8" strokeWidth={0.5} strokeDasharray="2,3" />}
          </g>
        ))}
        {cells}
        {/* x labels */}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={chartH - 4} textAnchor="start" className="fill-sol-base01/25" style={{ fontSize: 9 }}>{l.label}</text>
        ))}
        {/* hovered cell outline */}
        {hover && (
          <rect
            x={padLeft + hover.di * cellW - 0.5}
            y={padTop + hover.hr * cellH - 0.5}
            width={Math.max(cellW, 1)}
            height={cellH}
            fill="none"
            stroke="currentColor"
            className="text-sol-text/70"
            strokeWidth={1}
            rx={1}
            pointerEvents="none"
          />
        )}
      </svg>
      {hover && hovered && (
        <HoverTip x={hover.x} y={hover.y - 2}>
          {fmtDayLabel(hovered.date)} {hourLabel(hover.hr)}–{hourLabel(hover.hr + 1)} · {hovered.hours[hover.hr].toFixed(1)}h · {Math.round(hovered.msgs[hover.hr])} msgs · {Math.round(hovered.sends?.[hover.hr] ?? 0)} typed · {fmtK(Math.round(hovered.words?.[hover.hr] ?? 0))} words · {hovered.sessions[hover.hr]} sess
        </HoverTip>
      )}
    </div>
  );
}

/* Line/area chart of the selected metric. Two granularities through one
 * component: one point per day (markers on active days), or — in `hourly`
 * mode — one point per (day × hour) for the dense silhouette (no markers; the
 * nearest-point hover is driven off the whole plot so the fine wave stays
 * legible). `hour` on a point flags hourly so the tooltip can break it down. */
type ChartPoint = { date: string; value: number; sessions: number; hour?: number; hours?: number; msgs?: number };

function TimelineChart({
  points,
  cfg,
  hourly,
  onPickRange,
}: {
  points: ChartPoint[];
  cfg: (typeof METRIC_CFG)[TimelineMetric];
  hourly?: boolean;
  onPickRange?: (from: string, to: string) => void;
}) {
  const { ref: containerRef, width: containerW } = useContainerWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<{ idx: number; x: number; y: number } | null>(null);
  const brush = useDayBrush((a, b) => {
    if (onPickRange && points[a].date !== points[b].date) onPickRange(points[a].date, points[b].date);
  });

  const maxV = useMemo(() => Math.max(...points.map((d) => d.value), 1), [points]);

  const chartH = 180;
  const padTop = 12;
  const padBot = 28;
  const padLeft = 32;
  const padRight = 8;
  const plotW = containerW - padLeft - padRight;
  const plotH = chartH - padTop - padBot;
  const stepX = plotW / Math.max(points.length - 1, 1);

  const toX = (i: number) => padLeft + i * stepX;
  const toY = (v: number) => padTop + plotH - (v / maxV) * plotH;

  // Paths can hold thousands of points in hourly mode — rebuild only when the
  // data or width changes, never on hover.
  const { linePath, areaPath } = useMemo(() => {
    if (points.length === 0) return { linePath: "", areaPath: "" };
    const lp = points.map((d, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(d.value).toFixed(1)}`).join(" ");
    return { linePath: lp, areaPath: `${lp} L${toX(points.length - 1).toFixed(1)},${toY(0).toFixed(1)} L${toX(0).toFixed(1)},${toY(0).toFixed(1)} Z` };
  }, [points, maxV, containerW]);

  const xLabels = useMemo(() => timeAxisLabels(points.map((d) => d.date), toX), [points, containerW]);

  if (points.length === 0) return null;

  const yTicks = [0, maxV * 0.25, maxV * 0.5, maxV * 0.75, maxV];
  const hp = hovered ? points[hovered.idx] : null;

  return (
    <div ref={containerRef} className="w-full relative">
      <svg
        ref={svgRef}
        width={containerW}
        height={chartH}
        className="block cursor-crosshair"
        onMouseLeave={() => { setHovered(null); brush.cancel(); }}
        onMouseDown={(e) => { if (onPickRange && hovered) { e.preventDefault(); brush.start(hovered.idx); } }}
        onMouseUp={brush.end}
        onMouseMove={(e) => {
          const r = svgRef.current?.getBoundingClientRect();
          if (!r) return;
          let idx = Math.round((e.clientX - r.left - padLeft) / stepX);
          idx = Math.max(0, Math.min(points.length - 1, idx));
          setHovered({ idx, x: r.left + toX(idx), y: r.top + toY(points[idx].value) });
          brush.move(idx);
        }}
      >
        <BrushRect drag={brush.drag} toX={toX} top={padTop} height={plotH} />
        {/* Y grid lines */}
        {yTicks.map((v, i) => {
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={padLeft} x2={containerW - padRight} y1={y} y2={y} stroke="currentColor" className="text-sol-border/8" strokeWidth={0.5} strokeDasharray={i === 0 ? "none" : "2,3"} />
              <text x={padLeft - 4} y={y + 3} textAnchor="end" className="fill-sol-base01/25" style={{ fontSize: 8 }}>{cfg.fmtAxis(v)}</text>
            </g>
          );
        })}
        {/* X labels */}
        {xLabels.map((m, i) => (
          <text key={i} x={m.x} y={chartH - 6} textAnchor="start" className="fill-sol-base01/25" style={{ fontSize: 9 }}>{m.label}</text>
        ))}
        {/* Area fill */}
        <path d={areaPath} fill={cfg.line} opacity={0.12} />
        {/* Line */}
        <path d={linePath} fill="none" stroke={cfg.line} strokeWidth={1.5} opacity={0.7} />
        {/* Markers on active days (day granularity only — too dense hourly) */}
        {!hourly && points.map((d, i) => d.sessions > 0 ? (
          <circle
            key={i}
            cx={toX(i)} cy={toY(d.value)}
            r={d.sessions > 10 ? 3 : d.sessions > 3 ? 2.5 : 2}
            fill={cfg.line}
            opacity={hovered?.idx === i ? 1 : 0.6}
          />
        ) : null)}
        {/* Hover vertical line + point */}
        {hovered && hp && (
          <>
            <line x1={toX(hovered.idx)} x2={toX(hovered.idx)} y1={padTop} y2={padTop + plotH} stroke={cfg.line} strokeWidth={0.5} opacity={0.4} strokeDasharray="3,3" />
            <circle cx={toX(hovered.idx)} cy={toY(hp.value)} r={2.5} fill={cfg.line} />
          </>
        )}
      </svg>
      {hovered && hp && (
        <HoverTip x={hovered.x} y={hovered.y - 6}>
          {hp.hour !== undefined
            ? `${fmtDayLabel(hp.date)} ${hourLabel(hp.hour)}–${hourLabel(hp.hour + 1)} · ${(hp.hours ?? 0).toFixed(1)}h · ${Math.round(hp.msgs ?? 0)} msgs · ${hp.sessions} sess`
            : `${hp.date}: ${cfg.fmtVal(hp.value)}, ${hp.sessions} sessions`}
        </HoverTip>
      )}
    </div>
  );
}
