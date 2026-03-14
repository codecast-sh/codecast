"use client";

import { useQuery, useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import React, { useMemo, useState, useCallback } from "react";
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
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 4) {
    const mins = diffMinutes % 60;
    return mins > 0 ? `${diffHours}h ${mins}m ago` : `${diffHours}h ago`;
  }
  const date = new Date(timestamp);
  const h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
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
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

function formatMsgCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

const OUTCOME_STYLES: Record<string, { border: string; bg: string; label: string; badge: string }> = {
  shipped: { border: "border-l-sol-green/60", bg: "", label: "shipped", badge: "bg-sol-green/10 text-sol-green/70 ring-1 ring-sol-green/15" },
  progress: { border: "border-l-sol-yellow/40", bg: "", label: "progress", badge: "bg-sol-yellow/8 text-sol-yellow/60 ring-1 ring-sol-yellow/12" },
  blocked: { border: "border-l-sol-red/50", bg: "bg-sol-red/[0.03]", label: "blocked", badge: "bg-sol-red/12 text-sol-red/70 ring-1 ring-sol-red/20" },
  unknown: { border: "border-l-sol-text-dim/15", bg: "", label: "", badge: "" },
};

const PROJECT_PALETTE = [
  "bg-sol-cyan/12 text-sol-cyan/70",
  "bg-sol-yellow/12 text-sol-yellow/70",
  "bg-sol-violet/12 text-sol-violet/70",
  "bg-sol-green/12 text-sol-green/70",
  "bg-sol-orange/12 text-sol-orange/70",
  "bg-sol-blue/12 text-sol-blue/70",
  "bg-sol-red/12 text-sol-red/70",
];

function useProjectColors(items: any[]) {
  return useMemo(() => {
    const map: Record<string, string> = {};
    let idx = 0;
    for (const item of items) {
      const proj = extractProject(item.project_path);
      if (proj && !map[proj]) {
        map[proj] = PROJECT_PALETTE[idx % PROJECT_PALETTE.length];
        idx++;
      }
    }
    return map;
  }, [items]);
}

const TIMELINE_TYPE_STYLES: Record<string, { color: string; label?: string; bold?: boolean }> = {
  start: { color: "text-sol-text-dim/40" },
  direction: { color: "text-sol-yellow/80", label: "user", bold: true },
  prompt: { color: "text-sol-yellow/80", label: "user", bold: true },
  decision: { color: "text-sol-violet/70", label: "decided" },
  discovery: { color: "text-sol-orange/60" },
  ship: { color: "text-sol-green/70", bold: true },
  block: { color: "text-sol-red/60" },
  debug: { color: "text-sol-orange/50" },
  research: { color: "text-sol-blue/50" },
  change: { color: "text-sol-text-dim/50" },
};

function highlightCode(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|(?:[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|css|html|json|yaml|yml|md|sh|sql))\b|(?:[\w]+(?:\.[\w]+)+\(\)))/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="font-mono text-sol-cyan/60 bg-sol-cyan/5 px-0.5 rounded">{part.slice(1, -1)}</code>;
    }
    if (/\.(?:ts|tsx|js|jsx|py|go|rs|css|html|json|yaml|yml|md|sh|sql)$/.test(part)) {
      return <span key={i} className="font-mono text-sol-cyan/50">{part}</span>;
    }
    if (/\w+(?:\.\w+)+\(\)/.test(part)) {
      return <span key={i} className="font-mono text-sol-violet/50">{part}</span>;
    }
    return part;
  });
}

function formatRelativeTime(timeStr: string, firstTimeStr: string): string {
  const parse = (t: string) => {
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };
  const mins = parse(timeStr) - parse(firstTimeStr);
  if (mins <= 0) return "+0m";
  if (mins < 60) return `+${mins}m`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `+${h}h${rem}m` : `+${h}h`;
}

