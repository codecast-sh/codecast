import { useMemo } from "react";
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
    profileUser?._id ? { user_id: profileUser._id, team_id: teamId, limit: 50 } : "skip"
  );

  const filtered = useMemo(() => feed?.filter((i: any) => !NOISE_VERBS.has(i.verb)) ?? null, [feed]);
  const days = useMemo(() => filtered ? groupByDay(filtered) : [], [filtered]);

  if (!currentUser) return null;
  if (profileUser === null) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-sol-base01">User not found.</p></div>;
  if (!profileUser) return null;

  const dd = profileUser.daemon_last_seen ? Date.now() - profileUser.daemon_last_seen : Infinity;
  const online = dd < 60000;
  const recent = dd < 300000;

  return (
    <div className="max-w-2xl mx-auto py-4 px-2">
      {/* Profile header -- compact, one visual block */}
      <div className="flex items-center gap-3 pb-3 mb-1 border-b border-sol-border/15">
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

      {/* Feed */}
      <div className="mt-1">
        {days.map(([date, items]) => (
          <div key={date}>
            <DayHeader date={date} count={items.length} />
            <div className="space-y-0">
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
    </div>
  );
}

function Sep() {
  return <span className="text-sol-base01/15 select-none">&middot;</span>;
}

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

  return (
    <div
      className={`flex items-baseline gap-0 py-[3px] pl-2 pr-1 border-l-2 ${accent} hover:bg-sol-bg-alt/50 transition-colors ${href ? "cursor-pointer" : ""} group`}
      onClick={href ? () => router.push(href) : undefined}
    >
      {/* Time column -- fixed width, right-aligned */}
      <span className="w-[42px] flex-shrink-0 text-[10px] tabular-nums text-sol-base01/20 text-right pr-2 select-none leading-none">
        {fmtTime(item.timestamp)}
      </span>

      {/* Content -- single line, overflow hidden */}
      <span className="min-w-0 flex-1 text-[11.5px] leading-[1.5] overflow-hidden whitespace-nowrap text-ellipsis">
        {/* Verb */}
        {item.verb === "completed" && <span className="text-sol-green/60 mr-0.5">&#10003;</span>}
        <span className={`font-semibold ${verbColor}`}>{item.verb}</span>

        {/* Count badge for grouped messages */}
        {item.count && item.count > 5 && (
          <span className="text-sol-base01/25 text-[9px] ml-0.5">{item.count}x</span>
        )}

        {" "}

        {/* Doc type prefix */}
        {item.entity_type === "doc" && item.meta?.doc_type && item.meta.doc_type !== "note" && (
          <span className="inline-block text-[8.5px] font-semibold uppercase tracking-wider text-sol-cyan/40 bg-sol-cyan/8 px-1 py-px rounded mr-1 align-baseline">{item.meta.doc_type}</span>
        )}

        {/* Task short ID */}
        {item.entity_type === "task" && item.entity_short_id && (
          <span className="text-sol-base01/25 font-mono text-[9.5px] mr-0.5">{item.entity_short_id}</span>
        )}

        {/* Entity title -- the main content */}
        {item.entity_title && (
          <span className="text-sol-text/70 font-medium group-hover:text-sol-text transition-colors group-hover:underline decoration-sol-base01/15 underline-offset-2">
            {item.entity_title}
          </span>
        )}

        {/* LIVE badge */}
        {isLive && item.type === "message" && (
          <span className="inline-flex items-center gap-0.5 ml-1.5 align-baseline">
            <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse inline-block" />
            <span className="text-sol-green/70 text-[8px] font-bold tracking-wider">LIVE</span>
          </span>
        )}

        {/* Project chip */}
        {item.meta?.project && item.meta.project !== "unknown" && (
          <span className="text-sol-base01/18 text-[9.5px] font-mono ml-1.5">{item.meta.project}</span>
        )}

        {/* Git branch (filtered) */}
        {branch && (
          <span className="text-sol-base01/22 font-mono text-[9px] ml-1">{branch}</span>
        )}

        {/* Message count for sessions */}
        {item.meta?.message_count && item.meta.message_count > 20 && (
          <span className="text-sol-base01/18 text-[9px] tabular-nums ml-1">{item.meta.message_count}m</span>
        )}

        {/* Files changed for git events */}
        {item.meta?.files_changed && (
          <span className="text-sol-base01/18 text-[9px] ml-1">{item.meta.files_changed}f</span>
        )}

        {/* Message preview */}
        {item.type === "message" && item.preview && (
          <span className="text-sol-base01/28 ml-1.5 italic text-[10.5px]">{item.preview}</span>
        )}

        {/* Git/PR event preview */}
        {item.type !== "message" && item.preview && !item.entity_title && (
          <span className="text-sol-text/50 ml-0.5">{item.preview}</span>
        )}

        {/* Task priority dot */}
        {item.meta?.priority === "high" && (
          <span className="inline-block w-1 h-1 rounded-full bg-sol-red/50 ml-1 align-middle" />
        )}
        {item.meta?.priority === "urgent" && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-sol-red/70 ml-1 align-middle" />
        )}
      </span>
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
