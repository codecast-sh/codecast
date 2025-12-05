"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useEffect, useState } from "react";

type Conversation = {
  _id: string;
  title: string;
  preview?: string;
  agent_type: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  status: string;
  author_name: string;
  is_own: boolean;
};

type TimeGroup = {
  label: string;
  conversations: Conversation[];
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
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function groupByTime(conversations: Conversation[]): TimeGroup[] {
  const now = Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - 86400000;
  const weekAgoMs = todayMs - 7 * 86400000;

  const groups: TimeGroup[] = [
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "This Week", conversations: [] },
    { label: "Older", conversations: [] },
  ];

  conversations.forEach((conv) => {
    if (conv.started_at >= todayMs) {
      groups[0].conversations.push(conv);
    } else if (conv.started_at >= yesterdayMs) {
      groups[1].conversations.push(conv);
    } else if (conv.started_at >= weekAgoMs) {
      groups[2].conversations.push(conv);
    } else {
      groups[3].conversations.push(conv);
    }
  });

  return groups.filter((g) => g.conversations.length > 0);
}

export function ConversationList({ filter }: { filter: "my" | "team" }) {
  const conversations = useQuery(api.conversations.listConversations, {
    filter,
  });
  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  if (!conversations) {
    return <LoadingSkeleton />;
  }

  if (conversations.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Your synced conversations will appear here. Start a conversation in Claude Code or Cursor to see it listed."
        action={{
          label: "Learn how to sync",
          href: "/docs/sync",
        }}
      />
    );
  }

  const groups = groupByTime(conversations as Conversation[]);

  return (
    <div className="space-y-8">
      {groups.map((group, groupIdx) => (
        <div key={group.label}>
          <div className="pb-3 mb-4">
            <h2 className="text-xs font-medium tracking-wide uppercase text-slate-500 px-1">
              {group.label}
            </h2>
          </div>

          <div className="space-y-3">
            {group.conversations.map((conv) => (
              <Link
                key={conv._id}
                href={`/conversation/${conv._id}`}
                className="group block relative"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-slate-800/40 to-slate-900/40 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                <div className="relative bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 hover:border-amber-500/30 transition-all duration-200 backdrop-blur-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-slate-100 font-medium text-base mb-1 truncate group-hover:text-amber-50 transition-colors">
                        {conv.title}
                      </h3>
                      {conv.preview && (
                        <p className="text-slate-400 text-sm mb-2 line-clamp-2">
                          {conv.preview}
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-xs">
                        {!conv.is_own && (
                          <span className="text-slate-400 font-medium">
                            {conv.author_name}
                          </span>
                        )}
                        <span className="text-slate-500">
                          {getRelativeTime(conv.started_at)}
                        </span>
                        {conv.message_count > 0 && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-800/60 text-slate-400 border border-slate-700/50">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            {conv.message_count}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800/80 text-slate-300 border border-slate-700/50">
                        {conv.agent_type}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
