import { useMemo, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AvatarImg } from "../lib/avatarCache";
import { useQuery, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./ui/spinner";
import { useStableOrder } from "../hooks/useStableOrder";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { AgentIcon, type Conversation } from "./ConversationList";
import { ImageLightbox } from "./ImageGallery";
import { cleanTitle } from "../lib/conversationProcessor";
import { shouldShowSession, isWarmupSession } from "../lib/sessionFilters";
import { useInboxStore, useTrackedStore, sessionsWakeSig, isAgentActive, sortSessions, feedPagePersistence, isConvexId, type InboxSession } from "../store/inboxStore";
import { feedCoverMetaKey, newestTs, oldestTs, planFeedCatchup, walkStep, FEED_CATCHUP_PAGE_LIMIT, FEED_CATCHUP_MAX_PAGES } from "../lib/feedCatchup";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { ExternalEventRow } from "./feed/ExternalEventRow";
import { externalEventRowToExternalEvent, type ExternalEventRecord } from "../lib/externalEvents";
import { useExternalEvents, externalEventsNewestFirst } from "../hooks/useSyncExternalEvents";
import { FolderGit2 } from "lucide-react";
import type { CSSProperties } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
// The team-tinted card and accent text used by the share nudge below.
import "./team/teamFlow.css";

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
      <AvatarImg
        src={image}
        alt={name}
        className="w-full h-full object-cover"
        fallback={<span className={`w-full h-full flex items-center justify-center font-semibold ${AVATAR_BG[hashIndex(name, AVATAR_BG.length)]}`} style={{ fontSize: size * 0.5 }}>{initial}</span>}
      />
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
  // Row thumbnail for sessions that contain images — same pref as the inbox
  // session list (inbox_image_thumbs). Clicking it zooms the image, not the
  // session.
  const showImageThumb = useInboxStore((st) => st.clientState?.ui?.inbox_image_thumbs === true);
  const [thumbZoom, setThumbZoom] = useState(false);
  // Broken preview image → drop the slot entirely, otherwise the invisible
  // img reserves width and wraps the text early.
  const [thumbBroken, setThumbBroken] = useState(false);
  useEffect(() => setThumbBroken(false), [conv.image_preview_url]);
  const thumbUrl = showImageThumb && !thumbBroken ? conv.image_preview_url : null;

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
      <div className="px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
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
      {thumbUrl && (
        <button
          onClick={(e) => { e.stopPropagation(); setThumbZoom(true); }}
          className="shrink-0 self-center rounded-md overflow-hidden border border-sol-border/40 cursor-zoom-in"
          title="View image"
        >
          <img src={thumbUrl} alt="" loading="lazy" draggable={false} onError={() => setThumbBroken(true)} className="w-11 h-11 object-cover" />
        </button>
      )}
      {thumbZoom && thumbUrl && (
        <ImageLightbox src={thumbUrl} onClose={() => setThumbZoom(false)} />
      )}
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
      <Link
        href="/team/charts"
        className="ml-auto text-[11px] text-sol-cyan/60 hover:text-sol-cyan transition-colors whitespace-nowrap"
      >
        Charts
      </Link>
    </div>
  );
}

// One shared empty array, so a feed with no git events (the personal one) hands
// the memos below the same reference on every render instead of a new one.
const NO_EXTERNAL_EVENTS: ExternalEventRecord[] = [];

// A day holds two kinds of rows: the sessions it always held, and the team's
// git events from the same day. `ts` is what the two are ordered by.
type FeedEntry =
  | { kind: "conv"; ts: number; conv: Conversation }
  | { kind: "git"; ts: number; event: ExternalEventRecord };

// Place the git rows among the sessions by time WITHOUT reordering the
// sessions. Their order comes from the stable-order hook and from the inbox
// sort, and both must survive: a git row only takes a slot between two
// sessions it sits between in time.
function mergeDayEntries(convEntries: FeedEntry[], gitEntries: FeedEntry[]): FeedEntry[] {
  if (gitEntries.length === 0) return convEntries;
  const out: FeedEntry[] = [];
  let gi = 0;
  for (const conv of convEntries) {
    while (gi < gitEntries.length && gitEntries[gi].ts >= conv.ts) out.push(gitEntries[gi++]);
    out.push(conv);
  }
  while (gi < gitEntries.length) out.push(gitEntries[gi++]);
  return out;
}

