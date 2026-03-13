"use client";

import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

interface TeamAvatarBarProps {
  teamId?: Id<"teams">;
}

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

export function TeamAvatarBar({ teamId: propTeamId }: TeamAvatarBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const memberFilter = searchParams.get("member");
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const effectiveTeamId = propTeamId ?? activeTeamId;
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    effectiveTeamId ? { team_id: effectiveTeamId } : "skip"
  );

  if (!effectiveTeamId || !teamMembers || teamMembers.length === 0) {
    return null;
  }

  const sortedMembers = [...teamMembers]
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => {
      const aOnline = isOnline(a.daemon_last_seen);
      const bOnline = isOnline(b.daemon_last_seen);
      if (aOnline && !bOnline) return -1;
      if (!aOnline && bOnline) return 1;
      if (aOnline && bOnline) {
        return (a.name || a.email || "").localeCompare(b.name || b.email || "");
      }
      return (b.daemon_last_seen || 0) - (a.daemon_last_seen || 0);
    });

  const handleMemberClick = (memberId: string) => {
    if (memberFilter === memberId) {
      // Toggle off if already selected
      const params = new URLSearchParams(searchParams.toString());
      params.delete("member");
      router.push(`/dashboard?${params.toString()}`);
    } else {
      router.push(`/dashboard?filter=team&member=${memberId}`);
    }
  };

  const handleClearFilter = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("member");
    router.push(`/dashboard?${params.toString()}`);
  };

  const selectedMember = memberFilter ? sortedMembers.find(m => m._id === memberFilter) : null;

  return (
    <div className="flex items-center gap-1 px-2">
      {sortedMembers.slice(0, 6).map((member) => {
        const online = isOnline(member.daemon_last_seen);
        const avatar = member.image || member.github_avatar_url;
        const initial = (member.name || member.email || "?").charAt(0).toUpperCase();
        const displayName = member.name || member.email?.split("@")[0] || "Unknown";
        const lastSeenText = online ? "Active now" : `Last seen ${getRelativeTime(member.daemon_last_seen)} ago`;
        const sessionTitle = member.recent_session_title;
        const sessionMessages = member.recent_session_messages;
        const isSelected = memberFilter === member._id;
        return (
          <button
            key={member._id}
            onClick={() => handleMemberClick(member._id)}
            className="relative group"
            title={`${displayName} - ${lastSeenText}`}
          >
            <div className={`w-8 h-8 rounded-full overflow-hidden transition-all ${
              isSelected
                ? "ring-2 ring-sol-cyan ring-offset-1 ring-offset-sol-bg"
                : online ? "" : "opacity-50 hover:opacity-80"
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
            {online && !isSelected && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-400 border-2 border-sol-bg rounded-full" />
            )}
            <div className="absolute top-full right-0 mt-2 px-2.5 py-1.5 bg-sol-bg-alt border border-sol-border rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg max-w-[320px]">
              <div className="font-medium text-sol-text whitespace-nowrap">{displayName}</div>
              <div className={`whitespace-nowrap ${online ? "text-emerald-400" : "text-sol-text-muted"}`}>
                {lastSeenText}
              </div>
              {sessionTitle && (
                <div className="text-sol-text-muted mt-0.5 truncate" title={sessionTitle}>
                  {sessionTitle}{sessionMessages ? ` (${sessionMessages})` : ""}
                </div>
              )}
              {member.recent_session_last_message && (
                <div className="text-sol-cyan mt-0.5 truncate" title={member.recent_session_last_message}>
                  {member.recent_session_last_message}
                </div>
              )}
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
      {selectedMember && (
        <button
          onClick={handleClearFilter}
          className="flex items-center gap-1.5 px-2 py-1 ml-1 text-xs bg-sol-cyan/20 text-sol-cyan border border-sol-cyan/40 rounded-full hover:bg-sol-cyan/30 transition-colors"
          title="Clear filter"
        >
          <span className="max-w-[80px] truncate">{selectedMember.name || selectedMember.email?.split("@")[0]}</span>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
