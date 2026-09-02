import { useTeamFeature, useCallsAvailable } from "../lib/teamFeatures";
import type { TeamFeatureKey } from "@codecast/shared/contracts";
import { useState, useCallback, useMemo, useRef, memo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useShortcutAction, useShortcuts, isMac, type ShortcutAction } from "../shortcuts";
import { useTheme } from "./ThemeProvider";
import { KeyCap, MenuKeyCaps } from "./KeyboardShortcutsHelp";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Command as CommandPrimitive } from "cmdk";
import { cleanTitle } from "../lib/conversationProcessor";
import { AvatarImg } from "../lib/avatarCache";
import { canControlModel, modelOptionKey } from "../lib/modelSwitch";
import { commitModelChange } from "../lib/modelSwitchWeb";
import { AGENT_MODEL_CONFIG, modelAgentKey, dynamicModelOption } from "@codecast/shared/contracts";
import { useDynamicModels } from "../hooks/useDynamicModels";
import { useVaultStore } from "../store/vaultStore";
import { filesHref } from "../lib/vault/vaultHref";
import { useInboxStore, isConvexId, InboxSession, TaskItem, DocItem, BucketItem, BucketAssignmentItem, placeInboxRows, filterInboxScopeFromState, convBucketMap, sortLabels, computeChipCounts, getProjectName, RecentVisit, selectSessionRailOpen, sessionRowFromSummary } from "../store/inboxStore";
import { resolveRecentVisits, visitTimeAgo, VISIT_OBJECT_LABEL, type ResolvedVisit } from "../lib/recentVisits";
import { inActiveWorkspace } from "../lib/workspaceScope";
import { RecentVisitGlyph } from "./RecentVisitRow";
import { useOpenRecentVisit } from "../hooks/useOpenRecentVisit";
import { isNonTabRoute } from "../src/compat/tabRouting";
import { score, matchScore } from "../hooks/useMentionQuery";
import { dmOtherIds } from "@codecast/shared/chat";
import { channelDisplayName, dmCounterpart, memberName } from "../lib/chatViews";
import { memberAvatarUrl, memberDisplayName } from "../lib/liveEntities";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useCollectionRows } from "../hooks/useCollectionRows";
import { triggerSig, useSyncTriggers } from "../hooks/useSyncTriggers";
import { POP_OUT_PEOPLE_TITLE, isElectron, isPeopleWindow } from "../lib/desktop";
import { stageIsSplit } from "../hooks/useStageShortcuts";
import {
  Columns2 as StageSplitGlyph,
  SquareX as StageCloseGlyph,
  Maximize2 as StageExpandGlyph,
  ChevronsRight as StageNextGlyph,
} from "lucide-react";
import { popOutPeople } from "./people/popOutPeople";
import { isInboxRoute } from "../lib/inboxRouting";
import { sortedWorkbenches, switchToWorkbench } from "../lib/workbenchSwitch";
import type { WorkbenchSnapshot } from "../store/workbench";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { getLabelColor, DEFAULT_LABELS } from "../lib/labelColors";
import { toast } from "sonner";
import { undoableArchiveDoc, undoableHideSession, undoableDeferSession, undoableDormantSession } from "../store/undoActions";
import { useTriggerKillNotice } from "../hooks/useTriggerKillNotice";
import { STATUS_OPTIONS, PRIORITY_OPTIONS, PLAN_STATUS_OPTIONS, DOC_TYPE_OPTIONS } from "./menus/entityOptions";
import { statusByKey, statusEntityOptions, statusWriteFields, taskStatusKey, useTeamTaskStatusList } from "../lib/taskStatuses";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  PauseCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  FileText,
  Pin,
  PinOff,
  Archive,
  Copy,
  Trash2,
  Tag,
  User,
  Bot,
  Check,
  Search,
  ListTodo,
  Map as MapIcon,
  Square,
  Clock,
  ExternalLink,
  Pencil,
  Cpu,
  Filter,
  MessageSquare,
  Hash,
  Lock,
  Folder,
  Star,
  Link as LinkIcon,
  Shuffle,
  CalendarDays,
  Waypoints,
  FilePlus2,
  Terminal,
  Moon,
  Sun,
  PanelLeft,
  PanelRight,
  Keyboard,
  Rows3,
  Focus,
  Repeat,
  Zap,
  CornerDownRight,
  Headphones,
  PictureInPicture2,
  Users,
  Sparkles,
  LayoutDashboard,
  Plus,
  RefreshCw,
  EyeOff,
  PanelBottom,
} from "lucide-react";
import { AnchorGlyph } from "./anchor/AnchorIdentity";
import { isTriageBarCompact } from "./triage/graduation";
import { setTaskParent, closeTaskWithGuard } from "../lib/taskActions";
import type { PalettePickKind, PalettePickTarget } from "../lib/palettePick";

const api = _api as any;

type ActionMode = "status" | "priority" | "labels" | "assign" | "type" | "plan_status" | "agent_run" | "bucket" | "model" | "view" | "parent" | "layout_save" | "layout_update" | "layout_rename" | "layout_delete";

// Modes that act on the WORKSPACE rather than on selected rows: they open with
// no target and show no entity header. Everything else needs something picked.
const TARGETLESS_MODES = new Set<ActionMode>(["view", "layout_save", "layout_update", "layout_rename", "layout_delete"]);

// The layout modes all pick from (or name) a saved workbench.
const isLayoutMode = (m: ActionMode) => m.startsWith("layout_");

const DEFAULT_AGENT_RUN_MESSAGE = "lets do this task";

function isTask(item: any): item is TaskItem {
  return item && "status" in item && "short_id" in item;
}

// Status key → {label,color}, derived from the option arrays above so the
// palette's entity rows reuse the same labels/colors as the action submenus.
const TASK_STATUS_META: Record<string, { label: string; color: string }> =
  Object.fromEntries(STATUS_OPTIONS.map((o) => [o.key, { label: o.label, color: o.color ?? "" }]));
const PLAN_STATUS_META: Record<string, { label: string; color: string }> =
  Object.fromEntries(PLAN_STATUS_OPTIONS.map((o) => [o.key, { label: o.label, color: o.color ?? "" }]));


const AGENT_OPTIONS = [
  { key: "agent:claude_code", label: "Claude Code" },
  { key: "agent:codex", label: "Codex" },
  { key: "agent:cursor", label: "Cursor" },
  { key: "agent:gemini", label: "Gemini" },
  { key: "agent:opencode", label: "OpenCode" },
  { key: "agent:pi", label: "pi" },
  { key: "agent:grok", label: "Grok" },
];

const AGENT_COLORS: Record<string, string> = {
  "agent:codex": "text-blue-400",
  "agent:cursor": "text-purple-400",
  "agent:gemini": "text-amber-400",
  "agent:opencode": "text-orange-400",
  "agent:pi": "text-teal-400",
  "agent:grok": "text-sol-text",
};

// Ranked by expected use. `secondary` pages are reachable only by typing —
// they'd otherwise pad the empty-palette view that lives or dies by scan speed.
const NAV_PAGES: ReadonlyArray<{
  label: string;
  path: string;
  icon: string;
  keywords: string;
  secondary?: boolean;
  /** Only listed while the active team has this opt-in feature on. */
  feature?: TeamFeatureKey;
}> = [
  { label: "Dashboard", path: "/team/activity", icon: "grid", keywords: "home sessions main activity feed team" },
  { label: "Inbox", path: "/inbox", icon: "inbox", keywords: "idle queue waiting" },
  { label: "Threads", path: "/threads", icon: "message", keywords: "threads replies comments conversations unread mentions dms" },
  { label: "Chat", path: "/chat", icon: "message", keywords: "channels team talk messages rooms", feature: "chat" },
  { label: "Tasks", path: "/tasks", icon: "check", keywords: "todo work items" },
  { label: "Plans", path: "/plans", icon: "map", keywords: "roadmap goals milestones planning" },
  { label: "Calls", path: "/calls", icon: "phone", keywords: "huddle call transcript recording meeting summary voice", feature: "calls" },
  { label: "Documents", path: "/docs", icon: "file", keywords: "notes plans specs" },
  { label: "Files", path: "/files", icon: "folder", keywords: "notes markdown obsidian files vault code" },
  { label: "Triggers", path: "/triggers", icon: "clock", keywords: "schedules cron automation recurring followup reminders" },
  { label: "Capabilities", path: "/capabilities", icon: "grid", keywords: "skills mcp plugins drift machines library apps connect" },
  { label: "Pages", path: "/pages", icon: "file", keywords: "published html artifacts share cast publish gallery" },
  { label: "Team Charts", path: "/team/charts", icon: "grid", keywords: "activity punchcard heatmap hours messages typed sends members stats graphs" },
  { label: "Team Directory", path: "/team", icon: "grid", keywords: "members people profiles directory roster" },
  { label: "Search", path: "/search", icon: "search", keywords: "find query" },
  { label: "Settings", path: "/settings", icon: "settings", keywords: "preferences config profile general" },
  { label: "Workflows", path: "/workflows", icon: "workflow", keywords: "orchestration runs graph dot gates", secondary: true },
  { label: "Live Sessions", path: "/sessions", icon: "session", keywords: "running machines devices liveness", secondary: true },
  { label: "Notifications", path: "/notifications", icon: "bell", keywords: "alerts updates", secondary: true },
  { label: "Team Settings", path: "/settings/team", icon: "settings", keywords: "members invite workspace", secondary: true },
  { label: "Claude Accounts", path: "/settings/claude-accounts", icon: "settings", keywords: "account switch login oauth", secondary: true },
  { label: "Sync & Privacy", path: "/settings/sync", icon: "settings", keywords: "projects sharing private", secondary: true },
  { label: "Devices", path: "/settings/devices", icon: "cpu", keywords: "machines daemons keys cli hosts", secondary: true },
  { label: "Integrations", path: "/settings/integrations", icon: "link", keywords: "github slack webhooks connect", secondary: true },
  { label: "Provider Keys", path: "/settings/provider-keys", icon: "settings", keywords: "api keys openrouter anthropic openai", secondary: true },
  { label: "Notifications", path: "/settings/notifications", icon: "settings", keywords: "push email digest mentions mute", secondary: true },
  { label: "Sounds", path: "/settings/sounds", icon: "settings", keywords: "audio volume mute chime walkie", secondary: true },
];

// Global command rows: each fires the SAME registered handler its keyboard
// chord uses (via dispatchAction), so behavior can't fork between the palette
// and the key — and the keycap hint derives from the registry.
const GLOBAL_COMMANDS: ReadonlyArray<{
  action: ShortcutAction;
  /** A function when the label depends on current state (a toggle's direction). */
  label: string | (() => string);
  icon: React.ComponentType<{ className?: string }>;
  keywords: string;
  /** Rows that do not apply to every window say so; the people window has the
   *  wall as its whole view and needs no command to open one. */
  hidden?: () => boolean;
}> = [
  { action: "anchor.toggle", label: "Talk to Anchor", icon: AnchorGlyph, keywords: "agent assistant bot standing member ask personal team" },
  { action: "people.wall", label: "The team — hold a face to talk", icon: Users, keywords: "people wall faces who is around hold to talk walkie everyone roster", hidden: isPeopleWindow },
  { action: "terminal.toggle", label: "Toggle terminal", icon: Terminal, keywords: "shell console panel tmux" },
  { action: "ui.zenToggle", label: "Toggle zen mode", icon: Focus, keywords: "focus minimal distraction free" },
  { action: "sidebar.toggleLeft", label: "Toggle left sidebar", icon: PanelLeft, keywords: "nav collapse" },
  { action: "sidebar.toggleRight", label: "Toggle sessions panel", icon: PanelRight, keywords: "right rail collapse" },
  { action: "pane.split", label: "Split: open this view beside itself", icon: StageSplitGlyph, keywords: "split pane side by side column duplicate stage" },
  { action: "pane.close", label: "Close pane", icon: StageCloseGlyph, keywords: "split pane close stage", hidden: () => !stageIsSplit() },
  { action: "pane.expand", label: "Pane takes the whole stage", icon: StageExpandGlyph, keywords: "split pane expand maximize full stage", hidden: () => !stageIsSplit() },
  { action: "pane.next", label: "Focus next pane", icon: StageNextGlyph, keywords: "split pane focus cycle", hidden: () => !stageIsSplit() },
  { action: "inbox.toggleFlatView", label: "Cycle inbox view", icon: Rows3, keywords: "grouped time label flat layout" },
  { action: "inbox.toggleTriageBar", label: () => (isTriageBarCompact(useInboxStore.getState().clientState.ui) ? "Show triage bar" : "Hide triage bar"), icon: PanelBottom, keywords: "triage bar defer stash kill verbs footer show hide" },
  { action: "ui.toggleShortcutsHelp", label: "Keyboard shortcuts help", icon: Keyboard, keywords: "keys bindings hotkeys cheatsheet" },
];

