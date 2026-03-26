import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { Card } from "../../../components/ui/card";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  FileText,
} from "lucide-react";
import { getLabelColor } from "../../../lib/labelColors";

type VisibilityMode = "detailed" | "summary" | "minimal" | "hidden";

const STATUS_ICON: Record<string, any> = {
  backlog: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
};

const STATUS_COLOR: Record<string, string> = {
  backlog: "text-sol-text-dim",
  open: "text-sol-blue",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-sol-text-dim",
};

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  dropped: "Dropped",
};

const PRIORITY_ICON: Record<string, any> = {
  urgent: AlertTriangle,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
  none: Minus,
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "text-sol-red",
  high: "text-sol-orange",
  medium: "text-sol-text-muted",
  low: "text-sol-text-dim",
  none: "text-sol-text-dim",
};

const DOC_TYPE_COLOR: Record<string, { label: string; color: string; bg: string }> = {
  plan: { label: "Plan", color: "text-sol-blue", bg: "bg-sol-blue/10 border-sol-blue/30" },
  design: { label: "Design", color: "text-sol-violet", bg: "bg-sol-violet/10 border-sol-violet/30" },
  spec: { label: "Spec", color: "text-sol-cyan", bg: "bg-sol-cyan/10 border-sol-cyan/30" },
  investigation: { label: "Investigation", color: "text-sol-yellow", bg: "bg-sol-yellow/10 border-sol-yellow/30" },
  handoff: { label: "Handoff", color: "text-sol-orange", bg: "bg-sol-orange/10 border-sol-orange/30" },
  note: { label: "Note", color: "text-sol-text-muted", bg: "bg-sol-text-muted/10 border-sol-text-muted/30" },
};

export default function UserProfilePage() {
  return (
    <ErrorBoundary name="UserProfile" level="panel">
      <UserProfileContent />
    </ErrorBoundary>
  );
}

