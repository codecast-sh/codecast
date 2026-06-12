"use client";
import { useMemo, useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore } from "../../../store/inboxStore";
import Link from "next/link";
import { FileText, CheckCircle2, Circle, CircleDot, CircleDotDashed, XCircle, User, Activity, CornerUpRight } from "lucide-react";
import { SegmentedToggle } from "../../../components/SegmentedToggle";
import { getLabelColor } from "../../../lib/labelColors";
import { cleanContent } from "../../../lib/conversationProcessor";
import { ActivityHeatmap } from "../../../components/ActivityHeatmap";
import { TimelineCharts, fmtK, fmtDayLabel, type PunchRow } from "../../../components/ActivityCharts";
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

function ProfileSkeleton() {
  return (
    <div className="w-full py-4 px-4 animate-pulse motion-reduce:animate-none">
      <div className="flex items-center gap-3 pb-3 mb-0">
        <div className="w-9 h-9 rounded-full bg-sol-base02" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-28 bg-sol-base02 rounded" />
          <div className="h-2 w-44 bg-sol-base02/60 rounded" />
        </div>
      </div>
      <div className="h-16 bg-sol-base02/40 rounded-lg mb-2" />
      <div className="flex gap-0 border-b border-sol-border/10 mb-2">
        {["w-10", "w-8", "w-12"].map((w, i) => (
          <div key={i} className={`${w} h-3 bg-sol-base02/50 rounded mx-3 my-2`} />
        ))}
      </div>
      <div className="space-y-3 mt-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-20 bg-sol-base02/40 rounded" />
            <div className="h-14 bg-sol-base02/30 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

const NOISE_VERBS = new Set(["started", "finished"]);

function UserProfileContent() {
  const params = useParams();
  const username = params.username as string;
  const router = useRouter();
  const [view, setView] = useState<"feed" | "timeline" | "work">("feed");
  // Default feed shows only what the user explicitly typed (their messages).
  // The "All" segment re-adds automated activity: tasks, docs, commits, PRs.
  const [showAll, setShowAll] = useState(false);

  const profileUser = useQuery(api.users.getUserByUsername, { username });
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || currentUser?.active_team_id || currentUser?.team_id;

  // Own profile shows everything across teams; a teammate's profile is scoped
  // to the current workspace so you see their contribution to *this* team.
  const isOwn = !!currentUser?._id && currentUser._id === profileUser?._id;
  const scopeTeamId = isOwn ? undefined : teamId;

  const aa = useQuery(
    api.users.getUserAbstractActivity,
    profileUser?._id ? { user_id: profileUser._id, team_id: scopeTeamId } : "skip"
  );

  // Stable args identity so usePaginatedQuery doesn't reset to page 1 on every
  // re-render (incl. unrelated HMR churn) and lose accumulated "load more" pages.
  const feedArgs = useMemo(
    () => (profileUser?._id ? { user_id: profileUser._id, team_id: scopeTeamId } : "skip"),
    [profileUser?._id, scopeTeamId]
  );
  const { results: feed, status: feedStatus, loadMore } = usePaginatedQuery(
    api.users.getUserProfileFeed,
    feedArgs,
    { initialNumItems: 15 }
  );

  const userTasks = useQuery(
    api.users.getUserTasks,
    profileUser?._id ? { user_id: profileUser._id, limit: 30 } : "skip"
  );
  const userDocs = useQuery(
    api.users.getUserDocs,
    profileUser?._id ? { user_id: profileUser._id, limit: 20 } : "skip"
  );

  const filtered = useMemo(() => {
    return feed
      .filter((i: any) => {
        if (NOISE_VERBS.has(i.verb)) return false;
        if (!showAll && i.type !== "message") return false; // default: only user-typed messages
        return true;
      })
      .sort((a: any, b: any) => b.timestamp - a.timestamp); // keep newest-first across loaded pages
  }, [feed, showAll]);
  const days = useMemo(() => groupByDay(filtered), [filtered]);
  const groupedDays = useMemo(() => days.map(([date, items]) => [date, groupItemsBySessions(items)] as const), [days]);

  const heatmap = useQuery(
    api.users.getUserActivityHeatmap,
    profileUser?._id ? { user_id: profileUser._id, days: 371, team_id: scopeTeamId } : "skip"
  );

  const heatmapData = useMemo(() => heatmap || null, [heatmap]);

  if (!currentUser || profileUser === undefined) return <ProfileSkeleton />;
  if (profileUser === null) return (
    <div className="flex flex-col items-center justify-center gap-2 min-h-[40vh] text-center px-4">
      <p className="text-sol-base01 text-sm">User not found.</p>
      <p className="text-sol-base01/45 text-xs max-w-xs">This profile link may be out of date — the account was likely renamed or removed.</p>
      <div className="flex items-center gap-3 mt-1 text-xs">
        {currentUser?.github_username || currentUser?._id ? (
          <Link href={`/team/${currentUser.github_username || currentUser._id}`} className="text-sol-cyan/70 hover:text-sol-cyan underline underline-offset-2">Your profile</Link>
        ) : null}
        <Link href="/inbox" className="text-sol-base01/60 hover:text-sol-text underline underline-offset-2">Back to inbox</Link>
      </div>
    </div>
  );

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
        {view === "feed" && (
          <div className="ml-auto pb-1 scale-[0.82] origin-bottom-right">
            <SegmentedToggle
              value={showAll ? "all" : "mine"}
              onChange={(k) => setShowAll(k === "all")}
              items={[
                { key: "mine", icon: User, label: "Typed", title: "Only messages you typed" },
                { key: "all", icon: Activity, label: "All", title: "All activity — tasks, docs, commits, PRs" },
              ]}
            />
          </div>
        )}
      </div>

      {/* Feed view */}
      {view === "feed" && (
        <div className="mt-1">
          {groupedDays.map(([date, groups]) => (
            <div key={date}>
              <DayHeader date={date} count={groups.reduce((n: number, g: SessionGroupData | EventItem) => n + (g.type === "session" ? g.messages.length : 1), 0)} items={groups.flatMap((g: SessionGroupData | EventItem) => g.type === "session" ? g.messages : [g.item])} />
              <div className="space-y-2">
                {groups.map((group: SessionGroupData | EventItem, gi: number) =>
                  group.type === "session" ? (
                    <SessionGroup key={`sg-${group.sessionId}-${gi}`} group={group} router={router} avatarUrl={profileUser.github_avatar_url} displayName={profileUser.name} />
                  ) : (
                    <EventRow key={`ev-${group.item.timestamp}-${gi}`} item={group.item} router={router} />
                  )
                )}
              </div>
            </div>
          ))}
          {feedStatus !== "LoadingFirstPage" && filtered.length === 0 && (
            <div className="text-[11px] text-sol-base01/30 text-center py-16">
              {!showAll
                ? <>No messages typed yet. <button onClick={() => setShowAll(true)} className="text-sol-cyan/50 hover:text-sol-cyan underline underline-offset-2 transition-colors">Show all activity</button></>
                : (isOwn ? "No recent activity" : "No recent activity in this workspace")}
            </div>
          )}
          {feedStatus === "LoadingFirstPage" && <div className="text-[11px] text-sol-base01/20 text-center py-16 animate-pulse">Loading...</div>}
          {(feedStatus === "CanLoadMore" || feedStatus === "LoadingMore") && (
            <div className="flex justify-center py-5">
              <button
                onClick={() => loadMore(20)}
                disabled={feedStatus === "LoadingMore"}
                className="text-[10.5px] font-medium tracking-wide text-sol-base01/50 hover:text-sol-text border border-sol-border/30 hover:border-sol-border/60 rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
              >
                {feedStatus === "LoadingMore" ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
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

      {/* Timeline chart view — hour-granular punchcard + per-day series */}
      {view === "timeline" && <TimelineSection userId={profileUser._id} teamId={scopeTeamId} />}
    </div>
  );
}

function Sep() {
  return <span className="text-sol-base01/15 select-none">&middot;</span>;
}

/* ─── Timeline tab ─── */
// Chart components live in components/ActivityCharts (shared with the public
// profile). This wrapper just runs the authed punchcard query.
function TimelineSection({ userId, teamId }: { userId: Id<"users">; teamId: Id<"teams"> | undefined }) {
  // Hour-of-day cells only mean something in the viewer's local clock, so the
  // server buckets with our tz offset (one offset for the whole range).
  const tzOffset = useMemo(() => new Date().getTimezoneOffset(), []);
  const punchcard = useQuery(api.users.getUserActivityPunchcard, {
    user_id: userId,
    team_id: teamId,
    days: 371,
    tz_offset_minutes: tzOffset,
  }) as PunchRow[] | undefined;
  return <TimelineCharts punchcard={punchcard} />;
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

const TASK_STATUS_DOTS: Record<string, string> = {
  done: "bg-sol-green", in_progress: "bg-sol-yellow", open: "bg-sol-blue",
  in_review: "bg-sol-violet", blocked: "bg-sol-red", backlog: "bg-sol-base01/30",
};

const VERB_ICONS: Record<string, string> = {
  created: "text-sol-yellow/50", completed: "text-sol-green/60", wrote: "text-sol-cyan/50",
  edited: "text-sol-cyan/40", updated: "text-sol-yellow/30", pushed: "text-sol-green/40",
  "opened PR": "text-sol-violet/50", "merged PR": "text-sol-green/50",
};

function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

type SessionGroupData = {
  type: "session";
  sessionId: string;
  title: string;
  meta: Record<string, any>;
  messages: any[];
};

type EventItem = {
  type: "event";
  item: any;
};

function groupItemsBySessions(items: any[]): (SessionGroupData | EventItem)[] {
  const result: (SessionGroupData | EventItem)[] = [];
  let currentSession: SessionGroupData | null = null;

  for (const item of items) {
    if (item.type === "message" && item.entity_id) {
      if (currentSession && currentSession.sessionId === item.entity_id) {
        currentSession.messages.push(item);
      } else {
        currentSession = {
          type: "session",
          sessionId: item.entity_id,
          title: item.entity_title || "Untitled",
          meta: item.meta || {},
          messages: [item],
        };
        result.push(currentSession);
      }
    } else {
      currentSession = null;
      result.push({ type: "event", item });
    }
  }
  return result;
}

function TimeGutter({ ts, top }: { ts?: number; top?: boolean }) {
  return (
    <span className={`text-[9px] text-sol-base01/20 tabular-nums w-10 text-right flex-shrink-0 select-none pr-2 ${top ? "self-start mt-[3px]" : "self-center"}`}>
      {ts ? fmtTime(ts) : ""}
    </span>
  );
}

function oneLineOf(preview?: string): string | null {
  if (!preview) return null;
  const c = cleanContent(preview);
  if (!c) return null;
  return c.replace(/\s+/g, " ").trim() || null;
}

// A small round avatar for the feed — the profile owner, making it explicit that
// the messages below are theirs (i.e. "you sent this").
function FeedAvatar({ url, name }: { url?: string; name?: string }) {
  return url ? (
    <img src={url} alt="" className="w-[18px] h-[18px] rounded-full flex-shrink-0 mt-px ring-1 ring-sol-border/25 object-cover" />
  ) : (
    <div className="w-[18px] h-[18px] rounded-full flex-shrink-0 mt-px bg-sol-base02 ring-1 ring-sol-border/25 flex items-center justify-center text-[9px] font-semibold text-sol-text/80">
      {(name || "?")[0]?.toUpperCase()}
    </div>
  );
}

// One conversation's worth of messages YOU sent, framed as "[you] ↱ to <session>"
// so authorship (the avatar) and destination (the session) are both unmistakable.
function SessionGroup({ group, router, avatarUrl, displayName }: { group: SessionGroupData; router: ReturnType<typeof useRouter>; avatarUrl?: string; displayName?: string }) {
  const href = `/conversation/${group.sessionId}`;
  const meta = group.meta;
  const project = meta.project && meta.project !== "unknown" ? meta.project : null;
  const isLive = meta.status === "active" && group.messages.length > 0 && (Date.now() - group.messages[0].timestamp < 3600000);
  const displayTitle = group.title === "Untitled" && project ? project : group.title;
  const accent = getLabelColor(group.sessionId);
  const lastTs = group.messages[0]?.timestamp;

  return (
    <div className="flex gap-2.5">
      <FeedAvatar url={avatarUrl} name={displayName} />
      <div className="min-w-0 flex-1">
        {/* destination header: "↱ to <session>" */}
        <div className="flex items-center gap-1.5 pr-2 cursor-pointer group/h" onClick={() => router.push(href)}>
          <CornerUpRight className="w-3 h-3 flex-shrink-0 text-sol-base01/35" />
          <span className="text-[9px] font-semibold uppercase tracking-wider text-sol-base01/35 flex-shrink-0">to</span>
          <span className={`text-[11px] font-semibold truncate ${accent.text} opacity-90 group-hover/h:opacity-100 transition-opacity`}>{displayTitle}</span>
          {isLive && <span className="text-[8px] font-bold text-sol-green uppercase tracking-widest flex-shrink-0">live</span>}
          <span className="flex-1" />
          {project && project !== displayTitle && <span className="text-[9px] font-mono text-sol-base01/30 flex-shrink-0">{project}</span>}
          {lastTs && <span className="text-[9px] text-sol-base01/30 tabular-nums flex-shrink-0">{fmtTime(lastTs)}</span>}
        </div>
        {/* the message(s) you sent — accent spine ties them to the conversation */}
        <div className={`mt-1 space-y-1.5 border-l-2 pl-3 ${accent.border}`}>
          {group.messages.map((msg, i) => (
            <MessageRow key={`${msg.timestamp}-${i}`} item={msg} router={router} />
          ))}
        </div>
      </div>
    </div>
  );
}

// One message you sent, rendered in full.
function MessageRow({ item, router }: { item: any; router: ReturnType<typeof useRouter> }) {
  const oneLine = useMemo(() => oneLineOf(item.preview), [item.preview]);
  if (!oneLine) return null;

  return (
    <div className="rounded hover:bg-sol-blue/[0.05] -mx-1.5 px-1.5 py-[2px] cursor-pointer transition-colors" onClick={() => router.push(`/conversation/${item.entity_id}`)}>
      <span className="text-[13px] text-sol-text/95 whitespace-normal break-words leading-relaxed">{oneLine}</span>
    </div>
  );
}

function EventRow({ item, router }: { item: any; router: ReturnType<typeof useRouter> }) {
  const href = item.entity_type === "task" ? `/tasks/${item.entity_id}`
    : item.entity_type === "doc" ? `/docs/${item.entity_id}` : null;

  const verbColor = VERB_ICONS[item.verb] || "text-sol-base01/25";
  const isTask = item.entity_type === "task";
  const isDoc = item.entity_type === "doc";

  return (
    <div
      className={`flex items-baseline pr-2 rounded hover:bg-sol-bg-alt/30 transition-colors ${href ? "cursor-pointer" : ""} group`}
      onClick={href ? () => router.push(href) : undefined}
    >
      <TimeGutter ts={item.timestamp} />
      <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
        {isTask && (
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 self-center ${TASK_STATUS_DOTS[item.meta?.status] || "bg-sol-base01/20"}`} />
        )}
        {isDoc && <FileText className="w-3 h-3 flex-shrink-0 self-center text-sol-cyan/30" />}
        <span className={`text-[9.5px] font-medium flex-shrink-0 ${verbColor}`}>{item.verb}</span>
        <span className="text-[11.5px] text-sol-text/65 truncate flex-1 group-hover:text-sol-text/90 transition-colors leading-tight">
          {isTask && item.entity_short_id && <span className="font-mono text-[9px] text-sol-base01/25 mr-1">{item.entity_short_id}</span>}
          {item.entity_title || item.verb}
        </span>
        {item.meta?.priority === "high" && item.meta?.status !== "done" && <span className="w-1.5 h-1.5 rounded-full bg-sol-red/40 flex-shrink-0 self-center" />}
      </div>
    </div>
  );
}

function DayHeader({ date, items }: { date: string; count?: number; items: any[] }) {
  const { totalHours, sessions, messages } = useMemo(() => {
    const seen = new Set<string>();
    let h = 0, msgs = 0;
    for (const item of items) {
      if (item.type !== "message") continue;
      msgs++;
      if (!item.meta?.duration_ms || !item.entity_id || seen.has(item.entity_id)) continue;
      seen.add(item.entity_id);
      h += Math.min(item.meta.duration_ms, 8 * 3600000) / 3600000;
    }
    return { totalHours: h, sessions: seen.size, messages: msgs };
  }, [items]);

  return (
    <div className="flex items-baseline gap-2 mt-5 mb-1.5 first:mt-1">
      <span className="text-[10px] font-bold text-sol-text/50 uppercase tracking-wider select-none">{fmtDayLabel(date)}</span>
      <div className="flex-1 h-px bg-sol-border/10 translate-y-[-1px]" />
      <div className="flex items-baseline gap-2 text-[9px] tabular-nums text-sol-base01/30 select-none">
        {sessions > 0 && <span>{sessions} session{sessions !== 1 ? "s" : ""}</span>}
        {messages > 0 && <span>{messages} msg{messages !== 1 ? "s" : ""}</span>}
        {totalHours > 0 && <span className="text-sol-green/35">{totalHours.toFixed(1)}h</span>}
      </div>
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
