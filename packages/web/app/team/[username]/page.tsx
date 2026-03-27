"use client";
import { useMemo, useState } from "react";
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
    profileUser?._id ? { user_id: profileUser._id, team_id: teamId, limit: 80 } : "skip"
  );

  const filtered = useMemo(() => feed?.filter((i: any) => !NOISE_VERBS.has(i.verb)) ?? null, [feed]);
  const days = useMemo(() => filtered ? groupByDay(filtered) : [], [filtered]);

  const timelineSessions = useMemo(() => {
    if (!filtered) return [];
    return filtered
      .filter((i: any) => i.type === "message" && i.meta?.duration_ms)
      .map((i: any) => ({
        id: i.entity_id,
        title: i.entity_title,
        project: i.meta?.project,
        start: i.timestamp - (i.meta.duration_ms || 0),
        end: i.timestamp,
        duration: i.meta.duration_ms,
        messageCount: i.meta?.message_count || 0,
        isLive: i.meta?.status === "active" && (Date.now() - i.timestamp < 3600000),
      }));
  }, [filtered]);

  if (!currentUser) return null;
  if (profileUser === null) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-sol-base01">User not found.</p></div>;
  if (!profileUser) return null;

  const dd = profileUser.daemon_last_seen ? Date.now() - profileUser.daemon_last_seen : Infinity;
  const online = dd < 60000;
  const recent = dd < 300000;

  return (
    <div className="max-w-3xl mx-auto py-4 px-2">
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

      {/* Activity heatmap -- isolated so errors don't crash the feed */}
      {profileUser?._id && (
        <ErrorBoundary name="ActivityHeatmap" level="inline">
          <ActivityHeatmapLoader userId={profileUser._id} teamId={teamId} />
        </ErrorBoundary>
      )}

      {/* View toggle */}
      <div className="flex items-center gap-0 mt-2 mb-1 border-b border-sol-border/10">
        <button
          onClick={() => setView("feed")}
          className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors border-b-2 ${view === "feed" ? "text-sol-text border-sol-yellow/60" : "text-sol-base01/35 border-transparent hover:text-sol-base01/60"}`}
        >
          Feed
        </button>
        <button
          onClick={() => setView("timeline")}
          className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors border-b-2 ${view === "timeline" ? "text-sol-text border-sol-cyan/60" : "text-sol-base01/35 border-transparent hover:text-sol-base01/60"}`}
        >
          Timeline
        </button>
      </div>

      {/* Feed view */}
      {view === "feed" && (
        <div className="mt-1">
          {days.map(([date, items]) => (
            <div key={date}>
              <DayHeader date={date} count={items.length} />
              <div>
                {items.map((item: any, i: number) => (
                  <FeedRow key={`${item.type}-${item.timestamp}-${i}`} item={item} router={router} />
                ))}
              </div>
            </div>
          ))}
          {filtered && filtered.length === 0 && (
            <div className="text-[11px] text-sol-base01/30 text-center py-16">No recent activity</div>
          )}
          {!filtered && (
            <div className="text-[11px] text-sol-base01/20 text-center py-16 animate-pulse">Loading...</div>
          )}
        </div>
      )}

      {/* Timeline view */}
      {view === "timeline" && (
        <TimelineView sessions={timelineSessions} router={router} />
      )}
    </div>
  );
}

function Sep() {
  return <span className="text-sol-base01/15 select-none">&middot;</span>;
}

/* ─── Activity Heatmap (GitHub-style) ─── */

const HEAT_COLORS = [
  "bg-sol-base02/30",
  "bg-sol-green/20",
  "bg-sol-green/40",
  "bg-sol-green/60",
  "bg-sol-green/80",
];

function ActivityHeatmapLoader({ userId, teamId }: { userId: Id<"users">; teamId?: Id<"teams"> }) {
  const heatmap = useQuery(
    api.users.getUserActivityHeatmap,
    { user_id: userId, team_id: teamId, days: 90 }
  );
  if (!heatmap) return null;
  return <ActivityHeatmap data={heatmap} />;
}

