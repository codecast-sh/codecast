"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState, useCallback } from "react";
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
  if (diffMinutes < 60) return `${diffMinutes}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d`;

  const date = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDate(dateStr: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: tz });

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

function extractHeadline(item: any): string {
  if (item.headline) return item.headline;
  const text = item.summary || "";
  if (!text) return "";
  const firstSentence = text.match(/^[^.!?\n]+[.!?]/)?.[0] || text.split("\n")[0]?.slice(0, 90);
  if (!firstSentence) return text.slice(0, 90);
  const title = (item.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const sentClean = firstSentence.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (title && sentClean.startsWith(title.slice(0, Math.min(title.length, 15)))) return "";
  return firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence;
}

function extractExpandedContent(item: any): { changes: string[]; rest: string } {
  if (item.key_changes?.length) {
    return { changes: item.key_changes, rest: item.summary || "" };
  }
  const text = item.summary || "";
  const lines = text.split("\n").filter((l: string) => l.trim().startsWith("- "));
  if (lines.length) {
    return { changes: lines.map((l: string) => l.trim().replace(/^-\s*/, "")), rest: "" };
  }
  const headline = extractHeadline(item);
  const cleanHeadline = headline.replace(/\.{3}$/, "").replace(/[.!?]$/, "");
  const idx = text.indexOf(". ", cleanHeadline.length > 20 ? 20 : 0);
  const remaining = idx > 0 ? text.slice(idx + 2).trim() : "";
  return { changes: [], rest: remaining };
}

const JUNK_PROJECTS = new Set(["unknown", "src", "home", "tmp", "var", "users", "opt", "usr", "app", "root"]);

function extractProject(projectPath: string | undefined): string | undefined {
  if (!projectPath) return undefined;
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  const name = parts[parts.length - 1];
  if (!name || JUNK_PROJECTS.has(name.toLowerCase())) return undefined;
  if (name.length < 2 || name.length > 40) return undefined;
  if (!/[-_a-zA-Z]/.test(name[0])) return undefined;
  return name;
}

function synthesizeDaySummary(items: any[]): { projects: { name: string; count: number }[]; topHeadlines: string[] } {
  const projectCounts = new Map<string, number>();
  const headlines: string[] = [];
  for (const item of items) {
    const proj = extractProject(item.project_path);
    if (proj) {
      projectCounts.set(proj, (projectCounts.get(proj) || 0) + 1);
    }
    const h = item.headline || item.title || extractHeadline(item);
    const clean = h.replace(/\.{3}$/, "").replace(/\.$/, "");
    headlines.push(clean.length > 55 ? clean.slice(0, 52) + "..." : clean);
  }
  const projects = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  return { projects, topHeadlines: headlines.slice(0, 4) };
}

function formatDuration(startMs: number, endMs: number): string {
  const diffMs = endMs - startMs;
  if (diffMs < 60000) return "<1m";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function avatarColor(name: string): string {
  const colors = [
    "bg-sol-yellow/20 text-sol-yellow",
    "bg-sol-cyan/20 text-sol-cyan",
    "bg-sol-violet/20 text-sol-violet",
    "bg-sol-green/20 text-sol-green",
    "bg-sol-blue/20 text-sol-blue",
    "bg-sol-red/20 text-sol-red",
    "bg-sol-orange/20 text-sol-orange",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function SessionNode({ item, compact, showActor, onNavigate, onProjectFilter, isLast }: {
  item: any;
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
  onProjectFilter?: (project: string | null) => void;
  isLast?: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const actorName = item.actor?.name || "Unknown";

  const handleNav = useCallback(() => {
    if (onNavigate) onNavigate(item.conversation_id);
    else router.push(`/conversation/${item.conversation_id}`);
  }, [onNavigate, item.conversation_id, router]);

  const project = extractProject(item.project_path);
  const time = getRelativeTime(item.updated_at || item.started_at || item.generated_at);
  const isActive = item.status === "active";
  const headline = extractHeadline(item);
  const { changes, rest } = extractExpandedContent(item);

  const rawDurationMs = item.started_at && item.updated_at ? item.updated_at - item.started_at : 0;
  const duration = rawDurationMs > 0 && rawDurationMs < 86400000
    ? formatDuration(item.started_at, item.updated_at)
    : null;

  const hasExpandContent = changes.length > 0 || rest.length > 0 || item.blockers || item.next_action;
  const isTrivial = (item.message_count || 0) < 3;

  return (
    <div className={`relative ${compact ? "pl-5" : "pl-6"} ${isLast ? "" : compact ? "pb-2" : "pb-3"} ${isTrivial ? "opacity-40" : ""} group/session`}>
      {!isLast && (
        <div className={`absolute ${compact ? "left-[5px]" : "left-[7px]"} top-0 bottom-0 w-px bg-sol-border/25`} />
      )}
      <div className={`absolute left-0 rounded-full ${
        isActive
          ? `${compact ? "w-[11px] h-[11px]" : "w-3 h-3"} bg-sol-green ring-2 ring-sol-green/20 animate-pulse`
          : item.outcome_type === "shipped"
            ? `${compact ? "w-[9px] h-[9px]" : "w-[11px] h-[11px]"} bg-sol-green/50 ring-1 ring-sol-green/15`
            : item.outcome_type === "blocked"
              ? `${compact ? "w-[9px] h-[9px]" : "w-[11px] h-[11px]"} bg-sol-red/40 ring-1 ring-sol-red/15`
              : `${compact ? "w-[9px] h-[9px]" : "w-[11px] h-[11px]"} bg-sol-text-dim/30 ring-1 ring-sol-text-dim/10`
      }`} style={{ top: compact ? 4 : 5 }} />

      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          {showActor && (
            <span className={`font-medium text-sol-cyan ${compact ? "text-[10px]" : "text-[11px]"}`}>
              {actorName.split(" ")[0]}
            </span>
          )}
          <span
            onClick={handleNav}
            className={`font-semibold text-sol-text cursor-pointer hover:text-sol-yellow transition-colors ${compact ? "text-[12px]" : "text-[13px]"}`}
          >
            {item.title}
          </span>
          {project && (
            <span
              onClick={(e) => { e.stopPropagation(); onProjectFilter?.(project); }}
              className={`font-mono text-sol-text-dim/40 ${compact ? "text-[9px]" : "text-[10px]"} ${onProjectFilter ? "cursor-pointer hover:text-sol-cyan/60" : ""}`}
            >
              {project}
            </span>
          )}
          {item.outcome_type === "blocked" && (
            <span className={`text-sol-red/60 font-medium ${compact ? "text-[9px]" : "text-[10px]"}`}>blocked</span>
          )}
          <span className={`text-sol-text-dim/30 tabular-nums shrink-0 ${compact ? "text-[9px]" : "text-[10px]"}`}>
            {duration || time}
            {item.message_count > 10 && !compact ? ` / ${item.message_count} msgs` : ""}
          </span>
        </div>

        <div
          onClick={() => setExpanded(!expanded)}
          className={`cursor-pointer ${compact ? "mt-0" : "mt-0.5"}`}
        >
          <p className={`text-sol-text-muted leading-snug ${compact ? "text-[11px]" : "text-[12px]"}`}>
            {headline}
            {hasExpandContent && !expanded && (
              <span className="text-sol-cyan/30 ml-1 text-[10px] hover:text-sol-cyan/60">...</span>
            )}
          </p>
        </div>

        {expanded && (
          <div className={`${compact ? "mt-1 space-y-1" : "mt-1.5 space-y-1.5"}`}>
            {item.outcome_type === "blocked" && item.blockers && (
              <div className={`${compact ? "text-[10px]" : "text-[11.5px]"}`}>
                <span className="text-sol-red/50 font-medium">Blocked: </span>
                <span className="text-sol-text-muted/80">{item.blockers}</span>
              </div>
            )}
            {changes.length > 0 && (
              <ul className="space-y-0.5">
                {changes.map((change: string, i: number) => (
                  <li key={i} className={`flex gap-1.5 text-sol-text-muted/80 leading-snug ${compact ? "text-[10px]" : "text-[11.5px]"}`}>
                    <span className="text-sol-text-dim/30 select-none shrink-0">-</span>
                    <span>{change}</span>
                  </li>
                ))}
              </ul>
            )}
            {rest && changes.length === 0 && (
              <p className={`text-sol-text-muted/70 leading-relaxed ${compact ? "text-[10px]" : "text-[11.5px]"}`}>
                {rest.length > 150 ? rest.slice(0, 147) + "..." : rest}
              </p>
            )}
            {item.next_action && (isActive || item.outcome_type === "progress") && (
              <div className={`${compact ? "text-[10px]" : "text-[11.5px]"}`}>
                <span className="text-sol-cyan/50 font-medium">Next: </span>
                <span className="text-sol-text-muted/70">{item.next_action}</span>
              </div>
            )}
            {item.git_branch && item.git_branch !== "main" && item.git_branch !== "master" && (
              <div className={`font-mono text-sol-text-dim/30 ${compact ? "text-[9px]" : "text-[10px]"}`}>
                {item.git_branch}
              </div>
            )}
            {item.started_at && (
              <div className={`text-sol-text-dim/25 ${compact ? "text-[9px]" : "text-[10px]"}`}>
                {new Date(item.started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DaySection({ day, items, compact, showActor, onNavigate, onProjectFilter, defaultExpanded }: {
  day: { date: string; session_count: number; highlights: string[] };
  items: any[];
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
  onProjectFilter?: (project: string | null) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const label = formatDate(day.date);
  const isRecent = label === "Today" || label === "Yesterday";
  const { projects, topHeadlines } = useMemo(() => synthesizeDaySummary(items), [items]);

  return (
    <div className={compact ? "py-1" : "py-1.5"}>
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left group">
        <div className="flex items-center gap-3">
          <div className={`font-semibold tracking-tight ${isRecent ? "text-sol-text" : "text-sol-text-secondary"} ${compact ? "text-[13px]" : "text-[15px]"}`}>
            {label}
          </div>
          <div className="h-px flex-1 bg-sol-border/15" />
          {!expanded && projects.length > 0 && (
            <div className="flex items-center gap-1.5">
              {projects.slice(0, 3).map((p) => (
                <span key={p.name} className={`font-mono text-sol-text-dim/35 ${compact ? "text-[9px]" : "text-[10px]"}`}>
                  {p.name}{p.count > 1 ? ` x${p.count}` : ""}
                </span>
              ))}
            </div>
          )}
          <MiniOutcomeBar items={items} />
          <span className={`text-sol-text-dim tabular-nums ${compact ? "text-[10px]" : "text-[11px]"}`}>
            {day.session_count}
          </span>
          <span className={`text-[9px] text-sol-text-dim/40 transition-transform ${expanded ? "rotate-90" : ""}`}>&#9654;</span>
        </div>
      </button>

      {!expanded && topHeadlines.length > 0 && (
        <p className={`text-sol-text-muted/50 leading-relaxed ${compact ? "text-[10px] mt-0.5 mb-0.5" : "text-[11.5px] mt-1 mb-1"}`}>
          {topHeadlines.slice(0, 2).join("  /  ")}
          {items.length > 2 && <span className="text-sol-text-dim/30"> +{items.length - 2}</span>}
        </p>
      )}

      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          {items.length > 0 && (
            <div className={`${compact ? "mt-1.5 ml-0.5" : "mt-2 ml-1"}`}>
              {items.map((item: any, i: number) => (
                <SessionNode
                  key={item.conversation_id}
                  item={item}
                  compact={compact}
                  showActor={showActor}
                  onNavigate={onNavigate}
                  onProjectFilter={onProjectFilter}
                  isLast={i === items.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PeopleRow({ people, onSelect, selectedId }: { people: any[]; onSelect: (id: Id<"users"> | undefined) => void; selectedId?: Id<"users"> }) {
  if (!people?.length || people.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {people.map((person: any) => {
        const isSelected = selectedId?.toString() === person.actor._id.toString();
        const initial = (person.actor.name || "?")[0].toUpperCase();
        return (
          <button
            key={person.actor._id}
            onClick={() => onSelect(isSelected ? undefined : person.actor._id)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors shrink-0 ${
              isSelected
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            <span className={`w-5 h-5 text-[10px] rounded-full flex items-center justify-center font-semibold shrink-0 ${avatarColor(person.actor.name)}`}>
              {initial}
            </span>
            <span className="font-medium">{person.actor.name.split(" ")[0]}</span>
            <span className="opacity-40">{person.sessions}</span>
          </button>
        );
      })}
    </div>
  );
}

function MiniOutcomeBar({ items, width = 48 }: { items: any[]; width?: number }) {
  const counts = { shipped: 0, progress: 0, blocked: 0, other: 0 };
  for (const item of items) {
    if (item.outcome_type === "shipped") counts.shipped++;
    else if (item.outcome_type === "blocked") counts.blocked++;
    else if (item.outcome_type === "progress") counts.progress++;
    else counts.other++;
  }
  const total = items.length || 1;
  if (total < 2) return null;
  return (
    <div className="flex rounded-full overflow-hidden h-[3px]" style={{ width }}>
      {counts.shipped > 0 && <div className="bg-sol-green/50" style={{ width: `${(counts.shipped / total) * 100}%` }} />}
      {counts.progress > 0 && <div className="bg-sol-cyan/30" style={{ width: `${(counts.progress / total) * 100}%` }} />}
      {counts.blocked > 0 && <div className="bg-sol-red/40" style={{ width: `${(counts.blocked / total) * 100}%` }} />}
      {counts.other > 0 && <div className="bg-sol-text-dim/15" style={{ width: `${(counts.other / total) * 100}%` }} />}
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
  const [windowHours, setWindowHours] = useState<WindowHours>(168);
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(undefined);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"feed" | "raw">("feed");

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const digest = useQuery(api.sessionInsights.getActivityDigest, {
    mode,
    team_id: (mode === "team" && teamId) ? teamId as Id<"teams"> : undefined,
    window_hours: windowHours,
    timezone: tz,
  });

  const handleProjectFilter = useCallback((proj: string | null) => {
    setProjectFilter((prev) => prev === proj ? null : proj);
  }, []);

  const filteredFeed = useMemo(() => {
    if (!digest?.feed) return [];
    let items = digest.feed;
    if (actorFilter) items = items.filter((item: any) => item.actor?._id?.toString() === actorFilter?.toString());
    if (projectFilter) items = items.filter((item: any) => extractProject(item.project_path) === projectFilter);
    return items;
  }, [digest?.feed, actorFilter, projectFilter]);

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

  if (digest === undefined) return <LoadingSkeleton />;

  if (viewMode === "raw") {
    return (
      <div className="space-y-3">
        <FeedControls
          sessionCount={digest.sessions_analyzed}
          viewMode={viewMode}
          setViewMode={setViewMode}
          windowHours={windowHours}
          setWindowHours={(h) => { setWindowHours(h); setActorFilter(undefined); }}
          compact={compact}
        />
        <ConversationList filter={mode === "team" ? "team" : "my"} onNavigate={onNavigate} />
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <FeedControls
        sessionCount={digest.sessions_analyzed}
        viewMode={viewMode}
        setViewMode={setViewMode}
        windowHours={windowHours}
        setWindowHours={(h) => { setWindowHours(h); setActorFilter(undefined); setProjectFilter(null); }}
        compact={compact}
      />

      {projectFilter && (
        <button
          onClick={() => setProjectFilter(null)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] bg-sol-bg-alt/60 text-sol-text-muted hover:text-sol-text transition-colors"
        >
          <span className="font-mono">{projectFilter}</span>
          <span className="text-sol-text-dim/40">x</span>
        </button>
      )}

      {mode === "team" && (
        <PeopleRow people={digest.people} onSelect={setActorFilter} selectedId={actorFilter} />
      )}

      {digest.sessions_analyzed === 0 ? (
        <EmptyState title="No activity yet" description="Insights appear as sessions produce activity." />
      ) : filteredDaySummaries.length === 0 ? (
        <EmptyState title="No sessions" description={actorFilter ? "No sessions for this person in this window." : "No sessions found."} />
      ) : (
        <div>
          {filteredDaySummaries.map((day: any, i: number) => (
            <DaySection
              key={day.date}
              day={day}
              items={feedByDay.get(day.date) || []}
              compact={compact}
              showActor={mode === "team"}
              onNavigate={onNavigate}
              onProjectFilter={handleProjectFilter}
              defaultExpanded={i === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedControls({ sessionCount, viewMode, setViewMode, windowHours, setWindowHours, compact }: {
  sessionCount: number;
  viewMode: "feed" | "raw";
  setViewMode: (m: "feed" | "raw") => void;
  windowHours: WindowHours;
  setWindowHours: (h: WindowHours) => void;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${compact ? "px-1" : ""}`}>
      <span className="text-[11px] text-sol-text-dim tabular-nums">
        {sessionCount} session{sessionCount !== 1 ? "s" : ""}
      </span>
      <div className="flex items-center gap-2">
        <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
        <WindowToggle windowHours={windowHours} setWindowHours={setWindowHours} />
      </div>
    </div>
  );
}

function ViewToggle({ viewMode, setViewMode }: { viewMode: "feed" | "raw"; setViewMode: (m: "feed" | "raw") => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-sol-bg-alt/60 rounded-md p-0.5">
      <button
        onClick={() => setViewMode("feed")}
        className={`px-2 py-0.5 text-[11px] rounded transition-colors ${viewMode === "feed" ? "bg-sol-bg text-sol-text shadow-sm" : "text-sol-text-muted hover:text-sol-text"}`}
      >
        Feed
      </button>
      <button
        onClick={() => setViewMode("raw")}
        className={`px-2 py-0.5 text-[11px] rounded transition-colors ${viewMode === "raw" ? "bg-sol-bg text-sol-text shadow-sm" : "text-sol-text-muted hover:text-sol-text"}`}
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
          className={`px-2 py-0.5 text-[11px] rounded transition-colors ${windowHours === h ? "bg-sol-bg text-sol-text shadow-sm" : "text-sol-text-muted hover:text-sol-text"}`}
        >
          {h === 24 ? "24h" : h === 168 ? "7d" : "30d"}
        </button>
      ))}
    </div>
  );
}
