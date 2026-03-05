"use client";

import { useAction, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState } from "react";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

type ActivityEvent = {
  _id: Id<"team_activity_events">;
  event_type:
    | "session_started"
    | "session_completed"
    | "commit_pushed"
    | "member_joined"
    | "member_left"
    | "pr_created"
    | "pr_merged";
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
  if (diffMinutes === 1) return "1m ago";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours === 1) return "1h ago";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";

  const date = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function outcomeLabel(type: string) {
  switch (type) {
    case "shipped": return { label: "shipped", cls: "text-sol-green bg-sol-green/15 border-sol-green/30" };
    case "progress": return { label: "in progress", cls: "text-sol-cyan bg-sol-cyan/10 border-sol-cyan/20" };
    case "blocked": return { label: "blocked", cls: "text-sol-red bg-sol-red/10 border-sol-red/20" };
    default: return { label: "unknown", cls: "text-sol-text-muted bg-sol-bg-alt border-sol-border/40" };
  }
}

function getShortProject(path?: string): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

const AVATAR_COLORS = [
  "bg-sol-yellow/20 text-sol-yellow",
  "bg-sol-cyan/20 text-sol-cyan",
  "bg-sol-violet/20 text-sol-violet",
  "bg-sol-green/20 text-sol-green",
  "bg-sol-blue/20 text-sol-blue",
  "bg-sol-red/20 text-sol-red",
  "bg-sol-orange/20 text-sol-orange",
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function ActorAvatar({ name, size = "sm", outcomeType }: { name: string; size?: "sm" | "md"; outcomeType?: string }) {
  const initial = (name || "?")[0].toUpperCase();
  const cls = size === "md" ? "w-6 h-6 text-xs" : "w-4 h-4 text-[9px]";
  const ring = outcomeType === "blocked" ? "ring-1 ring-sol-red/40" : outcomeType === "progress" ? "ring-1 ring-sol-cyan/30" : outcomeType === "shipped" ? "ring-1 ring-sol-green/30" : "";
  return (
    <span className={`${cls} rounded-full flex items-center justify-center font-semibold shrink-0 ${avatarColor(name)} ${ring}`}>
      {initial}
    </span>
  );
}

function getTimeGroup(timestamp: number): string {
  const now = Date.now();
  const diffHours = (now - timestamp) / 3600000;
  if (diffHours < 12) return "Today";
  if (diffHours < 36) return "Yesterday";
  if (diffHours < 168) return "This week";
  return "Earlier";
}

function OutcomeBar({ outcomes }: { outcomes: { shipped: number; progress: number; blocked: number } }) {
  const total = outcomes.shipped + outcomes.progress + outcomes.blocked;
  if (total === 0) return null;
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden bg-sol-bg-alt/60">
      {outcomes.shipped > 0 && <div className="bg-sol-green/70 transition-all duration-500 ease-out" style={{ width: `${(outcomes.shipped / total) * 100}%` }} />}
      {outcomes.progress > 0 && <div className="bg-sol-cyan/60 transition-all duration-500 ease-out" style={{ width: `${(outcomes.progress / total) * 100}%` }} />}
      {outcomes.blocked > 0 && <div className="bg-sol-red/60 transition-all duration-500 ease-out" style={{ width: `${(outcomes.blocked / total) * 100}%` }} />}
    </div>
  );
}

