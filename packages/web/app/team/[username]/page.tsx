"use client";
import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore } from "../../../store/inboxStore";
import Link from "next/link";
import { FileText, CheckCircle2, Circle, CircleDot, CircleDotDashed, XCircle } from "lucide-react";
import { getLabelColor } from "../../../lib/labelColors";
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
  const [view, setView] = useState<"feed" | "timeline" | "work">("feed");

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

  const userTasks = useQuery(
    api.users.getUserTasks,
    profileUser?._id ? { user_id: profileUser._id, limit: 30 } : "skip"
  );
  const userDocs = useQuery(
    api.users.getUserDocs,
    profileUser?._id ? { user_id: profileUser._id, limit: 20 } : "skip"
  );

  const filtered = useMemo(() => feed?.filter((i: any) => !NOISE_VERBS.has(i.verb)) ?? null, [feed]);
  const days = useMemo(() => filtered ? groupByDay(filtered) : [], [filtered]);

  const heatmap = useQuery(
    api.users.getUserActivityHeatmap,
    profileUser?._id ? { user_id: profileUser._id, days: 180 } : "skip"
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
        <button onClick={() => setView("work")} className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors border-b-2 ${view === "work" ? "text-sol-text border-sol-violet/60" : "text-sol-base01/35 border-transparent hover:text-sol-base01/60"}`}>Work</button>
        <button onClick={() => setView("timeline")} className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors border-b-2 ${view === "timeline" ? "text-sol-text border-sol-cyan/60" : "text-sol-base01/35 border-transparent hover:text-sol-base01/60"}`}>Timeline</button>
      </div>

      {/* Feed view */}
      {view === "feed" && (
        <div className="mt-1">
          {days.map(([date, items]) => (
            <div key={date}>
              <DayHeader date={date} count={items.length} items={items} />
              <div>{items.map((item: any, i: number) => <FeedRow key={`${item.type}-${item.timestamp}-${i}`} item={item} router={router} idx={i} />)}</div>
            </div>
          ))}
          {filtered && filtered.length === 0 && <div className="text-[11px] text-sol-base01/30 text-center py-16">No recent activity</div>}
          {!filtered && <div className="text-[11px] text-sol-base01/20 text-center py-16 animate-pulse">Loading...</div>}
        </div>
      )}

      {/* Work view — tasks + docs */}
      {view === "work" && (
        <div className="mt-2 space-y-6">
          <WorkSection
            title="Tasks"
            items={userTasks}
            renderItem={(t: any) => <TaskWorkRow key={t._id} task={t} />}
            emptyText="No tasks"
          />
          <WorkSection
            title="Documents"
            items={userDocs}
            renderItem={(d: any) => <DocWorkRow key={d._id} doc={d} />}
            emptyText="No documents"
          />
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
  const [containerW, setContainerW] = useState(800);
  const [hovered, setHovered] = useState<{ idx: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  if (allDays.length === 0) return <div className="text-[11px] text-sol-base01/30 text-center py-16">No data</div>;

  const chartH = 180;
  const padTop = 12;
  const padBot = 28;
  const padLeft = 32;
  const padRight = 8;
  const plotW = containerW - padLeft - padRight;
  const plotH = chartH - padTop - padBot;
  const stepX = plotW / Math.max(allDays.length - 1, 1);

  const toX = (i: number) => padLeft + i * stepX;
  const toY = (h: number) => padTop + plotH - (h / maxH) * plotH;

  const linePath = allDays.map((d, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(d.hours).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${toX(allDays.length - 1).toFixed(1)},${toY(0).toFixed(1)} L${toX(0).toFixed(1)},${toY(0).toFixed(1)} Z`;

  const yTicks = [0, maxH * 0.25, maxH * 0.5, maxH * 0.75, maxH];

  const monthLabels = useMemo(() => {
    const labels: { label: string; x: number }[] = [];
    const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let lastM = -1;
    for (let i = 0; i < allDays.length; i++) {
      const d = new Date(allDays[i].date + "T12:00:00");
      if (d.getMonth() !== lastM) { lastM = d.getMonth(); labels.push({ label: mn[d.getMonth()], x: toX(i) }); }
    }
    return labels;
  }, [allDays, containerW]);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[9px] text-sol-base01/30 uppercase tracking-widest font-bold">Sessions Per Day</span>
        <span className="text-[9px] text-sol-base01/25 tabular-nums">{allDays.length} days</span>
      </div>
      <div ref={containerRef} className="w-full relative" onMouseLeave={() => setHovered(null)}>
        <svg width={containerW} height={chartH} className="block">
          {/* Y grid lines */}
          {yTicks.map((v, i) => {
            const y = toY(v);
            return (
              <g key={i}>
                <line x1={padLeft} x2={containerW - padRight} y1={y} y2={y} stroke="currentColor" className="text-sol-border/8" strokeWidth={0.5} strokeDasharray={i === 0 ? "none" : "2,3"} />
                <text x={padLeft - 4} y={y + 3} textAnchor="end" className="fill-sol-base01/25" style={{ fontSize: 8 }}>{v.toFixed(0)}h</text>
              </g>
            );
          })}
          {/* X month labels */}
          {monthLabels.map((m, i) => (
            <text key={i} x={m.x} y={chartH - 6} textAnchor="start" className="fill-sol-base01/25" style={{ fontSize: 9 }}>{m.label}</text>
          ))}
          {/* Area fill */}
          <path d={areaPath} fill="#859900" opacity={0.12} />
          {/* Line */}
          <path d={linePath} fill="none" stroke="#859900" strokeWidth={1.5} opacity={0.7} />
          {/* Data points on active days */}
          {allDays.map((d, i) => d.sessions > 0 ? (
            <circle
              key={i}
              cx={toX(i)} cy={toY(d.hours)}
              r={d.sessions > 10 ? 3 : d.sessions > 3 ? 2.5 : 2}
              fill="#859900"
              opacity={hovered?.idx === i ? 1 : 0.6}
              className="cursor-crosshair"
              onMouseEnter={(e) => {
                const r = (e.target as SVGCircleElement).getBoundingClientRect();
                setHovered({ idx: i, x: r.left + r.width / 2, y: r.top });
              }}
            />
          ) : null)}
          {/* Hover vertical line */}
          {hovered && (
            <line x1={toX(hovered.idx)} x2={toX(hovered.idx)} y1={padTop} y2={padTop + plotH} stroke="#859900" strokeWidth={0.5} opacity={0.4} strokeDasharray="3,3" />
          )}
        </svg>
        {/* Tooltip */}
        {hovered && (
          <div className="fixed z-50 px-2 py-1 bg-sol-base03 text-sol-base2 text-[10px] rounded shadow-lg pointer-events-none whitespace-nowrap" style={{ left: hovered.x, top: hovered.y - 4, transform: "translate(-50%, -100%)" }}>
            {allDays[hovered.idx].date}: {allDays[hovered.idx].hours.toFixed(1)}h, {allDays[hovered.idx].sessions} sessions
          </div>
        )}
      </div>
    </div>
  );
}


/* ─── Work Tab Components ─── */

const TASK_STATUS_ICON: Record<string, { icon: typeof Circle; color: string }> = {
  backlog: { icon: CircleDotDashed, color: "text-sol-base01/40" },
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  in_review: { icon: CircleDot, color: "text-sol-violet" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
  dropped: { icon: XCircle, color: "text-sol-base01/30" },
};

function WorkSection({ title, items, renderItem, emptyText }: { title: string; items: any[] | undefined; renderItem: (item: any) => React.ReactNode; emptyText: string }) {
  if (!items) return <div className="text-[11px] text-sol-base01/20 text-center py-6 animate-pulse">Loading {title.toLowerCase()}...</div>;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] font-bold text-sol-base01/30 uppercase tracking-widest">{title}</span>
        <div className="flex-1 h-px bg-sol-border/10" />
        <span className="text-[9px] tabular-nums text-sol-base01/22">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-sol-base01/30 text-center py-8">{emptyText}</div>
      ) : (
        <div className="space-y-px">{items.map(renderItem)}</div>
      )}
    </div>
  );
}

function TaskWorkRow({ task }: { task: any }) {
  const cfg = TASK_STATUS_ICON[task.status] || TASK_STATUS_ICON.open;
  const Icon = cfg.icon;
  const age = fmtAge(task.updated_at || task.created_at);
  return (
    <Link href={`/tasks/${task.short_id || task._id}`} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-sol-bg-alt/50 transition-colors group">
      <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${cfg.color}`} />
      <span className="text-[10px] font-mono text-sol-base01/35 w-14 flex-shrink-0">{task.short_id}</span>
      <span className="flex-1 text-[12px] text-sol-text/80 truncate group-hover:text-sol-text transition-colors">{task.title}</span>
      {task.labels?.slice(0, 2).map((l: string) => {
        const lc = getLabelColor(l);
        return <span key={l} className={`w-2 h-2 rounded-full flex-shrink-0 ${lc.dot}`} title={l} />;
      })}
      <span className="text-[10px] text-sol-base01/25 tabular-nums flex-shrink-0">{age}</span>
    </Link>
  );
}

function DocWorkRow({ doc }: { doc: any }) {
  const age = fmtAge(doc.updated_at || doc.created_at);
  return (
    <Link href={`/docs/${doc._id}`} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-sol-bg-alt/50 transition-colors group">
      <FileText className="w-3.5 h-3.5 flex-shrink-0 text-sol-cyan/50" />
      <span className="flex-1 text-[12px] text-sol-text/80 truncate group-hover:text-sol-text transition-colors">{doc.title || "Untitled"}</span>
      {doc.doc_type && doc.doc_type !== "note" && (
        <span className="text-[8.5px] font-semibold uppercase tracking-wider text-sol-cyan/40 bg-sol-cyan/8 px-1 py-px rounded">{doc.doc_type}</span>
      )}
      {doc.labels?.slice(0, 2).map((l: string) => {
        const lc = getLabelColor(l);
        return <span key={l} className={`w-2 h-2 rounded-full flex-shrink-0 ${lc.dot}`} title={l} />;
      })}
      <span className="text-[10px] text-sol-base01/25 tabular-nums flex-shrink-0">{age}</span>
    </Link>
  );
}

function fmtAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
  return `${Math.floor(diff / 604800000)}w`;
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

const TYPE_ICONS: Record<string, string> = {
  message: "\u25B8", task: "\u25A0", doc: "\u25C6",
  commit_pushed: "\u2022", pr_created: "\u2191", pr_merged: "\u2713",
};

const TASK_STATUS_DOTS: Record<string, string> = {
  done: "bg-sol-green", in_progress: "bg-sol-yellow", open: "bg-sol-blue",
  in_review: "bg-sol-violet", blocked: "bg-sol-red", backlog: "bg-sol-base01/30",
};

function stripSystemMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function FeedRow({ item, router, idx }: { item: any; router: ReturnType<typeof useRouter>; idx: number }) {
  const href = item.entity_type === "session" ? `/conversation/${item.entity_id}`
    : item.entity_type === "task" ? `/tasks/${item.entity_id}`
    : item.entity_type === "doc" ? `/docs/${item.entity_id}` : null;

  const verbColor = VERB_COLORS[item.verb] || "text-sol-base01/50";
  const accent = VERB_ACCENTS[item.verb] || "border-l-sol-base01/15";
  const isLive = item.meta?.status === "active" && (Date.now() - item.timestamp < 3600000);
  const branch = item.meta?.branch && !NOISE_BRANCHES.has(item.meta.branch) ? item.meta.branch : null;
  const durMs = item.meta?.duration_ms;
  const durStr = durMs ? (durMs < 3600000 ? `${Math.round(durMs / 60000)}m` : `${(durMs / 3600000).toFixed(1)}h`) : null;
  const typeIcon = TYPE_ICONS[item.type] || TYPE_ICONS[item.entity_type] || "";
  const zebraClass = idx % 2 === 0 ? "" : "bg-sol-bg-alt/20";

  const cleanPreview = useMemo(() => {
    if (!item.preview) return null;
    return stripSystemMarkup(item.preview);
  }, [item.preview]);

  return (
    <div className={`border-l-2 ${accent} hover:bg-sol-bg-alt/60 transition-colors ${href ? "cursor-pointer" : ""} group py-[3px] pl-2 pr-1 ${zebraClass}`} onClick={href ? () => router.push(href) : undefined}>
      <div className="flex items-baseline gap-0">
        {/* Time -- wider, more visible */}
        <span className="w-[48px] flex-shrink-0 text-[10px] tabular-nums text-sol-base01/28 text-right pr-2 select-none leading-none">{fmtTime(item.timestamp)}</span>

        {/* Type icon */}
        <span className={`w-[14px] flex-shrink-0 text-[8px] ${verbColor} select-none leading-none`}>{typeIcon}</span>

        {/* Content */}
        <span className="min-w-0 flex-1 text-[11.5px] leading-[1.55] overflow-hidden whitespace-nowrap text-ellipsis">
          {item.verb === "completed" && <span className="text-sol-green/70 mr-0.5">&#10003;</span>}
          <span className={`font-semibold ${verbColor}`}>{item.verb}</span>
          {item.count && item.count > 5 && <span className="text-sol-base01/25 text-[9px] ml-0.5">{item.count}x</span>}
          {" "}

          {/* Task status dot */}
          {item.entity_type === "task" && item.meta?.status && (
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${TASK_STATUS_DOTS[item.meta.status] || "bg-sol-base01/20"} mr-1 align-middle`} title={item.meta.status} />
          )}

          {/* Doc type chip */}
          {item.entity_type === "doc" && item.meta?.doc_type && item.meta.doc_type !== "note" && (
            <span className="inline-block text-[8.5px] font-semibold uppercase tracking-wider text-sol-cyan/45 bg-sol-cyan/10 px-1 py-px rounded mr-1 align-baseline">{item.meta.doc_type}</span>
          )}

          {/* Task short ID */}
          {item.entity_type === "task" && item.entity_short_id && <span className="text-sol-base01/30 font-mono text-[9.5px] mr-0.5">{item.entity_short_id}</span>}

          {/* Entity title -- stronger contrast */}
          {item.entity_title && (
            <span className="text-sol-text/85 font-medium group-hover:text-sol-text transition-colors group-hover:underline decoration-sol-base01/20 underline-offset-2">{item.entity_title}</span>
          )}

          {/* LIVE badge */}
          {isLive && item.type === "message" && (
            <span className="inline-flex items-center gap-0.5 ml-1.5 align-baseline">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse inline-block" />
              <span className="text-sol-green/80 text-[8px] font-bold tracking-wider">LIVE</span>
            </span>
          )}

          {/* Project -- more prominent */}
          {item.meta?.project && item.meta.project !== "unknown" && (
            <span className="text-sol-base01/28 text-[9.5px] font-mono ml-1.5 bg-sol-base02/30 px-1 rounded">{item.meta.project}</span>
          )}

          {/* Duration */}
          {durStr && <span className="text-sol-base01/25 text-[9px] ml-1 tabular-nums">{durStr}</span>}

          {/* Branch */}
          {branch && <span className="text-sol-base01/22 font-mono text-[9px] ml-1">{branch}</span>}

          {/* Message count -- spelled out */}
          {item.meta?.message_count && item.meta.message_count > 20 && (
            <span className="text-sol-base01/20 text-[9px] tabular-nums ml-1">{item.meta.message_count} msgs</span>
          )}

          {/* Files changed */}
          {item.meta?.files_changed && <span className="text-sol-base01/20 text-[9px] ml-1">{item.meta.files_changed} files</span>}

          {/* Non-message preview */}
          {item.type !== "message" && item.preview && !item.entity_title && <span className="text-sol-text/50 ml-0.5">{stripSystemMarkup(item.preview)}</span>}

          {/* Priority */}
          {item.meta?.priority === "high" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-sol-red/40 ml-1 align-middle" title="high priority" />}
          {item.meta?.priority === "urgent" && <span className="inline-block w-2 h-2 rounded-full bg-sol-red/60 ml-1 align-middle" title="urgent" />}
        </span>
      </div>

      {/* Message preview -- quote style, cleaned up, more readable */}
      {item.type === "message" && cleanPreview && (
        <div className="pl-[62px] mt-0.5 mb-0.5">
          <p className="text-[11px] text-sol-text/50 leading-snug line-clamp-2 border-l-2 border-sol-blue/15 pl-2 py-px">{cleanPreview}</p>
        </div>
      )}
    </div>
  );
}

function DayHeader({ date, count, items }: { date: string; count: number; items: any[] }) {
  const totalHours = useMemo(() => {
    const seen = new Set<string>();
    let h = 0;
    for (const item of items) {
      if (item.type !== "message" || !item.meta?.duration_ms || !item.entity_id) continue;
      if (seen.has(item.entity_id)) continue;
      seen.add(item.entity_id);
      h += Math.min(item.meta.duration_ms, 8 * 3600000) / 3600000;
    }
    return h;
  }, [items]);

  const sessions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) {
      if (item.type === "message" && item.entity_id) seen.add(item.entity_id);
    }
    return seen.size;
  }, [items]);

  return (
    <div className="flex items-center gap-2 mt-4 mb-1 first:mt-1">
      <span className="text-[9px] font-bold text-sol-base01/35 uppercase tracking-widest select-none">{fmtDayLabel(date)}</span>
      {totalHours > 0 && (
        <span className="text-[9px] text-sol-green/40 tabular-nums">{totalHours.toFixed(1)}h / {sessions}s</span>
      )}
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
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (diff < 86400000) return `Today, ${dayNames[date.getDay()]}`;
  if (diff < 172800000) return `Yesterday, ${dayNames[date.getDay()]}`;
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
