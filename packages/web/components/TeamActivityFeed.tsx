import { useAction, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState } from "react";
import Link from "next/link";
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

function getTimeGroup(timestamp: number): string {
  const now = Date.now();
  const diffHours = (now - timestamp) / 3600000;
  if (diffHours < 12) return "Today";
  if (diffHours < 36) return "Yesterday";
  if (diffHours < 168) return "This week";
  return "Earlier";
}

function SessionCard({ item }: { item: any }) {
  const [expanded, setExpanded] = useState(false);
  const actorName = item.actor?.name || "Unknown";
  const isBlocked = item.outcome_type === "blocked";
  const isShipped = item.outcome_type === "shipped";

  return (
    <div className={`group border-l-2 rounded-r-lg ${
      isBlocked ? "border-sol-red/40 bg-sol-red/[0.02]" : isShipped ? "border-sol-green/25 bg-sol-bg/60" : "border-sol-cyan/20 bg-sol-bg/60"
    }`}>
      <div className="pl-3 pr-2 py-3">
        <div className="flex items-center gap-2 mb-2">
          <ActorAvatar name={actorName} />
          <span className="text-[11px] font-medium text-sol-text">{actorName}</span>
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
          <span className="ml-auto text-[10px] text-sol-text-dim tabular-nums">{getRelativeTime(item.updated_at || item.started_at || item.generated_at)}</span>
        </div>

        <Link
          href={`/conversation/${item.conversation_id}`}
          className="block mb-1.5 hover:text-sol-yellow transition-colors"
        >
          <span className="text-sm font-medium text-sol-text leading-snug group-hover:text-sol-yellow">
            {item.title}
          </span>
        </Link>

        <p className="text-xs text-sol-text leading-relaxed whitespace-pre-line">
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

        {(item.metadata?.files_touched?.length > 0 || item.themes?.length > 0) && (
          <button
            onClick={() => setExpanded(!expanded)}
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

function PeopleRow({ people, onSelect, selectedId }: { people: any[]; onSelect: (id: Id<"users"> | undefined) => void; selectedId?: Id<"users"> }) {
  if (!people?.length) return null;
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

interface TeamActivityFeedProps {
  teamId: Id<"teams">;
}

type ViewMode = "insights" | "raw";


export function TeamActivityFeed({ teamId }: TeamActivityFeedProps) {
  const [windowHours, setWindowHours] = useState<24 | 168>(24);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ generated: number; candidates: number; skipped_or_failed: number } | null>(null);
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(undefined);
  const [viewMode, setViewMode] = useState<ViewMode>("insights");

  const digest = useQuery(api.sessionInsights.getTeamDigest, { team_id: teamId, window_hours: windowHours });
  const runBackfill = useAction(api.sessionInsights.backfillTeamInsights);

  const filteredFeed = useMemo(() => {
    if (!digest?.feed) return [];
    if (!actorFilter) return digest.feed;
    return digest.feed.filter((item: any) => item.actor?._id?.toString() === actorFilter?.toString());
  }, [digest?.feed, actorFilter]);

  const groupedFeed = useMemo(() => {
    const groups: { label: string; items: any[] }[] = [];
    let currentGroup = "";
    for (const item of filteredFeed) {
      const group = getTimeGroup(item.updated_at || item.started_at || item.generated_at);
      if (group !== currentGroup) {
        groups.push({ label: group, items: [] });
        currentGroup = group;
      }
      groups[groups.length - 1].items.push(item);
    }
    return groups;
  }, [filteredFeed]);

  if (digest === undefined) return <LoadingSkeleton />;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        {viewMode === "insights" ? (
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
        ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-sol-text">Team Sessions</span>
        </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-sol-bg-alt/60 rounded-md p-0.5">
            <button
              onClick={() => setViewMode("insights")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${viewMode === "insights" ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
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
          {viewMode === "insights" && (
          <div className="flex items-center gap-0.5 bg-sol-bg-alt/60 rounded-md p-0.5">
            <button
              onClick={() => { setWindowHours(24); setActorFilter(undefined); }}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${windowHours === 24 ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              24h
            </button>
            <button
              onClick={() => { setWindowHours(168); setActorFilter(undefined); }}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${windowHours === 168 ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/60" : "text-sol-text-muted hover:text-sol-text"}`}
            >
              7d
            </button>
          </div>
          )}

          {viewMode === "insights" && (
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
          )}
        </div>
      </div>

      {backfillResult && (
        <div className="text-xs text-sol-text-dim bg-sol-bg-alt/40 border border-sol-border/30 rounded px-3 py-1.5">
          Generated {backfillResult.generated} insights from {backfillResult.candidates} sessions
          {backfillResult.skipped_or_failed > 0 ? ` / ${backfillResult.skipped_or_failed} skipped` : ""}
        </div>
      )}

      {viewMode === "raw" ? (
        <ConversationList filter="team" />
      ) : (
        <>
          <OutcomeBar outcomes={digest.outcomes} />

          {/* People filter row */}
          <PeopleRow people={digest.people} onSelect={setActorFilter} selectedId={actorFilter} />

          {/* Feed */}
          {digest.sessions_analyzed === 0 ? (
            <EmptyState title="No insights yet" description="Insights appear after team sessions produce activity. Try regenerating with the refresh button above." />
          ) : filteredFeed.length === 0 ? (
            <EmptyState title="No sessions" description={actorFilter ? "This person has no sessions in this window." : "No sessions found."} />
          ) : (
            <div className="space-y-1">
              {groupedFeed.map((group) => (
                <div key={group.label}>
                  <div className="flex items-center gap-2 py-2 px-1">
                    <div className="h-px flex-1 bg-sol-border/20" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">{group.label}</span>
                    <div className="h-px flex-1 bg-sol-border/20" />
                  </div>
                  <div className="space-y-2">
                    {group.items.map((item: any) => (
                      <SessionCard key={item.conversation_id} item={item} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
