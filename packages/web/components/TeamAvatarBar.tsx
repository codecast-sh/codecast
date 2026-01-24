"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";

function getRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "offline";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function isOnline(lastSeen: number | undefined): boolean {
  if (!lastSeen) return false;
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  return lastSeen > fiveMinutesAgo;
}

export function TeamAvatarBar() {
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  if (!user?.team_id || !teamMembers || teamMembers.length === 0) {
    return null;
  }

  const sortedMembers = [...teamMembers].sort((a, b) => {
    const aOnline = isOnline(a.daemon_last_seen);
    const bOnline = isOnline(b.daemon_last_seen);
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return (b.daemon_last_seen || 0) - (a.daemon_last_seen || 0);
  });

  const handleMemberClick = (memberId: string) => {
    router.push(`/dashboard?filter=team&member=${memberId}`);
  };

  return (
    <div className="flex items-center gap-1 px-2">
      {sortedMembers.slice(0, 6).map((member) => {
        const online = isOnline(member.daemon_last_seen);
        const avatar = member.image || member.github_avatar_url;
        const initial = (member.name || member.email || "?").charAt(0).toUpperCase();
        const displayName = member.name || member.email?.split("@")[0] || "Unknown";
        const lastSeenText = online ? "Active now" : `Last seen ${getRelativeTime(member.daemon_last_seen)} ago`;
        return (
          <button
            key={member._id}
            onClick={() => handleMemberClick(member._id)}
            className="relative group"
            title={`${displayName} - ${lastSeenText}`}
          >
            <div className={`w-8 h-8 rounded-full overflow-hidden transition-all ${
              online ? "" : "opacity-50 hover:opacity-80"
            }`}>
              {avatar ? (
                <img
                  src={avatar}
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-sol-base02 flex items-center justify-center">
                  <span className="text-xs font-medium text-sol-text-muted">{initial}</span>
                </div>
              )}
            </div>
            {online && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-400 border-2 border-sol-bg rounded-full" />
            )}
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-sol-bg-alt border border-sol-border rounded text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
              <div className="font-medium text-sol-text">{displayName}</div>
              <div className={online ? "text-emerald-400" : "text-sol-text-muted"}>
                {lastSeenText}
              </div>
            </div>
          </button>
        );
      })}
      {teamMembers.length > 6 && (
        <button
          onClick={() => router.push("/dashboard?filter=team")}
          className="w-8 h-8 rounded-full bg-sol-base02 border-2 border-sol-border/50 flex items-center justify-center text-xs text-sol-text-muted hover:border-sol-border transition-colors"
          title={`${teamMembers.length - 6} more team members`}
        >
          +{teamMembers.length - 6}
        </button>
      )}
    </div>
  );
}
