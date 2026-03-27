"use client";
import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore } from "../../../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

export default function UserProfilePage() {
  return (
    <DashboardLayout>
      <ErrorBoundary name="UserProfile" level="inline">
        <UserProfileContent />
      </ErrorBoundary>
    </DashboardLayout>
  );
}

const NOISE_VERBS = new Set(["started", "finished"]);
const NOISE_BRANCHES = new Set(["main", "master"]);

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function UserProfileContent() {
  const params = useParams();
  const username = params.username as string;
  const router = useRouter();
  const [view, setView] = useState<"feed" | "timeline">("feed");

  const profileUser = useQuery(api.users.getUserByUsername, { username });
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || currentUser?.active_team_id || currentUser?.team_id;

  const aa = useQuery(
    api.users.getUserAbstractActivity,
    profileUser?._id ? { user_id: profileUser._id } : "skip"
  );

  const feed = useQuery(
    api.users.getUserProfileFeed,
    profileUser?._id ? { user_id: profileUser._id, team_id: teamId, limit: 200 } : "skip"
  );

  const filtered = useMemo(() => feed?.filter((i: any) => !NOISE_VERBS.has(i.verb)) ?? null, [feed]);
  const days = useMemo(() => filtered ? groupByDay(filtered) : [], [filtered]);

  const heatmap = useQuery(
    api.users.getUserActivityHeatmap,
    profileUser?._id ? { user_id: profileUser._id, team_id: teamId, days: 90 } : "skip"
  );

  const heatmapData = useMemo(() => heatmap || null, [heatmap]);
  const timelineData = useMemo(() => heatmapData || [], [heatmapData]);

  if (!currentUser) return null;
  if (profileUser === null) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-sol-base01">User not found.</p></div>;
  if (!profileUser) return null;

  const dd = profileUser.daemon_last_seen ? Date.now() - profileUser.daemon_last_seen : Infinity;
  const online = dd < 60000;
  const recent = dd < 300000;

  return (
    <div className="w-full py-4 px-4">
      {/* Profile header */}
      <div className="flex items-center gap-3 pb-3 mb-0">
        <div className="relative flex-shrink-0">
          {profileUser.github_avatar_url ? (
            <img src={profileUser.github_avatar_url} alt="" className="w-9 h-9 rounded-full ring-1 ring-sol-border/20" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-sol-base02 flex items-center justify-center text-sol-text text-sm font-semibold">
              {profileUser.name?.[0]?.toUpperCase() || "?"}
            </div>
          )}
          <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-sol-bg ${online ? "bg-sol-green" : recent ? "bg-sol-yellow" : "bg-sol-base01/30"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13px] font-bold text-sol-text leading-tight">{profileUser.name || "Unnamed"}</span>
            {profileUser.github_username && (
              <a href={`https://github.com/${profileUser.github_username}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-sol-cyan/40 hover:text-sol-cyan transition-colors">@{profileUser.github_username}</a>
            )}
            {online && <span className="text-[9px] text-sol-green font-medium">online</span>}
            {!online && recent && <span className="text-[9px] text-sol-yellow/60">recently active</span>}
          </div>
          {aa && (
            <div className="flex items-center gap-1 mt-0.5 text-[10px] text-sol-base01/40 leading-tight flex-wrap">
              {aa.is_currently_active && aa.current_project && (
                <span className="flex items-center gap-1 text-sol-cyan/70 font-medium mr-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan animate-pulse inline-block" />
                  {aa.current_project}
                </span>
              )}
              <span>{aa.week_sessions} sess</span>
              <Sep />
              <span>{fmtK(aa.week_messages)} msgs</span>
              {(aa.team_activity?.week_commits ?? 0) > 0 && <><Sep /><span className="text-sol-green/50">{aa.team_activity!.week_commits}c</span></>}
              {(aa.team_activity?.week_prs ?? 0) > 0 && <><Sep /><span className="text-sol-violet/50">{aa.team_activity!.week_prs} PRs</span></>}
              {aa.activity_streak > 0 && <><Sep /><span className="text-sol-orange/60">{aa.activity_streak}d streak</span></>}
              <span className="text-sol-base01/20 ml-0.5">this week</span>
            </div>
          )}
        </div>
      </div>

      {/* Activity heatmap -- derived from feed data */}
      {heatmapData && heatmapData.length > 0 && <ActivityHeatmap data={heatmapData} />}

      {/* View toggle */}
      <div className="flex items-center gap-0 mt-2 mb-1 border-b border-sol-border/10">
        <button onClick={() => setView("feed")} className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors border-b-2 ${view === "feed" ? "text-sol-text border-sol-yellow/60" : "text-sol-base01/35 border-transparent hover:text-sol-base01/60"}`}>Feed</button>
        <button onClick={() => setView("timeline")} className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors border-b-2 ${view === "timeline" ? "text-sol-text border-sol-cyan/60" : "text-sol-base01/35 border-transparent hover:text-sol-base01/60"}`}>Timeline</button>
      </div>

      {/* Feed view */}
      {view === "feed" && (
        <div className="mt-1">
          {days.map(([date, items]) => (
            <div key={date}>
              <DayHeader date={date} count={items.length} />
              <div>{items.map((item: any, i: number) => <FeedRow key={`${item.type}-${item.timestamp}-${i}`} item={item} router={router} />)}</div>
            </div>
          ))}
          {filtered && filtered.length === 0 && <div className="text-[11px] text-sol-base01/30 text-center py-16">No recent activity</div>}
          {!filtered && <div className="text-[11px] text-sol-base01/20 text-center py-16 animate-pulse">Loading...</div>}
        </div>
      )}

      {/* Timeline chart view */}
      {view === "timeline" && timelineData.length > 0 && <TimelineChart data={timelineData} />}
      {view === "timeline" && timelineData.length === 0 && <div className="text-[11px] text-sol-base01/30 text-center py-16">No session data</div>}
    </div>
  );
}

function Sep() {
  return <span className="text-sol-base01/15 select-none">&middot;</span>;
}

/* ─── Activity Heatmap ─── */

const HEAT_COLORS_HEX = ["#eee8d5", "#c3dfa0", "#8fbc5c", "#5f9e2f", "#3d7a1a"];

function ActivityHeatmap({ data }: { data: any[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(800);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    const weeks = 26;
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - (weeks * 7 - 1) - startDay.getDay());

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
    for (let w = 0; w < rows.length; w++) {
      const d = new Date(rows[w][0].date + "T12:00:00");
      if (d.getMonth() !== lastM) { lastM = d.getMonth(); monthLabels.push({ label: mn[d.getMonth()], col: w }); }
    }

    return { grid: rows, maxHours: max, totalHours: totalH, totalSessions: totalS, months: monthLabels };
  }, [data]);

  const gap = 2;
  const cellSize = Math.max(8, Math.floor((containerW - grid.length * gap) / grid.length));
  const step = cellSize + gap;
  const svgW = grid.length * step;
  const svgH = 7 * step;

  const getColor = (hours: number) => {
    if (hours <= 0) return HEAT_COLORS_HEX[0];
    const r = hours / maxHours;
    if (r < 0.15) return HEAT_COLORS_HEX[1];
    if (r < 0.4) return HEAT_COLORS_HEX[2];
    if (r < 0.7) return HEAT_COLORS_HEX[3];
    return HEAT_COLORS_HEX[4];
  };

  return (
    <div className="mt-2 mb-1 w-full">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[9px] text-sol-base01/30 uppercase tracking-widest font-bold">Agent Activity</span>
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
              fill={getColor(cell.hours)}
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
          {HEAT_COLORS_HEX.map((c, i) => <div key={i} style={{ background: c, width: 10, height: 10, borderRadius: 2 }} />)}
          <span className="text-[8px] text-sol-base01/25">More</span>
        </div>
        {/* Tooltip */}
        {tooltip && (
          <div className="fixed z-50 px-2 py-1 bg-sol-base03 text-sol-base2 text-[10px] rounded shadow-lg pointer-events-none" style={{ left: tooltip.x, top: tooltip.y, transform: "translate(-50%, -100%)" }}>
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Timeline Chart (zoomable SVG) ─── */

function TimelineChart({ data }: { data: Array<{ date: string; hours: number; sessions: number }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [hoveredBar, setHoveredBar] = useState<{ idx: number; x: number; y: number } | null>(null);

  const sorted = useMemo(() => [...data].sort((a, b) => a.date.localeCompare(b.date)), [data]);

  const allDays = useMemo(() => {
    if (sorted.length === 0) return [];
    const map: Record<string, { hours: number; sessions: number }> = {};
    for (const d of sorted) map[d.date] = d;
    const start = new Date(sorted[0].date + "T12:00:00");
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const result: Array<{ date: string; hours: number; sessions: number }> = [];
    const cur = new Date(start);
    while (cur <= end) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      const entry = map[key];
      result.push(entry ? { date: key, hours: entry.hours, sessions: entry.sessions } : { date: key, hours: 0, sessions: 0 });
      cur.setDate(cur.getDate() + 1);
    }
    return result;
  }, [sorted]);

  const maxH = useMemo(() => Math.max(...allDays.map(d => d.hours), 1), [allDays]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) setZoomLevel(z => Math.min(z * 1.3, 8));
    else setZoomLevel(z => Math.max(z / 1.3, 1));
    e.preventDefault();
  }, []);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollLeft = containerRef.current.scrollWidth;
  }, [allDays.length]);

  if (allDays.length === 0) return <div className="text-[11px] text-sol-base01/30 text-center py-16">No data</div>;

  const barW = Math.max(6, 14 * zoomLevel);
  const gap = Math.max(1, 2 * zoomLevel);
  const chartW = allDays.length * (barW + gap);
  const chartH = 220;
  const padTop = 10;
  const padBot = 24;
  const plotH = chartH - padTop - padBot;

  const yTicks = [0, maxH * 0.25, maxH * 0.5, maxH * 0.75, maxH];

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[9px] text-sol-base01/30 uppercase tracking-widest font-bold">Agent Hours Per Day</span>
        <span className="text-[9px] text-sol-base01/25">Scroll to zoom</span>
      </div>
      <div className="flex">
        {/* Y axis labels */}
        <div className="flex flex-col justify-between pr-1 flex-shrink-0" style={{ height: chartH, paddingTop: padTop, paddingBottom: padBot }}>
          {[...yTicks].reverse().map((v, i) => (
            <span key={i} className="text-[8px] text-sol-base01/25 tabular-nums text-right w-[24px] leading-none">{v.toFixed(0)}h</span>
          ))}
        </div>
        {/* Chart area */}
        <div ref={containerRef} className="flex-1 overflow-x-auto" onWheel={handleWheel} style={{ scrollBehavior: "smooth" }}>
          <svg width={chartW} height={chartH} className="block" onMouseLeave={() => setHoveredBar(null)}>
            {/* Horizontal grid lines */}
            {yTicks.map((v, i) => {
              const y = padTop + plotH - (v / maxH) * plotH;
              return <line key={i} x1={0} x2={chartW} y1={y} y2={y} stroke="currentColor" className="text-sol-border/10" strokeWidth={0.5} />;
            })}
            {/* Bars */}
            {allDays.map((day, i) => {
              const x = i * (barW + gap);
              const h = day.hours > 0 ? Math.max(2, (day.hours / maxH) * plotH) : 0;
              const y = padTop + plotH - h;
              const isToday = day.date === new Date().toISOString().split("T")[0];
              return (
                <g key={i}>
                  <rect
                    x={x} y={y} width={barW} height={h}
                    rx={barW > 6 ? 2 : 1}
                    fill={isToday ? "#268bd2" : day.hours > 0 ? "#859900" : "transparent"}
                    opacity={hoveredBar?.idx === i ? 1 : 0.7}
                    className="cursor-crosshair transition-opacity"
                    onMouseEnter={(e) => {
                      const r = (e.target as SVGRectElement).getBoundingClientRect();
                      setHoveredBar({ idx: i, x: r.left + r.width / 2, y: r.top });
                    }}
                  />
                  {/* X axis date labels - show weekly or as zoom allows */}
                  {(i % Math.max(1, Math.round(7 / zoomLevel)) === 0) && (
                    <text x={x + barW / 2} y={chartH - 4} textAnchor="middle" className="fill-sol-base01/20" style={{ fontSize: Math.min(9, 7 * zoomLevel) }}>
                      {fmtChartDate(day.date)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {/* Tooltip */}
          {hoveredBar && (
            <div className="fixed z-50 px-2 py-1 bg-sol-base03 text-sol-base2 text-[10px] rounded shadow-lg pointer-events-none whitespace-nowrap" style={{ left: hoveredBar.x, top: hoveredBar.y - 4, transform: "translate(-50%, -100%)" }}>
              {allDays[hoveredBar.idx].date}: {allDays[hoveredBar.idx].hours.toFixed(1)}h, {allDays[hoveredBar.idx].sessions} sessions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtChartDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${mn[m - 1]} ${d}`;
}

/* ─── Feed Components ─── */

const VERB_COLORS: Record<string, string> = {
  messaged: "text-sol-blue/80", created: "text-sol-yellow/75", updated: "text-sol-yellow/50",
  completed: "text-sol-green/85", wrote: "text-sol-cyan/65", edited: "text-sol-cyan/45",
  pushed: "text-sol-green/60", "opened PR": "text-sol-violet/70", "merged PR": "text-sol-green/70",
};

const VERB_ACCENTS: Record<string, string> = {
  messaged: "border-l-sol-blue/40", created: "border-l-sol-yellow/40", updated: "border-l-sol-yellow/20",
  completed: "border-l-sol-green/50", wrote: "border-l-sol-cyan/35", edited: "border-l-sol-cyan/20",
  pushed: "border-l-sol-green/30", "opened PR": "border-l-sol-violet/40", "merged PR": "border-l-sol-green/40",
};

function FeedRow({ item, router }: { item: any; router: ReturnType<typeof useRouter> }) {
  const href = item.entity_type === "session" ? `/conversation/${item.entity_id}`
    : item.entity_type === "task" ? `/tasks/${item.entity_id}`
    : item.entity_type === "doc" ? `/docs/${item.entity_id}` : null;

  const verbColor = VERB_COLORS[item.verb] || "text-sol-base01/50";
  const accent = VERB_ACCENTS[item.verb] || "border-l-sol-base01/15";
  const isLive = item.meta?.status === "active" && (Date.now() - item.timestamp < 3600000);
  const branch = item.meta?.branch && !NOISE_BRANCHES.has(item.meta.branch) ? item.meta.branch : null;
  const durMs = item.meta?.duration_ms;
  const durStr = durMs ? (durMs < 3600000 ? `${Math.round(durMs / 60000)}m` : `${(durMs / 3600000).toFixed(1)}h`) : null;

  return (
    <div className={`border-l-2 ${accent} hover:bg-sol-bg-alt/50 transition-colors ${href ? "cursor-pointer" : ""} group py-[2px] pl-2 pr-1`} onClick={href ? () => router.push(href) : undefined}>
      <div className="flex items-baseline gap-0">
        <span className="w-[42px] flex-shrink-0 text-[10px] tabular-nums text-sol-base01/22 text-right pr-2 select-none leading-none">{fmtTime(item.timestamp)}</span>
        <span className="min-w-0 flex-1 text-[11.5px] leading-[1.5] overflow-hidden whitespace-nowrap text-ellipsis">
          {item.verb === "completed" && <span className="text-sol-green/60 mr-0.5">&#10003;</span>}
          <span className={`font-semibold ${verbColor}`}>{item.verb}</span>
          {item.count && item.count > 5 && <span className="text-sol-base01/25 text-[9px] ml-0.5">{item.count}x</span>}
          {" "}
          {item.entity_type === "doc" && item.meta?.doc_type && item.meta.doc_type !== "note" && (
            <span className="inline-block text-[8.5px] font-semibold uppercase tracking-wider text-sol-cyan/40 bg-sol-cyan/8 px-1 py-px rounded mr-1 align-baseline">{item.meta.doc_type}</span>
          )}
          {item.entity_type === "task" && item.entity_short_id && <span className="text-sol-base01/30 font-mono text-[9.5px] mr-0.5">{item.entity_short_id}</span>}
          {item.entity_title && (
            <span className="text-sol-text/75 font-medium group-hover:text-sol-text transition-colors group-hover:underline decoration-sol-base01/20 underline-offset-2">{item.entity_title}</span>
          )}
          {isLive && item.type === "message" && (
            <span className="inline-flex items-center gap-0.5 ml-1.5 align-baseline">
              <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse inline-block" />
              <span className="text-sol-green/70 text-[8px] font-bold tracking-wider">LIVE</span>
            </span>
          )}
          {item.meta?.project && item.meta.project !== "unknown" && <span className="text-sol-base01/20 text-[9.5px] font-mono ml-1.5">{item.meta.project}</span>}
          {durStr && <span className="text-sol-base01/18 text-[9px] ml-1">{durStr}</span>}
          {branch && <span className="text-sol-base01/22 font-mono text-[9px] ml-1">{branch}</span>}
          {item.meta?.message_count && item.meta.message_count > 20 && <span className="text-sol-base01/18 text-[9px] tabular-nums ml-1">{item.meta.message_count}m</span>}
          {item.meta?.files_changed && <span className="text-sol-base01/20 text-[9px] ml-1">{item.meta.files_changed}f</span>}
          {item.type !== "message" && item.preview && !item.entity_title && <span className="text-sol-text/50 ml-0.5">{item.preview}</span>}
          {item.meta?.priority === "high" && <span className="inline-block w-1 h-1 rounded-full bg-sol-red/50 ml-1 align-middle" />}
          {item.meta?.priority === "urgent" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-sol-red/70 ml-1 align-middle" />}
        </span>
      </div>
      {/* Full message text */}
      {item.type === "message" && item.preview && (
        <div className="pl-[42px] mt-px">
          <p className="text-[10.5px] text-sol-text/40 leading-snug line-clamp-2">{item.preview}</p>
        </div>
      )}
    </div>
  );
}

function DayHeader({ date, count }: { date: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-1 first:mt-1">
      <span className="text-[9px] font-bold text-sol-base01/30 uppercase tracking-widest select-none">{fmtDayLabel(date)}</span>
      <div className="flex-1 h-px bg-sol-border/10" />
      <span className="text-[9px] tabular-nums text-sol-base01/22 select-none">{count}</span>
    </div>
  );
}

/* ─── Utilities ─── */

function groupByDay(items: any[]): [string, any[]][] {
  const groups: Record<string, any[]> = {};
  for (const item of items) {
    const d = new Date(item.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    (groups[key] ||= []).push(item);
  }
  return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
}

function fmtDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = today.getTime() - date.getTime();
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 30000) return "now";
  if (diff < 60000) return "<1m";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  const h = d.getHours();
  const m = d.getMinutes();
  if (diff < 86400000) return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "a" : "p"}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
