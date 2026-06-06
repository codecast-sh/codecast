import { useMemo, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useStableOrder } from "../hooks/useStableOrder";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { AgentIcon, type Conversation } from "./ConversationList";
import { cleanTitle } from "../lib/conversationProcessor";
import { shouldShowSession, isWarmupSession } from "../lib/sessionFilters";
import { useInboxStore, isAgentActive, sortSessions, type InboxSession } from "../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

// Activity feed. Two sources, one rendering (FeedBody):
//   • personal mode → a VIEW over store.sessions (the liberal delta cache that the
//     inbox already syncs) — no redundant server query, instant from cache.
//   • team mode → listConversations(filter=team), which correctly unions visible
//     members. (store.sessions is user-scoped, so it can't back the team feed; a
//     separate team-scoped feedSessions cache is the eventual source — pl-89.)
// Subagents excluded; pregenerated summaries shown by default; reuses the Raw
// feed's stable-order + FLIP "slide in" hooks. FeedCard is shared (tasks/docs too).

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

// Heat scale: bigger / longer sessions get a warmer color (color only — same
// size and weight as the rest of the meta row). Tier 0 = quiet (matches the dim
// row), climbing cyan → green → yellow → orange → red. Kept subdued on purpose.
const HEAT_COLOR = [
  "text-sol-text-dim/45", "text-sol-cyan/60", "text-sol-green/65",
  "text-sol-yellow/70", "text-sol-orange/70", "text-sol-red/70",
];
const MSG_BREAKS = [25, 75, 150, 350, 700];
const DUR_MIN_BREAKS = [10, 30, 90, 240, 600];

function heatTier(value: number, breaks: number[]): number {
  let t = 0;
  for (const b of breaks) { if (value >= b) t++; else break; }
  return t;
}

function HeatStat({ value, breaks, children }: { value: number; breaks: number[]; children: ReactNode }) {
  return <span className={`tabular-nums ${HEAT_COLOR[heatTier(value, breaks)]}`}>{children}</span>;
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
// Shared across the feed, tasks/[id], and docs/[id] — keep it exported and stable.
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

  // Expandable summary: show the full text on demand. We only surface the toggle
  // when the 2-line clamp actually truncates (measured while collapsed) — so
  // short summaries stay clean and never sprout a no-op button.
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const el = summaryRef.current;
    if (!el || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [summary, expanded]);

  return (
    <div
      data-flip-key={conv._id}
      onClick={() => (onNavigate ? onNavigate(conv._id) : router.push(`/conversation/${conv._id}`))}
      className="group relative cursor-pointer rounded-lg border border-sol-border/25 bg-sol-card hover:bg-sol-card-hover hover:border-sol-border/50 shadow-sm hover:shadow transition-all overflow-hidden"
    >
      {isActive && <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-sol-green/60" />}
      <div className="px-4 py-3">
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
          <p
            ref={summaryRef}
            className={`mt-1 text-[11.5px] leading-relaxed text-sol-text-muted/85 whitespace-pre-line break-words ${expanded ? "" : "line-clamp-2"}`}
          >
            {summary}
          </p>
        )}
        {(clamped || expanded) && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="mt-0.5 flex items-center gap-1 text-[10px] font-mono text-sol-text-dim/50 hover:text-sol-yellow transition-colors"
          >
            <span className={`inline-block transition-transform ${expanded ? "rotate-180" : ""}`}>&#x25BE;</span>
            {expanded ? "less" : "more"}
          </button>
        )}

        <div className="mt-1.5 flex items-center gap-x-2.5 gap-y-1 text-[10px] font-mono text-sol-text-dim/40 flex-wrap">
          {showActor && author && <span className="text-sol-text-dim/55">{author}</span>}
          {project && <span className={`rounded px-1 py-px ${projectColor || "text-sol-text-dim/45"}`}>{project}</span>}
          {msgs > 0 && <HeatStat value={msgs} breaks={MSG_BREAKS}>{formatMsgCount(msgs)} msg</HeatStat>}
          {dur && <HeatStat value={conv.duration_ms / 60000} breaks={DUR_MIN_BREAKS}>{dur}</HeatStat>}
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

// Server-side page size for listConversations (its default `limit`). A live page
// at least this long implies older pages exist.
const FEED_PAGE_SIZE = 20;

// Live overview, recomputed from the loaded session set every render — never stale.
function RollupHeader({ convs, compact }: {
  convs: Conversation[];
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
    </div>
  );
}