function HighlightCard({ item }: { item: any }) {
  const outcome = outcomeLabel(item.outcome_type);
  const project = getShortProject(item.project_path);
  const actorName = item.rolled_up && item.actor_names?.length > 0
    ? item.actor_names.join(", ")
    : item.actor?.name || "Unknown";

  const borderColor = item.outcome_type === "blocked" ? "border-sol-red/40"
    : item.outcome_type === "progress" ? "border-sol-cyan/25"
    : item.outcome_type === "shipped" ? "border-sol-green/25"
    : "border-transparent";

  const bgTint = item.outcome_type === "blocked" ? "bg-sol-red/[0.03]" : "";
  const isShipped = item.outcome_type === "shipped";

  return (
    <Link
      href={`/conversation/${item.conversation_id}`}
      className={`group block border-l-2 ${borderColor} hover:bg-sol-bg-alt/30 ${bgTint} pl-3 pr-2 py-2 transition-all duration-100 rounded-r`}
    >
      <div className="flex items-start gap-2.5">
        <ActorAvatar name={actorName} size="md" outcomeType={item.outcome_type} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[10px] font-medium w-[72px] text-center py-0.5 rounded border shrink-0 ${outcome.cls}`}>
              {outcome.label}
            </span>
            <span className={`text-sm font-medium ${isShipped ? "text-sol-text-muted" : "text-sol-text"} group-hover:text-sol-yellow transition-colors truncate leading-snug`}>
              {item.title}
            </span>
            {item.rolled_up && (
              <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-sol-violet/10 text-sol-violet">
                x{item.rollup_count}
              </span>
            )}
            {item.confidence !== undefined && item.confidence < 0.5 && (
              <span className="shrink-0 text-[10px] text-sol-orange/60" title="Low confidence insight">~</span>
            )}
          </div>

          {isShipped ? (
            item.what_changed && (
              <p className="text-[11px] text-sol-green/70 leading-relaxed truncate mb-0.5">
                {item.what_changed}
              </p>
            )
          ) : (
            <p className="text-xs text-sol-text-muted leading-relaxed truncate mb-0.5">
              {item.summary}
            </p>
          )}

          {item.blockers?.length > 0 && (
            <div className="text-[11px] leading-tight truncate mb-0.5">
              <span className="font-semibold text-sol-red">Blocked</span>
              <span className="text-sol-text-dim ml-1">{item.blockers[0]}</span>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-[10px] text-sol-text-dim">
            <span className="font-medium">{actorName}</span>
            {project && (
              <>
                <span className="opacity-40">in</span>
                <span className="font-mono">{project}</span>
              </>
            )}
            {item.git_branch && (
              <>
                <span className="opacity-40">/</span>
                <span className="font-mono">{item.git_branch}</span>
              </>
            )}
            <span className="ml-auto opacity-50 tabular-nums">{getRelativeTime(item.generated_at)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function getEventColor(eventType: string) {
  switch (eventType) {
    case "session_started":
    case "session_completed": return "bg-sol-yellow/20 text-sol-yellow border-sol-yellow/30";
    case "commit_pushed": return "bg-sol-violet/20 text-sol-violet border-sol-violet/30";
    case "member_joined": return "bg-sol-green/20 text-sol-green border-sol-green/30";
    case "member_left": return "bg-sol-red/20 text-sol-red border-sol-red/30";
    case "pr_created":
    case "pr_merged": return "bg-sol-blue/20 text-sol-blue border-sol-blue/30";
    default: return "bg-sol-bg-alt text-sol-text-muted border-sol-border/30";
  }
}

function getEventIcon(eventType: string) {
  switch (eventType) {
    case "session_started":
    case "session_completed":
      return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
        </svg>
      );
    case "commit_pushed":
      return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
        </svg>
      );
    case "pr_created":
    case "pr_merged":
      return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      );
    default:
      return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      );
  }
}

function ActivityEventCard({ event }: { event: ActivityEvent }) {
  const actorName = event.actor?.name || event.actor?.email || "Unknown";
  const colorCls = getEventColor(event.event_type);
  const content = (
    <div className="flex items-start gap-3 py-2.5 px-1 group hover:bg-sol-bg-alt/30 rounded-lg transition-colors">
      <div className={`shrink-0 w-7 h-7 rounded border flex items-center justify-center mt-0.5 ${colorCls}`}>
        {getEventIcon(event.event_type)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-sol-text truncate leading-snug">{event.title}</span>
          <span className="text-[10px] text-sol-text-dim shrink-0 tabular-nums">{getRelativeTime(event.timestamp)}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-sol-text-dim mt-0.5 flex-wrap">
          <span className="font-medium">{actorName}</span>
          {event.metadata?.git_branch && <span className="font-mono">{event.metadata.git_branch}</span>}
          {event.metadata?.insertions !== undefined && (
            <span className="text-sol-green">+{event.metadata.insertions}</span>
          )}
          {event.metadata?.deletions !== undefined && (
            <span className="text-sol-red">-{event.metadata.deletions}</span>
          )}
          {event.metadata?.files_changed !== undefined && (
            <span>{event.metadata.files_changed}f</span>
          )}
          {event.metadata?.message_count !== undefined && (
            <span>{event.metadata.message_count} msgs</span>
          )}
        </div>
        {event.description && (
          <p className="text-[11px] text-sol-text-dim mt-0.5 truncate">{event.description}</p>
        )}
      </div>
    </div>
  );

  if (event.related_conversation_id) {
    return <Link href={`/conversation/${event.related_conversation_id}`}>{content}</Link>;
  }
  return content;
}

interface TeamActivityFeedProps {
  teamId: Id<"teams">;
}

export function TeamActivityFeed({ teamId }: TeamActivityFeedProps) {
  const [viewMode, setViewMode] = useState<"digest" | "people" | "feed">("digest");
  const [windowHours, setWindowHours] = useState<24 | 168>(24);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ generated: number; candidates: number; skipped_or_failed: number } | null>(null);
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState<string | undefined>(undefined);
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(undefined);
  const [limit, setLimit] = useState(50);
  const [selectedActor, setSelectedActor] = useState<Id<"users"> | undefined>(undefined);

  const teamMembers = useQuery(api.teams.getTeamMembers, { team_id: teamId });
  const rawResult = useQuery(api.teamActivity.getTeamActivityFeed, {
    team_id: teamId,
    event_type_filter: eventTypeFilter as any,
    actor_filter: actorFilter,
    limit,
  });
  const digest = useQuery(api.sessionInsights.getTeamDigest, { team_id: teamId, window_hours: windowHours });
  const runBackfill = useAction(api.sessionInsights.backfillTeamInsights);
  const personDigest = useQuery(
    api.sessionInsights.getPersonDigest,
    selectedActor ? { team_id: teamId, actor_user_id: selectedActor, window_hours: windowHours } : "skip"
  );

  const groupedEvents = useMemo(() => {
    if (!rawResult?.events) return [];
    const now = Date.now();
    const buckets = [
      { label: "Last Hour", since: now - 60 * 60 * 1000 },
      { label: "Last 6 Hours", since: now - 6 * 60 * 60 * 1000 },
      { label: "Last 24 Hours", since: now - 24 * 60 * 60 * 1000 },
      { label: "This Week", since: now - 7 * 24 * 60 * 60 * 1000 },
      { label: "Older", since: 0 },
    ];
    const groups: { label: string; items: ActivityEvent[] }[] = [];
    const used = new Set<string>();
    for (const bucket of buckets) {
      const items = rawResult.events.filter((e: ActivityEvent) => {
        const id = e._id.toString();
        if (used.has(id)) return false;
        const inBucket = e.timestamp >= bucket.since && (bucket.label === "Older" || e.timestamp < (buckets[buckets.indexOf(bucket) - 1]?.since ?? Infinity));
        if (inBucket) used.add(id);
        return inBucket;
      });
      if (items.length > 0) groups.push({ label: bucket.label, items });
    }
    return groups;
  }, [rawResult?.events]);

  if (rawResult === undefined && digest === undefined) return <LoadingSkeleton />;

  const tabBtn = (mode: "digest" | "people" | "feed", label: string, count?: number) => (
    <button
      onClick={() => { setViewMode(mode); setThemeFilter(null); }}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        viewMode === mode
          ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60"
          : "text-sol-text-muted hover:text-sol-text"
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1 text-[10px] opacity-50">{count}</span>}
    </button>
  );

  return (
    <div className="space-y-5">
      {/* Header controls */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-sol-bg-alt/60 rounded-lg p-1">
          {tabBtn("digest", "Digest", digest?.highlights.length)}
          {tabBtn("people", "People", digest?.people.length)}
          {tabBtn("feed", "Raw Feed")}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-sol-bg-alt/60 rounded-md p-0.5">
            <button
              onClick={() => { setWindowHours(24); setThemeFilter(null); }}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${windowHours === 24 ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              24h
            </button>
            <button
              onClick={() => { setWindowHours(168); setThemeFilter(null); }}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${windowHours === 168 ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              7d
            </button>
          </div>

          <button
            onClick={async () => {
              setIsBackfilling(true);
              try {
                const result: any = await runBackfill({ team_id: teamId, window_hours: windowHours, limit: 25 });
                setBackfillResult({ generated: result?.generated || 0, candidates: result?.candidates || 0, skipped_or_failed: result?.skipped_or_failed || 0 });
                setTimeout(() => setBackfillResult(null), 5000);
              } finally {
                setIsBackfilling(false);
              }
            }}
            disabled={isBackfilling}
            className="w-7 h-7 flex items-center justify-center rounded-md border border-sol-border/50 bg-sol-bg-alt/60 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors disabled:opacity-40"
            title="Regenerate insights"
          >
            <svg className={`w-3.5 h-3.5 ${isBackfilling ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {backfillResult && (
        <div className="text-xs text-sol-text-dim bg-sol-bg-alt/40 border border-sol-border/30 rounded px-3 py-1.5">
          Generated {backfillResult.generated} insights from {backfillResult.candidates} sessions
          {backfillResult.skipped_or_failed > 0 ? ` · ${backfillResult.skipped_or_failed} skipped` : ""}
        </div>
      )}

      {/* Digest view */}
      {viewMode === "digest" && (
        <div className="space-y-4">
          {!digest ? (
            <LoadingSkeleton />
          ) : digest.sessions_analyzed === 0 ? (
            <EmptyState title="No insights yet" description="Insights appear after team sessions produce activity. Try regenerating with the refresh button above." />
          ) : (
            <>
              {/* Stats + Themes */}
              <div className="pb-3 border-b border-sol-border/30 space-y-3">
                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-semibold text-sol-text tabular-nums leading-none">{digest.sessions_analyzed}</span>
                  <span className="text-xs text-sol-text-dim">sessions{digest.people.length > 1 ? ` from ${digest.people.length} people` : ""}</span>
                  <span className="text-xs text-sol-text-dim mx-1">·</span>
                  <span className="text-xs text-sol-green"><span className="font-semibold tabular-nums">{digest.outcomes.shipped}</span> shipped</span>
                  <span className="text-xs text-sol-cyan"><span className="font-semibold tabular-nums">{digest.outcomes.progress}</span> in progress</span>
                  {digest.outcomes.blocked > 0 && (
                    <span className="text-xs text-sol-red"><span className="font-semibold tabular-nums">{digest.outcomes.blocked}</span> blocked</span>
                  )}
                </div>
                <OutcomeBar outcomes={digest.outcomes} />
                {digest.top_themes.length > 0 && (
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 pt-1">
                    {themeFilter && (
                      <button
                        onClick={() => setThemeFilter(null)}
                        className="text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
                      >
                        clear
                      </button>
                    )}
                    {digest.top_themes.map((theme: any) => {
                      const size = theme.count >= 5 ? "text-xs" : "text-[11px]";
                      const weight = theme.count >= 3 ? "font-medium" : "";
                      const isActive = themeFilter === theme.theme;
                      return (
                        <button
                          key={theme.theme}
                          onClick={() => setThemeFilter(isActive ? null : theme.theme)}
                          className={`${size} ${weight} px-1.5 py-0.5 rounded border transition-colors cursor-pointer ${
                            isActive
                              ? "bg-sol-yellow/20 text-sol-yellow border-sol-yellow/40"
                              : "bg-sol-yellow/8 text-sol-yellow/80 border-sol-yellow/15 hover:border-sol-yellow/30"
                          }`}
                        >
                          {theme.theme}
                          <span className="text-sol-text-dim ml-1 text-[10px] opacity-60">{theme.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Highlights */}
              <div>
                {(() => {
                  const filtered = themeFilter
                    ? digest.highlights.filter((h: any) => h.themes?.some((t: string) => t.toLowerCase() === themeFilter))
                    : digest.highlights;
                  const sorted = [...filtered].sort((a: any, b: any) => {
                    const order: Record<string, number> = { blocked: 0, progress: 1, shipped: 2, unknown: 3 };
                    return (order[a.outcome_type] ?? 3) - (order[b.outcome_type] ?? 3);
                  });
                  if (sorted.length === 0 && themeFilter) {
                    return (
                      <div className="py-8 text-center text-sm text-sol-text-dim">
                        No sessions matching "{themeFilter}"
                      </div>
                    );
                  }
                  let lastOutcome = "";
                  return sorted.map((item: any) => {
                    const showDivider = lastOutcome && lastOutcome !== item.outcome_type &&
                      ((lastOutcome === "blocked" && item.outcome_type !== "blocked") ||
                       (lastOutcome !== "shipped" && item.outcome_type === "shipped"));
                    lastOutcome = item.outcome_type;
                    return (
                      <div key={item.conversation_id}>
                        {showDivider && item.outcome_type === "shipped" && (
                          <div className="flex items-center gap-2 pt-3 pb-1 px-1">
                            <div className="h-px flex-1 bg-sol-border/30" />
                            <span className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wider">Completed</span>
                            <div className="h-px flex-1 bg-sol-border/30" />
                          </div>
                        )}
                        {showDivider && item.outcome_type === "progress" && lastOutcome !== "progress" && (
                          <div className="h-px bg-sol-border/20 my-1" />
                        )}
                        <HighlightCard item={item} />
                      </div>
                    );
                  });
                })()}
              </div>
            </>
          )}
        </div>
      )}

      {/* People view */}
      {viewMode === "people" && (
        <div className="space-y-4">
          {!digest ? (
            <LoadingSkeleton />
          ) : digest.people.length === 0 ? (
            <EmptyState title="No people insights yet" description="Once insights are generated, this view summarizes each teammate's work." />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {digest.people.map((person: any) => {
                  const isSelected = selectedActor?.toString() === person.actor._id.toString();
                  return (
                    <button
                      key={person.actor._id}
                      onClick={() => setSelectedActor(isSelected ? undefined : person.actor._id)}
                      className={`text-left bg-sol-bg border rounded-lg p-3.5 transition-all ${
                        isSelected ? "border-sol-yellow/50 bg-sol-yellow/5" : "border-sol-border/50 hover:border-sol-border"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 mb-2">
                        <ActorAvatar name={person.actor.name} size="md" />
                        <span className="text-sm font-medium text-sol-text flex-1">{person.actor.name}</span>
                        <span className="text-xs text-sol-text-dim tabular-nums">{person.sessions}</span>
                      </div>
                      <OutcomeBar outcomes={person.outcomes} />
                      <div className="flex items-center gap-3 text-[11px] mt-1.5 mb-2">
                        <span className="text-sol-green tabular-nums">{person.outcomes.shipped} shipped</span>
                        <span className="text-sol-cyan tabular-nums">{person.outcomes.progress} in progress</span>
                        {person.outcomes.blocked > 0 && <span className="text-sol-red tabular-nums">{person.outcomes.blocked} blocked</span>}
                      </div>
                      {person.top_themes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {person.top_themes.slice(0, 4).map((t: string) => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-sol-yellow/8 border border-sol-yellow/15 text-sol-yellow/70">{t}</span>
                          ))}
                        </div>
                      )}
                      {person.latest_summary && (
                        <p className="text-[11px] text-sol-text-dim leading-relaxed truncate">{person.latest_summary}</p>
                      )}
                    </button>
                  );
                })}
              </div>

              {selectedActor && personDigest && (
                <div className="bg-sol-bg border border-sol-yellow/30 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-sol-text">{personDigest.actor.name}</h3>
                    <span className="text-xs text-sol-text-dim">{personDigest.sessions_analyzed} sessions analyzed</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-sol-green">{personDigest.outcomes.shipped} shipped</span>
                    <span className="text-sol-cyan">{personDigest.outcomes.progress} in progress</span>
                    {personDigest.outcomes.blocked > 0 && <span className="text-sol-red">{personDigest.outcomes.blocked} blocked</span>}
                  </div>

                  {personDigest.top_themes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {personDigest.top_themes.map((t: any) => (
                        <span key={t.theme} className="px-2 py-0.5 text-xs rounded-full border border-sol-yellow/25 bg-sol-yellow/8 text-sol-yellow/80">
                          {t.theme} {t.count > 1 && <span className="opacity-60">({t.count})</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {personDigest.blockers.length > 0 && (
                    <div>
                      <div className="text-[11px] text-sol-red uppercase tracking-wide mb-1.5">Blockers</div>
                      <ul className="space-y-1">
                        {personDigest.blockers.map((b: any) => (
                          <li key={b.blocker} className="flex items-start gap-1.5 text-xs text-sol-text-muted">
                            <svg className="w-3 h-3 text-sol-red mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            {b.blocker}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Raw feed view */}
      {viewMode === "feed" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <select
              value={eventTypeFilter || "all"}
              onChange={(e) => { setEventTypeFilter(e.target.value === "all" ? undefined : e.target.value); setLimit(50); }}
              className="px-2.5 py-1.5 bg-sol-bg border border-sol-border/60 rounded-md text-xs text-sol-text focus:outline-none focus:ring-1 focus:ring-sol-yellow/40"
            >
              <option value="all">All events</option>
              <option value="session_started">Sessions started</option>
              <option value="session_completed">Sessions completed</option>
              <option value="commit_pushed">Commits</option>
              <option value="pr_created">PRs created</option>
              <option value="pr_merged">PRs merged</option>
            </select>
            {teamMembers && teamMembers.length > 0 && (
              <select
                value={actorFilter?.toString() || "all"}
                onChange={(e) => { setActorFilter(e.target.value === "all" ? undefined : e.target.value as Id<"users">); setLimit(50); }}
                className="px-2.5 py-1.5 bg-sol-bg border border-sol-border/60 rounded-md text-xs text-sol-text focus:outline-none focus:ring-1 focus:ring-sol-yellow/40"
              >
                <option value="all">All members</option>
                {teamMembers
                  .filter((m: any): m is NonNullable<typeof m> => m !== null)
                  .map((member: any) => (
                    <option key={member._id} value={member._id}>{member.name || member.email}</option>
                  ))}
              </select>
            )}
          </div>

          {!rawResult?.events?.length ? (
            <EmptyState title="No activity yet" description="Team activity appears here as members work on sessions, commits, and PRs." />
          ) : (
            <>
              {groupedEvents.map((group) => (
                <div key={group.label}>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-sol-text-dim px-1 py-1 mb-1">
                    {group.label}
                  </div>
                  <div className="divide-y divide-sol-border/20">
                    {group.items.map((event) => (
                      <ActivityEventCard key={event._id} event={event} />
                    ))}
                  </div>
                </div>
              ))}
              {rawResult.hasMore && (
                <button
                  onClick={() => setLimit((p) => p + 50)}
                  className="w-full py-2 text-xs text-sol-text-muted hover:text-sol-text transition-colors border border-sol-border/40 rounded-md"
                >
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
