"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useMemo } from "react";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

type ActivityEvent = {
  _id: Id<"team_activity_events">;
  event_type: "session_started" | "session_completed" | "commit_pushed" | "member_joined" | "member_left" | "pr_created" | "pr_merged";
  title: string;
  description?: string;
  timestamp: number;
  related_conversation_id?: Id<"conversations">;
  related_commit_sha?: string;
  related_pr_id?: Id<"pull_requests">;
  metadata?: {
    duration_ms?: number;
    message_count?: number;
    git_branch?: string;
    files_changed?: number;
    insertions?: number;
    deletions?: number;
  };
  actor: {
    _id: Id<"users">;
    name?: string;
    email?: string;
  } | null;
};

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes === 1) return "1 minute ago";
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "yesterday";

  const date = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getEventIcon(eventType: string) {
  switch (eventType) {
    case "session_started":
    case "session_completed":
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
        </svg>
      );
    case "commit_pushed":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
        </svg>
      );
    case "member_joined":
    case "member_left":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      );
    case "pr_created":
    case "pr_merged":
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      );
    default:
      return (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
  }
}

function getEventColor(eventType: string) {
  switch (eventType) {
    case "session_started":
    case "session_completed":
      return "bg-sol-yellow text-sol-bg";
    case "commit_pushed":
      return "bg-sol-violet/60 text-white";
    case "member_joined":
      return "bg-sol-green/60 text-white";
    case "member_left":
      return "bg-sol-red/60 text-white";
    case "pr_created":
    case "pr_merged":
      return "bg-sol-blue/60 text-white";
    default:
      return "bg-sol-bg-alt text-sol-text";
  }
}

