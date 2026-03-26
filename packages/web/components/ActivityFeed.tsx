import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import React, { useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { ConversationList } from "./ConversationList";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkEntityIds } from "../lib/remarkEntityIds";
import { EntityIdPill, isEntityId } from "./EntityIdPill";
import { PersonMention } from "./editor/MentionNodeView";
import "./editor/editor.css";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

function SessionMentionById({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const data = useQuery(api.conversations.getConversationMention, {
    conversation_id: conversationId as Id<"conversations">,
  });
  if (!data) return <span className="text-[11px] text-sol-text-dim/40 animate-pulse">...</span>;
  const project = data.project_path?.split("/").filter(Boolean).pop();
  const isLive = data.status === "working" || data.status === "thinking";
  return (
    <button
      onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${conversationId}`); }}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-sol-bg-alt/20 border border-sol-border/15 hover:border-sol-yellow/30 hover:bg-sol-yellow/5 transition-colors cursor-pointer align-baseline max-w-[320px] text-left"
    >
      {isLive && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 animate-pulse" />}
      <span className="text-[11px] font-medium text-sol-text/80 truncate">{data.title}</span>
      {project && <span className="text-[9px] text-sol-text-dim/35 shrink-0">{project}</span>}
      <span className="text-[9px] text-sol-text-dim/25 tabular-nums shrink-0">{data.message_count}m</span>
    </button>
  );
}

function PersonMentionInline({ userId, label }: { userId: string; label: string }) {
  return (
    <PersonMention attrs={{
      id: userId,
      label: label.replace(/^@/, ""),
      image: null,
    }} />
  );
}

function DigestLink({ href, children, ...props }: any) {
  if (href?.startsWith("entity://")) {
    return <EntityIdPill shortId={href.slice(9)} />;
  }
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
  if (isEntityId(text)) {
    return <EntityIdPill shortId={text} />;
  }
  const convMatch = href?.match(/^\/conversation\/(.+)/);
  if (convMatch) {
    return <SessionMentionById conversationId={convMatch[1]} />;
  }
  const teamMatch = href?.match(/^\/team\/(.+)/);
  if (teamMatch) {
    return <PersonMentionInline userId={teamMatch[1]} label={String(children)} />;
  }
  return <a href={href} className="text-sol-cyan/70 hover:text-sol-cyan underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
}

function DigestCode({ children, className, ...props }: any) {
  const text = String(children);
  if (!className && isEntityId(text)) return <EntityIdPill shortId={text} />;
  return <code className={`text-[11px] text-sol-cyan/70 bg-sol-bg-alt/30 px-1 py-0.5 rounded ${className || ""}`} {...props}>{children}</code>;
}

const digestRemarkPlugins = [remarkGfm, remarkEntityIds];

function DigestRenderer({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={digestRemarkPlugins}
        components={{
          a: DigestLink,
          code: DigestCode,
          h2: ({ children }) => <h2 className="text-[13px] font-semibold text-sol-text-muted/85 mt-3 mb-1 border-b border-sol-border/10 pb-0.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[12px] font-semibold text-sol-text-muted/75 mt-2 mb-0.5">{children}</h3>,
          p: ({ children }) => <p className="text-[12px] leading-relaxed my-1">{children}</p>,
          ul: ({ children }) => <ul className="text-[12px] my-1 pl-4 list-disc">{children}</ul>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          strong: ({ children }) => <strong className="text-sol-text-muted/90 font-semibold">{children}</strong>,
          hr: () => <hr className="my-3 border-sol-border/10" />,
          pre: ({ children }) => <pre className="text-[11px] bg-sol-bg-alt/20 rounded p-2 my-1 overflow-x-auto">{children}</pre>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

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

function avatarColor(name: string, id?: string): string {
  const colors = [
    "bg-sol-yellow/20 text-sol-yellow",
    "bg-sol-cyan/20 text-sol-cyan",
    "bg-sol-violet/20 text-sol-violet",
    "bg-sol-green/20 text-sol-green",
    "bg-sol-blue/20 text-sol-blue",
    "bg-sol-red/20 text-sol-red",
    "bg-sol-orange/20 text-sol-orange",
  ];
  const key = id ?? name;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function avatarRingColor(name: string, id?: string): string {
  const colors = [
    "ring-sol-yellow/70",
    "ring-sol-cyan/70",
    "ring-sol-violet/70",
    "ring-sol-green/70",
    "ring-sol-blue/70",
    "ring-sol-red/70",
    "ring-sol-orange/70",
  ];
  const key = id ?? name;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function formatMsgCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

const OUTCOME_STYLES: Record<string, { border: string; bg: string; label: string; badge: string; accent: string }> = {
  shipped: { border: "border-l-sol-green/60", bg: "", label: "shipped", badge: "bg-sol-green/20 text-sol-green/80", accent: "bg-sol-green/50" },
  progress: { border: "border-l-sol-yellow/40", bg: "", label: "progress", badge: "bg-sol-yellow/15 text-sol-yellow/70", accent: "bg-sol-yellow/40" },
  blocked: { border: "border-l-sol-red/50", bg: "bg-sol-red/[0.03]", label: "blocked", badge: "bg-sol-red/20 text-sol-red/80", accent: "bg-sol-red/50" },
  unknown: { border: "border-l-sol-text-dim/15", bg: "", label: "", badge: "", accent: "bg-sol-text-dim/15" },
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

function SessionTimeline({ timeline }: { timeline: any[] }) {
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


function SessionNarrativeOverlay({ item, onClose }: { item: any; onClose: () => void }) {
  const turns = item.turns || [];
  const router = useRouter();
  useEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); });
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative mt-12 mb-12 w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl bg-sol-bg-alt border border-sol-border/30 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-sol-bg-alt/95 backdrop-blur border-b border-sol-border/10">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-sol-text truncate">{item.title}</p>
            <p className="text-[11px] text-sol-text-muted/50 mt-0.5 truncate">{item.headline}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <button
              onClick={() => router.push(`/conversation/${item.conversation_id}`)}
              className="text-[11px] text-sol-cyan/60 hover:text-sol-cyan transition-colors"
            >
              open session
            </button>
            <button onClick={onClose} className="text-sol-text-dim/40 hover:text-sol-text/60 transition-colors text-[16px] leading-none">
              ×
            </button>
          </div>
        </div>

        {/* Turns narrative */}
        <div className="px-6 py-5 space-y-6">
          {turns.map((turn: any, i: number) => (
            <div key={i} className="relative">
              <p className="text-[14px] text-sol-blue font-medium leading-relaxed">
                {turn.ask}
              </p>
              {turn.did.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {turn.did.map((d: string, j: number) => (
                    <li key={j} className="flex gap-2 text-[12px] text-sol-text-muted/70 leading-relaxed">
                      <span className="text-sol-text-dim/25 select-none shrink-0 mt-0.5">—</span>
                      <span>{highlightCode(d)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {i < turns.length - 1 && (
                <div className="mt-6 h-px bg-sol-border/8" />
              )}
            </div>
          ))}

          {/* Footer: blockers, next action */}
          {(item.blockers || item.next_action) && (
            <div className="pt-2 border-t border-sol-border/10 space-y-1.5">
              {item.blockers && (
                <p className="text-[12px]">
                  <span className="text-sol-red/60 font-medium">Blocked: </span>
                  <span className="text-sol-text-muted/70">{item.blockers}</span>
                </p>
              )}
              {item.next_action && (
                <p className="text-[12px]">
                  <span className="text-sol-cyan/50 font-medium">Next: </span>
                  <span className="text-sol-text-muted/60">{item.next_action}</span>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionTurns({ turns, onDeepDive }: { turns: Array<{ ask: string; did: string[] }>; onDeepDive?: () => void }) {
  if (!turns?.length) return null;
  return (
    <div className="space-y-2">
      {turns.map((turn, i) => (
        <div key={i}>
          <span className="text-[11px] text-sol-blue/80 font-medium leading-snug">
            {turn.ask}
          </span>
          {turn.did.length > 0 && (
            <ul className="mt-0.5 space-y-px">
              {turn.did.map((d, j) => (
                <li key={j} className="flex gap-1.5 text-[10px] text-sol-text-muted/75 leading-snug">
                  <span className="text-sol-text-dim/50 select-none shrink-0">-</span>
                  <span>{highlightCode(d)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {onDeepDive && (
        <button
          onClick={onDeepDive}
          className="mt-1 text-[10px] text-sol-text-dim/40 hover:text-sol-cyan/60 transition-colors"
        >
          read session ↗
        </button>
      )}
    </div>
  );
}

export function SessionCardInner({ item, compact, showActor, onNavigate, projectColor }: {
  item: any;
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
  projectColor?: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [deepDive, setDeepDive] = useState(false);
  const actorName = item.actor?.name || "Unknown";
  const actorId = item.actor?._id;
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
  const hasTurns = item.turns?.length > 0;
  const hasTimeline = item.timeline?.length > 0;
  const hasDetail = hasTurns || changes.length > 0 || item.blockers || item.next_action || hasTimeline;

  const msgCount = item.message_count || 0;
  const metaParts = [duration, msgCount >= 50 ? `${formatMsgCount(msgCount)} msgs` : null].filter(Boolean);

  return (
    <div
      onClick={() => hasDetail && setExpanded(!expanded)}
      className={`group relative border border-sol-border/30 bg-white dark:bg-sol-bg-alt rounded-xl shadow-sm overflow-hidden ${compact ? "pl-4 pr-2.5 py-2" : "pl-5 pr-3 py-2.5"} ${isTrivial ? "opacity-50" : ""} ${hasDetail ? "cursor-pointer" : ""} hover:border-sol-yellow/30 hover:shadow-md transition-all`}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl ${outcome.accent}`} />
      {/* Row 1: actor + title + project + time */}
      <div className="flex items-center gap-1.5 min-w-0">
        {showActor && (
          <span className="shrink-0 rounded-full w-[20px] h-[20px] overflow-hidden flex items-center justify-center flex-shrink-0">
            {item.actor?.image ? (
              <img src={item.actor.image} alt={actorName} className="w-full h-full object-cover" />
            ) : (
              <span className={`${avatarColor(actorName, actorId)} w-full h-full flex items-center justify-center text-[9px] font-bold`}>
                {actorName[0].toUpperCase()}
              </span>
            )}
          </span>
        )}
        <span
          onClick={(e) => { e.stopPropagation(); handleNav(); }}
          className={`font-semibold text-sol-text cursor-pointer hover:text-sol-yellow transition-colors ${compact ? "text-xs" : "text-sm"}`}
        >
          {displayTitle}
        </span>
        {isActive && (
          <span className="flex items-center gap-0.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
            <span className="text-[8px] text-sol-green/60 font-medium uppercase tracking-wider">live</span>
          </span>
        )}
        {project && project !== "unknown" && (
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
        <span className="font-mono text-sol-text-dim opacity-30 tabular-nums shrink-0 whitespace-nowrap text-[10px]">
          {time}
        </span>
        {hasDetail && (
          <span className={`text-sol-text-dim opacity-20 text-[8px] shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}>
            &#x25B6;
          </span>
        )}
      </div>

      {/* Row 2: expanded detail / hover bullets / headline */}
      {expanded ? (
        <div className={`mt-1.5 space-y-1.5 ${showActor ? "ml-[26px]" : ""} text-[11px] cursor-pointer`} onClick={(e) => { e.stopPropagation(); handleNav(); }}>
          {item.outcome_type === "blocked" && item.blockers && (
            <div>
              <span className="text-sol-red/60 font-medium">Blocked: </span>
              <span className="text-sol-text-muted0">{item.blockers}</span>
            </div>
          )}
          {changes.length > 0 ? (
            <ul className="space-y-0.5">
              {changes.map((c: string, i: number) => (
                <li key={i} className="flex gap-1.5 text-sol-text-muted leading-snug">
                  <span className="text-sol-text-dim opacity-50 select-none shrink-0">-</span>
                  <span>{highlightCode(c)}</span>
                </li>
              ))}
            </ul>
          ) : hasTurns ? (
            <SessionTurns turns={item.turns} onDeepDive={() => setDeepDive(true)} />
          ) : hasTimeline ? (
            <SessionTimeline timeline={item.timeline} />
          ) : null}
          {item.next_action && (isActive || item.outcome_type === "progress") && (
            <div>
              <span className="text-sol-cyan/50 font-medium">Next: </span>
              <span className="text-sol-text-muted0">{item.next_action}</span>
            </div>
          )}
          {item.git_branch && item.git_branch !== "main" && item.git_branch !== "master" && (
            <div className="font-mono text-sol-text-dim opacity-20 text-[9px]">{item.git_branch}</div>
          )}
        </div>
      ) : headline ? (
        <div className={`mt-0.5 ${showActor ? "ml-[26px]" : ""}`}>
          <p className={`text-sol-base0/70 leading-snug ${compact ? "text-[11px]" : "text-[12px]"}`}>
            {headline}
            {metaParts.length > 0 && (
              <span className="text-sol-text-dim opacity-25 font-mono text-[9px] ml-2">{metaParts.join(" / ")}</span>
            )}
          </p>
        </div>
      ) : null}
      {deepDive && <SessionNarrativeOverlay item={item} onClose={() => setDeepDive(false)} />}
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
  return (
    <SessionCardInner item={item} compact={compact} showActor={showActor} onNavigate={onNavigate} projectColor={projectColor} />
  );
}

function extractFirstSection(narrative: string): string {
  const lines = narrative.split("\n");
  let endIdx = -1;
  let foundFirst = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      if (foundFirst) { endIdx = i; break; }
      foundFirst = true;
    }
  }
  if (endIdx > 0) return lines.slice(0, endIdx).join("\n").trim();
  return narrative.length > 500 ? narrative.slice(0, 500) + "..." : narrative;
}

function DayNarrative({ narrative, events }: { narrative: string; events: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const [showEvents, setShowEvents] = useState(false);

  const isRich = narrative.includes("##") || narrative.length > 300;
  const preview = isRich ? extractFirstSection(narrative) : narrative;
  const hasMore = isRich && preview.length < narrative.length;

  const sessionCount = useMemo(() => {
    const ids = new Set(events.map((e) => e.session_title).filter(Boolean));
    return ids.size;
  }, [events]);

  return (
    <div className="mb-1.5">
      <div className="px-2.5 py-1.5 rounded bg-sol-bg-alt/15 border-l-2 border-sol-violet/15">
        <div className="text-[12px] text-sol-text-muted/70 leading-relaxed">
          <DigestRenderer content={expanded ? narrative : preview} />
          {hasMore && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="text-sol-text-dim/35 hover:text-sol-cyan/50 text-[10px] mt-1 block transition-colors"
            >{expanded ? "collapse" : "show full digest"}</button>
          )}
        </div>
        {events.length > 0 && (
          <button
            onClick={() => setShowEvents(!showEvents)}
            className="text-[9px] text-sol-text-dim/25 hover:text-sol-cyan/40 mt-0.5 block transition-colors"
          >
            {showEvents ? "hide events" : `${events.length} events, ${sessionCount}s`}
          </button>
        )}
      </div>
      {showEvents && events.length > 0 && (
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

          <div className="space-y-1.5">
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
            <span className={`w-5 h-5 rounded-full flex items-center justify-center font-semibold shrink-0 ring-2 ${avatarRingColor(person.actor.name, person.actor._id)} overflow-hidden`}>
              {person.actor.image ? (
                <img src={person.actor.image} alt={person.actor.name} className="w-full h-full object-cover" />
              ) : (
                <span className={`w-full h-full flex items-center justify-center text-[10px] font-semibold ${avatarColor(person.actor.name, person.actor._id)}`}>{initial}</span>
              )}
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
  directoryFilter?: string | null;
  onNavigate?: (conversationId: string) => void;
  initialActorId?: string;
  hidePeopleRow?: boolean;
}

const WINDOW_STEPS: WindowHours[] = [168, 720];

type DigestScope = "day" | "week" | "month";

export function ActivityFeed({ mode, teamId, compact, directoryFilter, onNavigate, initialActorId, hidePeopleRow }: ActivityFeedProps) {
  const [windowIdx, setWindowIdx] = useState(0);
  const windowHours = WINDOW_STEPS[windowIdx];
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(initialActorId as Id<"users"> | undefined);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"feed" | "raw">("feed");
  const [digestScope, setDigestScope] = useState<DigestScope>("day");

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const digest = useQuery(api.sessionInsights.getActivityDigest, {
    mode,
    team_id: (mode === "team" && teamId) ? teamId as Id<"teams"> : undefined,
    window_hours: windowHours,
    timezone: tz,
  });

  const scopedDigests = useQuery(
    api.sessionInsights.getDigestsByScope,
    digestScope !== "day" ? {
      scope: digestScope,
      team_id: (mode === "team" && teamId) ? teamId as Id<"teams"> : undefined,
      window_months: digestScope === "month" ? 6 : 3,
    } : "skip"
  );

  const canLoadMore = windowIdx < WINDOW_STEPS.length - 1;

  useWatchEffect(() => {
    if (!canLoadMore || viewMode !== "feed" || digest === undefined) return;

    const scrollContainer = document.querySelector("[data-main-scroll]") as HTMLElement | null;
    if (!scrollContainer) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      if (scrollHeight - scrollTop - clientHeight < 400) {
        setWindowIdx((i) => Math.min(i + 1, WINDOW_STEPS.length - 1));
      }
    };

    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, [canLoadMore, viewMode, digest]);

  const filteredFeed = useMemo(() => {
    if (!digest?.feed) return [];
    let items = digest.feed;
    if (actorFilter) items = items.filter((item: any) => item.actor?._id?.toString() === actorFilter?.toString());
    if (directoryFilter) {
      const filterName = directoryFilter.split('/').filter(Boolean).pop();
      items = items.filter((item: any) => {
        const path = item.git_root || item.project_path;
        if (!path) return false;
        const parts = path.split('/').filter(Boolean);
        return parts.includes(filterName!);
      });
    }
    if (projectFilter) items = items.filter((item: any) => extractProject(item.project_path) === projectFilter);
    return items;
  }, [digest?.feed, actorFilter, directoryFilter, projectFilter]);

  const projectColors = useProjectColors(filteredFeed);

  const filteredDaySummaries = useMemo(() => {
    if (!digest?.day_summaries) return [];
    if (!actorFilter && !projectFilter && !directoryFilter) return digest.day_summaries;
    const feedDates = new Set(
      filteredFeed.map((item: any) => {
        const ts = item.updated_at || item.started_at || item.generated_at;
        return new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      })
    );
    return digest.day_summaries.filter((d: any) => feedDates.has(d.date));
  }, [digest?.day_summaries, actorFilter, directoryFilter, projectFilter, filteredFeed, tz]);

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
          digestScope={digestScope}
          setDigestScope={setDigestScope}
          compact={compact}
        />
        {mode === "team" && !hidePeopleRow && (
          <PeopleRow people={digest.people} onSelect={setActorFilter} selectedId={actorFilter} />
        )}
        <ConversationList filter={mode === "team" ? "team" : "my"} directoryFilter={directoryFilter} memberFilter={actorFilter?.toString() ?? null} onNavigate={onNavigate} />
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <FeedControls
        sessionCount={digest.sessions_analyzed}
        viewMode={viewMode}
        setViewMode={setViewMode}
        digestScope={digestScope}
        setDigestScope={setDigestScope}
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

      {mode === "team" && !hidePeopleRow && (
        <PeopleRow people={digest.people} onSelect={setActorFilter} selectedId={actorFilter} />
      )}

      {digestScope !== "day" ? (
        <ScopedDigestView scope={digestScope} digests={scopedDigests} />
      ) : digest.sessions_analyzed === 0 ? (
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

function formatDigestDate(date: string, scope: DigestScope): string {
  if (scope === "month") {
    const [y, m] = date.split("-");
    const monthName = new Date(parseInt(y), parseInt(m) - 1).toLocaleString("en", { month: "long" });
    return `${monthName} ${y}`;
  }
  if (scope === "week") {
    return date;
  }
  return new Date(date + "T12:00:00").toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
}

function ScopedDigestView({ scope, digests }: { scope: DigestScope; digests: any[] | undefined }) {
  if (digests === undefined) return <LoadingSkeleton />;
  if (digests.length === 0) return <EmptyState title={`No ${scope} digests`} description="Generate digests first via backfillDigests." />;

  return (
    <div className="space-y-3">
      {digests.map((d: any) => (
        <div key={d.date} className="rounded-lg border border-sol-border/15 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 bg-sol-bg-alt/10 border-b border-sol-border/10">
            <span className="text-[12px] font-semibold text-sol-text/80">
              {formatDigestDate(d.date, scope)}
            </span>
            <div className="flex items-center gap-2">
              {d.session_count != null && (
                <span className="text-[10px] text-sol-text-dim/40 tabular-nums">
                  {d.session_count} sessions
                </span>
              )}
              <span className="text-[9px] text-sol-text-dim/25 tabular-nums">
                {new Date(d.generated_at).toLocaleDateString("en", { month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
          <div className="px-3 py-2 text-[12px] text-sol-text-muted/70 leading-relaxed">
            <DigestRenderer content={d.narrative} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedControls({ sessionCount, viewMode, setViewMode, digestScope, setDigestScope, compact }: {
  sessionCount: number;
  viewMode: "feed" | "raw";
  setViewMode: (m: "feed" | "raw") => void;
  digestScope: DigestScope;
  setDigestScope: (s: DigestScope) => void;
  compact?: boolean;
}) {
  const scopes: DigestScope[] = ["day", "week", "month"];
  return (
    <div className={`flex items-center justify-between ${compact ? "px-1" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-sol-text-dim tabular-nums">
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
        </span>
        {viewMode === "feed" && (
          <div className="flex items-center border border-sol-border/20 rounded-md overflow-hidden">
            {scopes.map((s) => (
              <button
                key={s}
                onClick={() => setDigestScope(s)}
                className={`px-2 py-0.5 text-[10px] font-medium capitalize transition-colors ${s !== "day" ? "border-l border-sol-border/20" : ""} ${digestScope === s ? "bg-sol-violet/15 text-sol-text" : "text-sol-text-dim/40 hover:text-sol-text-dim/70 hover:bg-sol-bg-alt/30"}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center border border-sol-border/30 rounded-md overflow-hidden">
        <button
          onClick={() => setViewMode("feed")}
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${viewMode === "feed" ? "bg-sol-yellow/15 text-sol-text" : "text-sol-text-dim/50 hover:text-sol-text hover:bg-sol-bg-alt/50"}`}
        >
          Feed
        </button>
        <button
          onClick={() => setViewMode("raw")}
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors border-l border-sol-border/30 ${viewMode === "raw" ? "bg-sol-yellow/15 text-sol-text" : "text-sol-text-dim/50 hover:text-sol-text hover:bg-sol-bg-alt/50"}`}
        >
          Raw
        </button>
      </div>
    </div>
  );
}
