"use client";
import { useMemo, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "./ThemeProvider";

// Solarized contribution-graph ramps. Shared by the team profile (authed) and
// the public profile (anonymous) so the two pages render an identical graph.
export const HEAT_COLORS_LIGHT = ["#eee8d5", "#c3dfa0", "#8fbc5c", "#5f9e2f", "#3d7a1a"];
export const HEAT_COLORS_DARK = ["#073642", "#2d5016", "#3d7a1a", "#5f9e2f", "#8fbc5c"];

export function heatColor(value: number, max: number, colors: string[]): string {
  if (value <= 0) return colors[0];
  const r = value / max;
  if (r < 0.15) return colors[1];
  if (r < 0.4) return colors[2];
  if (r < 0.7) return colors[3];
  return colors[4];
}

export function useContainerWidth(initial = 800) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

// Portaled to <body>: x/y are viewport coordinates, but position:fixed resolves
// against the nearest *transformed* ancestor, not the viewport — and chart
// sections can sit inside entrance animations (.reveal keeps a fill-mode
// translateY(0), which still counts as a transform). The portal guarantees an
// untransformed containing block so the tip always lands at the cursor.
export function HoverTip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed z-50 px-2 py-1 bg-sol-base03 text-sol-base2 text-[10px] rounded shadow-lg pointer-events-none whitespace-nowrap" style={{ left: x, top: y, transform: "translate(-50%, -100%)" }}>
      {children}
    </div>,
    document.body
  );
}

// A GitHub-style year-long contribution grid. `data` is [{date,hours,sessions}].
// `label` lets each caller frame it ("Agent Activity" on the team page,
// "Contribution activity" on the anonymous public page).
export function ActivityHeatmap({ data, label = "Agent Activity" }: { data: any[]; label?: string }) {
  const { theme } = useTheme();
  const colors = theme === "dark" ? HEAT_COLORS_DARK : HEAT_COLORS_LIGHT;
  const { ref: containerRef, width: containerW } = useContainerWidth();
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  // Fit a full year of weeks to the container width at a compact cell size
  const gap = 2;
  const weeks = Math.max(20, Math.min(53, Math.floor((containerW - gap) / (13 + gap))));

  const { grid, maxHours, totalHours, totalSessions, months } = useMemo(() => {
    const map: Record<string, { hours: number; sessions: number }> = {};
    let max = 0, totalH = 0, totalS = 0;
    for (const d of data) {
      map[d.date] = { hours: d.hours, sessions: d.sessions };
      if (d.hours > max) max = d.hours;
      totalH += d.hours;
      totalS += d.sessions;
    }
    if (max === 0) max = 1;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - startDay.getDay() - (weeks - 1) * 7);

    const rows: Array<Array<{ date: string; hours: number; sessions: number }>> = [];
    for (let w = 0; w < weeks; w++) {
      const week: typeof rows[0] = [];
      for (let d = 0; d < 7; d++) {
        const cur = new Date(startDay); cur.setDate(cur.getDate() + w * 7 + d);
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        week.push({ date: key, ...(map[key] || { hours: 0, sessions: 0 }) });
      }
      rows.push(week);
    }

    const monthLabels: { label: string; col: number }[] = [];
    const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let lastM = -1;
    let lastCol = -Infinity;
    for (let w = 0; w < rows.length; w++) {
      const d = new Date(rows[w][0].date + "T12:00:00");
      if (d.getMonth() === lastM) continue;
      lastM = d.getMonth();
      // A month boundary in the first column or two sits on top of the previous
      // label ("JulAug") — drop the crowded one, keep the newer month.
      if (w - lastCol < 3) monthLabels.pop();
      lastCol = w;
      monthLabels.push({ label: mn[d.getMonth()], col: w });
    }

    return { grid: rows, maxHours: max, totalHours: totalH, totalSessions: totalS, months: monthLabels };
  }, [data, weeks]);

  // Exact cell size to fill the container width across the chosen number of weeks
  const cellSize = Math.min(16, Math.max(8, Math.floor((containerW - grid.length * gap) / grid.length)));
  const step = cellSize + gap;
  const svgW = grid.length * step;
  const svgH = 7 * step;

  return (
    <div className="mt-2 mb-1 w-full">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[9px] text-sol-base01/30 uppercase tracking-widest font-bold">{label}</span>
        <span className="text-[9px] text-sol-base01/35 tabular-nums">{totalHours.toFixed(0)}h across {totalSessions} sessions</span>
      </div>
      <div ref={containerRef} className="w-full overflow-x-auto relative" onMouseLeave={() => setTooltip(null)}>
        {/* Month labels */}
        <div className="flex" style={{ width: svgW, height: 14 }}>
          {months.map((m, i) => (
            <span key={i} className="text-[9px] text-sol-base01/30 select-none absolute" style={{ left: m.col * step }}>{m.label}</span>
          ))}
        </div>
        {/* SVG grid */}
        <svg width={svgW} height={svgH} className="block">
          {grid.map((week, w) => week.map((cell, d) => (
            <rect
              key={`${w}-${d}`}
              x={w * step} y={d * step}
              width={cellSize} height={cellSize}
              rx={2}
              fill={heatColor(cell.hours, maxHours, colors)}
              className="cursor-crosshair"
              onMouseEnter={(e) => {
                const r = (e.target as SVGRectElement).getBoundingClientRect();
                setTooltip({ x: r.left + r.width / 2, y: r.top - 4, text: `${cell.date}: ${cell.hours.toFixed(1)}h, ${cell.sessions} sessions` });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          )))}
        </svg>
        {/* Legend */}
        <div className="flex items-center gap-1 mt-1.5">
          <span className="text-[8px] text-sol-base01/25">Less</span>
          {colors.map((c, i) => <div key={i} style={{ background: c, width: 10, height: 10, borderRadius: 2 }} />)}
          <span className="text-[8px] text-sol-base01/25">More</span>
        </div>
        {/* Tooltip */}
        {tooltip && <HoverTip x={tooltip.x} y={tooltip.y}>{tooltip.text}</HoverTip>}
      </div>
    </div>
  );
}