function DaySection({ date, convs, showActor, onNavigate, compact, projectColors, onProjectFilter }: {
  date: string;
  convs: Conversation[];
  showActor: boolean;
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
            {showActor && people > 1 && <span className="text-sol-text-dim/25">{people}p</span>}
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
              showActor={showActor}
              onNavigate={onNavigate}
              projectColor={projectColors[extractWorkspace(conv.project_path) || ""]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Shared rendering for both sources: window/actor/project filter, live rollup,
// people row (team only), day grouping, FLIP animation, infinite scroll.
function FeedBody({ source, sourceConvs, hasMore, loadMore, isLoading, isLoadingMore, onNavigate, compact, hidePeopleRow, initialActorId }: {
  source: "team" | "personal";
  sourceConvs: Conversation[];
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  isLoadingMore?: boolean;
  onNavigate?: (id: string) => void;
  compact?: boolean;
  hidePeopleRow?: boolean;
  initialActorId?: string;
}) {
  const showActor = source === "team";
  const showPeople = source === "team" && !hidePeopleRow;
  // The team query is calm; store.sessions (personal) churns on every heartbeat, so
  // we keep the inbox's stable order and skip the reshuffle animation — cards update
  // in place instead of flying around / overlapping mid-FLIP.
  const animate = source === "team";

  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(initialActorId as Id<"users"> | undefined);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const isHovered = useRef(false);
  const { containerRef: flipContainerRef } = useFlipAnimation();

  // No time-window cut: the feed paginates through full history (day-grouped), so
  // a window would hide every older page "Load more" fetches. Only actor/project
  // filters apply here.
  const visibleConvs = useMemo(() => {
    const list = sourceConvs.filter((c) => {
      if (actorFilter && c.user_id?.toString() !== actorFilter.toString()) return false;
      if (projectFilter && extractWorkspace(c.project_path) !== projectFilter) return false;
      return true;
    });
    if (animate) list.sort((a, b) => b.updated_at - a.updated_at); // personal keeps sortSessions order
    return list;
  }, [sourceConvs, actorFilter, projectFilter, animate]);

  // Stable order (no reshuffle churn) but NO FLIP animation: with full-history
  // pagination the list can be hundreds of cards, and re-measuring every card's
  // rect on each live update would stutter badly. (Personal feed already omits it.)
  const stableOrdered = useStableOrder<Conversation>({
    items: visibleConvs,
    getKey: (c) => c._id,
    isHovered,
    onBeforeReorder: undefined,
  });
  const displayConvs = animate ? stableOrdered : visibleConvs;

  // Render a growing window of the (possibly large) cached list, not all of it.
  // Scrolling reveals more from cache INSTANTLY (renderLimit++), and only hits the
  // server once the window reaches the end of what's cached — so scroll feels
  // immediate even when the backend is slow, and the DOM stays light.
  const [renderLimit, setRenderLimit] = useState(40);
  useEffect(() => { setRenderLimit(40); }, [actorFilter, projectFilter]);
  const windowed = useMemo(() => displayConvs.slice(0, renderLimit), [displayConvs, renderLimit]);
  const canReveal = renderLimit < displayConvs.length;

  // People from the full window set (ignores actor filter) so the row stays
  // populated and a selection can always be cleared.
  const people = useMemo(() => {
    if (!showPeople) return [];
    const map = new Map<string, Person>();
    for (const c of sourceConvs) {
      const id = c.user_id?.toString();
      if (!id) continue;
      const cur = map.get(id) || { id, name: c.author_name || "Unknown", image: c.author_avatar, sessions: 0 };
      cur.sessions += 1;
      map.set(id, cur);
    }
    return [...map.values()].sort((a, b) => b.sessions - a.sessions);
  }, [sourceConvs, showPeople]);

  const projectColors = useProjectColors(displayConvs);

  const days = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of windowed) {
      const ts = c.updated_at || c.started_at || Date.now();
      const date = new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(c);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, convs]) => ({ date, convs }));
  }, [windowed, tz]);

  // --- Infinite scroll. DashboardLayout nests the feed inside a scroll container
  // that varies by route, so a viewport-rooted IntersectionObserver doesn't fire;
  // we walk up from the sentinel to find the element that actually scrolls and
  // listen on it. Scroll-driven (not fired on mount) so a short/filtered list
  // never rip-loads every page; the isLoadingMore guard keeps loads sequential. ---
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollState = useRef({ canReveal, hasMore, isLoadingMore, loadMore });
  scrollState.current = { canReveal, hasMore, isLoadingMore, loadMore };
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // Capture-phase scroll listener on the document so it fires no matter which
    // nested container scrolls (the feed's scroll parent varies by route), keyed
    // off the sentinel's viewport position. When near the sentinel: reveal more
    // cached rows first (instant), and only fetch older pages from the server once
    // the cache is exhausted.
    const maybeLoad = () => {
      const s = scrollState.current;
      const rect = el.getBoundingClientRect();
      if (rect.top >= window.innerHeight + 1200) return;
      if (s.canReveal) { setRenderLimit((r) => r + 30); return; }
      if (s.hasMore && !s.isLoadingMore) s.loadMore();
    };
    document.addEventListener("scroll", maybeLoad, { capture: true, passive: true });
    window.addEventListener("resize", maybeLoad, { passive: true });
    maybeLoad(); // top up if the sentinel is already in view (content shorter than viewport)
    return () => {
      document.removeEventListener("scroll", maybeLoad, { capture: true });
      window.removeEventListener("resize", maybeLoad);
    };
  }, [canReveal, hasMore, displayConvs.length]);

  if (isLoading && sourceConvs.length === 0) return <LoadingSkeleton />;

  return (
    <div
      className={compact ? "space-y-2" : "space-y-3"}
      onMouseEnter={() => { isHovered.current = true; }}
      onMouseLeave={() => { isHovered.current = false; }}
    >
      <RollupHeader convs={visibleConvs} compact={compact} />

      {showPeople && <PeopleRow people={people} onSelect={setActorFilter} selectedId={actorFilter} />}

      {projectFilter && (
        <button
          onClick={() => setProjectFilter(null)}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] bg-sol-bg-alt/60 text-sol-text-muted hover:text-sol-text transition-colors"
        >
          <span className="font-mono">{projectFilter}</span>
          <span className="text-sol-text-dim/40">×</span>
        </button>
      )}

      {displayConvs.length === 0 && !hasMore ? (
        <EmptyState title="No sessions" description={actorFilter || projectFilter ? "No sessions match this filter." : "No sessions in this window."} />
      ) : (
        <div ref={animate ? flipContainerRef : undefined} className={compact ? "space-y-2" : "space-y-3"}>
          {days.map(({ date, convs }) => (
            <DaySection
              key={date}
              date={date}
              convs={convs}
              showActor={showActor}
              onNavigate={onNavigate}
              compact={compact}
              projectColors={projectColors}
              onProjectFilter={setProjectFilter}
            />
          ))}
          {/* A filter can hide every loaded session while older pages still hold
              matches — keep "Load more" reachable so any filter can paginate. */}
          {displayConvs.length === 0 && (
            <p className="text-center text-[11px] text-sol-text-dim/50 py-3">
              {actorFilter || projectFilter ? "No matches in the sessions loaded so far." : "No sessions yet."}
            </p>
          )}
          {(canReveal || hasMore) && (
            <div
              ref={sentinelRef}
              onClick={() => { if (canReveal) setRenderLimit((r) => r + 30); else if (!isLoadingMore) loadMore(); }}
              className="flex justify-center py-4 cursor-pointer select-none"
              title="Loads automatically as you scroll — click to load now"
            >
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-sol-text-dim/40">
                <span className={`w-1 h-1 rounded-full bg-sol-text-dim/50 ${isLoadingMore ? "animate-pulse" : ""}`} />
                {isLoadingMore ? "loading more…" : "more"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Team source: an accumulating, IDB-persisted cache in inboxStore IS the read
// surface. The live listConversations query (newest page) and "Load more" (older
// pages) both dump into it; the feed renders from the store. The older-page cursor
// is derived from the oldest cached row, so pagination resumes across reloads
// instead of re-walking pages already cached. ---
function TeamFeed({ compact, directoryFilter, onNavigate, initialActorId, hidePeopleRow }: ActivityFeedProps) {
  const convex = useConvex();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  // Keyed by team+dir so a team/filter switch never mixes the wrong rows.
  const key = `${activeTeamId ?? ""}|${directoryFilter ?? ""}`;
  const cached = useInboxStore((s) => s.feedConversations[key]) as Conversation[] | undefined;
  const knownHasMore = useInboxStore((s) => s.feedHasMore[key]);
  const mergeFeed = useInboxStore((s) => s.mergeFeedConversations);
  const setFeedHasMore = useInboxStore((s) => s.setFeedHasMore);

  const queryArgs = useMemo(() => ({
    filter: "team" as const,
    include_message_previews: true,
    activeTeamId: activeTeamId || undefined,
    subagentFilter: "main" as const,
    directoryFilter: directoryFilter || undefined,
  }), [activeTeamId, directoryFilter]);

  // Live newest page (reactive). Dump every result into the store; read it back.
  const live = useQuery(api.conversations.listConversations, queryArgs);
  useEffect(() => {
    if (live) mergeFeed(key, live.conversations);
  }, [live, key, mergeFeed]);
  // Seed "older pages remain" once; afterwards loadMore maintains it. A full
  // first page (or a non-null cursor) means older pages exist; < a full page
  // means we already have everything.
  const liveHasMore = live != null && (((live.conversations?.length ?? 0) >= FEED_PAGE_SIZE) || live.nextCursor != null);
  useEffect(() => {
    if (live && knownHasMore === undefined) setFeedHasMore(key, liveHasMore);
  }, [live, key, knownHasMore, liveHasMore, setFeedHasMore]);

  // Load older pages imperatively, paginating from the oldest cached row's
  // timestamp (the server pages by updated_at < cursor). Merges into the same
  // accumulating store, so a reload never forces a re-walk of cached pages.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(async () => {
    if (loadingMore || !cached?.length) return;
    const oldest = cached[cached.length - 1]?.updated_at;
    if (oldest == null) return;
    setLoadingMore(true);
    try {
      const page = await convex.query(api.conversations.listConversations, { ...queryArgs, cursor: String(oldest) });
      const rows = (page.conversations ?? []) as Conversation[];
      const existing = new Set((cached ?? []).map((c) => c._id));
      const fresh = rows.filter((c) => !existing.has(c._id));
      mergeFeed(key, rows);
      // Trust "did we get genuinely older rows", NOT the server's nextCursor — the
      // team per-member merge nulls nextCursor on small pages even when older
      // sessions remain, which otherwise stops pagination after a single page.
      setFeedHasMore(key, fresh.length > 0);
    } catch {
      // Leave the cache + affordance intact; a transient failure can be retried.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, cached, convex, queryArgs, key, mergeFeed, setFeedHasMore]);

  const sourceConvs = useMemo(() => (cached ?? []).filter((c) => {
    if (c.visibility_mode === "summary" || c.visibility_mode === "minimal") return !isWarmupSession(c);
    return shouldShowSession(c, { excludeDefaultTitles: !c.is_own });
  }), [cached]);

  return (
    <FeedBody
      source="team"
      sourceConvs={sourceConvs}
      hasMore={knownHasMore ?? liveHasMore}
      loadMore={loadMore}
      isLoadingMore={loadingMore}
      isLoading={!cached?.length && live === undefined}
      onNavigate={onNavigate}
      compact={compact}
      hidePeopleRow={hidePeopleRow}
      initialActorId={initialActorId}
    />
  );
}

// Map an inbox session into the card shape: subtitle||idle_summary for the
// summary, derive liveness from agent_status, duration from started/updated.
function inboxSessionToConv(s: InboxSession): Conversation {
  const started = s.started_at ?? s.updated_at;
  return {
    _id: s._id,
    user_id: "",
    title: s.title,
    subtitle: s.subtitle ?? s.idle_summary ?? null,
    project_path: s.project_path ?? null,
    git_root: s.git_root ?? null,
    git_branch: s.git_branch ?? null,
    agent_type: s.agent_type,
    message_count: s.message_count,
    started_at: started,
    updated_at: s.updated_at,
    duration_ms: Math.max(0, s.updated_at - started),
    is_active: isAgentActive(s),
    author_name: "",
    is_own: true,
    visibility_mode: "full",
  } as Conversation;
}

// --- Personal source: a view over store.sessions (the liberal delta cache). ---
function PersonalFeed({ compact, directoryFilter, onNavigate }: ActivityFeedProps) {
  const sessions = useInboxStore((s) => s.sessions);
  const sourceConvs = useMemo(() => {
    const dirLeaf = directoryFilter ? directoryFilter.split("/").filter(Boolean).pop() : null;
    // sortSessions gives the inbox's stable order (pinned/active/idle) and already
    // drops dismissed — keep that order so the feed doesn't churn on heartbeats.
    return sortSessions(sessions)
      .filter((s) => !s.is_subagent)
      .filter((s) => {
        if (!dirLeaf) return true;
        const path = s.git_root || s.project_path;
        return !!path && path.split("/").filter(Boolean).includes(dirLeaf);
      })
      .map(inboxSessionToConv);
  }, [sessions, directoryFilter]);
  return (
    <FeedBody
      source="personal"
      sourceConvs={sourceConvs}
      hasMore={false}
      loadMore={() => {}}
      isLoading={false}
      onNavigate={onNavigate}
      compact={compact}
    />
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

export function ActivityFeed(props: ActivityFeedProps) {
  return props.mode === "team" ? <TeamFeed {...props} /> : <PersonalFeed {...props} />;
}