function NavIcon({ type, className }: { type: string; className?: string }) {
  const c = className || "w-4 h-4";
  switch (type) {
    case "grid":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>;
    case "check":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
    case "file":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>;
    case "user":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>;
    case "users":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>;
    case "inbox":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>;
    case "search":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>;
    case "settings":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
    case "bell":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>;
    case "star":
      return <svg className={c} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>;
    case "bookmark":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>;
    case "session":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>;
    case "folder":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>;
    case "message":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h8M8 14h5M21 12a8 8 0 01-8 8H7l-4 3v-4.5A8 8 0 0113 4a8 8 0 018 8z" /></svg>;
    case "map":
      return <MapIcon className={c} />;
    case "phone":
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>;
    case "clock":
      return <Clock className={c} />;
    case "workflow":
      return <Waypoints className={c} />;
    case "cpu":
      return <Cpu className={c} />;
    case "link":
      return <LinkIcon className={c} />;
    default:
      return <svg className={c} fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" strokeWidth={1.5} /></svg>;
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function getShortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// ─── Action submenu component (Linear-style) ───────────────────
export function ActionSubmenu({
  mode,
  targets,
  targetType,
  onClose,
  onBack,
  enteredViaRoot,
  teamMembers,
  currentUser,
}: {
  mode: ActionMode;
  targets: any[];
  targetType: "task" | "doc" | "plan" | "session";
  onClose: () => void;
  onBack: () => void;
  // True when the user drilled in from the root palette (Cmd+K → action row).
  // Deep links (e.g. Ctrl+Shift+M straight into label mode) have no higher
  // level to climb back to, so back affordances hide and Esc closes outright.
  enteredViaRoot?: boolean;
  teamMembers?: any[];
  currentUser?: any;
}) {
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Two-step state for the "Start agent run" mode: pick an agent, then compose
  // the initial message before launching a run per selected task.
  const [agentStep, setAgentStep] = useState<"pick" | "message">("pick");
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState(DEFAULT_AGENT_RUN_MESSAGE);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Rename is the other two-step mode: once a layout is picked the SAME search
  // input becomes the name field, so the row list collapses to one create-shaped
  // row. No second render block — the bucket mode's __create__ row does the work.
  const [renameId, setRenameId] = useState<string | null>(null);

  const updatePlan = useInboxStore((s) => s.updatePlan);
  const assignToAgent = useMutation(api.tasks.assignToAgent);
  const updateTask = useInboxStore((s) => s.updateTask);
  const updateDoc = useInboxStore((s) => s.updateDoc);
  const buckets = useInboxStore((s) => s.buckets);
  const bucketAssignments = useInboxStore((s) => s.bucketAssignments);
  // Exclude-mode chips don't read as "the active view" here — the palette's
  // view rows mark only include filters; picking any row sets include mode.
  const activeBucketFilter = useInboxStore((s) => (s.chipFilterExclude ? null : s.activeBucketFilter));
  const activeProjectFilter = useInboxStore((s) => (s.chipFilterExclude ? null : s.activeProjectFilter));
  // Exclude-mode chips don't mark their own row active (masked above), but
  // they DO hide sessions — "All sessions" must not claim the inbox is
  // unfiltered while one is on.
  const chipFilterExclude = useInboxStore((s) => s.chipFilterExclude);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const archiveDoc = useInboxStore((s) => s.archiveDoc);
  const router = useRouter();
  const pathname = usePathname();
  // Saved layouts, in the same rail order the ⌥N chords index into.
  const savedViews = useInboxStore((s) => s.savedViews);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const activeWorkbenchId = useInboxStore((s) => s.activeWorkbenchId);

  const target = targets[0];
  const currentLabels = target?.labels || [];
  // The targets' team status vocabulary (per-team custom statuses). A palette
  // selection is one workspace's rows, so the first target's team speaks for
  // the set; non-task targets fall back to the defaults harmlessly.
  const taskStatuses = useTeamTaskStatusList((target as any)?.team_id);
  // Dynamic-client (opencode/pi) live model inventory for the model mode; the
  // hook internally skips its query for static clients.
  const dynamicModels = useDynamicModels(
    mode === "model" ? (target as any)?.agent_type : undefined,
    (target as any)?.owner_device_id,
  );

  useWatchEffect(() => {
    setSearch("");
    setHighlightIndex(0);
    setAgentStep("pick");
    setSelectedAgentKey(null);
    setAgentMessage(DEFAULT_AGENT_RUN_MESSAGE);
    setRenameId(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [mode]);

  useWatchEffect(() => {
    if (mode === "agent_run" && agentStep === "message") {
      setTimeout(() => messageRef.current?.focus(), 0);
    }
  }, [mode, agentStep]);

  // View-switcher counts: snapshot at entry. The picker is transient (open,
  // pick, gone), so live count churn while it's up isn't worth subscribing the
  // submenu to all session sync; the label LIST itself stays live via the
  // buckets subscription above.
  const viewChipData = useMemo(() => {
    if (mode !== "view") return null;
    const st = useInboxStore.getState();
    // Scope like the inbox panel, but count the WHOLE scoped cache — dismissed,
    // stashed, and aged-out rows included (showOld keeps them in the active
    // slices; picking a view surfaces its dismissed/stashed sessions too). The
    // header chip row counts only the active set because it summarizes the list
    // it sits above; this picker is a catalog of views, and a label whose
    // sessions were all dismissed is still a real view — a 0 badge here would
    // read as "empty label".
    // The placement chokepoint (placeInboxRows, sync-convergence C5): the
    // same scoped working-set selection every other counting surface uses, so
    // the view badges here can never disagree with the panel's chip row.
    const placed = placeInboxRows(st, { focusedId: st.currentSessionId ?? null });
    const bucketByConv = convBucketMap(st.bucketAssignments as Record<string, BucketAssignmentItem>);
    const counts = computeChipCounts([...placed.sorted, ...placed.stashed, ...placed.dismissed], bucketByConv);
    // Label counts come from the assignments themselves, not from cached
    // sessions: bucket_assignments sync completely (buckets.webList collects the
    // whole per-user table), while the session cache is windowed and boot-pruned
    // — so a label whose sessions all aged out of the cache would tally 0 even
    // though the filing still exists. Assignments ARE the label's membership.
    const bucketCounts: Record<string, number> = {};
    for (const bid of Object.values(bucketByConv)) {
      if (bid) bucketCounts[bid] = (bucketCounts[bid] || 0) + 1;
    }
    // The local session cache is windowed and boot-pruned, so a project whose
    // sessions all fell out of it would vanish from this list even though the
    // server still knows it. Union in the recent-projects cache (the same
    // 30-day per-project counts the new-session picker syncs) so every project
    // the user works in stays reachable as a view; max() because both sides
    // undercount in different ways (cache is pruned, server list is capped).
    const byName = new Map(counts.projectCounts);
    for (const rp of st.recentProjects) {
      const name = getProjectName(rp.path);
      if (name === "unknown") continue;
      byName.set(name, Math.max(byName.get(name) || 0, rp.count));
      if (!counts.projectPathByName[name]) counts.projectPathByName[name] = rp.path;
    }
    return {
      bucketCounts,
      projectCounts: [...byName.entries()].sort((a, b) => b[1] - a[1]),
      projectPathByName: counts.projectPathByName,
    };
  }, [mode]);

  const layouts = useMemo(
    () => sortedWorkbenches({ savedViews: savedViews ?? {}, clientState: { ui: { active_team_id: activeTeamId } } }),
    [savedViews, activeTeamId],
  );
  // Update / rename / delete only ever act on your OWN layouts; a teammate's
  // shared one is read-only here exactly as it is in the rail.
  const myLayouts = useMemo(() => layouts.filter((v) => v.is_mine !== false), [layouts]);

  const items = useMemo(() => {
    const q = search.toLowerCase();

    if (isLayoutMode(mode)) {
      const trimmed = search.trim();
      // Save, and rename's second step, are pure naming: one create-shaped row
      // carrying the typed name, and nothing at all until something is typed.
      if (mode === "layout_save") {
        return trimmed ? [{ key: "__name__", label: `Save as "${trimmed}"`, active: false, icon: Plus }] : [];
      }
      if (mode === "layout_rename" && renameId) {
        return trimmed ? [{ key: "__name__", label: `Rename to "${trimmed}"`, active: false, icon: Pencil }] : [];
      }
      // Otherwise: pick a layout. Rail order is kept deliberately — it is the
      // order the ⌥N chords index into, so re-sorting would desync the keycap
      // the user just learned from the row it names. The active one is marked
      // with the usual check instead of being floated to the top.
      const icon = mode === "layout_update" ? RefreshCw : mode === "layout_delete" ? Trash2 : Pencil;
      return myLayouts
        .filter((v) => (v.name || "").toLowerCase().includes(q))
        .map((v) => ({ key: v._id, label: v.name || "Untitled layout", active: v._id === activeWorkbenchId, icon }));
    }

    if (mode === "view") {
      if (!viewChipData) return [];
      const { bucketCounts, projectCounts, projectPathByName } = viewChipData;
      // ONE list, because the underlying state is ONE filter slot — picking a
      // project clears any label focus and vice versa (the store setters
      // enforce it). Labels first in the user's chip order, then projects by
      // count, same as the chip row's +N popover.
      const rows: any[] = [];
      for (const b of sortLabels(buckets as Record<string, BucketItem>)) {
        rows.push({ key: `label:${b._id}`, id: b._id, kind: "label", label: b.name, count: bucketCounts[b._id] || 0, active: activeBucketFilter === b._id, dot: getLabelColor(b.name).dot });
      }
      for (const [name, count] of projectCounts) {
        rows.push({ key: `project:${name}`, kind: "project", label: name, count, active: activeProjectFilter === name, path: projectPathByName[name] || null, dot: getLabelColor(name).dot });
      }
      const matched = rows.filter((r) => r.label.toLowerCase().includes(q));
      // "All sessions" mirrors bucket-mode's remove row: empty-search only, on
      // the 0 key so the views keep 1-9.
      if (!q.trim()) {
        matched.unshift({ key: "__all__", kind: "all", label: "All sessions", active: !activeBucketFilter && !activeProjectFilter && !chipFilterExclude, icon: Circle, quickKey: "0" });
      }
      return matched;
    }

    if (mode === "status") {
      return statusEntityOptions(taskStatuses)
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({
          ...o,
          active: isTask(target) && taskStatusKey(target as any, taskStatuses) === o.key,
        }));
    }
    if (mode === "priority") {
      return PRIORITY_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({
          ...o,
          active: isTask(target) && target.priority === o.key,
        }));
    }
    if (mode === "type") {
      return DOC_TYPE_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({
          ...o,
          active: !isTask(target) && (target as DocItem).doc_type === o.key,
        }));
    }
    if (mode === "labels") {
      const all = [...new Set([...DEFAULT_LABELS, ...currentLabels])];
      const matched = all
        .filter((l) => l.toLowerCase().includes(q))
        .map((l) => ({
          key: l,
          label: l,
          active: currentLabels.includes(l),
          dot: getLabelColor(l).dot,
        }));
      if (q && !matched.some((l) => l.key.toLowerCase() === q)) {
        matched.unshift({ key: q, label: `Create "${q}"`, active: false, dot: getLabelColor(q).dot });
      }
      return matched;
    }
    if (mode === "assign") {
      const members = (teamMembers || []).filter(Boolean).map((m: any) => {
        const name = memberDisplayName(m);
        return {
          key: m._id,
          label: currentUser && m._id === currentUser._id ? `${name} (you)` : name,
          type: "user" as const,
          image: memberAvatarUrl(m),
        };
      });
      return members.filter((o) => o.label.toLowerCase().includes(q));
    }
    if (mode === "agent_run") {
      return AGENT_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((a) => ({ ...a, type: "agent" as const, image: undefined }));
    }
    if (mode === "parent") {
      // Candidate parents: same-workspace, open, not the targets themselves.
      const targetIds = new Set(targets.map((t: any) => String(t._id)));
      const teamKey = isTask(target) ? (target.team_id ?? null) : null;
      const all = Object.values(useInboxStore.getState().tasks) as TaskItem[];
      return all
        .filter((t: any) =>
          !targetIds.has(String(t._id)) &&
          inActiveWorkspace(t, teamKey) &&
          t.status !== "done" && t.status !== "dropped" &&
          !String(t._id).startsWith("temp_") &&
          (q === "" || t.title?.toLowerCase().includes(q) || t.short_id?.toLowerCase().includes(q)))
        .slice(0, 8)
        .map((t: any) => ({ key: t.short_id, label: `${t.short_id}  ${t.title}`, active: false }));
    }
    if (mode === "plan_status") {
      return PLAN_STATUS_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({
          ...o,
          active: target?.status === o.key,
        }));
    }
    if (mode === "bucket") {
      const convId = target?._id as string | undefined;
      const currentBucketId = convId
        ? ((Object.values(bucketAssignments) as BucketAssignmentItem[])
            .find((a) => a.conversation_id === convId)?.bucket_id ?? null)
        : null;
      const all = (Object.values(buckets) as BucketItem[])
        .filter((b) => !b.archived_at)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
      const matched: any[] = all
        .filter((b) => b.name.toLowerCase().includes(q))
        .map((b) => ({ key: b._id, label: b.name, active: b._id === currentBucketId, dot: getLabelColor(b.name).dot }));
      // Create-from-query, same shape as the labels mode. This is also how the
      // very FIRST bucket gets made — no dedicated create UI exists anywhere.
      const trimmed = search.trim();
      if (trimmed && !all.some((b) => b.name.toLowerCase() === trimmed.toLowerCase())) {
        matched.unshift({ key: "__create__", label: `Create "${trimmed}"`, active: false, dot: getLabelColor(trimmed).dot });
      }
      if (currentBucketId && !trimmed) {
        // First option, naming the label it clears — when a label is already
        // assigned, changing/removing it is the likeliest intent. quickKey "0"
        // extends the digit scheme (1-9 pick, 0 = none) without stealing a
        // letter from the filter-or-create input — the remove row only exists
        // while the search is empty, exactly when the next keystroke may be
        // the first letter of a label name.
        const currentName = (buckets as Record<string, BucketItem>)[currentBucketId]?.name;
        matched.unshift({
          key: "__remove__",
          label: currentName ? `Remove "${currentName}"` : "Remove label",
          active: false,
          icon: XCircle,
          quickKey: "0",
        });
      }
      return matched;
    }
    if (mode === "model") {
      // Model + effort options for the target session's agent, one flat
      // numbered list. The blank rail adds the "default" effort stop.
      const s0 = target as any;
      const agentType = s0?.agent_type as string | undefined;
      const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
      if (!cfg) return [];
      const blank = (s0?.message_count ?? 0) === 0;
      const curModelKey = modelOptionKey(s0?.model, agentType);
      const curEffort = s0?.effort as string | undefined;
      const rows: any[] = [];
      // Dynamic clients: Default + the live featured head; the query also
      // searches the device's full inventory below.
      const models = dynamicModels.dynamic
        ? [cfg.models[0], ...dynamicModels.featured]
        : cfg.models;
      for (const m of models) {
        rows.push({ key: `model:${m.key}`, label: m.label, sub: m.hint, active: m.key === curModelKey, icon: Cpu });
      }
      for (const level of [...(blank ? ["default"] : []), ...cfg.efforts]) {
        const active = level === "default" ? !curEffort : level === curEffort;
        rows.push({ key: `effort:${level}`, label: `${level} effort`, active, icon: CircleDot });
      }
      const filtered = rows.filter((r) => r.label.toLowerCase().includes(q));
      if (dynamicModels.dynamic && q) {
        const seen = new Set(models.map((m) => m.key));
        for (const id of dynamicModels.all) {
          if (filtered.length >= 24) break;
          if (seen.has(id) || !id.toLowerCase().includes(q)) continue;
          const opt = dynamicModelOption(id);
          filtered.push({ key: `model:${id}`, label: opt.label, sub: opt.hint, active: id === curModelKey, icon: Cpu });
        }
      }
      return filtered;
    }
    return [];
  }, [mode, search, target, currentLabels, teamMembers, currentUser, buckets, bucketAssignments, viewChipData, activeBucketFilter, activeProjectFilter, chipFilterExclude, dynamicModels, taskStatuses, myLayouts, renameId, activeWorkbenchId]);

  useWatchEffect(() => { setHighlightIndex(0); }, [search]);

  const selectItem = useCallback((index: number) => {
    const item = items[index] as any;
    if (!item) return;

    // Layout CRUD is global too — the workspace arrangement, not a row. Same
    // gestures the rail's Layouts section offers, for when the rail is closed.
    if (isLayoutMode(mode)) {
      const store = useInboxStore.getState();
      const trimmed = search.trim();
      if (mode === "layout_save") {
        if (!trimmed) return;
        store.saveWorkbench(trimmed, pathname ?? undefined);
        toast.success(`Saved the current layout as "${trimmed}"`);
      } else if (mode === "layout_update") {
        store.updateWorkbench(item.key, pathname ?? undefined);
        toast.success(`"${item.label}" now matches the current layout`);
      } else if (mode === "layout_rename") {
        // First press picks the layout and hands the input over to the new name.
        if (!renameId) {
          setRenameId(item.key);
          setSearch("");
          return;
        }
        if (!trimmed) return;
        store.updateSavedView(renameId, { name: trimmed });
        toast.success(`Renamed to "${trimmed}"`);
      } else {
        // No confirm, matching the rail's ✕ — a saved layout is cheap to remake.
        store.deleteSavedView(item.key);
        toast.success(`Removed "${item.label}"`);
      }
      onClose();
      return;
    }

    // View switching is global — no target entity involved. Picking the
    // already-active view toggles back to All, mirroring the chips.
    if (mode === "view") {
      const store = useInboxStore.getState();
      if (item.key === "__all__" || item.active) {
        store.setActiveBucketFilter(null);
        store.setActiveProjectFilter(null, null);
      } else if (item.kind === "project") {
        store.setActiveProjectFilter(item.label, item.path ?? null);
      } else {
        store.setActiveBucketFilter(item.id);
      }
      onClose();
      return;
    }

    if (!target) return;
    const count = targets.length;

    // Agent-run picks an agent, then advances to the message step (not a fire).
    if (mode === "agent_run") {
      setSelectedAgentKey(item.key);
      setAgentStep("message");
      return;
    }

    if (mode === "model") {
      const store = useInboxStore.getState();
      const real = store.getConvexId(target._id) ?? target._id;
      const s0 = target as any;
      // Split on the FIRST colon only — dynamic model ids can contain ":"
      // (openrouter variant suffixes like ":free").
      const keyStr = String(item.key);
      const sep = keyStr.indexOf(":");
      const kind = keyStr.slice(0, sep);
      const value = keyStr.slice(sep + 1);
      // commitModelChange owns the not-ready decision: a blank session records
      // the choice locally on the stub (the create carries it), only the live
      // rail needs a real id. Passing `real` (possibly still a stub) lets it
      // stamp + defer instead of erroring here.
      void commitModelChange({
        conversationId: real,
        agentType: s0?.agent_type,
        current: { model: s0?.model, effort: s0?.effort },
        sel: kind === "model" ? { model: value } : { effort: value },
        blank: (s0?.message_count ?? 0) === 0,
      });
      onClose();
      return;
    }

    if (mode === "bucket") {
      const store = useInboxStore.getState();
      // Sessions mid-create carry stub ids the server can't act on — resolve to
      // the real conversation id and skip (with a hint) if it hasn't landed yet.
      const resolveConvId = (t: any): string | null => {
        const real = store.getConvexId(t._id) ?? t._id;
        return isConvexId(real) ? real : null;
      };
      const applyBucket = (bucketId: string | null, bucketLabel?: string) => {
        let applied = 0;
        for (const t of targets) {
          const convId = resolveConvId(t);
          if (!convId) continue;
          store.assignSessionToBucket(convId, bucketId);
          applied++;
        }
        if (!applied) {
          toast.error("Session is still being created — try again in a moment");
          return;
        }
        toast.success(bucketId ? `Labeled ${bucketLabel}` : "Label removed");
      };
      if (item.key === "__remove__") {
        applyBucket(null);
      } else if (item.key === "__create__") {
        const name = search.trim();
        const conversationIds = targets
          .map(resolveConvId)
          .filter((id): id is string => !!id);
        store.createBucket(
          { name },
          conversationIds.length > 0
            ? { version: 1, kind: "assignBucket", conversationIds }
            : undefined,
        ).then((r: any) => {
          if (!r?.bucketId) return;
          toast.success(`Created label "${name}"`);
        }).catch(() => toast.error("Couldn't create label"));
      } else {
        applyBucket(item.key, item.label);
      }
      onClose();
      return;
    }

    if (targetType === "task") {
      const applyTaskUpdate = (fields: Record<string, any>) => {
        for (const t of targets as TaskItem[]) {
          updateTask(t.short_id, fields);
        }
      };
      const label = count === 1 ? (targets[0] as TaskItem).short_id : `${count} tasks`;

      if (mode === "status") {
        // Keys are team status ids; the status carries its category, which is
        // what the terminal check and the server's side effects key on.
        const picked = statusByKey(taskStatuses, item.key);
        if (!picked) return;
        const fields = statusWriteFields(picked);
        // Terminal moves route through the single close gateway so a parent
        // with open subtasks opens the shared dialog instead of writing Done
        // and stranding a doomed local state the server refuses.
        if (fields.status === "done" || fields.status === "dropped") {
          let deferred = false;
          for (const t of targets as TaskItem[]) {
            if (closeTaskWithGuard(t.short_id, fields.status, undefined, fields.status_id).needsConfirm) deferred = true;
          }
          if (!deferred) toast.success(`${label} \u2192 ${item.label}`);
        } else {
          applyTaskUpdate(fields);
          toast.success(`${label} \u2192 ${item.label}`);
        }
      } else if (mode === "priority") {
        applyTaskUpdate({ priority: item.key });
        toast.success(`${label} priority \u2192 ${item.label}`);
      } else if (mode === "labels") {
        const newLabels = item.active
          ? currentLabels.filter((l: string) => l !== item.key)
          : [...currentLabels, item.key];
        applyTaskUpdate({ labels: newLabels });
        toast.success(`${item.active ? "Removed" : "Added"} label: ${item.key}`);
      } else if (mode === "assign") {
        applyTaskUpdate({ assignee: item.key });
        const member = (teamMembers || []).find((m: any) => m._id === item.key);
        toast.success(`Assigned to ${memberDisplayName(member, "user")}`);
      } else if (mode === "parent") {
        let failed = 0;
        for (const t of targets as TaskItem[]) {
          const res = setTaskParent(t.short_id, item.key);
          if (!res.ok) failed++;
        }
        if (failed === 0) toast.success(`Nested under ${item.key}`);
        else toast.error(`${failed} could not be nested (cycle, depth, or workspace)`);
      }
    } else if (targetType === "plan") {
      if (mode === "plan_status") {
        const shortId = target.short_id || target._id;
        updatePlan(shortId, { status: item.key });
        toast.success(`Plan \u2192 ${item.label}`);
      }
    } else {
      const doc = target as DocItem;
      if (mode === "type") {
        updateDoc(doc._id, { doc_type: item.key });
        toast.success(`Type \u2192 ${item.label}`);
      } else if (mode === "labels") {
        const newLabels = item.active
          ? currentLabels.filter((l: string) => l !== item.key)
          : [...currentLabels, item.key];
        updateDoc(doc._id, { labels: newLabels });
        toast.success(`${item.active ? "Removed" : "Added"} label: ${item.key}`);
      }
    }
    onClose();
  }, [items, target, targets, targetType, mode, currentLabels, onClose, updateTask, updatePlan, assignToAgent, updateDoc, teamMembers, router, search, taskStatuses, pathname, renameId]);

  // Launch a session per selected task with the chosen agent + initial message.
  const launchAgentRun = useCallback(() => {
    if (!selectedAgentKey) return;
    const agentType = selectedAgentKey.replace("agent:", "");
    const agentLabel = AGENT_OPTIONS.find((a) => a.key === selectedAgentKey)?.label || "agent";
    const msg = agentMessage.trim() || undefined;
    const runnable = (targets as TaskItem[]).filter((t) => t && t.short_id);
    if (!runnable.length) {
      toast.error("No tasks to run");
      return;
    }
    Promise.allSettled(
      runnable.map((t) => assignToAgent({ short_id: t.short_id, agent_type: agentType, initial_message: msg }))
    ).then((results) => {
      const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      const ok = runnable.length - failures.length;
      if (failures.length) console.error("[agent_run] failures", failures.map((f) => f.reason));
      if (!ok) {
        toast.error(`Couldn't start ${agentLabel}: ${failures[0]?.reason?.message || "failed"}`);
      } else if (failures.length) {
        toast.warning(`Started ${ok}/${runnable.length} ${agentLabel} runs — ${failures.length} failed`);
      } else {
        toast.success(ok === 1 ? `Starting ${agentLabel}` : `Starting ${ok} ${agentLabel} sessions`);
      }
    });
    onClose();
  }, [selectedAgentKey, agentMessage, targets, assignToAgent, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Esc from a deep view escapes to GLOBAL (closes the palette), never just
    // one level — climbing back up is ↑ past the top / Backspace-on-empty,
    // and only exists when the user came down from the root palette.
    // Rename's second step climbs back to the layout picker before it leaves —
    // the same one-step-back Esc the agent_run message step offers.
    const backOutOfRename = () => { setRenameId(null); setSearch(""); };
    if (e.key === "Escape") {
      e.preventDefault();
      if (renameId) backOutOfRename(); else onClose();
      return;
    }
    if (e.key === "Backspace" && search === "") {
      e.preventDefault();
      if (renameId) backOutOfRename();
      else if (enteredViaRoot) onBack();
      else onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      if (highlightIndex === 0 && enteredViaRoot) {
        onBack();
        return;
      }
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      selectItem(highlightIndex);
      return;
    }
    // Bare keys only past this point — modifier combos (e.g. browser tab
    // switching) must pass through untouched.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Rows with a dedicated quick key ("Remove label" → 0) match it directly;
    // digits pick among the numbered rows only.
    const quickIndex = items.findIndex((it: any) => it.quickKey === e.key);
    if (quickIndex >= 0) {
      e.preventDefault();
      selectItem(quickIndex);
      return;
    }
    // Digits address the nth NUMBERED row, skipping quick-key rows, so a
    // leading "Remove label" (0) doesn't shift the labels off 1..N.
    const num = parseInt(e.key);
    if (num >= 1) {
      const numbered = items.filter((it: any) => !it.quickKey);
      if (num <= numbered.length) {
        e.preventDefault();
        selectItem(items.indexOf(numbered[num - 1]));
      }
    }
  }, [items, highlightIndex, selectItem, onBack, onClose, enteredViaRoot, search, renameId]);

  useWatchEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const highlighted = el.children[highlightIndex] as HTMLElement;
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const modeLabel =
    mode === "status" ? "Change status..." :
    mode === "priority" ? "Set priority..." :
    mode === "labels" ? "Toggle label..." :
    mode === "assign" ? "Assign to person..." :
    mode === "type" ? "Change document type..." :
    mode === "agent_run" ? "Start agent run — pick an agent..." :
    mode === "bucket" ? "Label session — type to filter or create..." :
    mode === "model" ? "Change model & effort..." :
    mode === "view" ? "Switch view — filter by label or project..." :
    mode === "parent" ? "Set parent — search tasks..." :
    mode === "layout_save" ? "Save current layout — type a name..." :
    mode === "layout_update" ? "Update layout to the current arrangement..." :
    mode === "layout_rename" ? (renameId ? "Rename layout — type the new name..." : "Rename layout — pick one...") :
    mode === "layout_delete" ? "Delete layout..." :
    "Select...";

  const itemClass = (i: number) =>
    `w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
      i === highlightIndex
        ? "bg-sol-bg-highlight text-sol-text"
        : "text-sol-text-muted hover:bg-sol-bg-alt/50"
    }`;

  // Second step of "Start agent run": compose the initial message, then launch.
  if (mode === "agent_run" && agentStep === "message") {
    const agentLabel = AGENT_OPTIONS.find((a) => a.key === selectedAgentKey)?.label || "Agent";
    const count = targets.length;
    const targetSummary = count === 1 ? (targets[0] as TaskItem).short_id : `${count} tasks`;
    return (
      <>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30">
          <button
            onClick={() => setAgentStep("pick")}
            className="text-xs px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
          >
            &larr;
          </button>
          <Bot className={`w-4 h-4 flex-shrink-0 ${AGENT_COLORS[selectedAgentKey || ""] || "text-sol-violet"}`} />
          <span className="text-sm text-sol-text">{agentLabel}</span>
          <span className="text-xs text-sol-text-dim font-mono">· {targetSummary}</span>
        </div>
        <div className="p-4">
          <label className="block text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim/70 mb-2">
            Initial message
          </label>
          <textarea
            ref={messageRef}
            value={agentMessage}
            onChange={(e) => setAgentMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                launchAgentRun();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setAgentStep("pick");
              }
            }}
            rows={4}
            placeholder="Message the agent starts with..."
            className="w-full resize-none rounded-lg bg-sol-bg-alt/40 border border-sol-border/40 px-3 py-2 text-sm text-sol-text placeholder:text-sol-text-dim/60 outline-none focus:border-sol-cyan/50 transition-colors"
          />
          <button
            onClick={launchAgentRun}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-sol-cyan/15 hover:bg-sol-cyan/25 border border-sol-cyan/30 text-sol-cyan text-sm font-medium transition-colors"
          >
            <Bot className="w-4 h-4" />
            {count === 1 ? `Launch ${agentLabel}` : `Launch ${count} ${agentLabel} runs`}
          </button>
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1">
            <KeyCap size="xs">&#9166;</KeyCap>
            launch
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">&#8679;</KeyCap>
            <KeyCap size="xs">&#9166;</KeyCap>
            newline
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">Esc</KeyCap>
            back
          </span>
        </div>
      </>
    );
  }

  const numberedCount = items.filter((it: any) => !it.quickKey).length;
  // Badge per row: the dedicated quick key, or this row's position among the
  // NUMBERED rows — mirrors the keydown handler exactly, so the hint can't lie.
  let badgeNum = 0;
  const rowBadges = items.map((it: any) =>
    it.quickKey ? it.quickKey : ++badgeNum <= 9 ? String(badgeNum) : null
  );

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30">
        {enteredViaRoot && (
          <button
            onClick={onBack}
            title="Back to actions"
            className="text-xs px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
          >
            &uarr;
          </button>
        )}
        <Search className="w-4 h-4 text-sol-text-dim flex-shrink-0" />
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={modeLabel}
          className="flex-1 text-sm bg-transparent text-sol-text placeholder:text-sol-text-dim/60 outline-none"
        />
      </div>
      <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
        {items.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-sol-text-dim">No results</div>
        )}
        {items.map((item: any, i: number) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => selectItem(i)}
              onMouseEnter={() => setHighlightIndex(i)}
              className={itemClass(i)}
            >
              {item.type === "agent" ? (
                <Bot className={`w-4 h-4 flex-shrink-0 ${AGENT_COLORS[item.key] || "text-sol-violet"}`} />
              ) : mode === "assign" ? (
                <AvatarImg
                  src={item.image}
                  alt={item.label}
                  className="w-4 h-4 rounded-full flex-shrink-0"
                  fallback={
                    <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                      {item.label.replace(" (you)", "").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                    </div>
                  }
                />
              ) : mode === "labels" ? (
                <span className={`w-3 h-3 rounded-full flex-shrink-0 ${item.dot || "bg-neutral-400"}`} />
              ) : mode === "bucket" && item.dot ? (
                // Square swatch: manual buckets read differently from the round
                // auto-derived label/project dots.
                <span className={`w-3 h-3 rounded-[3px] flex-shrink-0 ${item.dot}`} />
              ) : mode === "view" && item.dot ? (
                // Same shape convention as the chip row: square = manual label,
                // round = auto-derived project.
                <span className={`w-3 h-3 flex-shrink-0 ${item.kind === "project" ? "rounded-full" : "rounded-[3px]"} ${item.dot}`} />
              ) : Icon ? (
                <Icon className={`w-4 h-4 flex-shrink-0 ${item.color || ""}`} />
              ) : null}
              <span className="flex-1 text-left">{item.label}</span>
              {mode === "view" && item.kind === "project" && (
                <span className="text-[10px] text-sol-text-dim/60 flex-shrink-0">project</span>
              )}
              {typeof item.count === "number" && (
                <span className="text-[10px] tabular-nums text-sol-text-dim/70 flex-shrink-0">{item.count}</span>
              )}
              {item.active && <Check className="w-4 h-4 text-sol-cyan flex-shrink-0" />}
              {rowBadges[i] && <KeyCap size="xs">{rowBadges[i]}</KeyCap>}
              {item.type === "agent" && (
                <span className="text-[10px] text-sol-text-dim font-mono">&rarr;</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 px-4 py-2 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
        <span className="flex items-center gap-1">
          <KeyCap size="xs">&uarr;</KeyCap>
          <KeyCap size="xs">&darr;</KeyCap>
          navigate
        </span>
        <span className="flex items-center gap-1">
          <KeyCap size="xs">&#9166;</KeyCap>
          select
        </span>
        <span className="flex items-center gap-1">
          <KeyCap size="xs">Esc</KeyCap>
          close
        </span>
        {enteredViaRoot && (
          <span className="flex items-center gap-1">
            <KeyCap size="xs">&uarr;</KeyCap>
            back
          </span>
        )}
        {numberedCount > 0 && (
          <span className="flex items-center gap-1">
            <KeyCap size="xs">1-{Math.min(numberedCount, 9)}</KeyCap>
            quick pick
          </span>
        )}
      </div>
    </>
  );
}

// ─── Unified Command Palette ────────────────────────────────────
// We substring-match the local session cache OURSELVES and hand cmdk only the
// matches — because cmdk mounts and re-scores every Item it's given on each
// keystroke, so feeding it the whole cache (thousands of sessions) janks typing.
// RECENT_SEARCH_CAP bounds how deep into the (updated_at-desc) cache we scan;
// RECENT_RENDER_CAP bounds how many matches we actually mount. The long tail
// beyond the scan is covered by the async server search ("Search Results") below.
const RECENT_SEARCH_CAP = 750;
const RECENT_RENDER_CAP = 25;

// Stable empty index handed to the mention-index selector while the palette is
// closed, so a closed palette doesn't re-render on task/doc/plan sync churn.
const EMPTY_MENTION_INDEX = { tasks: {}, docs: {}, plans: {} } as const;
const ENTITY_RENDER_CAP = 8;
const EMPTY_RECENT_VISITS: RecentVisit[] = [];
const RECENT_VISITS_RENDER_CAP = 4;
// Closed-palette stable refs: a closed palette must not re-render on
// bucket/assignment sync churn (it reads these only to label recent rows).
const EMPTY_BUCKETS: Record<string, BucketItem> = {};
const EMPTY_BUCKET_ASSIGNMENTS: Record<string, BucketAssignmentItem> = {};
const EMPTY_VAULT_FILES: Record<string, { dir?: boolean; mtime: number }> = {};

const MARKDOWN_RE = /\.(md|markdown)$/i;

// One matcher for tasks/docs/plans over the globally-synced mention index.
// Reuses score() (exact > prefix > substring) with a short_id fallback, and
// mirrors the Tasks/Docs pages' team scoping: in a team view keep this team's
// items plus teamless orphans; in the personal view keep only teamless items.
type MentionRecord = {
  _id: string;
  title: string;
  short_id?: string;
  goal?: string;
  doc_type?: string;
  source_file?: string | null;
  status?: string;
  updated_at?: number;
  team_id?: string | null;
};
function matchEntities(
  records: Record<string, MentionRecord>,
  query: string,
  teamId: string | undefined,
  cap: number,
  exclude?: (r: MentionRecord) => boolean,
  // With no query, list the most recent records instead of nothing (pick mode
  // browses; the root palette stays session-focused when empty).
  browseWhenEmpty = false,
): MentionRecord[] {
  const q = query.trim().toLowerCase();
  if (!q && !browseWhenEmpty) return [];
  const ranked: Array<{ rec: MentionRecord; rank: number }> = [];
  for (const rec of Object.values(records)) {
    if (exclude?.(rec)) continue;
    if (!inActiveWorkspace(rec, teamId)) continue;
    if (!q) { ranked.push({ rec, rank: 0 }); continue; }
    const titleRank = score(rec.title || "", q);
    const goalRank = rec.goal ? score(rec.goal, q) : Infinity;
    // File-synced docs are titled from their content heading, not their filename;
    // score the source file too so a doc is findable by name/path. Score the
    // basename (strong prefix match) and the full path (matches "dir/file.md").
    let fileRank = Infinity;
    if (rec.source_file) {
      const path = rec.source_file.toLowerCase();
      const base = path.split("/").pop() || path;
      fileRank = Math.min(score(base, q), score(path, q));
    }
    let rank = Math.min(titleRank, goalRank, fileRank);
    if (rank === Infinity) {
      if (!rec.short_id?.toLowerCase().includes(q)) continue;
      rank = 50; // short_id-only hit ranks below any title/goal hit
    }
    ranked.push({ rec, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || (b.rec.updated_at || 0) - (a.rec.updated_at || 0));
  // Collapse same-title records to one row. Workflow-generated tasks/plans often
  // share an identical title across many distinct ids/statuses (e.g. a "Verify
  // task list covers entire plan" task minted every run), which floods the
  // palette with apparent dupes. Sorted best-first, so the first occurrence per
  // title is the highest-ranked, most-recent representative.
  const seen = new Set<string>();
  const out: MentionRecord[] = [];
  for (const { rec } of ranked) {
    const key = (rec.title || "").trim().toLowerCase();
    if (key && seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
    if (out.length >= cap) break;
  }
  return out;
}

// Memoized: this overlay is ALWAYS mounted inside DashboardLayout, which
// re-renders on every heartbeat. Its only prop (`standalone`) is stable, so memo
// severs the parent-cascade — combined with snapshotting session data at open
// (above), the palette now re-renders only on its OWN state, not on session churn.
function CommandPaletteImpl({ standalone = false }: { standalone?: boolean }) {
  const [query, setQuery] = useState("");
  const [actionMode, setActionMode] = useState<ActionMode | null>(null);
  // Whether the submenu was reached by drilling down from the root palette
  // (vs deep-linked open, e.g. Ctrl+Shift+M straight into label mode).
  const [enteredViaRoot, setEnteredViaRoot] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const { open: paletteOpen, targets, targetType, initialMode, initialQuery: paletteInitialQuery, pick } = useInboxStore((s) => s.palette);
  // Pick mode (lib/palettePick.ts): the palette is an entity chooser for a
  // caller. Only the allowed entity groups render, selection reports back
  // through pick.onPick instead of navigating, and the caller's extra rows
  // (e.g. "new agent session") sit on top.
  const picking = !!pick;
  const pickAllows = useCallback((kind: PalettePickKind) => !pick || pick.kinds.includes(kind), [pick]);
  const [pickNote, setPickNote] = useState("");
  // Two-step pick (pick.notePlaceholder set): the chosen target waits here
  // while the confirm step collects the optional note. The query is captured
  // at choose time — needsQuery extras read it from the search box.
  const [pickChosen, setPickChosen] = useState<{ target: PalettePickTarget; query: string } | null>(null);
  const closePalette = useInboxStore((s) => s.closePalette);
  const togglePalette = useInboxStore((s) => s.togglePalette);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);

  const updateTask = useInboxStore((s) => s.updateTask);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  // Kill from the palette says what schedules died with the session, same as
  // the sidebar kill button (the webList subscription inside is deduped).
  const { killWithNotice } = useTriggerKillNotice();
  const { user: currentUser } = useCurrentUser();
  const teamMembers = useInboxStore((s) => s.teamMembers.length > 0 ? s.teamMembers : undefined);

  const open = standalone || paletteOpen;

  const favorites = useInboxStore((s) => s.favorites);
  const bookmarks = useInboxStore((s) => s.bookmarks);

  // The palette is a TRANSIENT overlay, so it SNAPSHOTS session-derived data once
  // per open rather than subscribing to it live. Every agent heartbeat bumps
  // updated_at on its conversation, which both mints a fresh `s.sessions` ref AND
  // pushes a new `listRecentSessions` result ~1-2×/sec — and the old live
  // subscriptions re-ran a merge+sort over the WHOLE session cache (thousands of
  // rows) on each one, janking the open palette. Recents going a few seconds stale
  // while it's up is fine; the search groups below cover anything the snapshot misses.

  // Server recents: gate on open AND "not yet frozen" so the query unsubscribes
  // after its first result — heartbeat pushes then stop re-rendering the palette.
  const recentFrozenRef = useRef(false);
  const recentConversations = useQuery(
    api.conversations.listRecentSessions,
    open && !recentFrozenRef.current ? {} : "skip",
  );

  // Globally-synced lightweight index of tasks/docs/plans (title + short_id +
  // status), populated by DashboardLayout's useSyncMention* hooks. Captured at
  // open (already pre-synced) so a closed palette ignores entity-sync churn and an
  // open one doesn't re-render on it.
  const mentionIndex = useMemo(
    () => (open ? useInboxStore.getState().mentionIndex : EMPTY_MENTION_INDEX),
    [open],
  );
  // Workspace scoping uses the active-team pointer alone: an unset pointer IS
  // the personal workspace, so falling back to the user's default team here
  // would make personal rows unreachable from the palette.
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const savedViewRows = useInboxStore((s) => s.savedViews);
  // Opt-in team features: an off feature has no palette entry, no channel
  // rows and no "search chat" — the same "no UI at all" rule the sidebar uses.
  const chatOn = useTeamFeature("chat");
  const callsOn = useCallsAvailable();
  const featureOn = (f: TeamFeatureKey | undefined) => !f || (f === "chat" ? chatOn : callsOn);

  // Merge locally-loaded inbox sessions (own, instant) with the server list (own +
  // team-visible). Shows local sessions immediately, re-merges once when the server
  // result lands, then FREEZES — so heartbeat churn can't re-run this whole-cache
  // sort while the palette is open, and the query above flips to "skip".
  const [recentSessions, setRecentSessions] = useState<any[]>([]);
  useWatchEffect(() => {
    if (!open) { recentFrozenRef.current = false; setRecentSessions([]); return; }
    if (recentFrozenRef.current) return;
    const byId = new Map<string, any>();
    for (const c of (recentConversations ?? [])) byId.set(c._id, c);
    // Scope the local cache like the inbox panel (and the chip counts above):
    // the store caches sessions across scopes, so an unfiltered merge would
    // resurface rows from a previously viewed scope as recents.
    for (const s of Object.values(filterInboxScopeFromState(useInboxStore.getState()))) {
      if ((s as any).is_subagent) continue;
      byId.set(s._id, { ...byId.get(s._id), ...(s as any) });
    }
    setRecentSessions(Array.from(byId.values()).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)));
    // Server query has landed (undefined = still loading) → freeze.
    if (recentConversations !== undefined) recentFrozenRef.current = true;
  }, [open, recentConversations]);

  // "Recently Visited" — the unified recents rail (sessions, chip views,
  // pages), same source as the header's RecentlyViewedMenu. Empty-query only:
  // with a query the dedicated search groups below take over. The standalone
  // Electron palette window has its own store, so chip-view items (which
  // mutate THIS window's filters) are meaningless there and skipped.
  const vaultReady = useVaultStore((st) => st.vaults.length > 0 || st.activeVaultId !== null);

  // Vault notes are searchable from Cmd+K like any entity. Snapshot the file
  // index at open (same pattern as mentionIndex): the vault store churns on
  // watcher events, and a transient overlay shouldn't re-render on them.
  const vaultFiles = useMemo(
    () => (open && vaultReady ? useVaultStore.getState().files : EMPTY_VAULT_FILES),
    [open, vaultReady],
  );
  const vaultNoteMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ranked: Array<{ path: string; base: string; rank: number; mtime: number }> = [];
    for (const [path, entry] of Object.entries(vaultFiles)) {
      if (entry.dir || !MARKDOWN_RE.test(path)) continue;
      const base = (path.split("/").pop() || path).replace(MARKDOWN_RE, "");
      const rank = Math.min(score(base, q), score(path, q));
      if (rank === Infinity) continue;
      ranked.push({ path, base, rank, mtime: entry.mtime || 0 });
    }
    ranked.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
    return ranked.slice(0, ENTITY_RENDER_CAP);
  }, [vaultFiles, query]);

  // Triggers (schedules) search — same list the /triggers page subscribes to,
  // gated on an actual query so an idle palette costs nothing. Convex dedupes
  // the subscription when the page is already open.
  // Store-fed (hooks/useSyncTriggers): the palette searches the cached
  // roster; the feeder mounts only while a search is live.
  useSyncTriggers(open && query.trim().length >= 2);
  const triggerList = useCollectionRows<any>("agentTasks", { sig: triggerSig });
  const triggerMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !Array.isArray(triggerList)) return [];
    const ranked: Array<{ t: any; rank: number }> = [];
    for (const t of triggerList) {
      if (t.status === "completed" || t.status === "cancelled") continue;
      let rank = Math.min(score(t.title || "", q), score(t.prompt || "", q));
      if (rank === Infinity) {
        if (!t.short_id?.toLowerCase().includes(q)) continue;
        rank = 50;
      }
      ranked.push({ t, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || (b.t.updated_at || b.t._creationTime || 0) - (a.t.updated_at || a.t._creationTime || 0));
    return ranked.slice(0, 6).map((r) => r.t);
  }, [triggerList, query]);

  // Global command rows fire the same handlers their keyboard chords use.
  const { dispatchAction } = useShortcuts();
  const { theme, toggleTheme } = useTheme();
  const recentVisits = useInboxStore((s) => (open ? s.recentVisits : EMPTY_RECENT_VISITS));
  const recentVisitRows = useMemo(
    () => (open ? resolveRecentVisits(useInboxStore.getState(), RECENT_VISITS_RENDER_CAP, { skipViews: standalone }) : []),
    [recentVisits, open, standalone],
  );

  // A conversation's label (manual bucket) is a derived join, not a stored
  // field — resolve it live from the same assignment rows the session panel
  // uses. Gated on `open` so a closed palette ignores filing churn.
  const buckets = useInboxStore((s) => (open ? s.buckets : EMPTY_BUCKETS));
  const bucketAssignments = useInboxStore((s) => (open ? s.bucketAssignments : EMPTY_BUCKET_ASSIGNMENTS));
  const labelForConv = useMemo(() => {
    const byConv = convBucketMap(bucketAssignments as Record<string, BucketAssignmentItem>);
    const all = buckets as Record<string, BucketItem>;
    return (convId: string): BucketItem | null => {
      const id = byConv[convId];
      const b = id ? all[id] : undefined;
      return b && !b.archived_at ? b : null;
    };
  }, [buckets, bucketAssignments]);

  // Pre-filter the local cache ourselves so cmdk only ever mounts the matches
  // (RECENT_RENDER_CAP), never the whole cache. With no query we show the most
  // recent few; with a query we scan up to RECENT_SEARCH_CAP and collect matches.
  const recentMatches = useMemo(() => {
    if (!query.trim()) return recentSessions.slice(0, 8);
    const q = query.toLowerCase();
    const scan = recentSessions.length > RECENT_SEARCH_CAP
      ? recentSessions.slice(0, RECENT_SEARCH_CAP)
      : recentSessions;
    const out: any[] = [];
    for (let i = 0; i < scan.length && out.length < RECENT_RENDER_CAP; i++) {
      const conv = scan[i];
      // Summaries are part of the haystack: subtitle (multi-line generated
      // summary) and idle_summary (one-line blurb) match sessions the user
      // remembers by what they did, not what they're titled.
      const hay = `${cleanTitle(conv.title || "")} ${conv.subtitle || ""} ${conv.idle_summary || ""} ${conv.project_path || ""} ${conv.authorName || ""}`.toLowerCase();
      if (hay.includes(q)) out.push(conv);
    }
    return out;
  }, [recentSessions, query]);

  // Search tasks / docs / plans over the mention index. Only when there's a
  // query — the empty palette stays session-focused. Plan-type docs are excluded
  // from Documents so they don't double up with the Plans group.
  const taskMatches = useMemo(
    () => matchEntities(mentionIndex.tasks as any, query, activeTeamId, ENTITY_RENDER_CAP, (t) => t.status === "dropped", picking && pickAllows("task")),
    [mentionIndex, query, activeTeamId, picking, pickAllows],
  );
  const docMatches = useMemo(
    () => matchEntities(mentionIndex.docs as any, query, activeTeamId, ENTITY_RENDER_CAP, (d) => d.doc_type === "plan", picking && pickAllows("doc")),
    [mentionIndex, query, activeTeamId, picking, pickAllows],
  );
  const planMatches = useMemo(
    () => matchEntities(mentionIndex.plans as any, query, activeTeamId, ENTITY_RENDER_CAP, (p) => p.status === "abandoned", picking && pickAllows("plan")),
    [mentionIndex, query, activeTeamId, picking, pickAllows],
  );

  // Debounced search for async conversation results
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useWatchEffect(() => {
    if (!open) { setDebouncedQuery(""); return; }
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Non-throwing: a broad term can blow the backend's query budget and return a
  // terminal error — bare useQuery re-throws that in render and unmounts the
  // whole palette into its ErrorBoundary (ct-37627). The breaker unsubscribes a
  // never-resolving search so its silent retry loop stops flapping the shared
  // websocket (1011) for the rest of the app.
  const { data: searchResults, error: searchError } = useQueryNoThrow(
    api.conversations.searchConversations,
    open && debouncedQuery.length >= 2 ? { query: debouncedQuery, limit: 10 } : "skip",
    { breakAfterMs: 15_000 }
  );
  const searchData = searchResults && "results" in searchResults ? searchResults : null;
  // Cheap always-fast companion: title/subtitle/summary matches come from the
  // small conversations table and land while (or even if never) the message
  // content search resolves — so the user always gets something (ct-37627).
  const { data: titleResults } = useQueryNoThrow(
    api.conversations.searchConversationTitles,
    open && debouncedQuery.length >= 2 ? { query: debouncedQuery, limit: 10 } : "skip"
  );
  const titleData = titleResults && "results" in titleResults ? titleResults : null;
  const searchRows = useMemo(() => {
    const msgRows = searchData?.results ?? [];
    const titleRows = titleData?.results ?? [];
    if (!titleRows.length) return msgRows;
    const seen = new Set(msgRows.map((r: any) => r.conversationId));
    return [...msgRows, ...titleRows.filter((r: any) => !seen.has(r.conversationId))];
  }, [searchData, titleData]);

  // Chat rooms by name — a SNAPSHOT read (getState), not a subscription: the
  // channel map churns with every unread tick and the palette must not
  // re-render on team chatter while open (see the snapshot-memo rule above).
  // Scope and naming are the shared rules (inActiveWorkspace, channelDisplayName),
  // never restated here: the store caches rooms across workspaces, and an
  // inlined predicate is how another team's rooms leak into this one's palette.
  const chatChannelRows = useMemo(() => {
    // Channel pick mode (e.g. "send this link to…") browses with an empty
    // query and also offers teammates with no DM room yet — the caller opens
    // the DM on pick.
    const pickingChannels = picking && pickAllows("channel");
    if (!open || !chatOn || (!pickingChannels && query.trim().length < 1))
      return [] as Array<{ id: string; label: string; kind?: string; isPrivate?: boolean; image?: string }>;
    const state = useInboxStore.getState() as any;
    const viewerId = state.currentUser?._id ? String(state.currentUser._id) : "";
    const members = (state.teamMembers ?? []) as any[];
    const teamScope = activeTeamId ? String(activeTeamId) : undefined;
    const q = query.trim().toLowerCase();
    const rows: Array<{ id: string; label: string; kind?: string; isPrivate?: boolean; image?: string; s: number; t: number }> = [];
    const dmPartners = new Set<string>();
    for (const id in state.chatChannels) {
      const c = state.chatChannels[id];
      if (!c || c.archived_at) continue;
      if (!inActiveWorkspace({ team_id: c.team_id ? String(c.team_id) : undefined }, teamScope)) continue;
      const others = c.kind === "dm" ? dmOtherIds(c.dm_key, viewerId) : [];
      if (c.kind === "dm" && !others.length) continue;
      if (c.kind === "dm" && others.length === 1) dmPartners.add(others[0]);
      const label = channelDisplayName({ name: c.name, kind: c.kind, dmMemberIds: others }, members);
      if (!label) continue;
      const counterpart = dmCounterpart({ kind: c.kind, dmMemberIds: others }, members);
      const s = matchScore(label, q);
      if (s === Infinity) continue;
      rows.push({ id, label, kind: c.kind, isPrivate: c.kind === "private", image: memberAvatarUrl(counterpart), s, t: c.updated_at ?? 0 });
    }
    if (pickingChannels) {
      for (const m of members) {
        const mid = m?._id ? String(m._id) : "";
        if (!mid || mid === viewerId || dmPartners.has(mid)) continue;
        const label = memberName(m);
        if (!label) continue;
        const s = matchScore(label, q);
        if (s === Infinity) continue;
        rows.push({ id: mid, label, kind: "person", image: memberAvatarUrl(m), s, t: 0 });
      }
    }
    return rows.sort((a, b) => a.s - b.s || b.t - a.t).slice(0, pickingChannels ? 12 : 5);
  }, [open, query, activeTeamId, chatOn, picking, pick]);

  // Chat message hits ride the same debounced non-throwing lane as
  // conversation search — and the same access story: the server re-checks
  // room membership per hit, so private rooms never leak through here.
  const { data: chatSearchData } = useQueryNoThrow(
    api.chat.searchMessages,
    open && chatOn && debouncedQuery.length >= 2 && activeTeamId
      ? { team_id: activeTeamId, q: debouncedQuery, limit: 5 }
      : "skip",
    { breakAfterMs: 15_000 }
  );
  const chatHits = (chatSearchData?.results ?? []) as any[];
  const chatMemberName = useCallback((userId: string) => {
    const members = ((useInboxStore.getState() as any).teamMembers ?? []) as any[];
    return memberName(members.find((m) => String(m._id) === String(userId)));
  }, []);

  const projects = useMemo(() => {
    const dirMap = new Map<string, number>();
    for (const c of recentSessions) {
      const dir = c.git_root || c.project_path;
      if (dir) {
        const existing = dirMap.get(dir) || 0;
        if (c.updated_at > existing) dirMap.set(dir, c.updated_at);
      }
    }
    return Array.from(dirMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([path]) => path);
  }, [recentSessions]);

  // Global Cmd+K toggle — context-aware
  const storeOpenPalette = useInboxStore((s) => s.openPalette);
  useShortcutAction('palette.toggle', useCallback(() => {
    if (standalone) return;
    const state = useInboxStore.getState();
    if (state.palette.open) {
      state.closePalette();
      return;
    }
    const taskMatch = pathname?.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const id = taskMatch[1];
      const task = state.tasks[id] || Object.values(state.tasks).find((t: any) => t._id === id || t.short_id === id);
      if (task) {
        storeOpenPalette({ targets: [task], targetType: 'task' });
        return;
      }
    }
    const docMatch = pathname?.match(/^\/docs\/([^/]+)$/);
    if (docMatch) {
      const id = docMatch[1];
      const doc = state.docDetails[id] || state.docs[id];
      if (doc) {
        storeOpenPalette({ targets: [doc], targetType: 'doc' });
        return;
      }
    }
    const planMatch = pathname?.match(/^\/plans\/([^/]+)$/);
    if (planMatch) {
      storeOpenPalette({ targets: [{ _id: planMatch[1], short_id: planMatch[1] }], targetType: 'plan' });
      return;
    }
    // On conversation pages, target the current session
    const convMatch = pathname?.match(/^\/conversation\/([^/]+)/);
    if (convMatch) {
      const id = convMatch[1];
      const session = state.sessions[id];
      if (session) {
        storeOpenPalette({ targets: [session], targetType: 'session' });
        return;
      }
    }
    // On inbox with a selected session, target it
    if (isInboxRoute(pathname)) {
      const currentId = state.currentSessionId;
      const session = currentId ? state.sessions[currentId] : null;
      if (session) {
        storeOpenPalette({ targets: [session], targetType: 'session' });
        return;
      }
    }
    // On list pages, return false so GenericListView can handle with focused item
    if (pathname === '/tasks' || pathname === '/docs') return false;
    togglePalette();
  }, [standalone, togglePalette, storeOpenPalette, pathname]));

  // Reset state when palette opens
  useWatchEffect(() => {
    if (open) {
      setQuery(paletteInitialQuery || "");
      setActionMode(initialMode !== "root" ? initialMode as ActionMode : null);
      setEnteredViaRoot(false);
      setPickNote("");
      setPickChosen(null);
    }
  }, [open, initialMode, paletteInitialQuery]);

  // Escape handling — Esc anywhere in the palette escapes to GLOBAL (closes
  // it), including inside action submenus. Climbing back to the root list is
  // ↑/Backspace in the submenu, not Esc.
  useWatchEffect(() => {
    if (standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        e.preventDefault();
        closePalette();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, standalone, closePalette]);

  // Standalone palette events (Electron) — same global-escape rule: Esc hides
  // the palette window even from inside a submenu.
  useWatchEffect(() => {
    if (!standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setActionMode(null);
        if (isElectron()) {
          window.__CODECAST_ELECTRON__?.paletteHide?.();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [standalone]);

  useWatchEffect(() => {
    if (!standalone || !isElectron()) return;
    const unsub = window.__CODECAST_ELECTRON__?.onPaletteShow?.(() => {
      setQuery("");
      setActionMode(null);
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>("[cmdk-input]");
        input?.focus();
      }, 50);
    });
    return unsub;
  }, [standalone]);

  const navigate = useCallback(
    (path: string) => {
      if (standalone && isElectron()) {
        window.__CODECAST_ELECTRON__?.paletteNavigate?.(path);
        return;
      }
      router.push(path);
      closePalette();
    },
    [router, standalone, closePalette]
  );

  // Hand the current query off to the full /search page — the palette shows a
  // capped preview; the page has filters, pagination, and message context.
  const openFullSearch = useCallback(() => {
    const q = query.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }, [query, navigate]);

  const openVaultNote = useCallback((path: string) => {
    useVaultStore.getState().noteOpened(path);
    navigate(filesHref({ path }));
  }, [navigate]);

  // One compose entry for both hosts: the standalone Electron palette window
  // flips itself into the compose popup; in-app opens the compose overlay.
  const startCompose = useCallback((text: string) => {
    if (standalone) {
      window.dispatchEvent(new CustomEvent("codecast-compose", { detail: text }));
    } else {
      closePalette();
      useInboxStore.getState().openCompose(text || undefined);
    }
  }, [standalone, closePalette]);

  const navigateToSession = useCallback(
    (
      conv: { _id: string; session_id?: string; title?: string; updated_at?: number; project_path?: string; git_root?: string; agent_type?: string; message_count?: number; is_idle?: boolean; user_id?: string; authorName?: string | null; authorAvatar?: string | null; inbox_killed_at?: number | null; inbox_dismissed_at?: number | null; inbox_stashed_at?: number | null; inbox_pinned_at?: number | null },
      opts?: { messageId?: string; highlight?: string }
    ) => {
      const hash = opts?.messageId ? `#msg-${opts.messageId}` : "";
      const conversationPath = `/conversation/${conv._id}${hash}`;
      if (standalone && isElectron()) {
        window.__CODECAST_ELECTRON__?.paletteNavigate?.(conversationPath);
        return;
      }
      const store = useInboxStore.getState();
      const pending: Record<string, any> = {};
      if (opts?.messageId) pending.pendingScrollToMessageId = opts.messageId;
      if (opts?.highlight) pending.pendingHighlightQuery = opts.highlight;
      if (Object.keys(pending).length > 0) useInboxStore.setState(pending);
      if (!store.sessions[conv._id]) {
        // sessionRowFromSummary carries the triage stamps (killed/stash/
        // dismiss/pin) through — an injected killed row used to render alive,
        // and a stashed one flashed into the inbox as an active card at boot
        // (ct-42666). Both palette sources supply them: favorites pass whole
        // store rows, performListRecentSessions projects them off the doc.
        store.injectSession(sessionRowFromSummary({
          ...conv,
          // Search/recent results null out author for own sessions, so a present
          // authorName means "not mine" — carry it so the card labels whose it is.
          author_name: conv.authorName ?? null,
          author_avatar: conv.authorAvatar ?? null,
        }));
      } else {
        store.navigateToSession(conv._id);
      }
      if (isInboxRoute(pathname) || pathname?.startsWith("/conversation/")) {
        window.history.pushState({ inboxId: conv._id }, "", conversationPath);
      } else {
        router.push(conversationPath);
      }
      closePalette();
    },
    [router, pathname, standalone, closePalette]
  );

  // Pick mode: report the choice to the caller and close. Session rows go
  // through chooseSession so every session group (favorites, bookmarks,
  // recents, search) picks the same way it navigates.
  const finishPick = useCallback(
    (target: PalettePickTarget) => {
      if (!pick) return;
      if (pick.notePlaceholder) {
        // Two-step: stage the target; the confirm step completes the pick.
        setPickChosen({ target, query: query.trim() });
        return;
      }
      pick.onPick(target, { query: query.trim() });
      closePalette();
    },
    [pick, query, closePalette],
  );
  const sendPick = useCallback(() => {
    if (!pick || !pickChosen) return;
    const note = pickNote.trim();
    pick.onPick(pickChosen.target, { note: note || undefined, query: pickChosen.query });
    closePalette();
  }, [pick, pickChosen, pickNote, closePalette]);
  const chooseSession = useCallback(
    (conv: Parameters<typeof navigateToSession>[0], opts?: Parameters<typeof navigateToSession>[1]) => {
      if (pick) return finishPick({ kind: "session", id: conv._id, label: cleanTitle(conv.title || "Untitled") });
      navigateToSession(conv, opts);
    },
    [pick, finishPick, navigateToSession],
  );
  const chooseEntity = useCallback(
    (kind: Exclude<PalettePickKind, "session">, rec: { _id: string; title?: string }, path: string) => {
      if (pick) return finishPick({ kind, id: rec._id, label: rec.title || "Untitled" });
      navigate(path);
    },
    [pick, finishPick, navigate],
  );

  // Sessions go through navigateToSession (it injects rows the store lacks);
  // the palette's own navigate closes the overlay with the move, and a chip
  // view that stays on the page closes it here.
  const openRecentSession = useCallback(
    (id: string) => {
      const conv = recentSessions.find((c) => c._id === id);
      const row = recentVisitRows.find((r) => r.sessionId === id);
      navigateToSession(conv ?? { _id: id, title: row?.title });
    },
    [recentSessions, recentVisitRows, navigateToSession],
  );
  const openRecentVisit = useOpenRecentVisit(openRecentSession, navigate);
  const handleRecentVisitSelect = useCallback(
    (row: ResolvedVisit) => {
      openRecentVisit(row);
      if (row.bucketId || row.projectName) closePalette();
    },
    [openRecentVisit, closePalette],
  );

  // Root action handlers
  const handleRootAction = useCallback((actionKey: string) => {
    if (!targets.length) return;
    const target = targets[0] as any;

    if (["status", "priority", "labels", "assign", "type", "plan_status", "agent_run", "bucket", "model", "parent"].includes(actionKey)) {
      setEnteredViaRoot(true);
      setActionMode(actionKey as ActionMode);
      return;
    }

    if (actionKey === "remove_parent" && targetType === "task") {
      for (const t of targets as TaskItem[]) {
        if ((t as any).parent_id) setTaskParent(t.short_id, "");
      }
      toast.success("Parent removed");
      closePalette();
      return;
    }

    if (actionKey === "copy") {
      if (targetType === "task" && isTask(target)) {
        copyToClipboard(target.short_id);
        toast.success(`Copied ${target.short_id}`);
      } else if (targetType === "plan") {
        copyToClipboard(target.short_id || target._id);
        toast.success(`Copied ${target.short_id || target._id}`);
      } else {
        copyToClipboard(target._id);
        toast.success("Copied ID");
      }
      closePalette();
      return;
    }

    if (actionKey === "drop" && targetType === "task") {
      let deferred = false;
      for (const t of targets as TaskItem[]) {
        if (closeTaskWithGuard(t.short_id, "dropped").needsConfirm) deferred = true;
      }
      if (!deferred) toast.success("Task dropped");
      closePalette();
      return;
    }

    if (actionKey === "pin" && targetType === "doc") {
      const doc = target as DocItem;
      pinDoc(doc._id, !doc.pinned);
      toast.success(doc.pinned ? "Unpinned" : "Pinned");
      closePalette();
      return;
    }

    if (actionKey === "archive" && targetType === "doc") {
      undoableArchiveDoc(target._id);
      router.push("/docs");
      closePalette();
      return;
    }

    // Session actions
    if (targetType === "session") {
      const session = target as InboxSession;
      if (actionKey === "session_pin") {
        useInboxStore.getState().pinSession(session._id);
        toast.success(session.is_pinned ? "Unpinned" : "Pinned");
        closePalette();
      } else if (actionKey === "session_favorite") {
        useInboxStore.getState().toggleFavorite(session._id);
        toast.success(session.is_favorite ? "Removed from favorites" : "Added to favorites");
        closePalette();
      } else if (actionKey === "session_kill") {
        // The teardown rides the hide transition server-side (dispatch.applyPatches);
        // the notice hook names any schedules the kill cancels.
        killWithNotice(session._id);
        closePalette();
      } else if (actionKey === "session_stash") {
        undoableHideSession(session._id, "stash");
        closePalette();
      } else if (actionKey === "session_stash_hide") {
        undoableHideSession(session._id, "stash", { hidden: true });
        closePalette();
      } else if (actionKey === "session_defer") {
        undoableDeferSession(session._id);
        closePalette();
      } else if (actionKey === "session_dormant") {
        undoableDormantSession(session._id);
        closePalette();
      } else if (actionKey === "session_copy") {
        copyToClipboard(session._id);
        toast.success("Copied session ID");
        closePalette();
      } else if (actionKey === "session_copylink") {
        copyToClipboard(`${shareOrigin()}/conversation/${session._id}`).then(() => toast.success("Link copied!"));
        closePalette();
      } else if (actionKey === "session_rename") {
        // Navigate to the session and let them rename inline
        navigate(`/conversation/${session._id}`);
      } else if (actionKey === "session_newtab") {
        window.open(`/conversation/${session._id}`, "_blank");
        closePalette();
      }
      return;
    }
  }, [targets, targetType, closePalette, updateTask, pinDoc, router, navigate, killWithNotice]);

  const hasTargets = targets.length > 0 && targetType;
  const target = targets[0] as any;

  const contextLabel = useMemo(() => {
    if (!hasTargets) return "";
    if (targets.length === 1) {
      if (targetType === "session") {
        const s = target as InboxSession;
        return cleanTitle(s.title || "Untitled");
      }
      if (isTask(target)) return `${target.short_id} \u00B7 ${target.title}`;
      return target.display_title || target.title || "Untitled";
    }
    return `${targets.length} ${targetType}s selected`;
  }, [targets, target, targetType, hasTargets]);

  // Rows with a real global binding reference it by registry action \u2014 the hint
  // is derived (MenuKeyCaps), never typed by hand. Rows without one show none.
  type ContextActionRow = {
    key: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    shortcutAction?: ShortcutAction;
  };

  const taskActions = useMemo((): ContextActionRow[] => [
    { key: "status", label: "Change status...", icon: CircleDot },
    { key: "priority", label: "Set priority...", icon: ArrowUp },
    { key: "labels", label: "Add labels...", icon: Tag },
    { key: "assign", label: "Assign to...", icon: User },
    { key: "parent", label: "Set parent...", icon: CornerDownRight },
    ...(targets.some((t: any) => t?.parent_id) ? [{ key: "remove_parent", label: "Remove parent", icon: CornerDownRight }] : []),
    { key: "agent_run", label: "Start agent run...", icon: Bot },
    { key: "copy", label: "Copy task ID", icon: Copy },
    { key: "drop", label: "Drop task", icon: Trash2 },
  ], [targets]);

  const docActions = useMemo((): ContextActionRow[] => {
    const isPinned = target?.pinned;
    return [
      { key: "type", label: "Change type...", icon: FileText },
      { key: "pin", label: isPinned ? "Unpin document" : "Pin document", icon: Pin },
      { key: "labels", label: "Add labels...", icon: Tag },
      { key: "copy", label: "Copy document ID", icon: Copy },
      { key: "archive", label: "Archive document", icon: Archive },
    ];
  }, [target?.pinned]);

  const planActions = useMemo((): ContextActionRow[] => [
    { key: "plan_status", label: "Change status...", icon: CircleDot },
    { key: "copy", label: "Copy plan ID", icon: Copy },
  ], []);

  const sessionActions = useMemo((): ContextActionRow[] => {
    if (targetType !== "session" || !target) return [];
    const s = target as InboxSession;
    // Inbox convention: author_name is stamped only for teammates' sessions, so
    // its absence means this is the user's own session. Favorite is an owner-only
    // marking (matches the conv.favorite gate in ConversationView), so hide it on
    // teammates' sessions surfaced via recents/search.
    const isOwnSession = !(s as any).author_name && (!s.user_id || !currentUser || s.user_id === (currentUser as any)._id);
    return [
      { key: "session_pin", label: s.is_pinned ? "Unpin session" : "Pin session", icon: s.is_pinned ? PinOff : Pin, shortcutAction: "session.pin" },
      ...(isOwnSession
        ? [{ key: "session_favorite", label: s.is_favorite ? "Remove from favorites" : "Add to favorites", icon: Star, shortcutAction: "conv.favorite" } as ContextActionRow]
        : []),
      { key: "bucket", label: "Label session...", icon: Tag, shortcutAction: "session.moveToBucket" },
      ...(canControlModel(s.agent_type, (s.message_count ?? 0) === 0)
        ? [{ key: "model", label: "Change model & effort...", icon: Cpu } as ContextActionRow]
        : []),
      { key: "session_stash", label: "Stash session", icon: Archive, shortcutAction: "session.stash" },
      { key: "session_stash_hide", label: "Stash and hide session", icon: EyeOff, shortcutAction: "session.stashHide" },
      { key: "session_kill", label: "Kill session", icon: Square, shortcutAction: "session.kill" },
      { key: "session_defer", label: "Defer session", icon: Clock, shortcutAction: "session.deferAdvance" },
      { key: "session_dormant", label: "Dormant — a machine wakes it", icon: Moon, shortcutAction: "session.dormantAdvance" },
      { key: "session_rename", label: "Rename session", icon: Pencil, shortcutAction: "session.rename" },
      { key: "session_copy", label: "Copy session ID", icon: Copy },
      { key: "session_copylink", label: "Copy link", icon: LinkIcon, shortcutAction: "conv.copyLink" },
      { key: "session_newtab", label: "Open in new tab", icon: ExternalLink },
    ];
  }, [targetType, target, currentUser]);

  const actions = targetType === "task" ? taskActions
    : targetType === "doc" ? docActions
    : targetType === "plan" ? planActions
    : targetType === "session" ? sessionActions
    : [];

  const showFavorites = favorites && favorites.length > 0;
  const showBookmarks = bookmarks && bookmarks.length > 0;
  const showWorkspaces = projects.length > 0;
  // Rail order (yours first, then teammates'), the same order ⌥1-⌥9 index into.
  const layouts = useMemo(
    () => sortedWorkbenches({ savedViews: savedViewRows ?? {}, clientState: { ui: { active_team_id: activeTeamId } } }),
    [savedViewRows, activeTeamId],
  );
  const myLayouts = useMemo(() => layouts.filter((v) => v.is_mine !== false), [layouts]);
  // The layout you switched to last, if it is yours: one row updates it in
  // place without picking — the rail's inline "update" for a closed rail.
  const activeWorkbenchId = useInboxStore((s) => s.activeWorkbenchId);
  const currentLayout = useMemo(
    () => myLayouts.find((v) => v._id === activeWorkbenchId) ?? null,
    [myLayouts, activeWorkbenchId],
  );

  const groupClass = "px-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-sol-text-dim/70";
  const itemClass = "flex items-center gap-3 px-2.5 py-2 mx-1 rounded-lg text-sm text-sol-text-muted cursor-pointer transition-colors data-[selected=true]:bg-sol-cyan/10 data-[selected=true]:text-sol-text";

  // Action submenu mode. The workspace modes ("view", layout CRUD) are global,
  // so they need no target entity — and show no entity header. The `open` check
  // matters for those: actionMode survives closePalette (it only resets on the
  // next open), so without it the overlay would stick.
  if (open && actionMode && (hasTargets || TARGETLESS_MODES.has(actionMode))) {
    const paletteContent = (
      <div className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
        {contextLabel && !TARGETLESS_MODES.has(actionMode) && (
          <div className="px-4 pt-3 pb-0">
            <div className="text-xs font-mono text-sol-text-dim truncate">{contextLabel}</div>
          </div>
        )}
        <ActionSubmenu
          mode={actionMode}
          targets={targets}
          targetType={targetType ?? "session"}
          onClose={closePalette}
          onBack={() => setActionMode(null)}
          enteredViaRoot={enteredViaRoot}
          teamMembers={teamMembers}
          currentUser={currentUser}
        />
      </div>
    );

    if (standalone) return paletteContent;

    return (
      <div className="fixed inset-0 z-[9999]">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={closePalette} />
        <div className="absolute inset-0 flex items-start justify-center pt-[min(20vh,160px)]">
          {paletteContent}
        </div>
      </div>
    );
  }

  // Pick confirm step: the target is chosen; collect the optional note and
  // confirm. A plain view, not a CommandPrimitive — there is no list to
  // filter. Esc still closes the whole palette (the house rule); Backspace in
  // the empty note field or the target row itself goes back to the list.
  if (pick && pickChosen) {
    const target = pickChosen.target;
    const extra = target.kind === "extra" ? (pick.extras ?? []).find((x) => x.key === target.key) : null;
    const label = target.kind === "extra" ? (extra?.label ?? "Selection") : target.label;
    // Chat rows collapse DMs and channels into kind "channel" — recover the
    // row for its real icon (avatar / lock / hash) and tag.
    const chatRow = target.kind === "channel" || target.kind === "person"
      ? chatChannelRows.find((r) => r.id === target.id)
      : null;
    const tag =
      chatRow ? (chatRow.kind === "dm" ? "direct message" : chatRow.kind === "person" ? "new direct message" : "channel")
      : target.kind === "extra" ? null
      : target.kind === "person" ? "new direct message"
      : target.kind;
    const icon =
      chatRow?.kind === "dm" || chatRow?.kind === "person" || target.kind === "person" ? (
        <AvatarImg
          src={chatRow?.image}
          alt=""
          className="w-4 h-4 rounded-full flex-shrink-0"
          fallback={<User className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />}
        />
      ) : chatRow?.isPrivate ? (
        <Lock className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      ) : target.kind === "channel" ? (
        <Hash className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      ) : target.kind === "doc" || extra?.icon === "doc" ? (
        <FileText className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      ) : target.kind === "task" ? (
        <ListTodo className="w-4 h-4 flex-shrink-0 text-sol-cyan" />
      ) : target.kind === "plan" ? (
        <MapIcon className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      ) : target.kind === "session" ? (
        <MessageSquare className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      ) : extra?.icon === "slack" ? (
        <Hash className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
      ) : (
        <Sparkles className="w-4 h-4 flex-shrink-0 text-sol-violet" />
      );
    const confirmContent = (
      <div className="w-[580px] rounded-xl border border-sol-border bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
        <div className="px-4 pt-3">
          <div className="text-xs font-mono text-sol-text-dim truncate">{pick.title}</div>
        </div>
        <button
          type="button"
          onClick={() => setPickChosen(null)}
          className="mx-3 mt-2 flex items-center gap-3 rounded-lg border border-sol-border bg-sol-bg-inset px-3 py-2 text-left transition-colors hover:bg-sol-bg-highlight"
        >
          {icon}
          <span className="truncate flex-1 text-sm text-sol-text">{label}</span>
          {tag && <span className="text-[10px] text-sol-text-dim flex-shrink-0">{tag}</span>}
          <span className="text-[11px] text-sol-text-muted flex-shrink-0">change</span>
        </button>
        <div className="px-3 pt-2 pb-3">
          <input
            value={pickNote}
            onChange={(e) => setPickNote(e.target.value)}
            placeholder={pick.notePlaceholder}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendPick();
              } else if (e.key === "Backspace" && !pickNote) {
                e.preventDefault();
                setPickChosen(null);
              }
            }}
            className="w-full rounded-lg border border-sol-border bg-sol-bg-inset px-3 py-2 text-sm text-sol-text placeholder:text-sol-text-dim focus:border-sol-violet focus:outline-none"
          />
        </div>
        <div className="px-3 pb-3 flex items-center justify-between">
          <span className="flex items-center gap-1 text-[10px] text-sol-text-dim">
            <KeyCap size="xs">&#9003;</KeyCap>
            back
          </span>
          <button
            type="button"
            onClick={sendPick}
            className="sol-btn-primary flex items-center gap-2 border border-sol-border"
          >
            {pick.confirmLabel ?? "Send"}
            <KeyCap size="xs">&#9166;</KeyCap>
          </button>
        </div>
      </div>
    );
    if (standalone) return confirmContent;
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-[9999]">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={closePalette} />
        <div className="absolute inset-0 flex items-start justify-center pt-[min(20vh,160px)]">
          {confirmContent}
        </div>
      </div>
    );
  }

  // Root mode: navigation + context actions
  const paletteContent = (
    <CommandPrimitive
      className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
      filter={(value, search) => {
        // Async search results and compose are always relevant — bypass cmdk filter
        if (value.startsWith("__search__") || value.startsWith("__compose__") || value.startsWith("__recent__") || value.startsWith("__entity__") || value.startsWith("__chat__") || value.startsWith("__pick__")) return 1;
        const idx = value.indexOf("|||");
        const searchable = idx >= 0 ? value.slice(0, idx) : value;
        return searchable.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
      }}
      loop
    >
      {pick && (
        <div className="px-4 pt-3 pb-0">
          <div className="text-xs font-mono text-sol-text-dim truncate">{pick.title}</div>
        </div>
      )}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-sol-border/60">
        <div className="text-sol-text-dim">
          <NavIcon type="search" className="w-[18px] h-[18px]" />
        </div>
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          placeholder={pick ? "Search sessions, docs..." : hasTargets ? "Action or jump to..." : "Jump to..."}
          className="flex-1 bg-transparent text-[15px] text-sol-text placeholder:text-sol-text-dim/60 outline-none"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              openFullSearch();
            }
          }}
        />
        <KeyCap>Esc</KeyCap>
      </div>
      <CommandPrimitive.List className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain py-1.5 scroll-smooth">
        {!query.trim() && (
          <CommandPrimitive.Empty className="py-6 text-center text-sm text-sol-text-dim">
            No results found.
          </CommandPrimitive.Empty>
        )}

        {pick && (pick.extras ?? []).some((x) => !x.needsQuery || query.trim()) && (
          <CommandPrimitive.Group className={groupClass}>
            {(pick.extras ?? []).filter((x) => !x.needsQuery || query.trim()).map((x) => (
              <CommandPrimitive.Item
                key={`pick-${x.key}`}
                value={`__pick__ ${x.label}|||${x.key}`}
                onSelect={() => finishPick({ kind: "extra", key: x.key })}
                className={`${itemClass} ${x.primary ? "text-sol-text data-[selected=true]:bg-sol-violet/15" : ""}`}
              >
                {x.icon === "doc" ? (
                  <FileText className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                ) : x.icon === "slack" ? (
                  <Hash className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                ) : (
                  <Sparkles className="w-4 h-4 flex-shrink-0 text-sol-violet" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate">{x.label}</div>
                  {x.description && <div className="truncate text-[11px] text-sol-text-dim mt-0.5">{x.description}</div>}
                </div>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {hasTargets && !picking && (
          <CommandPrimitive.Group
            heading={contextLabel}
            className={groupClass}
          >
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <CommandPrimitive.Item
                  key={`action-${action.key}`}
                  value={`action ${action.label}|||${action.key}`}
                  onSelect={() => handleRootAction(action.key)}
                  className={itemClass}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate flex-1">{action.label}</span>
                  {action.shortcutAction && <MenuKeyCaps action={action.shortcutAction} />}
                </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.Group>
        )}

        {!picking && !query.trim() && recentVisitRows.length > 0 && (
          <CommandPrimitive.Group heading="Recently Visited" className={groupClass}>
            {recentVisitRows.map((row) => (
              <CommandPrimitive.Item
                key={`rv-${row.key}`}
                value={`recently visited ${row.title}|||${row.key}`}
                onSelect={() => handleRecentVisitSelect(row)}
                className={itemClass}
              >
                <RecentVisitGlyph item={row} className="w-4 h-4 flex-shrink-0" />
                <span className="truncate flex-1">{row.title}</span>
                <span className="text-[10px] text-sol-text-dim flex-shrink-0">{VISIT_OBJECT_LABEL[row.objectType].toLowerCase()}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{visitTimeAgo(row.ts)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {/* Global view switcher — drills into the label/project submenu. Not
            target-bound, so it's always offered (main app only: the standalone
            Electron palette window has no session panel to filter). */}
        {!standalone && !picking && (
          <CommandPrimitive.Group heading="View" className={groupClass}>
            <CommandPrimitive.Item
              key="view-switch"
              value="switch view filter label project sessions"
              onSelect={() => { setEnteredViaRoot(true); setActionMode("view"); }}
              className={itemClass}
            >
              <Filter className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
              <span className="truncate flex-1">Switch view (label / project)...</span>
              <MenuKeyCaps action="view.switch" />
            </CommandPrimitive.Item>
          </CommandPrimitive.Group>
        )}

        {/* Saved layouts. The rail's Layouts section is the other way in — this
            is the one that still works with the left sidebar closed, so every
            gesture there (switch, save, update, rename, delete) has a row here.
            Switch rows carry the ⌥N keycap, and the list is in rail order so the
            hint matches the chord. */}
        {!standalone && !picking && (
          <CommandPrimitive.Group heading="Layouts" className={groupClass}>
            {layouts.map((v, i) => (
              <CommandPrimitive.Item
                key={`wb-${v._id}`}
                value={`switch to layout ${v.name} layout workbench arrangement`}
                onSelect={() => { closePalette(); switchToWorkbench(v.prefs as WorkbenchSnapshot, router, pathname, v._id); }}
                className={itemClass}
              >
                <LayoutDashboard className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <span className="truncate flex-1">Switch to layout: {v.name}</span>
                {i < 9 && <MenuKeyCaps action={`workbench.${i + 1}` as ShortcutAction} />}
              </CommandPrimitive.Item>
            ))}
            {currentLayout && (
              <CommandPrimitive.Item
                key="wb-update-current"
                value={`update current layout ${currentLayout.name} workbench arrangement`}
                onSelect={() => {
                  closePalette();
                  useInboxStore.getState().updateWorkbench(currentLayout._id, pathname ?? undefined);
                  toast.success(`"${currentLayout.name}" now matches the current layout`);
                }}
                className={itemClass}
              >
                <RefreshCw className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <span className="truncate flex-1">Update current layout: {currentLayout.name}</span>
              </CommandPrimitive.Item>
            )}
            <CommandPrimitive.Item
              key="wb-save"
              value="save current layout as new layout workbench arrangement"
              onSelect={() => { setEnteredViaRoot(true); setActionMode("layout_save"); }}
              className={itemClass}
            >
              <Plus className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
              <span className="truncate flex-1">Save current layout as...</span>
            </CommandPrimitive.Item>
            {myLayouts.length > 0 && (
              <>
                <CommandPrimitive.Item
                  key="wb-update"
                  value="update layout to current arrangement workbench"
                  onSelect={() => { setEnteredViaRoot(true); setActionMode("layout_update"); }}
                  className={itemClass}
                >
                  <RefreshCw className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                  <span className="truncate flex-1">Update layout...</span>
                </CommandPrimitive.Item>
                <CommandPrimitive.Item
                  key="wb-rename"
                  value="rename layout workbench arrangement"
                  onSelect={() => { setEnteredViaRoot(true); setActionMode("layout_rename"); }}
                  className={itemClass}
                >
                  <Pencil className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                  <span className="truncate flex-1">Rename layout...</span>
                </CommandPrimitive.Item>
                <CommandPrimitive.Item
                  key="wb-delete"
                  value="delete remove layout workbench arrangement"
                  onSelect={() => { setEnteredViaRoot(true); setActionMode("layout_delete"); }}
                  className={itemClass}
                >
                  <Trash2 className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                  <span className="truncate flex-1">Delete layout...</span>
                </CommandPrimitive.Item>
              </>
            )}
          </CommandPrimitive.Group>
        )}

        {showFavorites && pickAllows("session") && (
          <CommandPrimitive.Group heading="Favorites" className={groupClass}>
            {(query ? favorites! : favorites!.slice(0, 5)).map((fav: any) => (
              <CommandPrimitive.Item
                key={`fav-${fav._id}`}
                value={`favorite ${cleanTitle(fav.title || fav.session_id || "")}|||${fav._id}`}
                onSelect={() => chooseSession(fav)}
                className={itemClass}
              >
                <span className="text-amber-400 flex-shrink-0">
                  <NavIcon type="star" />
                </span>
                <span className="truncate flex-1">{cleanTitle(fav.title || "New Session")}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{fav.message_count} msgs</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(fav.updated_at)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {showBookmarks && !picking && (
          <CommandPrimitive.Group heading="Bookmarks" className={groupClass}>
            {(query ? bookmarks! : bookmarks!.slice(0, 6)).map((bm: any) => (
              <CommandPrimitive.Item
                key={`bm-${bm._id}`}
                value={`bookmark ${bm.message_preview || bm.conversation_title || ""}|||${bm._id}`}
                onSelect={() => navigateToSession(
                  {
                    _id: bm.conversation_id,
                    title: bm.conversation_title,
                    updated_at: bm.conversation_updated_at,
                    message_count: bm.conversation_message_count,
                  },
                  { messageId: bm.message_id }
                )}
                className={itemClass}
              >
                <span className="text-sol-cyan flex-shrink-0">
                  <NavIcon type="bookmark" />
                </span>
                <span className="truncate flex-1">{bm.message_preview || bm.conversation_title}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {recentMatches.length > 0 && pickAllows("session") && (
          <CommandPrimitive.Group heading="Recent Sessions" className={groupClass}>
            {recentMatches.map((conv: any) => {
              const isTeam = conv.isOwn === false;
              return (
              <CommandPrimitive.Item
                key={`recent-${conv._id}`}
                value={`__recent__ ${cleanTitle(conv.title || "")} ${conv.project_path || ""} ${conv.authorName || ""}|||${conv._id}`}
                onSelect={() => chooseSession(conv)}
                className={`${itemClass} group`}
              >
                {isTeam && (conv.authorAvatar || conv.authorName) ? (
                  <AvatarImg
                    src={conv.authorAvatar}
                    alt={conv.authorName}
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    fallback={
                      <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                        {(conv.authorName || "?").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                    }
                  />
                ) : (
                  <span className="text-sol-text-dim flex-shrink-0">
                    <NavIcon type="session" />
                  </span>
                )}
                <span className="truncate flex-1">{cleanTitle(conv.title || "Untitled")}</span>
                {(() => {
                  const bucket = labelForConv(conv._id);
                  const project = getProjectName(conv.git_root, conv.project_path);
                  return (
                    <>
                      {bucket && (() => {
                        const bc = getLabelColor(bucket.name);
                        return (
                          <span className={`flex-shrink-0 px-1.5 py-0.5 rounded-full text-[10px] flex items-center gap-1 max-w-[120px] ${bc.bg} ${bc.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-[2px] flex-shrink-0 ${bc.dot}`} />
                            <span className="truncate">{bucket.name}</span>
                          </span>
                        );
                      })()}
                      {project !== "unknown" && (
                        <span className="flex-shrink-0 flex items-center gap-1 text-[10px] text-sol-text-dim max-w-[120px]" title={conv.git_root || conv.project_path || project}>
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-60 ${getLabelColor(project).dot}`} />
                          <span className="truncate">{project}</span>
                        </span>
                      )}
                    </>
                  );
                })()}
                {isTeam && conv.authorName && (
                  <span className="text-[10px] text-sol-text-dim flex-shrink-0">· {conv.authorName}</span>
                )}
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(conv.updated_at)}</span>
              </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.Group>
        )}

        {(!picking || pickAllows("channel")) && (chatChannelRows.length > 0 || (!picking && chatHits.length > 0)) && (
          <CommandPrimitive.Group heading="Chat" className={groupClass}>
            {chatChannelRows.map((c) => (
              <CommandPrimitive.Item
                key={`chatc-${c.id}`}
                value={`__chat__ ${c.label}|||${c.id}`}
                onSelect={() => {
                  if (pick) {
                    finishPick(
                      c.kind === "person"
                        ? { kind: "person", id: c.id, label: c.label }
                        : { kind: "channel", id: c.id, label: c.label },
                    );
                    return;
                  }
                  navigate(`/chat/${c.id}`);
                }}
                className={itemClass}
              >
                {c.kind === "dm" || c.kind === "person" ? (
                  <AvatarImg
                    src={c.image}
                    alt=""
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    fallback={<User className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />}
                  />
                ) : c.isPrivate ? (
                  <Lock className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                ) : (
                  <Hash className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                )}
                <span className="truncate flex-1">{c.label}</span>
                <span className="text-[10px] text-sol-text-dim flex-shrink-0">
                  {c.kind === "dm" ? "direct message" : c.kind === "person" ? "new direct message" : "channel"}
                </span>
              </CommandPrimitive.Item>
            ))}
            {!picking && chatHits.map((h) => (
              <CommandPrimitive.Item
                key={`chatm-${h._id}`}
                value={`__chat__ ${h.snippet?.slice(0, 80) ?? ""}|||${h._id}`}
                onSelect={() => navigate(h.permalink)}
                className={itemClass}
              >
                <MessageSquare className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm">{h.snippet}</div>
                  <div className="truncate text-[11px] text-sol-text-dim mt-0.5">
                    {chatMemberName(h.user_id)} · {h.channel_kind === "dm" ? "direct message" : `#${h.channel_name}`}
                  </div>
                </div>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(h.created_at)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {taskMatches.length > 0 && (
          <CommandPrimitive.Group heading="Tasks" className={groupClass}>
            {taskMatches.map((t: any) => {
              const st = TASK_STATUS_META[t.status];
              return (
                <CommandPrimitive.Item
                  key={`task-${t._id}`}
                  value={`__entity__ ${t.title} ${t.short_id}|||${t._id}`}
                  onSelect={() => chooseEntity("task", t, `/tasks/${t._id}`)}
                  className={itemClass}
                >
                  <ListTodo className="w-4 h-4 flex-shrink-0 text-sol-cyan" />
                  <span className="truncate flex-1">{t.title || "Untitled"}</span>
                  {st && <span className={`text-[10px] flex-shrink-0 ${st.color}`}>{st.label}</span>}
                  <span className="text-[10px] text-sol-text-dim font-mono tabular-nums flex-shrink-0">{t.short_id}</span>
                  <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(t.updated_at)}</span>
                </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.Group>
        )}

        {docMatches.length > 0 && (
          <CommandPrimitive.Group heading="Documents" className={groupClass}>
            {docMatches.map((d: any) => (
              <CommandPrimitive.Item
                key={`doc-${d._id}`}
                value={`__entity__ ${d.title} ${d.doc_type || ""}|||${d._id}`}
                onSelect={() => chooseEntity("doc", d, `/docs/${d._id}`)}
                className={itemClass}
              >
                <FileText className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <span className="truncate flex-1">{d.title || "Untitled"}</span>
                {d.source_file && (
                  <span className="text-[10px] text-sol-text-dim/70 font-mono truncate max-w-[140px] flex-shrink-0">{d.source_file.split("/").pop()}</span>
                )}
                <span className="text-[10px] text-sol-text-dim flex-shrink-0 capitalize">{d.doc_type || "note"}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(d.updated_at)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {planMatches.length > 0 && (
          <CommandPrimitive.Group heading="Plans" className={groupClass}>
            {planMatches.map((p: any) => {
              const st = PLAN_STATUS_META[p.status];
              return (
                <CommandPrimitive.Item
                  key={`plan-${p._id}`}
                  value={`__entity__ ${p.title} ${p.short_id}|||${p._id}`}
                  onSelect={() => chooseEntity("plan", p, `/plans/${p.short_id || p._id}`)}
                  className={itemClass}
                >
                  <MapIcon className="w-4 h-4 flex-shrink-0 text-sol-yellow" />
                  <span className="truncate flex-1">{p.title || "Untitled"}</span>
                  {st && <span className={`text-[10px] flex-shrink-0 ${st.color}`}>{st.label}</span>}
                  <span className="text-[10px] text-sol-text-dim font-mono tabular-nums flex-shrink-0">{p.short_id}</span>
                  <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(p.updated_at)}</span>
                </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.Group>
        )}

        {!picking && triggerMatches.length > 0 && (
          <CommandPrimitive.Group heading="Triggers" className={groupClass}>
            {triggerMatches.map((t: any) => (
              <CommandPrimitive.Item
                key={`trigger-${t._id}`}
                value={`__entity__ ${t.title} ${t.short_id || ""}|||${t._id}`}
                onSelect={() => navigate(`/triggers/${t._id}`)}
                className={itemClass}
              >
                {t.schedule_type === "recurring" ? (
                  <Repeat className={`w-4 h-4 flex-shrink-0 ${t.status === "paused" ? "text-sol-yellow" : "text-sol-violet"}`} />
                ) : t.schedule_type === "event" ? (
                  <Zap className="w-4 h-4 flex-shrink-0 text-sol-yellow" />
                ) : (
                  <Clock className={`w-4 h-4 flex-shrink-0 ${t.status === "paused" ? "text-sol-yellow" : "text-sol-cyan"}`} />
                )}
                <span className="truncate flex-1">{t.title || "Untitled trigger"}</span>
                {t.status === "paused" && (
                  <span className="text-[10px] text-sol-yellow flex-shrink-0">paused</span>
                )}
                {t.short_id && (
                  <span className="text-[10px] text-sol-text-dim font-mono tabular-nums flex-shrink-0">{t.short_id}</span>
                )}
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {!picking && vaultNoteMatches.length > 0 && (
          <CommandPrimitive.Group heading="Notes" className={groupClass}>
            {vaultNoteMatches.map((n) => (
              <CommandPrimitive.Item
                key={`vnote-${n.path}`}
                value={`__entity__ ${n.base} ${n.path}|||vault`}
                onSelect={() => openVaultNote(n.path)}
                className={itemClass}
              >
                <FileText className="w-4 h-4 flex-shrink-0 text-sol-cyan" />
                <span className="truncate flex-1">{n.base}</span>
                {n.path.includes("/") && (
                  <span className="text-[10px] text-sol-text-dim/70 font-mono truncate max-w-[180px] flex-shrink-0">
                    {n.path.slice(0, n.path.lastIndexOf("/"))}
                  </span>
                )}
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(n.mtime)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {!picking && (
        <CommandPrimitive.Group heading="Create" className={groupClass}>
          <CommandPrimitive.Item
            key="create-session"
            value="New session start agent compose run"
            onSelect={() => startCompose("")}
            className={itemClass}
          >
            <MessageSquare className="w-4 h-4 text-sol-cyan flex-shrink-0" />
            <span className="truncate flex-1">New Session</span>
            <MenuKeyCaps action="session.compose" />
          </CommandPrimitive.Item>
          <CommandPrimitive.Item
            key="create-task"
            value="Create task new todo"
            onSelect={() => { closePalette(); openCreateModal('task'); }}
            className={itemClass}
          >
            <ListTodo className="w-4 h-4 text-sol-cyan flex-shrink-0" />
            <span className="truncate flex-1">Create Task</span>
          </CommandPrimitive.Item>
          <CommandPrimitive.Item
            key="create-plan"
            value="Create plan new project"
            onSelect={() => { closePalette(); openCreateModal('plan'); }}
            className={itemClass}
          >
            <MapIcon className="w-4 h-4 text-sol-yellow flex-shrink-0" />
            <span className="truncate flex-1">Create Plan</span>
          </CommandPrimitive.Item>
          <CommandPrimitive.Item
            key="create-doc"
            value="Create document new note doc write"
            onSelect={() => { closePalette(); openCreateModal('doc'); }}
            className={itemClass}
          >
            <FileText className="w-4 h-4 text-sol-text-dim flex-shrink-0" />
            <span className="truncate flex-1">Create Document</span>
          </CommandPrimitive.Item>
          {callsOn && (
            <CommandPrimitive.Item
              key="create-huddle"
              value="Start huddle new call ring people group voice"
              onSelect={() => { closePalette(); openCreateModal('huddle'); }}
              className={itemClass}
            >
              <Headphones className="w-4 h-4 text-sol-violet flex-shrink-0" />
              <span className="truncate flex-1">Start Huddle</span>
            </CommandPrimitive.Item>
          )}
          <CommandPrimitive.Item
            key="create-trigger"
            value="Create trigger new schedule cron automation reminder"
            onSelect={() => navigate("/triggers?new=1")}
            className={itemClass}
          >
            <Clock className="w-4 h-4 text-sol-violet flex-shrink-0" />
            <span className="truncate flex-1">Create Trigger</span>
          </CommandPrimitive.Item>
        </CommandPrimitive.Group>
        )}

        {!picking && (
        <CommandPrimitive.Group heading="Pages" className={groupClass}>
          {(query.trim() ? NAV_PAGES : NAV_PAGES.filter((p) => !p.secondary)).filter((p) => featureOn(p.feature)).map((page) => (
            <CommandPrimitive.Item
              key={page.path + page.label}
              value={`${page.label} ${page.keywords}`}
              onSelect={() => navigate(page.path)}
              className={itemClass}
            >
              <span className="text-sol-text-dim flex-shrink-0">
                <NavIcon type={page.icon} />
              </span>
              <span className="truncate">{page.label}</span>
            </CommandPrimitive.Item>
          ))}
        </CommandPrimitive.Group>
        )}

        {!picking && vaultReady && (
          <CommandPrimitive.Group heading="Files" className={groupClass}>
            <CommandPrimitive.Item
              key="vault-random"
              value="Files vault random note surprise"
              onSelect={() => {
                const s = useVaultStore.getState();
                const notes = Object.keys(s.files).filter(
                  (p) => !s.files[p].dir && /\.(md|markdown)$/i.test(p),
                );
                if (!notes.length) return;
                const pick = notes[Math.floor(Math.random() * notes.length)];
                s.noteOpened(pick);
                navigate(filesHref({ path: pick }));
              }}
              className={itemClass}
            >
              <Shuffle className="w-4 h-4 text-sol-cyan flex-shrink-0" />
              <span className="truncate">Files: Random note</span>
            </CommandPrimitive.Item>
            <CommandPrimitive.Item
              key="vault-new-note"
              value="Files vault new note create markdown"
              onSelect={() => {
                closePalette();
                void useVaultStore.getState().newNote("").then((p) => {
                  if (p) navigate(filesHref({ path: p }));
                });
              }}
              className={itemClass}
            >
              <FilePlus2 className="w-4 h-4 text-sol-cyan flex-shrink-0" />
              <span className="truncate">Files: New note</span>
            </CommandPrimitive.Item>
            <CommandPrimitive.Item
              key="vault-daily"
              value="Files vault daily note today journal"
              onSelect={() => {
                closePalette();
                void useVaultStore.getState().openDailyNote().then((p) => {
                  if (p) {
                    useVaultStore.getState().noteOpened(p);
                    navigate(filesHref({ path: p }));
                  }
                });
              }}
              className={itemClass}
            >
              <CalendarDays className="w-4 h-4 text-sol-cyan flex-shrink-0" />
              <span className="truncate">Files: Today&apos;s daily note</span>
            </CommandPrimitive.Item>
            <CommandPrimitive.Item
              key="vault-graph"
              value="Files vault graph view links map"
              onSelect={() => navigate(filesHref({ graph: true }))}
              className={itemClass}
            >
              <Waypoints className="w-4 h-4 text-sol-cyan flex-shrink-0" />
              <span className="truncate">Files: Open graph</span>
            </CommandPrimitive.Item>
            {query.trim() && (
              <CommandPrimitive.Item
                key="vault-new-named"
                value={`__entity__ vault new named note|||${query.trim()}`}
                onSelect={() => {
                  const name = query.trim().replace(/^\/+/, "");
                  const path = MARKDOWN_RE.test(name) ? name : `${name}.md`;
                  const s = useVaultStore.getState();
                  // Name already taken → this is an open, not a create.
                  if (s.files[path]) { openVaultNote(path); return; }
                  closePalette();
                  void s.createFile(path).then(() => {
                    s.noteOpened(path);
                    navigate(filesHref({ path }));
                  }).catch(() => toast.error(`Couldn't create ${path}`));
                }}
                className={itemClass}
              >
                <FilePlus2 className="w-4 h-4 text-sol-cyan flex-shrink-0" />
                <span className="truncate flex-1">
                  Files: New note &ldquo;{query.trim().length > 40 ? query.trim().slice(0, 40) + "..." : query.trim()}&rdquo;
                </span>
              </CommandPrimitive.Item>
            )}
          </CommandPrimitive.Group>
        )}

        {!standalone && !picking && (
          <CommandPrimitive.Group heading="Commands" className={groupClass}>
            {GLOBAL_COMMANDS.filter((cmd) => !cmd.hidden?.()).map((cmd) => {
              const Icon = cmd.icon;
              const label = typeof cmd.label === "function" ? cmd.label() : cmd.label;
              return (
                <CommandPrimitive.Item
                  key={`cmd-${cmd.action}`}
                  value={`${label} ${cmd.keywords}`}
                  onSelect={() => { closePalette(); dispatchAction(cmd.action); }}
                  className={itemClass}
                >
                  <Icon className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                  <span className="truncate flex-1">{label}</span>
                  <MenuKeyCaps action={cmd.action} />
                </CommandPrimitive.Item>
              );
            })}
            {!isPeopleWindow() && (
              <CommandPrimitive.Item
                key="cmd-people"
                value="People window buddy list roster presence pop out floating who is online"
                onSelect={() => { closePalette(); void popOutPeople(); }}
                className={itemClass}
              >
                <PictureInPicture2 className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <span className="truncate flex-1">{POP_OUT_PEOPLE_TITLE}</span>
              </CommandPrimitive.Item>
            )}
            <CommandPrimitive.Item
              key="cmd-theme"
              value="Switch theme dark light mode appearance"
              onSelect={() => { closePalette(); toggleTheme(); }}
              className={itemClass}
            >
              {theme === "dark" ? (
                <Sun className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
              ) : (
                <Moon className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
              )}
              <span className="truncate flex-1">Switch to {theme === "dark" ? "light" : "dark"} theme</span>
            </CommandPrimitive.Item>
          </CommandPrimitive.Group>
        )}

        {showWorkspaces && !picking && (
          <CommandPrimitive.Group heading="Workspaces" className={groupClass}>
            {projects.map((dir) => (
              <CommandPrimitive.Item
                key={`proj-${dir}`}
                value={`workspace ${getShortPath(dir)} ${dir}`}
                onSelect={() => navigate(`/team/activity?filter=my&dir=${encodeURIComponent(dir)}`)}
                className={itemClass}
              >
                <span className="text-sol-text-dim flex-shrink-0">
                  <NavIcon type="folder" />
                </span>
                <span className="truncate">{getShortPath(dir)}</span>
                <span className="text-[10px] text-sol-text-dim truncate ml-auto max-w-[200px]">{dir}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {/* Async conversation search results */}
        {debouncedQuery.length >= 2 && pickAllows("session") && (
          <CommandPrimitive.Group
            heading={searchData || titleData ? `Search Results (${searchRows.length})` : searchError ? "Search Results" : "Searching..."}
            className={groupClass}
          >
            {!searchData && !searchError && searchRows.length === 0 && (
              <CommandPrimitive.Item
                value="__search__ loading"
                disabled
                className="px-4 py-3 text-center text-xs text-sol-text-dim animate-pulse cursor-default"
              >
                Searching conversations...
              </CommandPrimitive.Item>
            )}
            {searchError && (
              <CommandPrimitive.Item
                value="__search__ error"
                disabled
                className="px-4 py-3 text-center text-xs text-sol-text-dim cursor-default"
              >
                {searchRows.length > 0
                  ? "Content search timed out — showing title matches only."
                  : "Search timed out — broad terms scan your whole history. Try a more specific word or a quoted phrase."}
              </CommandPrimitive.Item>
            )}
            {searchRows.map((result: any) => (
              <CommandPrimitive.Item
                key={`search-${result.conversationId}`}
                value={`__search__ ${result.title} ${result.matches?.[0]?.content?.slice(0, 100) || ""}|||${result.conversationId}`}
                onSelect={() => chooseSession(
                  {
                    _id: result.conversationId,
                    title: result.title,
                    updated_at: result.updatedAt,
                    message_count: result.messageCount,
                  },
                  { messageId: result.matches?.[0]?.messageId }
                )}
                className={itemClass}
              >
                {!result.isOwn && (result.authorAvatar || result.authorName) ? (
                  <AvatarImg
                    src={result.authorAvatar}
                    alt={result.authorName}
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    fallback={
                      <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                        {(result.authorName || "?").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                    }
                  />
                ) : (
                  <span className="text-sol-text-dim flex-shrink-0">
                    <NavIcon type="session" />
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm flex items-center gap-1.5">
                    <span className="truncate">{cleanTitle(result.title || "Untitled")}</span>
                    {!result.isOwn && (
                      <span className="text-[10px] text-sol-text-dim flex-shrink-0">· {result.authorName}</span>
                    )}
                  </div>
                  {result.matches?.[0]?.content && (
                    <div className="truncate text-[11px] text-sol-text-dim mt-0.5">
                      {result.matches[0].content.slice(0, 80)}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
                  {result.titleMatch
                    ? "title"
                    : `${result.matches?.length || 0} match${(result.matches?.length || 0) !== 1 ? "es" : ""}`}
                </span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(result.updatedAt)}</span>
              </CommandPrimitive.Item>
            ))}
            {!searchData && !searchError && searchRows.length > 0 && (
              <CommandPrimitive.Item
                value="__search__ content-loading"
                disabled
                className="px-4 py-2 text-center text-[11px] text-sol-text-dim animate-pulse cursor-default"
              >
                Searching message content...
              </CommandPrimitive.Item>
            )}
            {searchData && searchRows.length === 0 && (
              <CommandPrimitive.Item
                value="__search__ empty"
                disabled
                className="px-4 py-3 text-center text-xs text-sol-text-dim cursor-default"
              >
                No conversations matched
              </CommandPrimitive.Item>
            )}
          </CommandPrimitive.Group>
        )}

        {!picking && query.trim().length >= 2 && (
          <CommandPrimitive.Group className={groupClass}>
            <CommandPrimitive.Item
              value="__search__page"
              onSelect={openFullSearch}
              className={itemClass}
            >
              <Search className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
              <span className="truncate flex-1">
                Open full search for &ldquo;{query.trim().length > 40 ? query.trim().slice(0, 40) + "..." : query.trim()}&rdquo;
              </span>
              <span className="flex items-center gap-[2px]">
                <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
                <KeyCap size="xs">&#9166;</KeyCap>
              </span>
            </CommandPrimitive.Item>
            {vaultReady && (
              <CommandPrimitive.Item
                key="vault-content-search"
                value={`__entity__ vault content search|||${query.trim()}`}
                onSelect={() => {
                  useVaultStore.getState().openSearch(query.trim());
                  navigate(filesHref());
                }}
                className={itemClass}
              >
                <Search className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <span className="truncate flex-1">
                  Search note content for &ldquo;{query.trim().length > 40 ? query.trim().slice(0, 40) + "..." : query.trim()}&rdquo;
                </span>
              </CommandPrimitive.Item>
            )}
            {activeTeamId && chatOn && (
              <CommandPrimitive.Item
                value="__chat__ open-chat-search"
                onSelect={() => {
                  // Stay in the room the reader is in: /chat alone would fall
                  // back to the busiest channel and offer the wrong in: filter.
                  const m = pathname?.match(/^\/chat\/([^/?#]+)/);
                  const base = m ? `/chat/${m[1]}` : "/chat";
                  navigate(`${base}?search=${encodeURIComponent(query.trim())}`);
                }}
                className={itemClass}
              >
                <MessageSquare className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                <span className="truncate flex-1">
                  Search chat for &ldquo;{query.trim().length > 40 ? query.trim().slice(0, 40) + "..." : query.trim()}&rdquo;
                </span>
              </CommandPrimitive.Item>
            )}
          </CommandPrimitive.Group>
        )}

        {!picking && query.trim() && (
          <CommandPrimitive.Group className={groupClass}>
            <CommandPrimitive.Item
              value="__compose__"
              onSelect={() => startCompose(query.trim())}
              className={itemClass}
            >
              <span className="text-sol-yellow flex-shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                </svg>
              </span>
              <span className="truncate">New session: &ldquo;{query.trim().length > 40 ? query.trim().slice(0, 40) + "..." : query.trim()}&rdquo;</span>
            </CommandPrimitive.Item>
          </CommandPrimitive.Group>
        )}
      </CommandPrimitive.List>

      <div className="px-3 py-2 border-t border-sol-border/60 flex items-center justify-between text-[10px] text-sol-text-dim bg-sol-bg-alt/40">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <KeyCap size="xs">&#8593;</KeyCap>
            <KeyCap size="xs">&#8595;</KeyCap>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">&#9166;</KeyCap>
            open
          </span>
          {query.trim().length >= 2 && (
            <span className="flex items-center gap-1">
              <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
              <KeyCap size="xs">&#9166;</KeyCap>
              full search
            </span>
          )}
        </div>
        <span className="flex items-center gap-1">
          <MenuKeyCaps action="palette.toggle" />
          toggle
        </span>
      </div>
    </CommandPrimitive>
  );

  if (standalone) {
    return paletteContent;
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={closePalette}
      />
      <div className="absolute inset-0 flex items-start justify-center pt-[min(20vh,160px)]">
        {paletteContent}
      </div>
    </div>
  );
}

export const CommandPalette = memo(CommandPaletteImpl);
