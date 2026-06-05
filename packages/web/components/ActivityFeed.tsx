import { useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useConversationsWithError } from "../hooks/useConversationsWithError";
import { useStableOrder } from "../hooks/useStableOrder";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { AgentIcon, type Conversation } from "./ConversationList";
import { cleanTitle } from "../lib/conversationProcessor";
import { shouldShowSession, isWarmupSession } from "../lib/sessionFilters";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

// Team activity feed: top-level sessions (subagents excluded) from the same light
// source the Raw list uses, with pregenerated summaries shown by default. Purpose
// -built clean card; reuses the Raw feed's stable-order + FLIP "slide in" hooks so
// new and updated sessions animate into place. A live overview header, people
// filter, and day grouping sit on top.

const JUNK_WORKSPACES = new Set(["unknown", "src", "home", "tmp", "var", "users", "opt", "usr", "app", "root"]);

function extractWorkspace(projectPath: string | undefined | null): string | undefined {
  if (!projectPath) return undefined;
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  const name = parts[parts.length - 1];
  if (!name || JUNK_WORKSPACES.has(name.toLowerCase())) return undefined;
  // Worktree/agent/session dirs (e.g. "agent-ac5c…", "session-1ntsja") aren't workspaces.
  if (/^(agent|session)-[0-9a-z]{5,}$/i.test(name)) return undefined;
  if (name.length < 2 || name.length > 40) return undefined;
  if (!/[-_a-zA-Z]/.test(name[0])) return undefined;
  return name;
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

function formatMsgCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// The pregenerated summary the Raw feed shows by default — subtitle first, then
// the activity line, then a cleaned first reply as a last resort.
function cardSummary(conv: Conversation): string | null {
  if (conv.subtitle && conv.visibility_mode !== "minimal") return conv.subtitle.trim();
  if (conv.activity_summary) return conv.activity_summary.trim();
  const fa = conv.first_assistant_message;
  if (fa) return fa.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || null;
  return null;
}

const AVATAR_BG = [
  "bg-sol-yellow/20 text-sol-yellow", "bg-sol-cyan/20 text-sol-cyan", "bg-sol-violet/20 text-sol-violet",
  "bg-sol-green/20 text-sol-green", "bg-sol-blue/20 text-sol-blue", "bg-sol-red/20 text-sol-red", "bg-sol-orange/20 text-sol-orange",
];
const AVATAR_RING = [
  "ring-sol-yellow/70", "ring-sol-cyan/70", "ring-sol-violet/70", "ring-sol-green/70", "ring-sol-blue/70", "ring-sol-red/70", "ring-sol-orange/70",
];
function hashIndex(key: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % mod;
}

const PROJECT_PALETTE = [
  "bg-sol-cyan/12 text-sol-cyan/70", "bg-sol-yellow/12 text-sol-yellow/70", "bg-sol-violet/12 text-sol-violet/70",
  "bg-sol-green/12 text-sol-green/70", "bg-sol-orange/12 text-sol-orange/70", "bg-sol-blue/12 text-sol-blue/70", "bg-sol-red/12 text-sol-red/70",
];
function useProjectColors(convs: Conversation[]) {
  return useMemo(() => {
    const map: Record<string, string> = {};
    let idx = 0;
    for (const c of convs) {
      const proj = extractWorkspace(c.project_path);
      if (proj && !map[proj]) { map[proj] = PROJECT_PALETTE[idx % PROJECT_PALETTE.length]; idx++; }
    }
    return map;
  }, [convs]);
}

function Avatar({ name, image, size = 18 }: { name: string; image?: string | null; size?: number }) {
  const initial = (name || "?")[0].toUpperCase();
  return (
    <span className="shrink-0 rounded-full overflow-hidden flex items-center justify-center" style={{ width: size, height: size }}>
      {image
        ? <img src={image} alt={name} className="w-full h-full object-cover" />
        : <span className={`w-full h-full flex items-center justify-center font-semibold ${AVATAR_BG[hashIndex(name, AVATAR_BG.length)]}`} style={{ fontSize: size * 0.5 }}>{initial}</span>}
    </span>
  );
}

// --- The card. Clean, scannable: title row · summary · one dim meta line. ---
export function FeedCard({ conv, showActor, onNavigate, projectColor }: {
  conv: Conversation;
  showActor: boolean;
  onNavigate?: (id: string) => void;
  projectColor?: string;
}) {
  const router = useRouter();
  const project = extractWorkspace(conv.project_path);
  const summary = cardSummary(conv);
  const isActive = conv.is_active;
  const msgs = conv.message_count ?? 0;
  const dur = conv.duration_ms > 90000 ? shortDuration(conv.duration_ms) : null;
  const title = cleanTitle(conv.title || "Untitled");
  const author = conv.author_name?.split(" ")[0];

  return (
    <div
      data-flip-key={conv._id}
      onClick={() => (onNavigate ? onNavigate(conv._id) : router.push(`/conversation/${conv._id}`))}
      className="group relative cursor-pointer rounded-lg border border-sol-border/20 bg-sol-bg-alt/15 hover:bg-sol-bg-alt/40 hover:border-sol-border/45 transition-all overflow-hidden"
    >
      {isActive && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-sol-green/60" />}
      <div className="pl-3.5 pr-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {showActor && <Avatar name={conv.author_name || "?"} image={conv.author_avatar} />}
          <span className="font-medium text-[13px] text-sol-text/90 truncate min-w-0 group-hover:text-sol-yellow transition-colors">
            {title}
          </span>
          {isActive && (
            <span className="flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
              <span className="text-[8px] font-medium uppercase tracking-wider text-sol-green/70">live</span>
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[10px] font-mono text-sol-text-dim/45 tabular-nums shrink-0">{relTime(conv.updated_at)}</span>
        </div>

        {summary && (
          <p className="mt-1 text-[11.5px] leading-relaxed text-sol-text-muted/75 line-clamp-2 whitespace-pre-line break-words">
            {summary}
          </p>
        )}

        <div className="mt-1.5 flex items-center gap-x-2.5 gap-y-1 text-[10px] font-mono text-sol-text-dim/40 flex-wrap">
          {showActor && author && <span className="text-sol-text-dim/55">{author}</span>}
          {project && <span className={`rounded px-1 py-px ${projectColor || "text-sol-text-dim/45"}`}>{project}</span>}
          {msgs > 0 && <span className="tabular-nums">{formatMsgCount(msgs)} msg</span>}
          {dur && <span className="tabular-nums">{dur}</span>}
          <AgentIcon agentType={conv.agent_type || "claude_code"} className="w-3 h-3 opacity-40 ml-auto shrink-0" />
        </div>
      </div>
    </div>
  );
}

type Person = { id: string; name: string; image?: string | null; sessions: number };

function PeopleRow({ people, onSelect, selectedId }: {
  people: Person[];
  onSelect: (id: Id<"users"> | undefined) => void;
  selectedId?: Id<"users">;
}) {
  if (people.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {people.map((p) => {
        const isSel = selectedId?.toString() === p.id;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(isSel ? undefined : (p.id as Id<"users">))}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors shrink-0 ring-1 ${isSel ? "bg-sol-bg-alt text-sol-text ring-sol-border/40" : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50 ring-transparent"}`}
          >
            <span className={`rounded-full ring-2 ${AVATAR_RING[hashIndex(p.id, AVATAR_RING.length)]}`}>
              <Avatar name={p.name} image={p.image} size={20} />
            </span>
            <span className="font-medium">{p.name.split(" ")[0]}</span>
            <span className="opacity-40 tabular-nums">{p.sessions}</span>
          </button>
        );
      })}
    </div>
  );
}

const FEED_WINDOWS: { key: string; label: string; hours: number }[] = [
  { key: "24h", label: "Today", hours: 24 },
  { key: "7d", label: "7 days", hours: 168 },
  { key: "30d", label: "30 days", hours: 720 },
];

// Live overview, recomputed from the loaded session set every render — never stale.
function RollupHeader({ convs, windowKey, setWindowKey, compact }: {
  convs: Conversation[];
  windowKey: string;
  setWindowKey: (k: string) => void;
  compact?: boolean;
}) {
  const stats = useMemo(() => {
    const people = new Set<string>();
    const projects = new Map<string, number>();
    let active = 0;
    let msgs = 0;
    for (const c of convs) {
      if (c.user_id) people.add(c.user_id.toString());
      if (c.is_active) active += 1;
      msgs += c.message_count || 0;
      const p = extractWorkspace(c.project_path);
      if (p) projects.set(p, (projects.get(p) || 0) + 1);
    }
    const topProjects = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { sessions: convs.length, people: people.size, active, msgs, topProjects };
  }, [convs]);

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${compact ? "px-1" : ""}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold text-sol-text tabular-nums">{stats.sessions}</span>
        <span className="text-[11px] text-sol-text-dim">session{stats.sessions !== 1 ? "s" : ""}</span>
      </div>
      {stats.people > 1 && <span className="text-[11px] text-sol-text-dim/70 tabular-nums">{stats.people} people</span>}
      {stats.active > 0 && (
        <span className="flex items-center gap-1 text-[11px] text-sol-green/70 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />{stats.active} live
        </span>
      )}
      {stats.msgs > 0 && <span className="text-[11px] text-sol-text-dim/50 tabular-nums">{formatMsgCount(stats.msgs)} msgs</span>}
      {stats.topProjects.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto">
          {stats.topProjects.map(([p, n]) => (
            <span key={p} className="font-mono text-[9px] text-sol-text-dim/55 bg-sol-bg-alt/50 rounded px-1 py-px whitespace-nowrap">
              {p}<span className="opacity-40"> {n}</span>
            </span>
          ))}
        </div>
      )}
      <div className="ml-auto flex items-center border border-sol-border/30 rounded-md overflow-hidden shrink-0">
        {FEED_WINDOWS.map((w) => (
          <button
            key={w.key}
            onClick={() => setWindowKey(w.key)}
            className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${w.key !== "24h" ? "border-l border-sol-border/30" : ""} ${windowKey === w.key ? "bg-sol-yellow/15 text-sol-text" : "text-sol-text-dim/50 hover:text-sol-text hover:bg-sol-bg-alt/50"}`}
          >
            {w.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function DaySection({ date, convs, hasTeam, onNavigate, compact, projectColors, onProjectFilter }: {
  date: string;
  convs: Conversation[];
  hasTeam: boolean;
  onNavigate?: (id: string) => void;
  compact?: boolean;
  projectColors: Record<string, string>;
  onProjectFilter?: (project: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const label = formatDate(date);

  const { projects, people, active } = useMemo(() => {
    const projSet = new Set<string>();
    const actorSet = new Set<string>();
    let act = 0;
    for (const c of convs) {
      const p = extractWorkspace(c.project_path);
      if (p) projSet.add(p);
      if (c.user_id) actorSet.add(c.user_id.toString());
      if (c.is_active) act++;
    }
    return { projects: [...projSet], people: actorSet.size, active: act };
  }, [convs]);

  return (
    <div className={compact ? "py-0.5" : "py-1"}>
      <div className="flex items-center gap-3 mb-2 cursor-pointer select-none" onClick={() => setCollapsed(!collapsed)}>
        <span className={`text-sol-text-dim/30 text-[10px] transition-transform ${collapsed ? "" : "rotate-90"}`}>&#x25B6;</span>
        <span className={`font-semibold tracking-tight text-sol-text ${compact ? "text-[13px]" : "text-[15px]"}`}>{label}</span>
        {active > 0 && (
          <span className="flex items-center gap-1 text-[9px] text-sol-green/60 font-medium">
            <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse" />{active} active
          </span>
        )}
        <div className="h-px flex-1 bg-sol-border/15" />
        <div className="flex items-center gap-2">
          {projects.slice(0, 4).map((p) => (
            <button
              key={p}
              onClick={(e) => { e.stopPropagation(); onProjectFilter?.(p); }}
              className={`font-mono rounded px-1 py-px text-[9px] hover:ring-1 hover:ring-sol-cyan/30 transition-all ${projectColors[p] || "bg-sol-bg-alt text-sol-text-dim/40"}`}
            >
              {p}
            </button>
          ))}
          <span className="text-sol-text-dim/30 tabular-nums text-[10px] flex items-center gap-1.5">
            {hasTeam && people > 1 && <span className="text-sol-text-dim/25">{people}p</span>}
            {convs.length}s
          </span>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-1.5">
          {convs.map((conv) => (
            <FeedCard
              key={conv._id}
              conv={conv}
              showActor={hasTeam}
              onNavigate={onNavigate}
              projectColor={projectColors[extractWorkspace(conv.project_path) || ""]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ActivityFeedProps {
  mode: "personal" | "team";
  teamId?: string;
  compact?: boolean;
  directoryFilter?: string | null;
  onNavigate?: (conversationId: string) => void;
  initialActorId?: string;
  hidePeopleRow?: boolean;
}

export function ActivityFeed({ mode, compact, directoryFilter, onNavigate, initialActorId, hidePeopleRow }: ActivityFeedProps) {
  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(initialActorId as Id<"users"> | undefined);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState("7d");
  const windowHours = FEED_WINDOWS.find((w) => w.key === windowKey)?.hours ?? 168;
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const filter: "my" | "team" = mode === "team" ? "team" : "my";

  // Top-level sessions only (subagentFilter "main" excludes orchestration workers).
  const { conversations, hasMore, loadMore, isLoading } = useConversationsWithError(filter, null, "main", directoryFilter ?? null, null);

  const isHovered = useRef(false);
  const { containerRef: flipContainerRef, beforeReorder } = useFlipAnimation();

  const visibleConvs = useMemo(() => {
    const since = Date.now() - windowHours * 3600000;
    const convs = (conversations as Conversation[]).filter((c) => {
      if ((c.updated_at ?? c.started_at ?? 0) < since) return false;
      if (actorFilter && c.user_id?.toString() !== actorFilter.toString()) return false;
      if (projectFilter && extractWorkspace(c.project_path) !== projectFilter) return false;
      if (c.visibility_mode === "summary" || c.visibility_mode === "minimal") return !isWarmupSession(c);
      return shouldShowSession(c, { excludeDefaultTitles: filter === "team" && !c.is_own });
    });
    convs.sort((a, b) => b.updated_at - a.updated_at);
    return convs;
  }, [conversations, windowHours, actorFilter, projectFilter, filter]);

  // Stable order (no hover jumping) + FLIP animation when sessions arrive/reorder.
  const stable = useStableOrder<Conversation>({
    items: visibleConvs,
    getKey: (c) => c._id,
    isHovered,
    onBeforeReorder: beforeReorder,
  });

  // People from the full window set (ignores actor filter) so the row stays
  // populated and a selection can always be cleared.
  const people = useMemo(() => {
    const since = Date.now() - windowHours * 3600000;
    const map = new Map<string, Person>();
    for (const c of conversations as Conversation[]) {
      if ((c.updated_at ?? c.started_at ?? 0) < since) continue;
      const id = c.user_id?.toString();
      if (!id) continue;
      const cur = map.get(id) || { id, name: c.author_name || "Unknown", image: c.author_avatar, sessions: 0 };
      cur.sessions += 1;
      map.set(id, cur);
    }
    return [...map.values()].sort((a, b) => b.sessions - a.sessions);
  }, [conversations, windowHours]);

  const projectColors = useProjectColors(stable);

  const days = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of stable) {
      const ts = c.updated_at || c.started_at || Date.now();
      const date = new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(c);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, convs]) => ({ date, convs }));
  }, [stable, tz]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore(); },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadMore]);

  if (isLoading && conversations.length === 0) return <LoadingSkeleton />;

  return (
    <div
      className={compact ? "space-y-2" : "space-y-3"}
      onMouseEnter={() => { isHovered.current = true; }}
      onMouseLeave={() => { isHovered.current = false; }}
    >
      <RollupHeader convs={visibleConvs} windowKey={windowKey} setWindowKey={setWindowKey} compact={compact} />

      {mode === "team" && !hidePeopleRow && (
        <PeopleRow people={people} onSelect={setActorFilter} selectedId={actorFilter} />
      )}

      {projectFilter && (
        <button
          onClick={() => setProjectFilter(null)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] bg-sol-bg-alt/60 text-sol-text-muted hover:text-sol-text transition-colors"
        >
          <span className="font-mono">{projectFilter}</span>
          <span className="text-sol-text-dim/40">×</span>
        </button>
      )}

      {stable.length === 0 ? (
        <EmptyState title="No sessions" description={actorFilter ? "No sessions for this person in this window." : "No sessions in this window."} />
      ) : (
        <div ref={flipContainerRef} className={compact ? "space-y-2" : "space-y-3"}>
          {days.map(({ date, convs }) => (
            <DaySection
              key={date}
              date={date}
              convs={convs}
              hasTeam={mode === "team"}
              onNavigate={onNavigate}
              compact={compact}
              projectColors={projectColors}
              onProjectFilter={setProjectFilter}
            />
          ))}
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-3">
              <span className="text-[10px] text-sol-text-dim/30 tabular-nums">loading more…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