function SessionTimeline({ timeline, startedAt }: { timeline: any[]; startedAt?: number }) {
  if (!timeline?.length) return null;
  const firstTime = timeline[0]?.t || "00:00";

  return (
    <div className="mt-0.5 pl-2 border-l border-sol-border/12 space-y-px">
      {timeline.map((te: any, i: number) => {
        const style = TIMELINE_TYPE_STYLES[te.type] || TIMELINE_TYPE_STYLES.change;
        const relTime = formatRelativeTime(te.t, firstTime);
        const isUserDirection = te.type === "direction" || te.type === "prompt";
        const eventText = te.event.length > 120 ? te.event.slice(0, 115) + "..." : te.event;

        return (
          <div key={i} className={`flex items-baseline gap-2 ${isUserDirection ? "py-0.5" : ""}`}>
            <span className="font-mono tabular-nums shrink-0 text-[9px] text-sol-text-dim/25 w-[32px] text-right">
              {relTime}
            </span>
            {style.label && (
              <span className={`text-[8px] font-medium uppercase tracking-wider shrink-0 ${style.color}`}>
                {style.label}
              </span>
            )}
            <span className={`leading-snug text-[10px] ${style.color} ${style.bold ? "font-medium" : ""}`}>
              {highlightCode(eventText)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SessionCard({ item, compact, showActor, onNavigate, projectColor }: {
  item: any;
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
  projectColor?: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const actorName = item.actor?.name || "Unknown";
  const project = extractProject(item.project_path);
  const outcome = OUTCOME_STYLES[item.outcome_type] || OUTCOME_STYLES.unknown;
  const isActive = item.status === "active";
  const isTrivial = (item.message_count || 0) < 3;

  const rawDuration = item.started_at && item.updated_at ? item.updated_at - item.started_at : 0;
  const cappedDuration = Math.min(rawDuration, 8 * 3600000);
  const duration = cappedDuration > 60000 && cappedDuration < 8 * 3600000 ? formatDuration(0, cappedDuration) : null;
  const time = getRelativeTime(item.updated_at || item.started_at || item.generated_at);

  const handleNav = useCallback(() => {
    if (onNavigate) onNavigate(item.conversation_id);
    else router.push(`/conversation/${item.conversation_id}`);
  }, [onNavigate, item.conversation_id, router]);

  const rawTitle = item.title || "Session";
  const firstName = actorName.split(" ")[0];
  const displayTitle = showActor && rawTitle.startsWith(firstName + " ")
    ? rawTitle.slice(firstName.length + 1)
    : rawTitle;

  const headline = item.headline || "";
  const changes = item.key_changes || [];
  const hasTimeline = item.timeline?.length > 0;
  const hasDetail = changes.length > 0 || item.blockers || item.next_action || hasTimeline;

  const msgCount = item.message_count || 0;
  const metaParts = [duration, msgCount >= 50 ? `${formatMsgCount(msgCount)} msgs` : null].filter(Boolean);

  return (
    <div
      onClick={() => hasDetail && setExpanded(!expanded)}
      className={`group border-l-2 ${outcome.border} ${outcome.bg} ${compact ? "pl-2.5 py-1.5" : "pl-3 py-2"} ${isTrivial ? "opacity-50" : ""} ${hasDetail ? "cursor-pointer" : ""} hover:bg-sol-bg-alt/30 transition-colors rounded-r`}
    >
      {/* Row 1: actor + title + project + time */}
      <div className="flex items-center gap-1.5 min-w-0">
        {showActor && (
          <span className={`shrink-0 ${avatarColor(actorName)} rounded-full w-[18px] h-[18px] text-[9px] flex items-center justify-center font-bold`}>
            {actorName[0].toUpperCase()}
          </span>
        )}
        {showActor && (
          <span className={`font-medium text-sol-text shrink-0 ${compact ? "text-[11px]" : "text-[12px]"}`}>
            {actorName.split(" ")[0]}
          </span>
        )}
        <span
          onClick={(e) => { e.stopPropagation(); handleNav(); }}
          className={`font-semibold text-sol-text truncate cursor-pointer hover:text-sol-yellow transition-colors ${compact ? "text-[12px]" : "text-[13px]"}`}
        >
          {displayTitle}
        </span>
        {isActive && (
          <span className="flex items-center gap-0.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
            <span className="text-[8px] text-sol-green/60 font-medium uppercase tracking-wider">live</span>
          </span>
        )}
        {project && (
          <span className={`font-mono rounded px-1 py-px shrink-0 text-[9px] ${projectColor || "bg-sol-bg-alt text-sol-text-dim/50"}`}>
            {project}
          </span>
        )}
        <span className="flex-1" />
        {outcome.label && (
          <span className={`rounded-full px-1.5 py-px shrink-0 font-medium text-[9px] ${outcome.badge}`}>
            {outcome.label}
          </span>
        )}
        <span className={`font-mono text-sol-text-dim/35 tabular-nums shrink-0 whitespace-nowrap text-[10px]`}>
          {time}
        </span>
        {hasDetail && (
          <span className={`text-sol-text-dim/20 text-[8px] shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}>
            &#x25B6;
          </span>
        )}
      </div>

      {/* Row 2: headline */}
      {headline && (
        <div className={`mt-0.5 ${showActor ? "ml-[26px]" : ""}`}>
          <p className={`text-sol-text-muted/60 leading-snug ${compact ? "text-[11px]" : "text-[12px]"}`}>
            {headline}
            {metaParts.length > 0 && (
              <span className="text-sol-text-dim/20 font-mono text-[9px] ml-2">{metaParts.join(" / ")}</span>
            )}
          </p>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className={`mt-1.5 space-y-1 ${showActor ? "ml-[26px]" : ""} text-[11px]`} onClick={(e) => e.stopPropagation()}>
          {item.outcome_type === "blocked" && item.blockers && (
            <div>
              <span className="text-sol-red/60 font-medium">Blocked: </span>
              <span className="text-sol-text-muted/70">{item.blockers}</span>
            </div>
          )}
          {changes.length > 0 && !hasTimeline && (
            <ul className="space-y-0.5">
              {changes.map((c: string, i: number) => (
                <li key={i} className="flex gap-1.5 text-sol-text-muted/60 leading-snug">
                  <span className="text-sol-text-dim/30 select-none shrink-0">-</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
          {item.next_action && (isActive || item.outcome_type === "progress") && (
            <div>
              <span className="text-sol-cyan/50 font-medium">Next: </span>
              <span className="text-sol-text-muted/60">{item.next_action}</span>
            </div>
          )}
          {hasTimeline && <SessionTimeline timeline={item.timeline} startedAt={item.started_at} />}
          {item.git_branch && item.git_branch !== "main" && item.git_branch !== "master" && (
            <div className="font-mono text-sol-text-dim/20 text-[9px]">{item.git_branch}</div>
          )}
        </div>
      )}
    </div>
  );
}

function DayNarrative({ narrative, events }: { narrative: string; events: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const [showFullNarrative, setShowFullNarrative] = useState(false);

  const sessionCount = useMemo(() => {
    const ids = new Set(events.map((e) => e.session_title).filter(Boolean));
    return ids.size;
  }, [events]);

  const isLong = narrative.length > 200;
  const displayNarrative = isLong && !showFullNarrative ? narrative.slice(0, 180) + "..." : narrative;

  return (
    <div className="mb-1.5">
      <div
        className="px-2.5 py-1.5 rounded bg-sol-bg-alt/15 border-l-2 border-sol-violet/15"
      >
        <p className="text-[11px] text-sol-text-muted/55 leading-relaxed">
          {displayNarrative}
          {isLong && !showFullNarrative && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowFullNarrative(true); }}
              className="text-sol-text-dim/35 hover:text-sol-cyan/50 ml-1 transition-colors"
            >more</button>
          )}
        </p>
        {events.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[9px] text-sol-text-dim/25 hover:text-sol-cyan/40 mt-0.5 block transition-colors"
          >
            {expanded ? "collapse" : `${events.length} events, ${sessionCount}s`}
          </button>
        )}
      </div>
      {expanded && events.length > 0 && (
        <div className="mt-1.5 pl-3 border-l border-sol-border/10 space-y-px" onClick={(e) => e.stopPropagation()}>
          {events.map((e: any, i: number) => {
            const style = TIMELINE_TYPE_STYLES[e.type] || TIMELINE_TYPE_STYLES.change;
            const isUserDirection = e.type === "direction" || e.type === "prompt";
            const prevSession = i > 0 ? events[i - 1].session_title : null;
            const showSessionBreak = e.session_title && e.session_title !== prevSession;
            return (
              <React.Fragment key={i}>
                {showSessionBreak && (
                  <div className="flex items-center gap-2 pt-1 pb-0.5">
                    <span className="text-[9px] font-medium text-sol-text-dim/30 truncate max-w-[200px]">
                      {e.session_title}
                    </span>
                    {e.project && (
                      <span className="font-mono text-[8px] text-sol-text-dim/15">{e.project}</span>
                    )}
                    <div className="h-px flex-1 bg-sol-border/6" />
                  </div>
                )}
                <div className={`flex items-baseline gap-2 ${isUserDirection ? "py-0.5" : ""}`}>
                  <span className="font-mono tabular-nums shrink-0 text-[9px] text-sol-text-dim/25 w-[32px] text-right">
                    {e.t}
                  </span>
                  {style.label && (
                    <span className={`text-[8px] font-medium uppercase tracking-wider shrink-0 ${style.color}`}>
                      {style.label}
                    </span>
                  )}
                  <span className={`leading-snug text-[10px] ${style.color} ${style.bold ? "font-medium" : ""}`}>
                    {highlightCode(e.event)}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DaySection({ day, items, compact, showActor, onNavigate, projectColors, dayNarrative, onProjectFilter }: {
  day: { date: string; session_count: number; highlights: string[] };
  items: any[];
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
  projectColors: Record<string, string>;
  dayNarrative?: { narrative: string; events: any[]; generated_at: number };
  onProjectFilter?: (project: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const label = formatDate(day.date);
  const outcomes = useMemo(() => {
    const o = { shipped: 0, progress: 0, blocked: 0 };
    for (const i of items) {
      if (i.outcome_type === "shipped") o.shipped++;
      else if (i.outcome_type === "progress") o.progress++;
      else if (i.outcome_type === "blocked") o.blocked++;
    }
    return o;
  }, [items]);

  const { projects, peopleCount } = useMemo(() => {
    const projSet = new Set<string>();
    const actorSet = new Set<string>();
    for (const i of items) {
      const p = extractProject(i.project_path);
      if (p) projSet.add(p);
      if (i.actor?._id) actorSet.add(i.actor._id.toString());
    }
    return { projects: [...projSet], peopleCount: actorSet.size };
  }, [items]);

  const outcomeBar = useMemo(() => {
    const total = outcomes.shipped + outcomes.progress + outcomes.blocked;
    if (total === 0) return null;
    return (
      <div className="flex h-1.5 w-16 rounded-full overflow-hidden bg-sol-border/8 gap-px">
        {outcomes.shipped > 0 && <div className="bg-sol-green/50 rounded-full" style={{ width: `${(outcomes.shipped / total) * 100}%` }} />}
        {outcomes.progress > 0 && <div className="bg-sol-yellow/40 rounded-full" style={{ width: `${(outcomes.progress / total) * 100}%` }} />}
        {outcomes.blocked > 0 && <div className="bg-sol-red/50 rounded-full" style={{ width: `${(outcomes.blocked / total) * 100}%` }} />}
      </div>
    );
  }, [outcomes]);

  const activeCount = useMemo(() => {
    return items.filter((i) => i.status === "active").length;
  }, [items]);

  return (
    <div className={compact ? "py-0.5" : "py-1"}>
      <div
        className="flex items-center gap-3 mb-1.5 cursor-pointer select-none group/day"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`text-sol-text-dim/30 text-[10px] transition-transform ${collapsed ? "" : "rotate-90"}`}>
          &#x25B6;
        </span>
        <span className={`font-semibold tracking-tight text-sol-text ${compact ? "text-[13px]" : "text-[15px]"}`}>
          {label}
        </span>
        {activeCount > 0 && (
          <span className="flex items-center gap-1 text-[9px] text-sol-green/50 font-medium">
            <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse" />
            {activeCount} active
          </span>
        )}
        <div className="h-px flex-1 bg-sol-border/15" />
        <div className="flex items-center gap-2">
          {outcomeBar}
          {projects.length > 0 && (
            <div className="flex items-center gap-1">
              {projects.slice(0, 4).map((p) => (
                <button
                  key={p}
                  onClick={(e) => { e.stopPropagation(); onProjectFilter?.(p); }}
                  className={`font-mono rounded px-1 py-px text-[9px] hover:ring-1 hover:ring-sol-cyan/30 transition-all ${projectColors[p] || "bg-sol-bg-alt text-sol-text-dim/40"}`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          <span className={`text-sol-text-dim/30 tabular-nums text-[10px] flex items-center gap-1.5`}>
            {showActor && peopleCount > 1 && <span className="text-sol-text-dim/25">{peopleCount}p</span>}
            {items.length}s
          </span>
        </div>
      </div>

      {collapsed && dayNarrative && (
        <p className="text-[10px] text-sol-text-dim/30 truncate ml-5 -mt-1 mb-0.5">
          {dayNarrative.narrative.slice(0, 120)}...
        </p>
      )}

      {!collapsed && (
        <>
          {dayNarrative && <DayNarrative narrative={dayNarrative.narrative} events={dayNarrative.events} />}

          <div className="divide-y divide-sol-border/8">
            {items.map((item: any) => (
              <SessionCard
                key={item.conversation_id}
                item={item}
                compact={compact}
                showActor={showActor}
                onNavigate={onNavigate}
                projectColor={projectColors[extractProject(item.project_path) || ""]}
              />
            ))}
          </div>
        </>
      )}
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

  const filteredFeed = useMemo(() => {
    if (!digest?.feed) return [];
    let items = digest.feed;
    if (actorFilter) items = items.filter((item: any) => item.actor?._id?.toString() === actorFilter?.toString());
    if (projectFilter) items = items.filter((item: any) => extractProject(item.project_path) === projectFilter);
    return items;
  }, [digest?.feed, actorFilter, projectFilter]);

  const projectColors = useProjectColors(filteredFeed);

  const filteredDaySummaries = useMemo(() => {
    if (!digest?.day_summaries) return [];
    if (!actorFilter && !projectFilter) return digest.day_summaries;
    const feedDates = new Set(
      filteredFeed.map((item: any) => {
        const ts = item.updated_at || item.started_at || item.generated_at;
        return new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      })
    );
    return digest.day_summaries.filter((d: any) => feedDates.has(d.date));
  }, [digest?.day_summaries, actorFilter, projectFilter, filteredFeed, tz]);

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
        <div className={compact ? "space-y-1" : "space-y-2"}>
          {filteredDaySummaries.map((day: any) => (
            <DaySection
              key={day.date}
              day={day}
              items={feedByDay.get(day.date) || []}
              compact={compact}
              showActor={mode === "team"}
              onNavigate={onNavigate}
              projectColors={projectColors}
              dayNarrative={digest.day_narratives?.[day.date]}
              onProjectFilter={setProjectFilter}
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
  const backfillTimelines = useAction(api.sessionInsights.backfillTimelines);
  const backfillDayNarratives = useAction(api.sessionInsights.backfillDayNarratives);
  const [backfilling, setBackfilling] = useState(false);
  const [genDays, setGenDays] = useState(false);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    try {
      const result = await backfillTimelines({ window_hours: windowHours, limit: 50 });
      console.log("Backfill result:", result);
    } catch (e) {
      console.error("Backfill failed:", e);
    }
    setBackfilling(false);
  }, [backfillTimelines, windowHours]);

  const handleGenDays = useCallback(async () => {
    setGenDays(true);
    try {
      const result = await backfillDayNarratives({ window_hours: windowHours });
      console.log("Day narrative result:", result);
    } catch (e) {
      console.error("Day narrative gen failed:", e);
    }
    setGenDays(false);
  }, [backfillDayNarratives, windowHours]);

  return (
    <div className={`flex items-center justify-between ${compact ? "px-1" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-sol-text-dim tabular-nums">
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
        </span>
        <span className="text-sol-text-dim/15">|</span>
        <button
          onClick={async () => { await handleBackfill(); await handleGenDays(); }}
          disabled={backfilling || genDays}
          className="text-[10px] text-sol-text-dim/40 hover:text-sol-cyan/60 transition-colors disabled:opacity-30"
        >
          {backfilling || genDays ? "regenerating..." : "regen"}
        </button>
      </div>
      <div className="flex items-center gap-2">
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
      </div>
    </div>
  );
}