function ActivityEventCard({ event }: { event: ActivityEvent }) {
  const actorName = event.actor?.name || event.actor?.email || "Unknown";
  const eventColor = getEventColor(event.event_type);
  const content = (
    <div className="relative bg-sol-bg-alt/40 border border-sol-border/30 rounded-xl p-4 hover:border-sol-yellow/40 transition-all duration-200 backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <div className={`flex-shrink-0 w-8 h-8 rounded ${eventColor} flex items-center justify-center mt-1`}>
          {getEventIcon(event.event_type)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 mb-1">
            <span className="text-sol-text font-medium text-base truncate">
              {event.title}
            </span>
            <span className="text-[11px] text-sol-text-dim/50 shrink-0">
              {getRelativeTime(event.timestamp)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-sol-text-muted flex-wrap">
            <span className="font-medium">{actorName}</span>
            {event.metadata?.git_branch && (
              <span className="inline-flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                </svg>
                {event.metadata.git_branch}
              </span>
            )}
            {event.metadata?.message_count !== undefined && (
              <span className="inline-flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                {event.metadata.message_count}
              </span>
            )}
            {event.metadata?.files_changed !== undefined && (
              <>
                {event.metadata.insertions !== undefined && (
                  <span className="text-sol-green">+{event.metadata.insertions}</span>
                )}
                {event.metadata.deletions !== undefined && (
                  <span className="text-sol-red">-{event.metadata.deletions}</span>
                )}
                <span>{event.metadata.files_changed} files</span>
              </>
            )}
          </div>
          {event.description && (
            <p className="text-xs text-sol-text-muted mt-1 truncate">{event.description}</p>
          )}
        </div>
      </div>
    </div>
  );

  if (event.related_conversation_id) {
    return (
      <Link href={`/conversation/${event.related_conversation_id}`} className="group block relative">
        <div className="absolute inset-0 bg-gradient-to-br from-sol-bg-alt/40 to-sol-bg/40 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
        {content}
      </Link>
    );
  }

  return content;
}

interface TeamActivityFeedProps {
  teamId: Id<"teams">;
}

export function TeamActivityFeed({ teamId }: TeamActivityFeedProps) {
  const [eventTypeFilter, setEventTypeFilter] = useState<string | undefined>(undefined);
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(undefined);
  const [cursor, setCursor] = useState<number | undefined>(undefined);

  const teamMembers = useQuery(api.teams.getTeamMembers, { team_id: teamId });
  const result = useQuery(api.teamActivity.getTeamActivityFeed, {
    team_id: teamId,
    event_type_filter: eventTypeFilter as any,
    actor_filter: actorFilter,
    cursor,
  });

  const groupedEvents = useMemo(() => {
    if (!result?.events) return [];

    const groups: { label: string; items: ActivityEvent[] }[] = [];
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const groupMap = new Map<string, ActivityEvent[]>([
      ["Last Hour", []],
      ["Last 6 Hours", []],
      ["Last 24 Hours", []],
      ["This Week", []],
      ["Older", []],
    ]);

    for (const event of result.events) {
      if (event.timestamp >= oneHourAgo) {
        groupMap.get("Last Hour")!.push(event);
      } else if (event.timestamp >= sixHoursAgo) {
        groupMap.get("Last 6 Hours")!.push(event);
      } else if (event.timestamp >= oneDayAgo) {
        groupMap.get("Last 24 Hours")!.push(event);
      } else if (event.timestamp >= weekAgo) {
        groupMap.get("This Week")!.push(event);
      } else {
        groupMap.get("Older")!.push(event);
      }
    }

    for (const [label, items] of groupMap) {
      if (items.length > 0) {
        groups.push({ label, items });
      }
    }

    return groups;
  }, [result?.events]);

  if (result === undefined) {
    return <LoadingSkeleton />;
  }

  if (!result.events || result.events.length === 0) {
    return (
      <>
        <div className="flex flex-wrap gap-3 mb-6">
          <select
            value={eventTypeFilter || "all"}
            onChange={(e) => setEventTypeFilter(e.target.value === "all" ? undefined : e.target.value)}
            className="px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sm text-sol-text focus:outline-none focus:ring-2 focus:ring-sol-yellow/50"
          >
            <option value="all">All Events</option>
            <option value="session_started">Sessions Started</option>
            <option value="session_completed">Sessions Completed</option>
            <option value="commit_pushed">Commits</option>
            <option value="member_joined">Members Joined</option>
            <option value="member_left">Members Left</option>
            <option value="pr_created">PRs Created</option>
            <option value="pr_merged">PRs Merged</option>
          </select>
          {teamMembers && teamMembers.length > 0 && (
            <select
              value={actorFilter?.toString() || "all"}
              onChange={(e) => setActorFilter(e.target.value === "all" ? undefined : e.target.value as Id<"users">)}
              className="px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sm text-sol-text focus:outline-none focus:ring-2 focus:ring-sol-yellow/50"
            >
              <option value="all">All Members</option>
              {teamMembers.map((member) => (
                <option key={member._id} value={member._id}>
                  {member.name || member.email}
                </option>
              ))}
            </select>
          )}
        </div>
        <EmptyState
          title="No team activity yet"
          description="Team activity will appear here as members work on sessions, make commits, and collaborate."
        />
      </>
    );
  }

  const handleLoadMore = () => {
    if (result.hasMore && result.nextCursor) {
      setCursor(result.nextCursor);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <select
          value={eventTypeFilter || "all"}
          onChange={(e) => {
            setEventTypeFilter(e.target.value === "all" ? undefined : e.target.value);
            setCursor(undefined);
          }}
          className="px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sm text-sol-text focus:outline-none focus:ring-2 focus:ring-sol-yellow/50"
        >
          <option value="all">All Events</option>
          <option value="session_started">Sessions Started</option>
          <option value="session_completed">Sessions Completed</option>
          <option value="commit_pushed">Commits</option>
          <option value="member_joined">Members Joined</option>
          <option value="member_left">Members Left</option>
          <option value="pr_created">PRs Created</option>
          <option value="pr_merged">PRs Merged</option>
        </select>
        {teamMembers && teamMembers.length > 0 && (
          <select
            value={actorFilter?.toString() || "all"}
            onChange={(e) => {
              setActorFilter(e.target.value === "all" ? undefined : e.target.value as Id<"users">);
              setCursor(undefined);
            }}
            className="px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sm text-sol-text focus:outline-none focus:ring-2 focus:ring-sol-yellow/50"
          >
            <option value="all">All Members</option>
            {teamMembers.map((member) => (
              <option key={member._id} value={member._id}>
                {member.name || member.email}
              </option>
            ))}
          </select>
        )}
      </div>

      {groupedEvents.map((group) => (
        <div key={group.label}>
          <div className="pb-2 mb-3">
            <h2 className="text-xs font-medium tracking-wide uppercase text-sol-text-muted">
              {group.label}
            </h2>
          </div>
          <div className="space-y-3">
            {group.items.map((event) => (
              <ActivityEventCard key={event._id} event={event} />
            ))}
          </div>
        </div>
      ))}

      {result.hasMore && (
        <div className="flex justify-center pt-4">
          <button
            onClick={handleLoadMore}
            className="px-6 py-2 bg-sol-yellow text-sol-bg rounded-lg font-medium hover:bg-sol-yellow/90 transition-colors"
          >
            Load More
          </button>
        </div>
      )}
    </div>
  );
}
