"use client";
import { useMemo, useState, useRef } from "react";
import { Activity, Clock, LayoutGrid, MessageSquare } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { SegmentedToggle } from "./SegmentedToggle";
import { HEAT_COLORS_LIGHT, HEAT_COLORS_DARK, heatColor, useContainerWidth, HoverTip } from "./ActivityHeatmap";

// Detailed activity charts (hour-of-day punchcard + per-day/hourly series),
// shared by the team profile Timeline tab (authed punchcard query) and the
// public profile (anonymized punchcard query). Purely presentational: callers
// fetch their own data and pass it in as `punchcard`.

export type PunchRow = { date: string; hours: number[]; msgs: number[]; sessions: number[]; day_sessions: number };
export type TimelineMetric = "hours" | "msgs";

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
} as const;

const RANGE_DAYS: Record<string, number | null> = { "1m": 30, "3m": 90, all: null };

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const zeros24 = () => new Array(24).fill(0);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "12a";
  if (hh === 12) return "12p";
  return hh < 12 ? `${hh}a` : `${hh - 12}p`;
}

// X-axis ticks for a continuous day series: weekly on short ranges, month
// starts otherwise, suppressing labels that would crowd the previous one.
function timeAxisLabels(dates: string[], toX: (i: number) => number): { label: string; x: number }[] {
  const labels: { label: string; x: number }[] = [];
  const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const weekly = dates.length <= 45;
  let lastM = -1;
  let lastX = -Infinity;
  for (let i = 0; i < dates.length; i++) {
    const [y, m, d] = dates[i].split("-").map(Number);
    const isTick = weekly ? new Date(y, m - 1, d).getDay() === 1 : m - 1 !== lastM;
    if (!isTick) continue;
    lastM = m - 1;
    const x = toX(i);
    if (x - lastX < 28) continue;
    lastX = x;
    labels.push({ label: weekly ? `${mn[m - 1]} ${d}` : mn[m - 1], x });
  }
  return labels;
}

export function TimelineCharts({ punchcard }: { punchcard: PunchRow[] | undefined }) {
  const [metric, setMetric] = useState<TimelineMetric>("hours");
  const [range, setRange] = useState<"1m" | "3m" | "all">("3m");
  const [view, setView] = useState<"grid" | "chart">("grid");

  // Continuous day axis from first activity through today — both charts share it.
  const filled = useMemo(() => {
    if (!punchcard || punchcard.length === 0) return [];
    const map = new Map(punchcard.map((r) => [r.date, r]));
    const [y, m, d] = punchcard[0].date.split("-").map(Number);
    const cur = new Date(y, m - 1, d);
    const todayKey = dateKey(new Date());
    const out: PunchRow[] = [];
    while (out.length < 400) {
      const key = dateKey(cur);
      out.push(map.get(key) ?? { date: key, hours: zeros24(), msgs: zeros24(), sessions: zeros24(), day_sessions: 0 });
      if (key === todayKey) break;
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [punchcard]);

  const sliced = useMemo(() => {
    const n = RANGE_DAYS[range];
    return n ? filled.slice(-n) : filled;
  }, [filled, range]);

  const daySeries = useMemo(
    () =>
      sliced.map((r) => ({
        date: r.date,
        value: metric === "hours" ? sum(r.hours) : sum(r.msgs),
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
        : sliced.flatMap((r) =>
            r.hours.map((_, h) => ({
              date: r.date,
              hour: h,
              hours: r.hours[h],
              msgs: r.msgs[h],
              sessions: r.sessions[h],
              value: metric === "hours" ? r.hours[h] : r.msgs[h],
            }))
          ),
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
            items={[
              { key: "hours", icon: Clock, label: "Hours", title: "Agent hours" },
              { key: "msgs", icon: MessageSquare, label: "Messages", title: "Messages sent" },
            ]}
          />
          <SegmentedToggle
            value={range}
            onChange={(k) => setRange(k as "1m" | "3m" | "all")}
            items={[
              { key: "1m", label: "1M", title: "Last 30 days" },
              { key: "3m", label: "3M", title: "Last 90 days" },
              { key: "all", label: "All", title: "Everything" },
            ]}
          />
        </div>
      </div>
      {view === "grid" ? (
        <>
          <PunchcardChart rows={sliced} metric={metric} />
          <div className="mt-4">
            <TimelineChart points={daySeries} cfg={cfg} />
          </div>
        </>
      ) : (
        <TimelineChart points={hourSeries} cfg={cfg} hourly />
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
    for (const r of rows) for (const v of r[metric]) if (v > m) m = v;
    return m || 1;
  }, [rows, metric]);

  // Cells are memoized so hover-state changes don't rebuild thousands of rects.
  const cells = useMemo(
    () => rows.flatMap((r, di) =>
      r[metric].map((v, h) =>
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
          {fmtDayLabel(hovered.date)} {hourLabel(hover.hr)}–{hourLabel(hover.hr + 1)} · {hovered.hours[hover.hr].toFixed(1)}h · {Math.round(hovered.msgs[hover.hr])} msgs · {hovered.sessions[hover.hr]} sess
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

function TimelineChart({ points, cfg, hourly }: { points: ChartPoint[]; cfg: (typeof METRIC_CFG)[TimelineMetric]; hourly?: boolean }) {
  const { ref: containerRef, width: containerW } = useContainerWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<{ idx: number; x: number; y: number } | null>(null);

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
        onMouseLeave={() => setHovered(null)}
        onMouseMove={(e) => {
          const r = svgRef.current?.getBoundingClientRect();
          if (!r) return;
          let idx = Math.round((e.clientX - r.left - padLeft) / stepX);
          idx = Math.max(0, Math.min(points.length - 1, idx));
          setHovered({ idx, x: r.left + toX(idx), y: r.top + toY(points[idx].value) });
        }}
      >
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