function DaySection({ date, entries, showActor, onNavigate, compact, projectColors, onProjectFilter }: {
  date: string;
  entries: FeedEntry[];
  showActor: boolean;
  onNavigate?: (id: string) => void;
  compact?: boolean;
  projectColors: Record<string, string>;
  onProjectFilter?: (project: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const label = formatDate(date);

  const convs = useMemo(
    () => entries.flatMap((e) => (e.kind === "conv" ? [e.conv] : [])),
    [entries],
  );

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
          {entries.map((entry) =>
            entry.kind === "git" ? (
              <ExternalEventRow
                key={`git-${entry.event._id}`}
                event={externalEventRowToExternalEvent(entry.event)}
                density="feed"
              />
            ) : (
              <FeedCard
                key={entry.conv._id}
                conv={entry.conv}
                showActor={showActor}
                onNavigate={onNavigate}
                projectColor={projectColors[extractWorkspace(entry.conv.project_path) || ""]}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// Shared rendering for both sources: window/actor/project filter, live rollup,
// people row (team only), day grouping, FLIP animation, infinite scroll.
function FeedBody({ source, sourceConvs, externalEvents = NO_EXTERNAL_EVENTS, hasMore, loadMore, isLoading, isLoadingMore, onNavigate, compact, hidePeopleRow, initialActorId, shareNudge }: {
  source: "team" | "personal";
  sourceConvs: Conversation[];
  /** Team mode only: the git events to interleave into the day sections. */
  externalEvents?: ExternalEventRecord[];
  hasMore: boolean;
  loadMore: (opts?: { reconfirm?: boolean }) => void;
  isLoading: boolean;
  isLoadingMore?: boolean;
  onNavigate?: (id: string) => void;
  compact?: boolean;
  hidePeopleRow?: boolean;
  initialActorId?: string;
  /** Team mode: a push to share workspaces, shown while the viewer shares none. */
  shareNudge?: ReactNode;
}) {
  const showActor = source === "team";
  const showPeople = source === "team" && !hidePeopleRow;
  // The team query is calm; store.sessions (personal) churns on every heartbeat, so
  // we keep the inbox's stable order and skip the reshuffle animation — cards update
  // in place instead of flying around / overlapping mid-FLIP.
  const animate = source === "team";

  const [actorFilter, setActorFilter] = useState<Id<"users"> | undefined>(initialActorId as Id<"users"> | undefined);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  // Local state, not a saved preference: the ui prefs bag (ClientUI in
  // store/inboxStore.ts) is a closed type, so a saved key would mean editing
  // that file too.
  const [showGit, setShowGit] = useState(true);
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

  // External events get their own window so they never eat the session window: keep
  // the ones that fall inside the time span the shown sessions already cover,
  // capped so a busy repo cannot flood a quiet day. The same actor and project
  // filters apply, by the person who did it and by the repository name.
  const gitInView = useMemo(() => {
    if (externalEvents.length === 0) return NO_EXTERNAL_EVENTS;
    let floor = 0;
    for (const c of windowed) {
      const ts = c.updated_at || c.started_at || 0;
      if (ts && (floor === 0 || ts < floor)) floor = ts;
    }
    const proj = projectFilter?.toLowerCase();
    const actor = actorFilter?.toString();
    return externalEvents
      .filter((e) => {
        const ts = e.created_at ?? 0;
        if (!ts || ts < floor) return false;
        if (actor && e.actor_user_id?.toString() !== actor) return false;
        if (proj) {
          const repo = e.repository?.split("/").filter(Boolean).pop()?.toLowerCase();
          if (repo !== proj) return false;
        }
        return true;
      })
      .slice(0, 200);
  }, [externalEvents, windowed, actorFilter, projectFilter]);

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
    const dayKey = (ts: number) => new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });
    const convDays = new Map<string, FeedEntry[]>();
    for (const c of windowed) {
      const ts = c.updated_at || c.started_at || Date.now();
      const date = dayKey(ts);
      if (!convDays.has(date)) convDays.set(date, []);
      convDays.get(date)!.push({ kind: "conv", ts, conv: c });
    }
    const gitDays = new Map<string, FeedEntry[]>();
    if (showGit) {
      for (const e of gitInView) {
        const ts = e.created_at ?? 0;
        if (!ts) continue;
        const date = dayKey(ts);
        if (!gitDays.has(date)) gitDays.set(date, []);
        gitDays.get(date)!.push({ kind: "git", ts, event: e });
      }
    }
    const dates = new Set([...convDays.keys(), ...gitDays.keys()]);
    return [...dates]
      .sort((a, b) => b.localeCompare(a))
      .map((date) => ({
        date,
        entries: mergeDayEntries(
          convDays.get(date) ?? [],
          (gitDays.get(date) ?? []).sort((a, b) => b.ts - a.ts),
        ),
      }));
  }, [windowed, gitInView, showGit, tz]);

  // --- Infinite scroll. DashboardLayout nests the feed inside a scroll container
  // that varies by route, so a viewport-rooted IntersectionObserver doesn't fire;
  // we walk up from the sentinel to find the element that actually scrolls and
  // listen on it. Scroll-driven (not fired on mount) so a short/filtered list
  // never rip-loads every page; the isLoadingMore guard keeps loads sequential. ---
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastReconfirmAt = useRef(0);
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
      if (s.isLoadingMore) return;
      if (s.hasMore) { s.loadMore(); return; }
      // Believed end-of-history: a bottom-scroll still re-verifies it
      // (throttled), so a stale or poisoned persisted "end" can never strand
      // the feed — reaching the bottom always attempts to load more.
      const now = Date.now();
      if (now - lastReconfirmAt.current > 30_000) {
        lastReconfirmAt.current = now;
        s.loadMore({ reconfirm: true });
      }
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

      {shareNudge}

      {showPeople && <PeopleRow people={people} onSelect={setActorFilter} selectedId={actorFilter} />}

      {(projectFilter || externalEvents.length > 0) && (
        <div className="flex items-center gap-2">
          {projectFilter && (
            <button
              onClick={() => setProjectFilter(null)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] bg-sol-bg-alt/60 text-sol-text-muted hover:text-sol-text transition-colors"
            >
              <span className="font-mono">{projectFilter}</span>
              <span className="text-sol-text-dim/40">×</span>
            </button>
          )}
          {externalEvents.length > 0 && (
            <button
              onClick={() => setShowGit((v) => !v)}
              title={showGit ? "Hide events from GitHub and Linear" : "Show events from GitHub and Linear"}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] transition-colors ${showGit ? "bg-sol-bg-alt/60 text-sol-text-muted hover:text-sol-text" : "bg-sol-bg-alt/30 text-sol-text-dim/50 hover:text-sol-text-muted"}`}
            >
              <span className="font-mono">Git &amp; issues</span>
              <span className="tabular-nums text-sol-text-dim/40">{gitInView.length}</span>
            </button>
          )}
        </div>
      )}

      {displayConvs.length === 0 && days.length === 0 && !hasMore ? (
        <EmptyState
          title={source === "team" ? "No team sessions yet" : "No sessions"}
          description={
            actorFilter || projectFilter
              ? "No sessions match this filter."
              : source === "team"
                // A brand new team lands here. "No sessions in this window"
                // reads as a bug on a feed that has never had one; say what
                // fills it instead, in the same words the create flow used.
                ? "Sessions from the workspaces this team shares land here."
                : "No sessions in this window."
          }
        />
      ) : (
        <div ref={animate ? flipContainerRef : undefined} className={compact ? "space-y-2" : "space-y-3"}>
          {days.map(({ date, entries }) => (
            <DaySection
              key={date}
              date={date}
              entries={entries}
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
          {/* Always mounted — even at the believed end of history — so the
              scroll listener keyed off this node stays alive; that's what lets
              a bottom-scroll re-verify a persisted "end" instead of stranding
              the feed. The label only shows while there's known work to do. */}
          <div
            ref={sentinelRef}
            onClick={() => { if (canReveal) setRenderLimit((r) => r + 30); else if (!isLoadingMore) loadMore(hasMore ? undefined : { reconfirm: true }); }}
            className={`flex justify-center py-4 select-none ${canReveal || hasMore ? "cursor-pointer" : ""}`}
            title={canReveal || hasMore ? "Loads automatically as you scroll — click to load now" : undefined}
          >
            {isLoadingMore ? (
              <Spinner className="text-sol-text-dim/70" />
            ) : (canReveal || hasMore) && (
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-sol-text-dim/40">
                <span className="w-1 h-1 rounded-full bg-sol-text-dim/50" />
                more
              </span>
            )}
          </div>
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
// Shown in the team feed while the viewer shares no workspace with the team:
// their sessions are invisible to teammates, and this is the surface where that
// absence is felt. One click lands in the guided setup (visibility + repos).
function TeamShareNudge({ teamId }: { teamId: string }) {
  const router = useRouter();
  // The card belongs to one team, so it wears that team's color instead of a
  // fixed cyan. A user who just picked a color in the create flow lands here
  // and finds the same color waiting. Cyan stays the fallback.
  const color = useInboxStore(
    (s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId))?.icon_color,
  ) as string | undefined;
  return (
    <button
      type="button"
      onClick={() => router.push(`/settings/team/join?teamId=${teamId}&setup=1`)}
      style={color ? ({ "--tf-acc": `var(--sol-${color})` } as CSSProperties) : undefined}
      className="tf-accent-card w-full flex items-center gap-3 rounded-lg border px-4 py-3 text-left outline-none"
    >
      <FolderGit2 className="tf-accent-text h-4 w-4 shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-sol-text">Share your workspaces with the team</span>
        <span className="block text-xs text-sol-text-muted">
          Your sessions stay off this feed until you share the repos you work in.
        </span>
      </span>
      <span className="tf-accent-text shrink-0 text-sm font-medium">Set up sharing &rarr;</span>
    </button>
  );
}

function TeamFeed({ compact, directoryFilter, onNavigate, initialActorId, hidePeopleRow }: ActivityFeedProps) {
  const convex = useConvex();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  // Keyed by team+dir so a team/filter switch never mixes the wrong rows.
  const key = `${activeTeamId ?? ""}|${directoryFilter ?? ""}`;
  const cached = useInboxStore((s) => s.feedConversations[key]) as Conversation[] | undefined;
  const knownHasMore = useInboxStore((s) => s.feedHasMore[key]);
  const knownCursor = useInboxStore((s) => s.feedCursors[key]);
  const mergeFeed = useInboxStore((s) => s.mergeFeedConversations);
  const setFeedHasMore = useInboxStore((s) => s.setFeedHasMore);
  const setFeedCursor = useInboxStore((s) => s.setFeedCursor);

  const queryArgs = useMemo(() => ({
    filter: "team" as const,
    include_message_previews: true,
    activeTeamId: activeTeamId || undefined,
    subagentFilter: "main" as const,
    directoryFilter: directoryFilter || undefined,
  }), [activeTeamId, directoryFilter]);

  // Live newest page (reactive). Dump every result into the store; read it back.
  // A just-created team holds an optimistic stub id until the server echoes;
  // a stub is not an Id<"teams">, so skip for that window (the new team has
  // no server rows yet anyway).
  const stubTeam = !!activeTeamId && !isConvexId(String(activeTeamId));
  const live = useQuery(api.conversations.listConversations, stubTeam ? "skip" : queryArgs);

  // Enrichment only (the feed renders fine without it), so noThrow: a failure
  // means no nudge, never a broken feed.
  const mappings = useQueryNoThrow(
    api.users.getDirectoryTeamMappings,
    activeTeamId && !stubTeam ? {} : "skip",
  ).data as { team_id?: Id<"teams">; auto_share?: boolean }[] | undefined;
  const sharesNone =
    !!activeTeamId && !stubTeam && Array.isArray(mappings) &&
    !mappings.some((m) => m.team_id?.toString() === activeTeamId.toString() && m.auto_share);
  useEffect(() => {
    if (live) mergeFeed(key, live.conversations);
  }, [live, key, mergeFeed]);

  // --- Absence-gap catch-up (lib/feedCatchup). The cache only ever grows at
  // its ends (live head + deep "Load more" cursor), so time away opens a hole
  // in the middle that no scroll can reach — the feed then shows "Today, then
  // July" and looks exhaustive while silently missing weeks. On each app run,
  // once per key: check the live page against the persisted covered watermark
  // and, if they don't connect, walk pages from the head until they do. ---
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const catchupState = useRef<Record<string, "pending" | "walking" | "contiguous">>({});
  useEffect(() => {
    if (!hydrated || !live) return;
    const rows = (live.conversations ?? []) as Conversation[];
    // An empty live page is indistinguishable from an auth blip — decide
    // nothing from it (an empty team has no holes to miss).
    if (rows.length === 0) return;
    const top = newestTs(rows);
    const state = catchupState.current[key] ?? "pending";
    const stamp = () => {
      const st = useInboxStore.getState();
      const prev = st.syncMeta[feedCoverMetaKey(key)]?.cursor;
      if (top != null && (prev === undefined || top > prev)) st.recordSyncMeta(feedCoverMetaKey(key), { cursor: top });
    };
    if (state === "contiguous") {
      // The live subscription keeps the head covered while mounted — rows that
      // fall off the newest page are already cached — so every push advances
      // the watermark.
      stamp();
      return;
    }
    if (state === "walking") return;
    const coveredTo = useInboxStore.getState().syncMeta[feedCoverMetaKey(key)]?.cursor;
    const liveOldest = oldestTs(rows);
    const cached = (useInboxStore.getState().feedConversations[key] ?? []) as Conversation[];
    const plan = planFeedCatchup({
      coveredTo,
      livePageFull: rows.length >= FEED_PAGE_SIZE || live.nextCursor != null,
      liveOldest,
      cacheHasRowsBelowLive: liveOldest != null && cached.some((c) => (c.updated_at ?? 0) < liveOldest),
    });
    if (plan === "contiguous") {
      catchupState.current[key] = "contiguous";
      stamp();
      return;
    }
    catchupState.current[key] = "walking";
    (async () => {
      try {
        let cursor: string | null = live.nextCursor ?? null;
        let settled = cursor === null; // full page + no continuation = nothing below
        for (let hop = 0; hop < FEED_CATCHUP_MAX_PAGES && !settled && cursor !== null; hop++) {
          const page: { conversations?: unknown[]; nextCursor?: string | null } =
            await convex.query(api.conversations.listConversations, { ...queryArgs, cursor, limit: FEED_CATCHUP_PAGE_LIMIT });
          const pageRows = (page.conversations ?? []) as Conversation[];
          mergeFeed(key, pageRows);
          const step = walkStep({ coveredTo, pageOldest: oldestTs(pageRows), nextCursor: page.nextCursor ?? null });
          if (step === "abort") { catchupState.current[key] = "pending"; return; }
          if (step === "end") {
            // True end-of-history reached while filling the gap: the walk now
            // covers everything — record honest end for the scroll pagination.
            const persist = feedPagePersistence({ rowCount: pageRows.length, nextCursor: null });
            if (persist.cursor !== undefined) setFeedCursor(key, persist.cursor);
            setFeedHasMore(key, persist.hasMore);
          }
          if (step !== "continue") settled = true;
          else cursor = page.nextCursor ?? null;
        }
        if (!settled && cursor !== null) {
          // Budget spent above the covered band (giant gap, or a legacy cache
          // with no watermark): adopt the walk frontier as the new deep cursor.
          // Deeper cached rows stay visible, and scrolling re-examines
          // everything below the frontier (dupes merge), so nothing is skipped.
          setFeedCursor(key, cursor);
          setFeedHasMore(key, true);
        }
        catchupState.current[key] = "contiguous";
        stamp();
      } catch {
        catchupState.current[key] = "pending"; // transient — retry on the next live push
      }
    })();
  }, [live, key, hydrated, convex, queryArgs, mergeFeed, setFeedCursor, setFeedHasMore]);
  // Seed "older pages remain" once; afterwards loadMore maintains it. A full
  // first page (or a non-null cursor) means older pages exist; < a full page
  // means we already have everything.
  const liveHasMore = live != null && (((live.conversations?.length ?? 0) >= FEED_PAGE_SIZE) || live.nextCursor != null);
  useEffect(() => {
    if (live && knownHasMore === undefined) setFeedHasMore(key, liveHasMore);
  }, [live, key, knownHasMore, liveHasMore, setFeedHasMore]);

  // Load older pages imperatively. Merges into the same accumulating store, so
  // a reload never forces a re-walk of cached pages. Two guarantees keep the
  // bottom of the feed alive:
  //   • Drain: a page can overlap rows the client already has (legacy-cursor
  //     resume, gap re-covers) — zero NEW rows renders zero new pixels, and a
  //     user parked at the bottom gets no further scroll events, so one dupe
  //     page used to read as "load more does nothing". Keep pulling (bounded)
  //     until something fresh lands or the continuation runs out.
  //   • Reconfirm: bypasses the persisted end-of-history and retries from the
  //     oldest cached row, so a latched null (auth-blip empty page, pre-fix
  //     poison) heals on the next bottom-scroll instead of stranding the feed.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(async (opts?: { reconfirm?: boolean }) => {
    if (loadingMore) return;
    if (knownCursor === null && !opts?.reconfirm) return; // believed end-of-history
    const liveRows = (useInboxStore.getState().feedConversations[key] ?? []) as Conversation[];
    if (!liveRows.length) return;
    const oldest = liveRows[liveRows.length - 1]?.updated_at;
    const fallback = oldest != null ? String(oldest) : null;
    const start = opts?.reconfirm ? fallback : knownCursor ?? fallback;
    if (start == null) return;
    let cursor: string = start;
    setLoadingMore(true);
    try {
      const seen = new Set(liveRows.map((c) => c._id));
      for (let hop = 0; hop < 5; hop++) {
        // Bigger pages than the live query's 20: crossing a band the client
        // already has (per-member cursor re-serves) costs hops, not pixels.
        const page: { conversations?: unknown[]; nextCursor?: string | null } =
          await convex.query(api.conversations.listConversations, { ...queryArgs, cursor, limit: FEED_CATCHUP_PAGE_LIMIT });
        const rows = (page.conversations ?? []) as Conversation[];
        mergeFeed(key, rows);
        const next = page.nextCursor ?? null;
        const persist = feedPagePersistence({ rowCount: rows.length, nextCursor: next });
        if (persist.cursor !== undefined) setFeedCursor(key, persist.cursor);
        setFeedHasMore(key, persist.hasMore);
        const fresh = rows.some((c) => !seen.has(c._id));
        rows.forEach((c) => seen.add(c._id));
        if (fresh || next == null) break;
        cursor = next;
      }
    } catch {
      // Leave the cache + affordance intact; a transient failure can be retried.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, knownCursor, convex, queryArgs, key, mergeFeed, setFeedCursor, setFeedHasMore]);

  const sourceConvs = useMemo(() => (cached ?? []).filter((c) => {
    if (c.visibility_mode === "summary" || c.visibility_mode === "minimal") return !isWarmupSession(c);
    return shouldShowSession(c, { excludeDefaultTitles: !c.is_own });
  }), [cached]);

  // Read the store the team feeder fills; the feeder itself is mounted globally.
  const externalEvents = useExternalEvents(undefined, externalEventsNewestFirst);

  return (
    <FeedBody
      source="team"
      sourceConvs={sourceConvs}
      externalEvents={externalEvents}
      hasMore={knownCursor === null ? false : (knownHasMore ?? liveHasMore)}
      loadMore={loadMore}
      isLoadingMore={loadingMore}
      isLoading={!cached?.length && live === undefined}
      onNavigate={onNavigate}
      compact={compact}
      hidePeopleRow={hidePeopleRow}
      initialActorId={initialActorId}
      shareNudge={sharesNone ? <TeamShareNudge teamId={String(activeTeamId)} /> : undefined}
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
    image_preview_url: s.image_preview_url ?? null,
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
  // Wake only on STRUCTURAL session change (bucket/order/identity), not on every ~1s
  // liveness heartbeat. Subscribing to the raw s.sessions map re-ran sortSessions
  // (O(N log N)) + filter + map on every tick even though the order was stable. The
  // memo below reads s.sessions for the data; this only gates the re-render. See
  // store/wakeSig.ts.
  const s = useTrackedStore([(st) => sessionsWakeSig(st.sessions)]);
  const sessions = s.sessions;
  // The mapped conversations carry time-driven fields (duration_ms, live status). A
  // structural wake alone would freeze those between changes, so refresh on a coarse
  // 15s clock — same cadence the inbox sidebar uses — instead of the heartbeat.
  const coarseNow = useCoarseNow(15_000);
  const sourceConvs = useMemo(() => {
    const dirLeaf = directoryFilter ? directoryFilter.split("/").filter(Boolean).pop() : null;
    // sortSessions gives the inbox's stable order (pinned/active/idle) and already
    // drops dismissed — keep that order so the feed doesn't churn on heartbeats.
    return sortSessions(sessions)
      .filter((sess) => !sess.is_subagent)
      .filter((sess) => {
        if (!dirLeaf) return true;
        const path = sess.git_root || sess.project_path;
        return !!path && path.split("/").filter(Boolean).includes(dirLeaf);
      })
      .map(inboxSessionToConv);
    // coarseNow: re-run on the coarse clock so time-driven fields stay fresh without
    // riding heartbeat churn (categorize memo in SessionListPanel does the same).
  }, [sessions, directoryFilter, coarseNow]);
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