function ActivityHeatmap({ data }: { data: any[] }) {
  const { grid, maxHours, totalHours, totalSessions } = useMemo(() => {
    const map: Record<string, { hours: number; sessions: number }> = {};
    let max = 0;
    let totalH = 0;
    let totalS = 0;
    for (const d of data) {
      map[d.date] = { hours: d.hours, sessions: d.sessions };
      if (d.hours > max) max = d.hours;
      totalH += d.hours;
      totalS += d.sessions;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weeks = 26;
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - (weeks * 7 - 1) - startDay.getDay());

    const rows: Array<Array<{ date: string; hours: number; sessions: number }>> = [];
    for (let w = 0; w < weeks; w++) {
      const week: typeof rows[0] = [];
      for (let d = 0; d < 7; d++) {
        const cur = new Date(startDay);
        cur.setDate(cur.getDate() + w * 7 + d);
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        const entry = map[key] || { hours: 0, sessions: 0 };
        week.push({ date: key, ...entry });
      }
      rows.push(week);
    }
    return { grid: rows, maxHours: max || 1, totalHours: totalH, totalSessions: totalS };
  }, [data]);

  const getColor = (hours: number) => {
    if (hours === 0) return HEAT_COLORS[0];
    const ratio = hours / maxHours;
    if (ratio < 0.25) return HEAT_COLORS[1];
    if (ratio < 0.5) return HEAT_COLORS[2];
    if (ratio < 0.75) return HEAT_COLORS[3];
    return HEAT_COLORS[4];
  };

  const months = useMemo(() => {
    const labels: { label: string; col: number }[] = [];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let lastMonth = -1;
    for (let w = 0; w < grid.length; w++) {
      const d = new Date(grid[w][0].date + "T12:00:00");
      if (d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth();
        labels.push({ label: monthNames[d.getMonth()], col: w });
      }
    }
    return labels;
  }, [grid]);

  return (
    <div className="mt-2 mb-1">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[9px] text-sol-base01/25 uppercase tracking-widest font-bold">Agent Activity</span>
        <span className="text-[9px] text-sol-base01/30 tabular-nums">
          {totalHours.toFixed(0)}h across {totalSessions} sessions
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col gap-0">
          {/* Month labels */}
          <div className="flex gap-[2px] mb-0.5 ml-0">
            {months.map((m, i) => (
              <span
                key={i}
                className="text-[8px] text-sol-base01/25 select-none"
                style={{ position: "absolute", left: `${m.col * 11}px` }}
              >
                {m.label}
              </span>
            ))}
          </div>
          {/* Heatmap grid -- 7 rows (days of week) x N weeks */}
          <div className="relative mt-3">
            {[0, 1, 2, 3, 4, 5, 6].map(dow => (
              <div key={dow} className="flex gap-[2px] mb-[2px]">
                {grid.map((week, w) => {
                  const cell = week[dow];
                  return (
                    <div
                      key={w}
                      className={`w-[9px] h-[9px] rounded-[2px] ${getColor(cell.hours)} transition-colors`}
                      title={`${cell.date}: ${cell.hours.toFixed(1)}h, ${cell.sessions} sessions`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* Legend */}
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[8px] text-sol-base01/20">Less</span>
            {HEAT_COLORS.map((c, i) => (
              <div key={i} className={`w-[8px] h-[8px] rounded-[1px] ${c}`} />
            ))}
            <span className="text-[8px] text-sol-base01/20">More</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Timeline View ─── */

function TimelineView({ sessions, router }: { sessions: any[]; router: ReturnType<typeof useRouter> }) {
  const dayGroups = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const s of sessions) {
      const d = new Date(s.end);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      (groups[key] ||= []).push(s);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [sessions]);

  if (sessions.length === 0) {
    return <div className="text-[11px] text-sol-base01/30 text-center py-16">No session data</div>;
  }

  return (
    <div className="mt-2 space-y-3">
      {dayGroups.map(([date, daySessions]) => (
        <div key={date}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[9px] font-bold text-sol-base01/30 uppercase tracking-widest select-none">{fmtDayLabel(date)}</span>
            <div className="flex-1 h-px bg-sol-border/10" />
            <span className="text-[9px] text-sol-base01/20 tabular-nums">
              {(daySessions.reduce((a: number, s: any) => a + (s.duration || 0), 0) / 3600000).toFixed(1)}h
            </span>
          </div>
          <TimelineDayStrip sessions={daySessions} date={date} router={router} />
        </div>
      ))}
    </div>
  );
}

function TimelineDayStrip({ sessions, date, router }: { sessions: any[]; date: string; router: ReturnType<typeof useRouter> }) {
  const dayStart = new Date(date + "T00:00:00").getTime();
  const dayEnd = dayStart + 86400000;
  const now = Date.now();
  const effectiveEnd = Math.min(dayEnd, now);
  const range = effectiveEnd - dayStart;

  return (
    <div className="relative h-8 bg-sol-base02/15 rounded overflow-hidden">
      {/* Hour markers */}
      {[0, 3, 6, 9, 12, 15, 18, 21].map(h => {
        const pct = (h * 3600000) / range * 100;
        if (pct > 100) return null;
        return (
          <div key={h} className="absolute top-0 bottom-0 border-l border-sol-border/8" style={{ left: `${pct}%` }}>
            <span className="absolute top-0.5 left-0.5 text-[7px] text-sol-base01/15 select-none">
              {h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
            </span>
          </div>
        );
      })}
      {/* Session bars */}
      {sessions.map((s, i) => {
        const left = Math.max(0, ((s.start - dayStart) / range) * 100);
        const width = Math.max(0.5, ((s.duration) / range) * 100);
        const durMins = Math.round(s.duration / 60000);
        const durStr = durMins < 60 ? `${durMins}m` : `${(durMins / 60).toFixed(1)}h`;
        return (
          <div
            key={i}
            className={`absolute top-1 bottom-1 rounded-sm cursor-pointer transition-opacity hover:opacity-100 ${s.isLive ? "bg-sol-cyan/60 animate-pulse" : "bg-sol-green/40"} opacity-80`}
            style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, minWidth: "3px" }}
            title={`${s.title}\n${s.project || ""} ${durStr} ${s.messageCount}m`}
            onClick={() => s.id && router.push(`/conversation/${s.id}`)}
          />
        );
      })}
    </div>
  );
}

/* ─── Feed Components ─── */

const VERB_COLORS: Record<string, string> = {
  messaged:    "text-sol-blue/80",
  created:     "text-sol-yellow/75",
  updated:     "text-sol-yellow/50",
  completed:   "text-sol-green/85",
  wrote:       "text-sol-cyan/65",
  edited:      "text-sol-cyan/45",
  pushed:      "text-sol-green/60",
  "opened PR": "text-sol-violet/70",
  "merged PR": "text-sol-green/70",
};

const VERB_ACCENTS: Record<string, string> = {
  messaged:    "border-l-sol-blue/40",
  created:     "border-l-sol-yellow/40",
  updated:     "border-l-sol-yellow/20",
  completed:   "border-l-sol-green/50",
  wrote:       "border-l-sol-cyan/35",
  edited:      "border-l-sol-cyan/20",
  pushed:      "border-l-sol-green/30",
  "opened PR": "border-l-sol-violet/40",
  "merged PR": "border-l-sol-green/40",
};

function FeedRow({ item, router }: { item: any; router: ReturnType<typeof useRouter> }) {
  const href = item.entity_type === "session" ? `/conversation/${item.entity_id}`
    : item.entity_type === "task" ? `/tasks/${item.entity_id}`
    : item.entity_type === "doc" ? `/docs/${item.entity_id}`
    : null;

  const verbColor = VERB_COLORS[item.verb] || "text-sol-base01/50";
  const accent = VERB_ACCENTS[item.verb] || "border-l-sol-base01/15";
  const isLive = item.meta?.status === "active" && (Date.now() - item.timestamp < 3600000);
  const branch = item.meta?.branch && !NOISE_BRANCHES.has(item.meta.branch) ? item.meta.branch : null;
  const durMs = item.meta?.duration_ms;
  const durStr = durMs ? (durMs < 3600000 ? `${Math.round(durMs / 60000)}m` : `${(durMs / 3600000).toFixed(1)}h`) : null;

  return (
    <div
      className={`border-l-2 ${accent} hover:bg-sol-bg-alt/50 transition-colors ${href ? "cursor-pointer" : ""} group py-[2px] pl-2 pr-1`}
      onClick={href ? () => router.push(href) : undefined}
    >
      {/* Main line: time | verb | entity */}
      <div className="flex items-baseline gap-0">
        <span className="w-[42px] flex-shrink-0 text-[10px] tabular-nums text-sol-base01/22 text-right pr-2 select-none leading-none">
          {fmtTime(item.timestamp)}
        </span>
        <span className="min-w-0 flex-1 text-[11.5px] leading-[1.5] overflow-hidden whitespace-nowrap text-ellipsis">
          {item.verb === "completed" && <span className="text-sol-green/60 mr-0.5">&#10003;</span>}
          <span className={`font-semibold ${verbColor}`}>{item.verb}</span>
          {item.count && item.count > 5 && (
            <span className="text-sol-base01/25 text-[9px] ml-0.5">{item.count}x</span>
          )}
          {" "}
          {item.entity_type === "doc" && item.meta?.doc_type && item.meta.doc_type !== "note" && (
            <span className="inline-block text-[8.5px] font-semibold uppercase tracking-wider text-sol-cyan/40 bg-sol-cyan/8 px-1 py-px rounded mr-1 align-baseline">{item.meta.doc_type}</span>
          )}
          {item.entity_type === "task" && item.entity_short_id && (
            <span className="text-sol-base01/30 font-mono text-[9.5px] mr-0.5">{item.entity_short_id}</span>
          )}
          {item.entity_title && (
            <span className="text-sol-text/75 font-medium group-hover:text-sol-text transition-colors group-hover:underline decoration-sol-base01/20 underline-offset-2">
              {item.entity_title}
            </span>
          )}
          {isLive && item.type === "message" && (
            <span className="inline-flex items-center gap-0.5 ml-1.5 align-baseline">
              <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse inline-block" />
              <span className="text-sol-green/70 text-[8px] font-bold tracking-wider">LIVE</span>
            </span>
          )}
          {item.meta?.project && item.meta.project !== "unknown" && (
            <span className="text-sol-base01/20 text-[9.5px] font-mono ml-1.5">{item.meta.project}</span>
          )}
          {durStr && <span className="text-sol-base01/18 text-[9px] ml-1">{durStr}</span>}
          {branch && <span className="text-sol-base01/22 font-mono text-[9px] ml-1">{branch}</span>}
          {item.meta?.message_count && item.meta.message_count > 20 && (
            <span className="text-sol-base01/18 text-[9px] tabular-nums ml-1">{item.meta.message_count}m</span>
          )}
          {item.meta?.files_changed && (
            <span className="text-sol-base01/20 text-[9px] ml-1">{item.meta.files_changed}f</span>
          )}
          {item.type !== "message" && item.preview && !item.entity_title && (
            <span className="text-sol-text/50 ml-0.5">{item.preview}</span>
          )}
          {item.meta?.priority === "high" && (
            <span className="inline-block w-1 h-1 rounded-full bg-sol-red/50 ml-1 align-middle" />
          )}
          {item.meta?.priority === "urgent" && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-sol-red/70 ml-1 align-middle" />
          )}
        </span>
      </div>

      {/* Second line: full message text for messages */}
      {item.type === "message" && item.preview && (
        <div className="pl-[42px] mt-px">
          <p className="text-[10.5px] text-sol-base01/35 leading-snug line-clamp-2 italic">
            {item.preview}
          </p>
        </div>
      )}
    </div>
  );
}

function DayHeader({ date, count }: { date: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-1 first:mt-1">
      <span className="text-[9px] font-bold text-sol-base01/30 uppercase tracking-widest select-none">
        {fmtDayLabel(date)}
      </span>
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
