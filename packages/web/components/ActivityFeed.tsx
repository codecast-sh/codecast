"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { ConversationList } from "./ConversationList";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

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

function ActorAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initial = (name || "?")[0].toUpperCase();
  const cls = size === "md" ? "w-7 h-7 text-xs" : "w-5 h-5 text-[10px]";
  return (
    <span className={`${cls} rounded-full flex items-center justify-center font-semibold shrink-0 ${avatarColor(name)}`}>
      {initial}
    </span>
  );
}

function OutcomeBadge({ type }: { type: string }) {
  const config: Record<string, { label: string; cls: string }> = {
    shipped: { label: "shipped", cls: "text-sol-green bg-sol-green/10 border-sol-green/25" },
    progress: { label: "in progress", cls: "text-sol-cyan bg-sol-cyan/8 border-sol-cyan/20" },
    blocked: { label: "blocked", cls: "text-sol-red bg-sol-red/10 border-sol-red/25" },
  };
  const c = config[type] || { label: type, cls: "text-sol-text-dim bg-sol-bg-alt border-sol-border/30" };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border shrink-0 ${c.cls}`}>
      {c.label}
    </span>
  );
}

function OutcomeBar({ outcomes }: { outcomes: { shipped: number; progress: number; blocked: number } }) {
  const total = outcomes.shipped + outcomes.progress + outcomes.blocked;
  if (total === 0) return null;
  return (
    <div className="flex h-1 rounded-full overflow-hidden bg-sol-bg-alt/60">
      {outcomes.shipped > 0 && <div className="bg-sol-green/70" style={{ width: `${(outcomes.shipped / total) * 100}%` }} />}
      {outcomes.progress > 0 && <div className="bg-sol-cyan/60" style={{ width: `${(outcomes.progress / total) * 100}%` }} />}
      {outcomes.blocked > 0 && <div className="bg-sol-red/60" style={{ width: `${(outcomes.blocked / total) * 100}%` }} />}
    </div>
  );
}

function PeopleRow({ people, onSelect, selectedId }: { people: any[]; onSelect: (id: Id<"users"> | undefined) => void; selectedId?: Id<"users"> }) {
  if (!people?.length || people.length < 2) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {people.map((person: any) => {
        const isSelected = selectedId?.toString() === person.actor._id.toString();
        return (
          <button
            key={person.actor._id}
            onClick={() => onSelect(isSelected ? undefined : person.actor._id)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors shrink-0 ${
              isSelected
                ? "border-sol-yellow/40 bg-sol-yellow/8 text-sol-text"
                : "border-sol-border/30 bg-sol-bg hover:border-sol-border/50 text-sol-text-muted hover:text-sol-text"
            }`}
          >
            <ActorAvatar name={person.actor.name} size="sm" />
            <span className="text-[11px] font-medium">{person.actor.name.split(" ")[0]}</span>
            <span className="text-[10px] opacity-50">{person.sessions}</span>
          </button>
        );
      })}
    </div>
  );
}

