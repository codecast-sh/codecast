"use client";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueries } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { Clock, MessageSquare, Send } from "lucide-react";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { AvatarImg } from "../../../lib/avatarCache";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { ActivityHeatmap } from "../../../components/ActivityHeatmap";
import {
  BrushRect,
  RangeControl,
  TimelineCharts,
  fillDays,
  fmtDayLabel,
  fmtK,
  rangeLabel,
  sliceRange,
  timeAxisLabels,
  useDayBrush,
  type DayRange,
  type PunchRow,
  type TimelineMetric,
} from "../../../components/ActivityCharts";
import { HoverTip, useContainerWidth } from "../../../components/ActivityHeatmap";
import { SegmentedToggle } from "../../../components/SegmentedToggle";

// Team-wide activity: every member's punchcard merged into one grid, plus a
// per-member breakdown. One punchcard query per member (the same query the
// profile Timeline tab runs — a single query aggregating all members
// server-side blows the per-query read budget), merged client-side.
export default function TeamChartsPage() {
  return (
    <DashboardLayout>
      <ErrorBoundary name="TeamCharts" level="inline">
        <TeamChartsContent />
      </ErrorBoundary>
    </DashboardLayout>
  );
}

type MemberInfo = { _id: string; name?: string; github_username?: string; github_avatar_url?: string };

const LINE_COLORS = ["#268bd2", "#859900", "#cb4b16", "#6c71c4", "#2aa198", "#b58900", "#d33682", "#dc322f"];

const zeros24 = () => new Array(24).fill(0);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

