import { useState, useCallback, useMemo, useRef, memo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useShortcutAction, isMac, type ShortcutAction } from "../shortcuts";
import { KeyCap, MenuKeyCaps } from "./KeyboardShortcutsHelp";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Command as CommandPrimitive } from "cmdk";
import { cleanTitle } from "../lib/conversationProcessor";
import { commitModelChange, canControlModel, modelOptionKey } from "./ModelEffortPicker";
import { AGENT_MODEL_CONFIG, modelAgentKey } from "@codecast/shared/contracts";
import { useInboxStore, isConvexId, InboxSession, TaskItem, DocItem, BucketItem, BucketAssignmentItem, categorizeSessions, sessionsWithPendingSend, convBucketMap, sortLabels, computeChipCounts, getProjectName, RecentVisit } from "../store/inboxStore";
import { resolveRecentVisits, visitTimeAgo, type ResolvedVisit } from "../lib/recentVisits";
import { PageIcon } from "./RecentlyViewedMenu";
import { isNonTabRoute } from "../src/compat/tabRouting";
import { score } from "../hooks/useMentionQuery";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { isElectron } from "../lib/desktop";
import { isInboxRoute } from "../lib/inboxRouting";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { getLabelColor, DEFAULT_LABELS } from "../lib/labelColors";
import { toast } from "sonner";
import { undoableArchiveDoc, undoableHideSession, undoableDeferSession } from "../store/undoActions";
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
  Folder,
  Star,
  Link as LinkIcon,
} from "lucide-react";

const api = _api as any;

type ActionMode = "status" | "priority" | "labels" | "assign" | "type" | "plan_status" | "agent_run" | "bucket" | "model" | "view";

const DEFAULT_AGENT_RUN_MESSAGE = "lets do this task";