function formatDate(dateStr: string): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  if (dateStr === today) return "Today";
  if (dateStr === yesterday) return "Yesterday";

  const d = new Date(dateStr + "T12:00:00");
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function DayRow({ day, isExpanded, onToggle, compact }: {
  day: { date: string; session_count: number; outcomes: { shipped: number; progress: number; blocked: number; unknown: number }; top_themes: string[]; highlights: string[]; people_count: number };
  isExpanded: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full text-left rounded-lg border transition-all ${
        isExpanded
          ? "border-sol-border/40 bg-sol-bg-alt/30"
          : "border-sol-border/20 bg-sol-bg hover:border-sol-border/40 hover:bg-sol-bg-alt/20"
      } ${compact ? "px-3 py-2" : "px-4 py-3"}`}
    >
      <div className="flex items-center gap-3">
        <span className={`text-[10px] opacity-40 transition-transform ${isExpanded ? "rotate-90" : ""}`}>&#9654;</span>
        <span className={`font-medium text-sol-text ${compact ? "text-xs" : "text-sm"}`}>{formatDate(day.date)}</span>
        <span className="text-[11px] text-sol-text-dim tabular-nums">{day.session_count} session{day.session_count !== 1 ? "s" : ""}</span>

        <div className="flex items-center gap-1.5 text-[10px]">
          {day.outcomes.shipped > 0 && <span className="text-sol-green font-medium">{day.outcomes.shipped} shipped</span>}
          {day.outcomes.progress > 0 && <span className="text-sol-cyan font-medium">{day.outcomes.progress} wip</span>}
          {day.outcomes.blocked > 0 && <span className="text-sol-red font-medium">{day.outcomes.blocked} blocked</span>}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {day.top_themes.slice(0, compact ? 2 : 3).map((t) => (
            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-sol-yellow/8 border border-sol-yellow/15 text-sol-yellow/60">
              {t}
            </span>
          ))}
        </div>
      </div>

      {!isExpanded && day.highlights.length > 0 && !compact && (
        <div className="mt-1.5 pl-6">
          {day.highlights.map((h, i) => (
            <p key={i} className="text-[11px] text-sol-text-dim leading-relaxed line-clamp-1">{h}</p>
          ))}
        </div>
      )}
    </button>
  );
}

function SessionCard({ item, compact, showActor, onNavigate }: {
  item: any;
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();
  const actorName = item.actor?.name || "Unknown";
  const isBlocked = item.outcome_type === "blocked";
  const isShipped = item.outcome_type === "shipped";

  const handleClick = () => {
    if (onNavigate) {
      onNavigate(item.conversation_id);
    } else {
      router.push(`/conversation/${item.conversation_id}`);
    }
  };

  return (
    <div className={`group border-l-2 rounded-r-lg ${
      isBlocked ? "border-sol-red/40 bg-sol-red/[0.02]" : isShipped ? "border-sol-green/25 bg-sol-bg/60" : "border-sol-cyan/20 bg-sol-bg/60"
    }`}>
      <div className={compact ? "pl-2.5 pr-2 py-2" : "pl-3 pr-2 py-3"}>
        <div className="flex items-center gap-2 mb-1.5">
          {showActor && <ActorAvatar name={actorName} size="sm" />}
          {showActor && <span className="text-[11px] font-medium text-sol-text">{actorName}</span>}
          <OutcomeBadge type={item.outcome_type} />
          {item.project_path && (
            <span className="text-[10px] font-mono text-sol-text-dim">
              {item.project_path.split("/").pop()}
              {item.git_branch && item.git_branch !== "main" && <span className="opacity-50"> / {item.git_branch}</span>}
            </span>
          )}
          {item.message_count != null && (
            <span className="text-[10px] text-sol-text-dim opacity-50">{item.message_count} msgs</span>
          )}
          <span className="ml-auto text-[10px] text-sol-text-dim tabular-nums">
            {getRelativeTime(item.updated_at || item.started_at || item.generated_at)}
          </span>
        </div>

        <div
          onClick={handleClick}
          className="block mb-1 cursor-pointer hover:text-sol-yellow transition-colors"
        >
          <span className={`font-medium text-sol-text leading-snug group-hover:text-sol-yellow ${compact ? "text-xs" : "text-sm"}`}>
            {item.title}
          </span>
        </div>

        <p className={`text-sol-text leading-relaxed ${compact ? "text-[11px] line-clamp-2" : "text-xs line-clamp-3"}`}>
          {item.summary}
        </p>

        {item.blockers?.length > 0 && (
          <div className="mt-1.5">
            {item.blockers.map((b: string, i: number) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-sol-red/80 leading-relaxed">
                <span className="shrink-0 mt-0.5">!</span>
                <span>{b}</span>
              </div>
            ))}
          </div>
        )}

        {!compact && (item.metadata?.files_touched?.length > 0 || item.themes?.length > 0) && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="text-[10px] text-sol-text-dim hover:text-sol-text transition-colors mt-1.5"
          >
            {expanded ? "less" : "details"}
            <span className="ml-1 opacity-40">{expanded ? "\u25B4" : "\u25BE"}</span>
          </button>
        )}

        {expanded && (
          <div className="mt-2 pt-2 border-t border-sol-border/20 space-y-1.5">
            {item.metadata?.files_touched?.length > 0 && (
              <div className="text-[11px] text-sol-text-dim">
                <span className="font-medium">Commits:</span>
                {item.metadata.files_touched.map((f: string, i: number) => (
                  <div key={i} className="font-mono text-[10px] text-sol-violet/70 pl-2 truncate">{f}</div>
                ))}
              </div>
            )}
            {item.themes?.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {item.themes.map((t: string) => (
                  <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-sol-yellow/8 border border-sol-yellow/15 text-sol-yellow/60">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type WindowHours = 24 | 168 | 720;

interface ActivityFeedProps {
  mode: "personal" | "team";
  teamId?: string;
  compact?: boolean;
  onNavigate?: (conversationId: string) => void;
}

export function ActivityFeed({ mode, teamId, compact, onNavigate }: ActivityFeedProps) {
  const [windowHours, setWindowHours] = useState<WindowHours>(24);
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(undefined);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"feed" | "raw">("feed");

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const digest = useQuery(api.sessionInsights.getActivityDigest, {
    mode,
    team_id: (mode === "team" && teamId) ? teamId as Id<"teams"> : undefined,
    window_hours: windowHours,
    timezone: tz,
  });

  const filteredFeed = useMemo(() => {
    if (!digest?.feed) return [];
    if (!actorFilter) return digest.feed;
    return digest.feed.filter((item: any) => item.actor?._id?.toString() === actorFilter?.toString());
  }, [digest?.feed, actorFilter]);

  const filteredDaySummaries = useMemo(() => {
    if (!digest?.day_summaries) return [];
    if (!actorFilter) return digest.day_summaries;
    const actorFeedDates = new Set(
      filteredFeed.map((item: any) => {
        const ts = item.updated_at || item.started_at || item.generated_at;
        return new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      })
    );
    return digest.day_summaries.filter((d: any) => actorFeedDates.has(d.date));
  }, [digest?.day_summaries, actorFilter, filteredFeed, tz]);

  const feedByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const item of filteredFeed) {
      const ts = item.updated_at || item.started_at || item.generated_at;
      const dateStr = new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      if (!map.has(dateStr)) map.set(dateStr, []);
      map.get(dateStr)!.push(item);
    }
    return map;
  }, [filteredFeed, tz]);

  const toggleDay = (date: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  if (digest === undefined) return <LoadingSkeleton />;

  if (viewMode === "raw") {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
        </div>
        <ConversationList filter={mode === "team" ? "team" : "my"} />
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {/* Header */}
      {!compact && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-semibold text-sol-text tabular-nums">{digest.sessions_analyzed}</span>
            <span className="text-xs text-sol-text-dim">
              sessions{digest.people.length > 1 ? ` across ${digest.people.length} people` : ""}
            </span>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-sol-green"><span className="font-semibold tabular-nums">{digest.outcomes.shipped}</span> shipped</span>
              <span className="text-sol-cyan"><span className="font-semibold tabular-nums">{digest.outcomes.progress}</span> wip</span>
              {digest.outcomes.blocked > 0 && (
                <span className="text-sol-red"><span className="font-semibold tabular-nums">{digest.outcomes.blocked}</span> blocked</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
            <WindowToggle windowHours={windowHours} setWindowHours={(h) => { setWindowHours(h); setActorFilter(undefined); }} />
          </div>
        </div>
      )}

      {compact && (
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-sol-text-dim">{digest.sessions_analyzed} sessions</span>
            {digest.outcomes.shipped > 0 && <span className="text-sol-green">{digest.outcomes.shipped} shipped</span>}
            {digest.outcomes.progress > 0 && <span className="text-sol-cyan">{digest.outcomes.progress} wip</span>}
          </div>
          <WindowToggle windowHours={windowHours} setWindowHours={(h) => { setWindowHours(h); setActorFilter(undefined); }} />
        </div>
      )}

      {!compact && <OutcomeBar outcomes={digest.outcomes} />}

      {mode === "team" && (
        <PeopleRow people={digest.people} onSelect={setActorFilter} selectedId={actorFilter} />
      )}

      {/* Day summaries with zoom */}
      {digest.sessions_analyzed === 0 ? (
        <EmptyState title="No activity yet" description="Insights appear as sessions produce activity." />
      ) : filteredDaySummaries.length === 0 ? (
        <EmptyState title="No sessions" description={actorFilter ? "No sessions for this person in this window." : "No sessions found."} />
      ) : (
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          {filteredDaySummaries.map((day: any) => {
            const isExpanded = expandedDays.has(day.date);
            const dayItems = feedByDay.get(day.date) || [];
            return (
              <div key={day.date}>
                <DayRow day={day} isExpanded={isExpanded} onToggle={() => toggleDay(day.date)} compact={compact} />
                {isExpanded && (
                  <div className={`mt-1.5 space-y-1.5 ${compact ? "pl-3" : "pl-4"}`}>
                    {dayItems.map((item: any) => (
                      <SessionCard
                        key={item.conversation_id}
                        item={item}
                        compact={compact}
                        showActor={mode === "team"}
                        onNavigate={onNavigate}
                      />
                    ))}
                    {dayItems.length === 0 && (
                      <p className="text-[11px] text-sol-text-dim py-2">No detailed sessions available for this day.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ViewToggle({ viewMode, setViewMode }: { viewMode: "feed" | "raw"; setViewMode: (m: "feed" | "raw") => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-sol-bg-alt/60 rounded-md p-0.5">
      <button
        onClick={() => setViewMode("feed")}
        className={`px-2.5 py-1 text-xs rounded transition-colors ${viewMode === "feed" ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
      >
        Feed
      </button>
      <button
        onClick={() => setViewMode("raw")}
        className={`px-2.5 py-1 text-xs rounded transition-colors ${viewMode === "raw" ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
      >
        Raw
      </button>
    </div>
  );
}

function WindowToggle({ windowHours, setWindowHours }: { windowHours: WindowHours; setWindowHours: (h: WindowHours) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-sol-bg-alt/60 rounded-md p-0.5">
      {([24, 168, 720] as WindowHours[]).map((h) => (
        <button
          key={h}
          onClick={() => setWindowHours(h)}
          className={`px-2 py-1 text-xs rounded transition-colors ${windowHours === h ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
        >
          {h === 24 ? "24h" : h === 168 ? "7d" : "30d"}
        </button>
      ))}
    </div>
  );
}