function TeamChartsContent() {
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const myTeams = useQueryNoThrow(api.teams.getUserTeams, {}).data;
  const defaultTeamId = activeTeamId || currentUser?.active_team_id || currentUser?.team_id;
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const teamId = (pickedTeam ?? (defaultTeamId ? String(defaultTeamId) : null)) as Id<"teams"> | null;

  const tzOffset = useMemo(() => new Date().getTimezoneOffset(), []);
  const members = useQuery(api.users.getTeamMembers, teamId ? { team_id: teamId } : "skip") as
    | MemberInfo[]
    | undefined;

  // One punchcard subscription per member; useQueries keeps hook order legal
  // as the member set changes.
  const punchQueries = useMemo(() => {
    const q: Record<string, { query: typeof api.users.getUserActivityPunchcard; args: any }> = {};
    if (teamId && members) {
      for (const m of members) {
        q[String(m._id)] = {
          query: api.users.getUserActivityPunchcard,
          args: { user_id: m._id as Id<"users">, team_id: teamId, days: 371, tz_offset_minutes: tzOffset },
        };
      }
    }
    return q;
  }, [teamId, members, tzOffset]);
  const punchResults = useQueries(punchQueries) as Record<string, PunchRow[] | undefined>;

  const allLoaded =
    !!members && members.length > 0 && members.every((m) => punchResults[String(m._id)] !== undefined);

  // Merge member punchcards cell-by-cell into the team-wide grid.
  const rows = useMemo(() => {
    if (!allLoaded || !members) return undefined;
    const merged: Record<string, { hours: number[]; msgs: number[]; sends: number[]; sessions: number[]; day_sessions: number }> = {};
    for (const m of members) {
      for (const r of punchResults[String(m._id)] ?? []) {
        const acc = (merged[r.date] ||= { hours: zeros24(), msgs: zeros24(), sends: zeros24(), sessions: zeros24(), day_sessions: 0 });
        for (let h = 0; h < 24; h++) {
          acc.hours[h] += r.hours[h];
          acc.msgs[h] += r.msgs[h];
          acc.sends[h] += r.sends?.[h] ?? 0;
          acc.sessions[h] += r.sessions[h];
        }
        acc.day_sessions += r.day_sessions;
      }
    }
    return Object.entries(merged)
      .map(([date, r]) => ({
        date,
        hours: r.hours.map((h) => Math.round(h * 100) / 100),
        msgs: r.msgs,
        sends: r.sends,
        sessions: r.sessions,
        day_sessions: r.day_sessions,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)) as PunchRow[];
  }, [allLoaded, members, punchResults]);

  // One window for every section below the heatmap, set from the header.
  const [range, setRange] = useState<DayRange>({ preset: "1m" });
  const days = useMemo(() => fillDays(rows), [rows]);

  const heatmapData = useMemo(() => {
    if (!rows) return null;
    return rows.map((r) => ({
      date: r.date,
      hours: Math.round(sum(r.hours) * 100) / 100,
      sessions: r.day_sessions,
    }));
  }, [rows]);

  if (!currentUser) return <div className="w-full py-10" />;
  if (!teamId) {
    return <div className="text-[12px] text-sol-base01/40 text-center py-16">Join a team to see team charts.</div>;
  }

  return (
    <div className="w-full py-4 px-4">
      <div className="flex items-center gap-2 pb-3">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-sol-text leading-tight">Team activity</div>
          <div className="text-[10px] text-sol-base01/40 mt-0.5">
            Everyone&apos;s hours, messages, and typed sends in one view
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {rows && (
            <div className="scale-[0.82] origin-right">
              <RangeControl value={range} onChange={setRange} days={days} />
            </div>
          )}
          {myTeams && myTeams.length > 1 && (
            <select
              value={String(teamId)}
              onChange={(e) => setPickedTeam(e.target.value)}
              className="text-[10px] text-sol-base01/60 bg-transparent border border-sol-border/25 rounded px-1.5 py-0.5 hover:border-sol-border/50 focus:outline-none cursor-pointer max-w-[150px]"
            >
              {myTeams.filter((t): t is NonNullable<typeof t> => t !== null).map((t) => (
                <option key={String(t._id)} value={String(t._id)}>{t.name}</option>
              ))}
            </select>
          )}
          <Link href="/team" className="text-[10px] text-sol-cyan/60 hover:text-sol-cyan transition-colors">
            Members
          </Link>
        </div>
      </div>

      {rows === undefined && (
        <div className="mt-3 space-y-3 animate-pulse motion-reduce:animate-none">
          <div className="h-16 bg-sol-bg-alt/40 rounded-lg" />
          <div className="h-44 bg-sol-bg-alt/40 rounded-lg" />
          <div className="h-40 bg-sol-bg-alt/25 rounded-lg" />
        </div>
      )}
      {rows && (
        <>
          {heatmapData && heatmapData.length > 0 && <ActivityHeatmap data={heatmapData} />}
          <TimelineCharts punchcard={rows} range={range} onRangeChange={setRange} />
          <MemberBreakdown
            members={members ?? []}
            punchResults={punchResults}
            dayKeys={sliceRange(days, range).map((d) => d.date)}
            range={range}
            onRangeChange={setRange}
          />
        </>
      )}
      {members && members.length === 0 && (
        <div className="text-[12px] text-sol-base01/40 text-center py-16">No members in this team.</div>
      )}
    </div>
  );
}

/* Per-member breakdown: totals over the page's window + a comparative line chart. */
function MemberBreakdown({
  members,
  punchResults,
  dayKeys,
  range,
  onRangeChange,
}: {
  members: MemberInfo[];
  punchResults: Record<string, PunchRow[] | undefined>;
  /** The window's day slots, shared so every member's line is comparable point-for-point. */
  dayKeys: string[];
  range: DayRange;
  onRangeChange: (r: DayRange) => void;
}) {
  const [metric, setMetric] = useState<TimelineMetric>("hours");
  const from = dayKeys[0] ?? "";
  const to = dayKeys[dayKeys.length - 1] ?? "";

  const metricOf = (r: PunchRow) =>
    metric === "hours" ? sum(r.hours) : metric === "msgs" ? sum(r.msgs) : sum(r.sends ?? []);

  const ranked = useMemo(() => {
    return members
      .map((m) => {
        const recent = (punchResults[String(m._id)] ?? []).filter((r) => r.date >= from && r.date <= to);
        return {
          ...m,
          display_name: m.name || m.github_username || "Unnamed",
          rows: recent,
          month_hours: Math.round(recent.reduce((s, r) => s + sum(r.hours), 0) * 10) / 10,
          month_msgs: recent.reduce((s, r) => s + sum(r.msgs), 0),
          month_sends: recent.reduce((s, r) => s + sum(r.sends ?? []), 0),
          month_sessions: recent.reduce((s, r) => s + r.day_sessions, 0),
        };
      })
      .sort((a, b) => b.month_hours - a.month_hours);
  }, [members, punchResults, from, to]);

  const series = useMemo(() => {
    return ranked.slice(0, LINE_COLORS.length).map((m, i) => {
      const byDate = new Map(m.rows.map((r) => [r.date, r]));
      return {
        name: m.display_name,
        color: LINE_COLORS[i % LINE_COLORS.length],
        values: dayKeys.map((k) => {
          const r = byDate.get(k);
          return r ? metricOf(r) : 0;
        }),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, dayKeys, metric]);

  if (members.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] font-bold text-sol-base01/30 uppercase tracking-widest">Members · {rangeLabel(range)}</span>
        <div className="flex-1 h-px bg-sol-border/10" />
        <div className="scale-[0.82] origin-right">
          <SegmentedToggle
            value={metric}
            onChange={(k) => setMetric(k as TimelineMetric)}
            items={[
              { key: "hours", icon: Clock, label: "Hours", title: "Agent hours" },
              { key: "msgs", icon: MessageSquare, label: "Messages", title: "All session messages" },
              { key: "sends", icon: Send, label: "Typed", title: "Messages the person typed" },
            ]}
          />
        </div>
      </div>

      <MemberLines
        series={series}
        dayKeys={dayKeys}
        fmt={metric === "hours" ? (v) => `${v.toFixed(1)}h` : (v) => fmtK(Math.round(v))}
        onPickRange={(a, b) => onRangeChange({ from: a, to: b })}
      />

      <div className="mt-3 space-y-px">
        {ranked.map((m, i) => (
          <Link
            key={String(m._id)}
            href={m.github_username ? `/team/${m.github_username}` : "#"}
            className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-sol-bg-alt/50 transition-colors group"
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: i < LINE_COLORS.length ? LINE_COLORS[i % LINE_COLORS.length] : "transparent" }}
            />
            <AvatarImg
              src={m.github_avatar_url}
              alt=""
              className="w-5 h-5 rounded-full ring-1 ring-sol-border/20"
              fallback={
                <div className="w-5 h-5 rounded-full bg-sol-base02 flex items-center justify-center text-[9px] font-semibold text-sol-text/80">
                  {m.display_name[0]?.toUpperCase() || "?"}
                </div>
              }
            />
            <span className="text-[12px] text-sol-text/80 truncate flex-1 group-hover:text-sol-text transition-colors">{m.display_name}</span>
            <span className="text-[10px] tabular-nums text-sol-green/50 w-14 text-right">{m.month_hours}h</span>
            <span className="text-[10px] tabular-nums text-sol-cyan/50 w-16 text-right">{fmtK(m.month_msgs)} msgs</span>
            <span className="text-[10px] tabular-nums text-sol-blue/60 w-16 text-right">{fmtK(m.month_sends)} typed</span>
            <span className="text-[10px] tabular-nums text-sol-base01/30 w-14 text-right">{m.month_sessions} sess</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* Overlaid per-member lines over the window's shared day axis. Hover lists
 * every member's value for that day; drag across days to zoom into them. */
function MemberLines({
  series,
  dayKeys,
  fmt,
  onPickRange,
}: {
  series: { name: string; color: string; values: number[] }[];
  dayKeys: string[];
  fmt: (v: number) => string;
  onPickRange: (from: string, to: string) => void;
}) {
  const { ref, width } = useContainerWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverAt, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const brush = useDayBrush((a, b) => { setHover(null); onPickRange(dayKeys[a], dayKeys[b]); });
  const h = 140, padL = 32, padR = 8, padT = 6, padB = 20;
  const n = dayKeys.length;
  const max = useMemo(() => {
    let m = 1;
    for (const s of series) for (const v of s.values) if (v > m) m = v;
    return m;
  }, [series]);
  const plotH = h - padT - padB;
  const toX = (i: number) => padL + (i / Math.max(n - 1, 1)) * (width - padL - padR);
  const toY = (v: number) => padT + (1 - v / max) * plotH;
  const xLabels = useMemo(() => timeAxisLabels(dayKeys, toX), [dayKeys, width]);
  if (n === 0) return null;
  // A hover left over from a wider window (before a zoom) points past this one.
  const hover = hoverAt && hoverAt.idx < n ? hoverAt : null;
  const idxAt = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return null;
    const i = Math.round(((clientX - r.left - padL) / Math.max(width - padL - padR, 1)) * (n - 1));
    return { i: Math.max(0, Math.min(n - 1, i)), r };
  };
  const rows = hover
    ? series.map((s) => ({ ...s, v: s.values[hover.idx] })).filter((s) => s.v > 0).sort((a, b) => b.v - a.v)
    : [];
  return (
    <div ref={ref} className="w-full relative">
      <svg
        ref={svgRef}
        width={width}
        height={h}
        className="block cursor-crosshair select-none"
        onMouseLeave={() => { setHover(null); brush.cancel(); }}
        onMouseDown={(e) => { const at = idxAt(e.clientX); if (at) { e.preventDefault(); brush.start(at.i); } }}
        onMouseUp={brush.end}
        onMouseMove={(e) => {
          const at = idxAt(e.clientX);
          if (!at) return;
          setHover({ idx: at.i, x: at.r.left + toX(at.i), y: at.r.top + padT });
          brush.move(at.i);
        }}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={width - padR} y1={toY(max * f)} y2={toY(max * f)} stroke="currentColor" className="text-sol-border/8" strokeWidth={0.5} strokeDasharray={f === 0 ? "none" : "2,3"} />
            <text x={padL - 4} y={toY(max * f) + 3} textAnchor="end" className="fill-sol-base01/25" style={{ fontSize: 8 }}>{fmt(max * f)}</text>
          </g>
        ))}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={h - 5} textAnchor="start" className="fill-sol-base01/25" style={{ fontSize: 9 }}>{l.label}</text>
        ))}
        <BrushRect drag={brush.drag} toX={toX} top={padT} height={plotH} />
        {series.map((s) => (
          <path
            key={s.name}
            d={s.values.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            opacity={0.75}
          />
        ))}
        {hover && (
          <>
            <line x1={toX(hover.idx)} x2={toX(hover.idx)} y1={padT} y2={padT + plotH} stroke="currentColor" className="text-sol-text/30" strokeWidth={0.5} strokeDasharray="3,3" />
            {rows.map((s) => <circle key={s.name} cx={toX(hover.idx)} cy={toY(s.v)} r={2.5} fill={s.color} />)}
          </>
        )}
      </svg>
      {hover && (
        <HoverTip x={hover.x} y={hover.y}>
          <div className="font-semibold mb-0.5">{fmtDayLabel(dayKeys[hover.idx])}</div>
          {rows.length === 0 && <div className="opacity-60">No activity</div>}
          {rows.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5 tabular-nums">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
              <span className="flex-1">{s.name}</span>
              <span className="pl-3">{fmt(s.v)}</span>
            </div>
          ))}
        </HoverTip>
      )}
    </div>
  );
}
