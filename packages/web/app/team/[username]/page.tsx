"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import Link from "next/link";
import { useParams } from "next/navigation";

export default function UserProfilePage() {
  const params = useParams();
  const username = params.username as string;

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

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-4">
        <Link href="/team" className="text-sol-cyan hover:underline">
          ← Back to Team
        </Link>
      </div>

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
              {profileUser.timezone && <div>🌍 {profileUser.timezone}</div>}
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

      {!profileUser.hide_activity && abstractActivity && (
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
              Currently working on {abstractActivity.current_project || 'a session'}
            </div>
          )}

          <div className="space-y-4">
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
            <div className="text-xs text-sol-base01 text-center -mt-2">This week</div>

            {abstractActivity.recent_projects.length > 0 && (
              <div className="pt-3 border-t border-sol-border">
                <div className="text-sm text-sol-base1 mb-2">Recent Projects</div>
                <div className="space-y-2">
                  {abstractActivity.recent_projects.map((project) => (
                    <div key={project.name} className="flex items-center justify-between text-sm">
                      <span className="text-sol-text font-medium">{project.name}</span>
                      <span className="text-sol-base01 text-xs">
                        {project.sessions} sessions, {project.messages} msgs
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {abstractActivity.recent_sessions && abstractActivity.recent_sessions.length > 0 && (
              <div className="pt-3 border-t border-sol-border">
                <div className="text-sm text-sol-base1 mb-2">Recent Sessions</div>
                <div className="space-y-3">
                  {abstractActivity.recent_sessions.map((session, i) => (
                    <div key={i} className="text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-sol-text font-medium truncate flex-1 mr-2">{session.title}</span>
                        <span className="text-sol-base01 text-xs whitespace-nowrap">
                          {session.message_count} msgs
                        </span>
                      </div>
                      {session.subtitle && (
                        <div className="text-xs text-sol-base01 mt-1 line-clamp-2 whitespace-pre-line">
                          {session.subtitle}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-xs text-sol-base01">
                        {session.project && <span className="font-mono">{session.project}</span>}
                        <span>{getRelativeTime(session.updated_at)}</span>
                        {session.status === "active" && (
                          <span className="px-1.5 py-0.5 bg-sol-green/20 text-sol-green rounded text-xs">active</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {abstractActivity.team_activity && (
              <div className="pt-3 border-t border-sol-border">
                <div className="text-sm text-sol-base1 mb-2">Git Activity</div>
                <div className="grid grid-cols-3 gap-3 text-sm mb-3">
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
                {abstractActivity.team_activity.recent_branches.length > 0 && (
                  <div className="mb-3">
                    <div className="text-xs text-sol-base01 mb-1">Active branches</div>
                    <div className="flex flex-wrap gap-1">
                      {abstractActivity.team_activity.recent_branches.map((branch) => (
                        <span
                          key={branch}
                          className="px-2 py-0.5 bg-sol-base02 text-sol-text text-xs rounded font-mono"
                        >
                          {branch}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {abstractActivity.recent_commits.length > 0 && (
              <div className="pt-3 border-t border-sol-border">
                <div className="text-sm text-sol-base1 mb-2">Recent Commits</div>
                <div className="space-y-2">
                  {abstractActivity.recent_commits.map((commit, i) => (
                    <div key={i} className="text-sm">
                      <div className="text-sol-text truncate">{commit.message}</div>
                      <div className="text-xs text-sol-base01 flex gap-2">
                        {commit.branch && <span className="font-mono">{commit.branch}</span>}
                        {commit.filesChanged && <span>{commit.filesChanged} files</span>}
                        <span>{getRelativeTime(commit.timestamp)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {abstractActivity.peak_hours.length > 0 && (
              <div className="pt-3 border-t border-sol-border">
                <div className="text-xs text-sol-base01 mb-1">Usually active around</div>
                <div className="text-sm text-sol-text">
                  {abstractActivity.peak_hours.map((h) => {
                    const period = h >= 12 ? 'PM' : 'AM';
                    const hour = h % 12 || 12;
                    return `${hour}${period}`;
                  }).join(', ')}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {userStats && userActivity && userActivity.length > 0 && (
        <Card className="p-6 bg-sol-bg border-sol-border mb-6">
          <h2 className="text-lg font-semibold text-sol-text mb-4">Shared Sessions</h2>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <div className="text-2xl font-bold text-sol-cyan">
                {userStats.total_conversations}
              </div>
              <div className="text-sm text-sol-base1">Shared</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-sol-cyan">
                {userStats.total_messages}
              </div>
              <div className="text-sm text-sol-base1">Messages</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-sol-cyan">
                {userStats.active_conversations}
              </div>
              <div className="text-sm text-sol-base1">Active</div>
            </div>
          </div>
          <div className="space-y-3">
            {userActivity.map((conversation) => (
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
                    {conversation.subtitle && (
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

      {profileUser.hide_activity && (
        <Card className="p-6 bg-sol-bg border-sol-border">
          <p className="text-sol-base1 text-center">
            This user has hidden their activity.
          </p>
        </Card>
      )}
    </div>
  );
}