const PLAN_STATUS_OPTIONS = [
  { key: "draft", icon: Circle, label: "Draft", color: "text-neutral-500" },
  { key: "active", icon: CircleDot, label: "Active", color: "text-cyan-400" },
  { key: "paused", icon: PauseCircle, label: "Paused", color: "text-yellow-400" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-green-400" },
  { key: "abandoned", icon: XCircle, label: "Abandoned", color: "text-neutral-500" },
];

function isTask(item: any): item is TaskItem {
  return item && "status" in item && "short_id" in item;
}

const STATUS_OPTIONS = [
  { key: "backlog", icon: CircleDotDashed, label: "Backlog", color: "text-neutral-500" },
  { key: "open", icon: Circle, label: "Open", color: "text-blue-400" },
  { key: "in_progress", icon: CircleDot, label: "In Progress", color: "text-yellow-400" },
  { key: "in_review", icon: CircleDot, label: "In Review", color: "text-violet-400" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-green-400" },
  { key: "dropped", icon: XCircle, label: "Dropped", color: "text-neutral-500" },
];

const PRIORITY_OPTIONS = [
  { key: "urgent", icon: AlertTriangle, label: "Urgent", color: "text-red-400" },
  { key: "high", icon: ArrowUp, label: "High", color: "text-orange-400" },
  { key: "medium", icon: Minus, label: "Medium", color: "text-neutral-400" },
  { key: "low", icon: ArrowDown, label: "Low", color: "text-neutral-500" },
  { key: "none", icon: Minus, label: "None", color: "text-neutral-600" },
];

// Status key → {label,color}, derived from the option arrays above so the
// palette's entity rows reuse the same labels/colors as the action submenus.
const TASK_STATUS_META: Record<string, { label: string; color: string }> =
  Object.fromEntries(STATUS_OPTIONS.map((o) => [o.key, { label: o.label, color: o.color }]));
const PLAN_STATUS_META: Record<string, { label: string; color: string }> =
  Object.fromEntries(PLAN_STATUS_OPTIONS.map((o) => [o.key, { label: o.label, color: o.color }]));

const DOC_TYPE_OPTIONS = [
  { key: "note", label: "Note" },
  { key: "plan", label: "Plan" },
  { key: "design", label: "Design" },
  { key: "spec", label: "Spec" },
  { key: "investigation", label: "Investigation" },
  { key: "handoff", label: "Handoff" },
];

const AGENT_OPTIONS = [
  { key: "agent:claude_code", label: "Claude Code" },
  { key: "agent:codex", label: "Codex" },
  { key: "agent:cursor", label: "Cursor" },
  { key: "agent:gemini", label: "Gemini" },
];

const AGENT_COLORS: Record<string, string> = {
  "agent:codex": "text-blue-400",
  "agent:cursor": "text-purple-400",
  "agent:gemini": "text-amber-400",
};

const NAV_PAGES = [
  { label: "Dashboard", path: "/team/activity", icon: "grid", keywords: "home sessions main activity feed team" },
  { label: "Tasks", path: "/tasks", icon: "check", keywords: "todo work items" },
  { label: "Documents", path: "/docs", icon: "file", keywords: "notes plans specs" },
  { label: "Inbox", path: "/inbox", icon: "inbox", keywords: "idle queue waiting" },
  { label: "Search", path: "/search", icon: "search", keywords: "find query" },
  { label: "Settings", path: "/settings", icon: "settings", keywords: "preferences config profile general" },
  { label: "Team Settings", path: "/settings/team", icon: "settings", keywords: "members invite workspace" },
  { label: "Claude Accounts", path: "/settings/claude-accounts", icon: "settings", keywords: "account switch login oauth" },
  { label: "Sync & Privacy", path: "/settings/sync", icon: "settings", keywords: "projects sharing private" },
  { label: "Notifications", path: "/notifications", icon: "bell", keywords: "alerts updates" },
] as const;

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
function ActionSubmenu({
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

  const updatePlan = useInboxStore((s) => s.updatePlan);
  const assignToAgent = useMutation(api.tasks.assignToAgent);
  const updateTask = useInboxStore((s) => s.updateTask);
  const updateDoc = useInboxStore((s) => s.updateDoc);
  const buckets = useInboxStore((s) => s.buckets);
  const bucketAssignments = useInboxStore((s) => s.bucketAssignments);
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const activeProjectFilter = useInboxStore((s) => s.activeProjectFilter);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const archiveDoc = useInboxStore((s) => s.archiveDoc);
  const router = useRouter();

  const target = targets[0];
  const currentLabels = target?.labels || [];

  useWatchEffect(() => {
    setSearch("");
    setHighlightIndex(0);
    setAgentStep("pick");
    setSelectedAgentKey(null);
    setAgentMessage(DEFAULT_AGENT_RUN_MESSAGE);
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
    const { pinned, newSessions, needsInput, working } = categorizeSessions(
      st.sessions,
      st.sessionsWithQueuedMessages,
      sessionsWithPendingSend(st.pendingMessages),
      { currentSessionId: st.currentSessionId, pendingCreateIds: new Set(Object.keys(st.pendingSessionCreates)) },
    );
    const active = [...pinned, ...newSessions, ...needsInput, ...working];
    return computeChipCounts(active, convBucketMap(st.bucketAssignments as Record<string, BucketAssignmentItem>));
  }, [mode]);

  const items = useMemo(() => {
    const q = search.toLowerCase();

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
        matched.unshift({ key: "__all__", kind: "all", label: "All sessions", active: !activeBucketFilter && !activeProjectFilter, icon: Circle, quickKey: "0" });
      }
      return matched;
    }

    if (mode === "status") {
      return STATUS_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({
          ...o,
          active: isTask(target) && target.status === o.key,
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
      const members = (teamMembers || []).filter(Boolean).map((m: any) => ({
        key: m._id,
        label: currentUser && m._id === currentUser._id ? `${m.name} (you)` : m.name,
        type: "user" as const,
        image: m.image || m.github_avatar_url,
      }));
      return members.filter((o) => o.label.toLowerCase().includes(q));
    }
    if (mode === "agent_run") {
      return AGENT_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((a) => ({ ...a, type: "agent" as const, image: undefined }));
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
      // numbered list. The blank/live rail picks which models qualify
      // (Sonnet 1M is reachable only via the in-place picker).
      const s0 = target as any;
      const agentType = s0?.agent_type as string | undefined;
      const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
      if (!cfg) return [];
      const blank = (s0?.message_count ?? 0) === 0;
      const curModelKey = modelOptionKey(s0?.model, agentType);
      const curEffort = s0?.effort as string | undefined;
      const rows: any[] = [];
      for (const m of cfg.models) {
        if (blank && m.midSessionOnly) continue;
        rows.push({ key: `model:${m.key}`, label: m.label, sub: m.hint, active: m.key === curModelKey, icon: Cpu });
      }
      for (const level of [...(blank ? ["default"] : []), ...cfg.efforts]) {
        const active = level === "default" ? !curEffort : level === curEffort;
        rows.push({ key: `effort:${level}`, label: `${level} effort`, active, icon: CircleDot });
      }
      return rows.filter((r) => r.label.toLowerCase().includes(q));
    }
    return [];
  }, [mode, search, target, currentLabels, teamMembers, currentUser, buckets, bucketAssignments, viewChipData, activeBucketFilter, activeProjectFilter]);

  useWatchEffect(() => { setHighlightIndex(0); }, [search]);

  const selectItem = useCallback((index: number) => {
    const item = items[index] as any;
    if (!item) return;

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
      const [kind, value] = String(item.key).split(":");
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
        store.createBucket({ name }).then((r: any) => {
          if (!r?._id) return;
          for (const t of targets) {
            const convId = resolveConvId(t);
            if (convId) store.assignSessionToBucket(convId, r._id);
          }
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
        applyTaskUpdate({ status: item.key });
        toast.success(`${label} \u2192 ${item.label}`);
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
        toast.success(`Assigned to ${member?.name || "user"}`);
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
  }, [items, target, targets, targetType, mode, currentLabels, onClose, updateTask, updatePlan, assignToAgent, updateDoc, teamMembers, router, search]);

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
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Backspace" && search === "") {
      e.preventDefault();
      if (enteredViaRoot) onBack(); else onClose();
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
  }, [items, highlightIndex, selectItem, onBack, onClose, enteredViaRoot, search]);

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
                item.image ? (
                  <img src={item.image} alt={item.label} className="w-4 h-4 rounded-full flex-shrink-0" />
                ) : (
                  <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                    {item.label.replace(" (you)", "").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                )
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
): MentionRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<{ rec: MentionRecord; rank: number }> = [];
  for (const rec of Object.values(records)) {
    if (exclude?.(rec)) continue;
    const team = rec.team_id ? String(rec.team_id) : null;
    if (teamId ? team && team !== teamId : team) continue;
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

  const { open: paletteOpen, targets, targetType, initialMode, initialQuery: paletteInitialQuery } = useInboxStore((s) => s.palette);
  const closePalette = useInboxStore((s) => s.closePalette);
  const togglePalette = useInboxStore((s) => s.togglePalette);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);

  const updateTask = useInboxStore((s) => s.updateTask);
  const pinDoc = useInboxStore((s) => s.pinDoc);
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
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const effectiveTeamId = (activeTeamId || (currentUser as any)?.team_id) as string | undefined;

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
    for (const s of Object.values(useInboxStore.getState().sessions)) {
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
    () => matchEntities(mentionIndex.tasks as any, query, effectiveTeamId, ENTITY_RENDER_CAP, (t) => t.status === "dropped"),
    [mentionIndex, query, effectiveTeamId],
  );
  const docMatches = useMemo(
    () => matchEntities(mentionIndex.docs as any, query, effectiveTeamId, ENTITY_RENDER_CAP, (d) => d.doc_type === "plan"),
    [mentionIndex, query, effectiveTeamId],
  );
  const planMatches = useMemo(
    () => matchEntities(mentionIndex.plans as any, query, effectiveTeamId, ENTITY_RENDER_CAP, (p) => p.status === "abandoned"),
    [mentionIndex, query, effectiveTeamId],
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

  const navigateToSession = useCallback(
    (
      conv: { _id: string; session_id?: string; title?: string; updated_at?: number; project_path?: string; git_root?: string; agent_type?: string; message_count?: number; is_idle?: boolean; user_id?: string; authorName?: string | null; authorAvatar?: string | null },
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
        store.injectSession({
          _id: conv._id,
          session_id: conv.session_id || conv._id,
          title: conv.title,
          updated_at: conv.updated_at ?? Date.now(),
          project_path: conv.project_path,
          git_root: conv.git_root,
          agent_type: conv.agent_type || "claude_code",
          message_count: conv.message_count || 0,
          is_idle: conv.is_idle ?? true,
          has_pending: false,
          // Search/recent results null out author for own sessions, so a present
          // authorName means "not mine" — carry it so the card labels whose it is.
          user_id: conv.user_id,
          author_name: conv.authorName ?? null,
          author_avatar: conv.authorAvatar ?? null,
        } as InboxSession);
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

  const handleRecentVisitSelect = useCallback(
    (row: ResolvedVisit) => {
      if (row.sessionId) {
        const conv = recentSessions.find((c) => c._id === row.sessionId) ?? { _id: row.sessionId, title: row.title };
        navigateToSession(conv);
        return;
      }
      if (row.bucketId || row.projectName) {
        const store = useInboxStore.getState();
        if (row.bucketId) store.setActiveBucketFilter(row.bucketId);
        else store.setActiveProjectFilter(row.projectName!, row.projectPath ?? null);
        if (!store.sidePanelOpen) store.toggleSidePanel();
        // The chip views live in the session panel; non-tab surfaces
        // (Settings, auth) don't render it, so head home to the inbox. The
        // real router URL decides — usePathname can report the carried tab.
        if (isNonTabRoute(window.location.pathname)) navigate("/inbox");
        else closePalette();
        return;
      }
      if (row.path) navigate(row.path);
    },
    [recentSessions, navigateToSession, navigate, closePalette],
  );

  // Root action handlers
  const handleRootAction = useCallback((actionKey: string) => {
    if (!targets.length) return;
    const target = targets[0] as any;

    if (["status", "priority", "labels", "assign", "type", "plan_status", "agent_run", "bucket", "model"].includes(actionKey)) {
      setEnteredViaRoot(true);
      setActionMode(actionKey as ActionMode);
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
      for (const t of targets as TaskItem[]) {
        updateTask(t.short_id, { status: "dropped" });
      }
      toast.success("Task dropped");
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
        // The teardown rides the hide transition server-side (dispatch.applyPatches).
        undoableHideSession(session._id, "kill");
        closePalette();
      } else if (actionKey === "session_stash") {
        undoableHideSession(session._id, "stash");
        closePalette();
      } else if (actionKey === "session_defer") {
        undoableDeferSession(session._id);
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
  }, [targets, targetType, closePalette, updateTask, pinDoc, router, navigate]);

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
    { key: "agent_run", label: "Start agent run...", icon: Bot },
    { key: "copy", label: "Copy task ID", icon: Copy },
    { key: "drop", label: "Drop task", icon: Trash2 },
  ], []);

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
      { key: "session_kill", label: "Kill session", icon: Square, shortcutAction: "session.kill" },
      { key: "session_defer", label: "Defer session", icon: Clock, shortcutAction: "session.deferAdvance" },
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

  const groupClass = "px-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-sol-text-dim/70";
  const itemClass = "flex items-center gap-3 px-2.5 py-2 mx-1 rounded-lg text-sm text-sol-text-muted cursor-pointer transition-colors data-[selected=true]:bg-sol-cyan/10 data-[selected=true]:text-sol-text";

  // Action submenu mode. "view" is global (switches the session-panel filter),
  // so it needs no target entity — and shows no entity header. The `open` check
  // matters for target-less view mode: actionMode survives closePalette (it
  // only resets on the next open), so without it the overlay would stick.
  if (open && actionMode && (hasTargets || actionMode === "view")) {
    const paletteContent = (
      <div className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
        {contextLabel && actionMode !== "view" && (
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

  // Root mode: navigation + context actions
  const paletteContent = (
    <CommandPrimitive
      className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
      filter={(value, search) => {
        // Async search results and compose are always relevant — bypass cmdk filter
        if (value.startsWith("__search__") || value.startsWith("__compose__") || value.startsWith("__recent__") || value.startsWith("__entity__")) return 1;
        const idx = value.indexOf("|||");
        const searchable = idx >= 0 ? value.slice(0, idx) : value;
        return searchable.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
      }}
      loop
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-sol-border/60">
        <div className="text-sol-text-dim">
          <NavIcon type="search" className="w-[18px] h-[18px]" />
        </div>
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          placeholder={hasTargets ? "Action or jump to..." : "Jump to..."}
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

        {hasTargets && (
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

        {!query.trim() && recentVisitRows.length > 0 && (
          <CommandPrimitive.Group heading="Recently Visited" className={groupClass}>
            {recentVisitRows.map((row) => (
              <CommandPrimitive.Item
                key={`rv-${row.key}`}
                value={`recently visited ${row.title}|||${row.key}`}
                onSelect={() => handleRecentVisitSelect(row)}
                className={itemClass}
              >
                {row.sessionId ? (
                  <MessageSquare className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                ) : row.bucketId ? (
                  <Tag className={`w-4 h-4 flex-shrink-0 ${getLabelColor(row.title).text}`} />
                ) : row.projectName ? (
                  <Folder className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                ) : (
                  <PageIcon path={row.path!} className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
                )}
                <span className="truncate flex-1">{row.title}</span>
                {(row.bucketId || row.projectName) && (
                  <span className="text-[10px] text-sol-text-dim flex-shrink-0">view</span>
                )}
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{visitTimeAgo(row.ts)}</span>
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        )}

        {/* Global view switcher — drills into the label/project submenu. Not
            target-bound, so it's always offered (main app only: the standalone
            Electron palette window has no session panel to filter). */}
        {!standalone && (
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

        {showFavorites && (
          <CommandPrimitive.Group heading="Favorites" className={groupClass}>
            {(query ? favorites! : favorites!.slice(0, 5)).map((fav: any) => (
              <CommandPrimitive.Item
                key={`fav-${fav._id}`}
                value={`favorite ${cleanTitle(fav.title || fav.session_id || "")}|||${fav._id}`}
                onSelect={() => navigateToSession(fav)}
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

        {showBookmarks && (
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

        {recentMatches.length > 0 && (
          <CommandPrimitive.Group heading="Recent Sessions" className={groupClass}>
            {recentMatches.map((conv: any) => {
              const isTeam = conv.isOwn === false;
              return (
              <CommandPrimitive.Item
                key={`recent-${conv._id}`}
                value={`__recent__ ${cleanTitle(conv.title || "")} ${conv.project_path || ""} ${conv.authorName || ""}|||${conv._id}`}
                onSelect={() => navigateToSession(conv)}
                className={`${itemClass} group`}
              >
                {isTeam && conv.authorAvatar ? (
                  <img src={conv.authorAvatar} alt={conv.authorName} className="w-4 h-4 rounded-full flex-shrink-0" />
                ) : isTeam && conv.authorName ? (
                  <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                    {conv.authorName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
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

        {taskMatches.length > 0 && (
          <CommandPrimitive.Group heading="Tasks" className={groupClass}>
            {taskMatches.map((t: any) => {
              const st = TASK_STATUS_META[t.status];
              return (
                <CommandPrimitive.Item
                  key={`task-${t._id}`}
                  value={`__entity__ ${t.title} ${t.short_id}|||${t._id}`}
                  onSelect={() => navigate(`/tasks/${t._id}`)}
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
                onSelect={() => navigate(`/docs/${d._id}`)}
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
                  onSelect={() => navigate(`/plans/${p.short_id || p._id}`)}
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

        <CommandPrimitive.Group heading="Pages" className={groupClass}>
          {NAV_PAGES.map((page) => (
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

        <CommandPrimitive.Group heading="Create" className={groupClass}>
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
        </CommandPrimitive.Group>

        {showWorkspaces && (
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

        {query.trim() && (
          <CommandPrimitive.Group className={groupClass}>
            <CommandPrimitive.Item
              value="__compose__"
              onSelect={() => {
                if (standalone) {
                  // Flip this palette window into the compose popup, carrying
                  // the typed text in as the first message.
                  window.dispatchEvent(new CustomEvent('codecast-compose', { detail: query.trim() }));
                } else {
                  closePalette();
                  // Open the in-app compose popup, carrying the typed text in as
                  // the first message — same surface, just an overlay.
                  useInboxStore.getState().openCompose(query.trim());
                }
              }}
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

        {query.trim().length >= 2 && (
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
          </CommandPrimitive.Group>
        )}

        {/* Async conversation search results */}
        {debouncedQuery.length >= 2 && (
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
                onSelect={() => navigateToSession(
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
                {!result.isOwn && result.authorAvatar ? (
                  <img src={result.authorAvatar} alt={result.authorName} className="w-4 h-4 rounded-full flex-shrink-0" />
                ) : !result.isOwn && result.authorName ? (
                  <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                    {result.authorName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
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