function UserProfileContent() {
  const params = useParams();
  const username = params.username as string;
  const [showTeammateView, setShowTeammateView] = useState(true);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const profileUser = useQuery(api.users.getUserByUsername, { username });
  const currentUser = useQuery(api.users.getCurrentUser);
  const userActivity = useQuery(
    api.users.getUserActivity,
    profileUser?._id ? { user_id: profileUser._id, limit: 10 } : "skip"
  );
  const userStats = useQuery(
    api.users.getUserStats,
    profileUser?._id ? { user_id: profileUser._id } : "skip"
  );
  const abstractActivity = useQuery(
    api.users.getUserAbstractActivity,
    profileUser?._id ? { user_id: profileUser._id } : "skip"
  );
  const userTasks = useQuery(
    (api.users as any).getUserTasks,
    profileUser?._id ? { user_id: profileUser._id, limit: 20 } : "skip"
  );
  const userDocs = useQuery(
    (api.users as any).getUserDocs,
    profileUser?._id ? { user_id: profileUser._id, limit: 20 } : "skip"
  );

  const isOwnProfile = currentUser?._id === profileUser?._id;
  const visibilityMode: VisibilityMode = profileUser?.activity_visibility || "detailed";

  const shouldShowAsTeammate = isOwnProfile && showTeammateView;

  const handleCopyLink = useCallback(() => {
    const url = `${window.location.origin}/team/${username}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    setShareMenuOpen(false);
  }, [username]);

  if (!currentUser) {
    return null;
  }

  if (!profileUser) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Card className="p-6 bg-sol-bg border-sol-border">
          <p className="text-sol-base1">User not found.</p>
        </Card>
      </div>
    );
  }

  const getRelativeTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    if (hours === 1) return "1 hour ago";
    if (hours < 24) return `${hours} hours ago`;
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };

  const getMemberStatus = (timestamp: number | undefined) => {
    if (!timestamp) return { status: "offline", text: "Offline" };
    const diff = Date.now() - timestamp;
    if (diff < 60000) return { status: "online", text: "Online" };
    if (diff < 300000) return { status: "recent", text: "Recently active" };
    return { status: "offline", text: "Offline" };
  };

  const daemonStatus = getMemberStatus(profileUser.daemon_last_seen);
  const activityHidden = profileUser.hide_activity || (shouldShowAsTeammate && visibilityMode === "hidden");

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <Link href="/team" className="text-sol-cyan hover:underline">
          &larr; Back to Team
        </Link>

        {isOwnProfile && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-sol-base01">Viewing as:</span>
              <button
                onClick={() => setShowTeammateView(!showTeammateView)}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                  showTeammateView
                    ? "bg-sol-cyan/20 text-sol-cyan"
                    : "bg-sol-base02 text-sol-base1 hover:bg-sol-base02/80"
                }`}
              >
                {showTeammateView ? "Teammate" : "Full"}
              </button>
            </div>

            <div className="relative">
              <button
                onClick={() => setShareMenuOpen(!shareMenuOpen)}
                className="px-3 py-1 rounded-full text-sm font-medium bg-sol-violet/20 text-sol-violet hover:bg-sol-violet/30 transition-colors"
              >
                Share
              </button>
              {shareMenuOpen && (
                <div className="absolute right-0 top-full mt-1 bg-sol-bg border border-sol-border rounded-lg shadow-lg p-2 z-10 min-w-[160px]">
                  <button
                    onClick={handleCopyLink}
                    className="w-full text-left px-3 py-2 text-sm text-sol-text hover:bg-sol-base02 rounded"
                  >
                    {copied ? "Copied!" : "Copy profile link"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {isOwnProfile && (
        <div className="mb-4 p-3 bg-sol-base02/50 border border-sol-border rounded-lg text-sm">
          <div className="flex items-center justify-between">
            <span className="text-sol-base1">
              {showTeammateView ? (
                <>
                  Showing what teammates see
                  {visibilityMode !== "detailed" && (
                    <span className="text-sol-yellow ml-1">
                      ({visibilityMode} mode)
                    </span>
                  )}
                </>
              ) : (
                "Showing your full activity (only visible to you)"
              )}
            </span>
            <Link
              href="/settings/sync"
              className="text-sol-cyan hover:underline text-xs"
            >
              Change visibility
            </Link>
          </div>
        </div>
      )}

      {/* Profile Header */}
      <Card className="p-6 bg-sol-bg border-sol-border mb-6">
        <div className="flex items-start gap-6">
          <div className="relative">
            {profileUser.github_avatar_url ? (
              <img
                src={profileUser.github_avatar_url}
                alt={profileUser.name || "User avatar"}
                className="w-24 h-24 rounded-full"
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-sol-base02 flex items-center justify-center text-sol-text text-3xl font-semibold">
                {profileUser.name?.[0]?.toUpperCase() ||
                  profileUser.email?.[0]?.toUpperCase() ||
                  "?"}
              </div>
            )}
            <div
              className={`absolute bottom-1 right-1 w-5 h-5 rounded-full border-4 border-sol-bg ${
                daemonStatus.status === "online"
                  ? "bg-sol-green"
                  : daemonStatus.status === "recent"
                  ? "bg-sol-yellow"
                  : "bg-sol-base01"
              }`}
            />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-sol-text mb-1">
              {profileUser.name || "Unnamed"}
            </h1>
            {profileUser.title && (
              <div className="text-lg text-sol-base1 mb-2">{profileUser.title}</div>
            )}
            {profileUser.bio && (
              <p className="text-sol-text mb-3">{profileUser.bio}</p>
            )}
            <div className="flex flex-wrap gap-4 text-sm text-sol-base1">
              {profileUser.email && <div>{profileUser.email}</div>}
              {profileUser.github_username && (
                <a
                  href={`https://github.com/${profileUser.github_username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sol-cyan hover:underline"
                >
                  @{profileUser.github_username}
                </a>
              )}
            </div>
            <div className="flex items-center gap-4 mt-3">
              {profileUser.status && (
                <span
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    profileUser.status === "available"
                      ? "bg-sol-green/20 text-sol-green"
                      : profileUser.status === "busy"
                      ? "bg-sol-red/20 text-sol-red"
                      : "bg-sol-yellow/20 text-sol-yellow"
                  }`}
                >
                  {profileUser.status}
                </span>
              )}
              {profileUser.role && (
                <span
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    profileUser.role === "admin"
                      ? "bg-sol-cyan/20 text-sol-cyan"
                      : "bg-sol-base02/20 text-sol-base1"
                  }`}
                >
                  {profileUser.role}
                </span>
              )}
              <span className="text-sm text-sol-base01">{daemonStatus.text}</span>
            </div>
          </div>
        </div>
      </Card>

      {activityHidden ? (
        <Card className="p-6 bg-sol-bg border-sol-border">
          <p className="text-sol-base1 text-center">
            {isOwnProfile && showTeammateView
              ? "Your activity is hidden from teammates. Only your profile info is visible."
              : "This user has hidden their activity."}
          </p>
          {isOwnProfile && showTeammateView && (
            <div className="text-center mt-3">
              <Link
                href="/settings/sync"
                className="text-sol-cyan hover:underline text-sm"
              >
                Change visibility settings
              </Link>
            </div>
          )}
        </Card>
      ) : (
        <>
          {/* Activity Overview */}
          {abstractActivity && (
            <Card className="p-6 bg-sol-bg border-sol-border mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-sol-text">Activity Overview</h2>
                {abstractActivity.activity_streak > 0 && (
                  <span className="px-2 py-1 bg-sol-orange/20 text-sol-orange text-xs rounded-full font-medium">
                    {abstractActivity.activity_streak} day streak
                  </span>
                )}
              </div>

              {abstractActivity.is_currently_active && (
                <div className="flex items-center gap-2 text-sol-green text-sm mb-4 p-2 bg-sol-green/10 rounded">
                  <span className="w-2 h-2 rounded-full bg-sol-green animate-pulse" />
                  {shouldShowAsTeammate && visibilityMode === "minimal"
                    ? "Currently active"
                    : `Currently working on ${abstractActivity.current_project || 'a session'}`}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="text-center">
                  <div className="text-xl font-bold text-sol-cyan">{abstractActivity.week_sessions}</div>
                  <div className="text-xs text-sol-base01">Sessions</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-bold text-sol-cyan">{abstractActivity.week_messages}</div>
                  <div className="text-xs text-sol-base01">Messages</div>
                </div>
              </div>
              <div className="text-xs text-sol-base01 text-center mt-1">This week</div>

              {abstractActivity.recent_projects.length > 0 && (
                <div className="pt-3 mt-3 border-t border-sol-border">
                  <div className="text-sm text-sol-base1 mb-2">Recent Projects</div>
                  <div className="space-y-2">
                    {abstractActivity.recent_projects.map((project: any) => (
                      <div key={project.name} className="flex items-center justify-between text-sm">
                        <span className="text-sol-text font-medium">{project.name}</span>
                        <span className="text-sol-base01 text-xs">
                          {project.sessions} sessions{!shouldShowAsTeammate || visibilityMode === "detailed" ? `, ${project.messages} msgs` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {abstractActivity.team_activity && (
                <div className="pt-3 mt-3 border-t border-sol-border">
                  <div className="text-sm text-sol-base1 mb-2">Git Activity</div>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div className="text-center p-2 bg-sol-base02/50 rounded">
                      <div className="font-bold text-sol-green">{abstractActivity.team_activity.week_commits}</div>
                      <div className="text-xs text-sol-base01">Commits</div>
                    </div>
                    <div className="text-center p-2 bg-sol-base02/50 rounded">
                      <div className="font-bold text-sol-violet">{abstractActivity.team_activity.week_prs}</div>
                      <div className="text-xs text-sol-base01">PRs</div>
                    </div>
                    <div className="text-center p-2 bg-sol-base02/50 rounded">
                      <div className="font-bold text-sol-cyan">{abstractActivity.team_activity.week_files_changed || 0}</div>
                      <div className="text-xs text-sol-base01">Files Changed</div>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Tasks Section */}
          {userTasks && userTasks.length > 0 && (
            <Card className="p-6 bg-sol-bg border-sol-border mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-sol-text">Tasks</h2>
                <span className="text-xs text-sol-base01">{userTasks.length} tasks</span>
              </div>
              <div className="border border-sol-border/20 rounded-lg divide-y divide-sol-border/10 overflow-hidden">
                {userTasks.map((task: any) => {
                  const StatusIcon = STATUS_ICON[task.status] || Circle;
                  const statusColor = STATUS_COLOR[task.status] || "text-sol-text-dim";
                  const PriorityIcon = PRIORITY_ICON[task.priority] || Minus;
                  const priorityColor = PRIORITY_COLOR[task.priority] || "text-sol-text-dim";
                  return (
                    <Link
                      key={task._id}
                      href={`/tasks/${task._id}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-sol-bg-alt/50 transition-colors"
                    >
                      <StatusIcon className={`w-4 h-4 flex-shrink-0 ${statusColor}`} />
                      <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0">
                        {task.short_id}
                      </span>
                      <span className="flex-1 text-sm text-sol-text truncate">
                        {task.title}
                      </span>
                      {task.labels && task.labels.length > 0 && (
                        <div className="flex gap-1 flex-shrink-0">
                          {task.labels.slice(0, 2).map((l: string) => {
                            const lc = getLabelColor(l);
                            return (
                              <span key={l} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${lc.bg} ${lc.border} ${lc.text}`}>
                                {l}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <span className={`text-[10px] px-1.5 py-0 rounded border border-current/20 ${statusColor}`}>
                        {STATUS_LABEL[task.status] || task.status}
                      </span>
                      <PriorityIcon className={`w-3.5 h-3.5 flex-shrink-0 ${priorityColor}`} />
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Docs Section */}
          {userDocs && userDocs.length > 0 && (
            <Card className="p-6 bg-sol-bg border-sol-border mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-sol-text">Docs</h2>
                <span className="text-xs text-sol-base01">{userDocs.length} docs</span>
              </div>
              <div className="border border-sol-border/20 rounded-lg divide-y divide-sol-border/10 overflow-hidden">
                {userDocs.map((doc: any) => {
                  const typeConfig = DOC_TYPE_COLOR[doc.doc_type] || DOC_TYPE_COLOR.note;
                  return (
                    <Link
                      key={doc._id}
                      href={`/docs/${doc._id}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-sol-bg-alt/50 transition-colors"
                    >
                      <FileText className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                      <span className="flex-1 text-sm text-sol-text truncate">
                        {doc.title || "Untitled"}
                      </span>
                      {doc.labels && doc.labels.length > 0 && (
                        <div className="flex gap-1 flex-shrink-0">
                          {doc.labels.slice(0, 2).map((l: string) => {
                            const lc = getLabelColor(l);
                            return (
                              <span key={l} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${lc.bg} ${lc.border} ${lc.text}`}>
                                {l}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-md border ${typeConfig.color} ${typeConfig.bg}`}>
                        {typeConfig.label}
                      </span>
                      <span className="text-xs text-sol-base01 whitespace-nowrap">
                        {getRelativeTime(doc.updated_at || doc.created_at)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Shared Sessions */}
          {userStats && userActivity && userActivity.length > 0 && (
            <Card className="p-6 bg-sol-bg border-sol-border mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-sol-text">Sessions</h2>
                <div className="flex items-center gap-4 text-xs text-sol-base01">
                  <span>{userStats.total_conversations} shared</span>
                  <span>{userStats.active_conversations} active</span>
                  <span>{userStats.total_messages} messages</span>
                </div>
              </div>
              <div className="space-y-3">
                {userActivity.map((conversation: any) => (
                  <Link
                    key={conversation._id}
                    href={`/conversation/${conversation._id}`}
                    className="block p-3 rounded-lg bg-sol-bg-alt hover:bg-sol-base02 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sol-text truncate">
                          {conversation.title || "Untitled Conversation"}
                        </div>
                        {conversation.subtitle && !(shouldShowAsTeammate && (visibilityMode === "minimal" || visibilityMode === "summary")) && (
                          <div className="text-sm text-sol-base1 line-clamp-3 whitespace-pre-line">
                            {conversation.subtitle}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-sol-base01 ml-4 whitespace-nowrap">
                        {getRelativeTime(conversation.updated_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-sol-base01">
                        {conversation.message_count} messages
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          conversation.status === "active"
                            ? "bg-sol-green/20 text-sol-green"
                            : "bg-sol-base02/20 text-sol-base1"
                        }`}
                      >
                        {conversation.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
