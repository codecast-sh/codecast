"use client";
import { useMemo, useState } from "react";
import { useQuery, useQueries } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { Clock, MessageSquare, Send } from "lucide-react";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { AvatarImg } from "../../../lib/avatarCache";
import { useInboxStore } from "../../../store/inboxStore";
import { ActivityHeatmap } from "../../../components/ActivityHeatmap";
import { TimelineCharts, fmtK, type PunchRow, type TimelineMetric } from "../../../components/ActivityCharts";
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
  const myTeams = useQuery(api.teams.getUserTeams);
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
          <TimelineCharts punchcard={rows} />
          <MemberBreakdown members={members ?? []} punchResults={punchResults} />
        </>
      )}
      {members && members.length === 0 && (
        <div className="text-[12px] text-sol-base01/40 text-center py-16">No members in this team.</div>
      )}
    </div>
  );
}

/* Per-member breakdown: 30-day totals + a comparative line chart. */
function MemberBreakdown({
  members,
  punchResults,
}: {
  members: MemberInfo[];
  punchResults: Record<string, PunchRow[] | undefined>;
}) {
  const [metric, setMetric] = useState<TimelineMetric>("hours");

  const cutoffKey = useMemo(() => {
    const d = new Date(Date.now() - 30 * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const metricOf = (r: PunchRow) =>
    metric === "hours" ? sum(r.hours) : metric === "msgs" ? sum(r.msgs) : sum(r.sends ?? []);

  const ranked = useMemo(() => {
    return members
      .map((m) => {
        const recent = (punchResults[String(m._id)] ?? []).filter((r) => r.date >= cutoffKey);
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
  }, [members, punchResults, cutoffKey]);

  // 30 shared day slots so every member's line is comparable point-for-point.
  const dayKeys = useMemo(() => {
    const keys: string[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    return keys;
  }, []);

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
        <span className="text-[9px] font-bold text-sol-base01/30 uppercase tracking-widest">Members · last 30 days</span>
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

      <MemberLines series={series} />

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

/* Overlaid per-member lines over the shared 30-day axis. */
function MemberLines({ series }: { series: { name: string; color: string; values: number[] }[] }) {
  const w = 720, h = 120, padL = 4, padR = 4, padT = 6, padB = 6;
  const n = series[0]?.values.length ?? 0;
  const max = useMemo(() => {
    let m = 1;
    for (const s of series) for (const v of s.values) if (v > m) m = v;
    return m;
  }, [series]);
  if (n === 0) return null;
  const toX = (i: number) => padL + (i / Math.max(n - 1, 1)) * (w - padL - padR);
  const toY = (v: number) => padT + (1 - v / max) * (h - padT - padB);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full block" preserveAspectRatio="none" style={{ height: 120 }}>
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
    </svg>
  );
}
