import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore } from "../../../store/inboxStore";
import {
  MessageSquare,
  GitCommit,
  GitPullRequest,
  FileText,
  CheckCircle2,
  Circle,
  CircleDot,
  Play,
} from "lucide-react";
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

function UserProfileContent() {
  const params = useParams();
  const username = params.username as string;

  const profileUser = useQuery(api.users.getUserByUsername, { username });
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || currentUser?.active_team_id || currentUser?.team_id;

  const abstractActivity = useQuery(
    api.users.getUserAbstractActivity,
    profileUser?._id ? { user_id: profileUser._id, team_id: teamId } : "skip"
  );

  const feed = useQuery(
    (api.users as any).getUserProfileFeed,
    profileUser?._id ? { user_id: profileUser._id, team_id: teamId, limit: 40 } : "skip"
  );

  if (!currentUser) return null;

  if (profileUser === null) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-sol-base01">User not found.</p>
      </div>
    );
  }

  if (!profileUser) return null;

  const daemonDiff = profileUser.daemon_last_seen ? Date.now() - profileUser.daemon_last_seen : Infinity;
  const isOnline = daemonDiff < 60000;
  const isRecent = daemonDiff < 300000;
  const firstName = profileUser.name?.split(" ")[0] || profileUser.github_username || "User";

  return (
    <div className="max-w-3xl mx-auto py-6 space-y-5">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-shrink-0">
            {profileUser.github_avatar_url ? (
              <img
                src={profileUser.github_avatar_url}
                alt={profileUser.name || ""}
                className="w-12 h-12 rounded-full"
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-sol-base02 flex items-center justify-center text-sol-text text-lg font-semibold">
                {profileUser.name?.[0]?.toUpperCase() || "?"}
              </div>
            )}
            <div
              className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-sol-bg ${
                isOnline ? "bg-sol-green" : isRecent ? "bg-sol-yellow" : "bg-sol-base01"
              }`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base font-bold text-sol-text">
                {profileUser.name || "Unnamed"}
              </h1>
              {profileUser.role && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sol-cyan/15 text-sol-cyan font-medium">
                  {profileUser.role}
                </span>
              )}
              <span className={`text-[11px] ${isOnline ? "text-sol-green" : "text-sol-base01"}`}>
                {isOnline ? "Online" : isRecent ? "Recently active" : "Offline"}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-sol-base01 mt-0.5">
              {profileUser.github_username && (
                <a
                  href={`https://github.com/${profileUser.github_username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sol-cyan/70 hover:text-sol-cyan"
                >
                  @{profileUser.github_username}
                </a>
              )}
              {profileUser.email && <span>{profileUser.email}</span>}
            </div>
          </div>
        </div>

        {abstractActivity && (
          <div className="flex items-center gap-3 text-[11px] text-sol-base01 flex-wrap">
            {abstractActivity.is_currently_active && (
              <span className="flex items-center gap-1 text-sol-cyan font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan animate-pulse" />
                Working on {abstractActivity.current_project || "a session"}
              </span>
            )}
            <span><b className="text-sol-text font-semibold">{abstractActivity.week_sessions}</b> sessions</span>
            <span><b className="text-sol-text font-semibold">{abstractActivity.week_messages}</b> messages</span>
            {abstractActivity.team_activity && abstractActivity.team_activity.week_commits > 0 && (
              <span><b className="text-sol-text font-semibold">{abstractActivity.team_activity.week_commits}</b> commits</span>
            )}
            {abstractActivity.team_activity && abstractActivity.team_activity.week_prs > 0 && (
              <span><b className="text-sol-text font-semibold">{abstractActivity.team_activity.week_prs}</b> PRs</span>
            )}
            {abstractActivity.activity_streak > 0 && (
              <span className="px-1.5 py-0.5 bg-sol-orange/15 text-sol-orange rounded-full font-medium">
                {abstractActivity.activity_streak}d streak
              </span>
            )}
            <span className="text-sol-base01/50">this week</span>
          </div>
        )}
      </div>

      {feed && feed.length > 0 && (
        <div className="space-y-0.5">
          {groupByDay(feed).map(([date, items]) => (
            <div key={date}>
              <div className="text-[10px] font-medium text-sol-base01/60 uppercase tracking-wider py-2 sticky top-0 bg-sol-bg z-10">
                {formatDayLabel(date)}
              </div>
              <div className="space-y-px">
                {items.map((item: any, i: number) => (
                  <FeedItem key={`${item.type}-${item.timestamp}-${i}`} item={item} firstName={firstName} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {feed && feed.length === 0 && (
        <div className="text-sm text-sol-base01 text-center py-8">No recent activity</div>
      )}
    </div>
  );
}

const FEED_ICONS: Record<string, { icon: typeof MessageSquare; color: string }> = {
  message: { icon: MessageSquare, color: "text-sol-blue" },
  task: { icon: CircleDot, color: "text-sol-yellow" },
  doc: { icon: FileText, color: "text-sol-cyan" },
  commit_pushed: { icon: GitCommit, color: "text-sol-green" },
  pr_created: { icon: GitPullRequest, color: "text-sol-violet" },
  pr_merged: { icon: GitPullRequest, color: "text-sol-green" },
  session_started: { icon: Play, color: "text-sol-blue" },
  session_completed: { icon: CheckCircle2, color: "text-sol-green" },
};

function FeedItem({ item, firstName }: { item: any; firstName: string }) {
  const router = useRouter();
  const config = FEED_ICONS[item.type] || { icon: Circle, color: "text-sol-base01" };
  const Icon = config.icon;

  const entityHref = item.entity_type === "session" ? `/conversation/${item.entity_id}`
    : item.entity_type === "task" ? `/tasks/${item.entity_id}`
    : item.entity_type === "doc" ? `/docs/${item.entity_id}`
    : null;

  return (
    <div
      className="flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-sol-bg-alt/40 transition-colors group"
      role={entityHref ? "button" : undefined}
      onClick={entityHref ? () => router.push(entityHref) : undefined}
      style={entityHref ? { cursor: "pointer" } : undefined}
    >
      <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${config.color}`} />
      <div className="flex-1 min-w-0 text-[12px] leading-relaxed">
        <span className="text-sol-base01">
          <span className="text-sol-text font-medium">{firstName}</span>
          {" "}{item.title}
        </span>
        {item.entity_title && (
          <EntityChip
            type={item.entity_type}
            title={item.entity_title}
            shortId={item.entity_short_id}
            meta={item.meta}
          />
        )}
        {item.preview && (
          <span className="text-sol-base01/60 block truncate mt-0.5">{item.preview}</span>
        )}
      </div>
      <span className="text-[10px] text-sol-base01/40 flex-shrink-0 mt-0.5 tabular-nums">
        {formatTime(item.timestamp)}
      </span>
    </div>
  );
}

function EntityChip({ type, title, shortId, meta }: { type: string; title: string; shortId?: string; meta?: any }) {
  const colors: Record<string, string> = {
    session: "bg-sol-blue/10 text-sol-blue border-sol-blue/20",
    task: "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/20",
    doc: "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20",
  };
  const c = colors[type] || "bg-sol-base02/50 text-sol-base01 border-sol-border/20";

  return (
    <span className={`inline-flex items-center gap-1 ml-1 px-1.5 py-0 rounded border text-[11px] font-medium ${c}`}>
      {shortId && <span className="opacity-60">{shortId}</span>}
      <span className="truncate max-w-[200px]">{title}</span>
      {meta?.project && <span className="opacity-40 font-mono text-[9px]">{meta.project}</span>}
    </span>
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

function formatDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = today.getTime() - date.getTime();
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) {
    const h = d.getHours();
    const m = d.getMinutes();
    return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "a" : "p"}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
