import { useState, useCallback, useMemo, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useShortcutAction } from "../shortcuts";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Command as CommandPrimitive } from "cmdk";
import { cleanTitle } from "../lib/conversationProcessor";
import { useInboxStore, InboxSession, TaskItem, DocItem } from "../store/inboxStore";
import { isElectron } from "../lib/desktop";
import { isInboxRoute } from "../lib/inboxRouting";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { getLabelColor, DEFAULT_LABELS } from "../lib/labelColors";
import { toast } from "sonner";
import { undoableArchiveDoc, undoableStashSession, undoableDeferSession } from "../store/undoActions";
import { copyToClipboard } from "../lib/utils";
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
  CornerDownLeft,
  ListTodo,
  Map as MapIcon,
  Square,
  Clock,
  ExternalLink,
  Pencil,
} from "lucide-react";

const api = _api as any;

type ActionMode = "status" | "priority" | "labels" | "assign" | "type" | "plan_status";

const PLAN_STATUS_OPTIONS = [
  { key: "draft", icon: Circle, label: "Draft", color: "text-neutral-500", shortcut: "1" },
  { key: "active", icon: CircleDot, label: "Active", color: "text-cyan-400", shortcut: "2" },
  { key: "paused", icon: PauseCircle, label: "Paused", color: "text-yellow-400", shortcut: "3" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-green-400", shortcut: "4" },
  { key: "abandoned", icon: XCircle, label: "Abandoned", color: "text-neutral-500", shortcut: "5" },
];

function isTask(item: any): item is TaskItem {
  return item && "status" in item && "short_id" in item;
}

const STATUS_OPTIONS = [
  { key: "backlog", icon: CircleDotDashed, label: "Backlog", color: "text-neutral-500", shortcut: "1" },
  { key: "open", icon: Circle, label: "Open", color: "text-blue-400", shortcut: "2" },
  { key: "in_progress", icon: CircleDot, label: "In Progress", color: "text-yellow-400", shortcut: "3" },
  { key: "in_review", icon: CircleDot, label: "In Review", color: "text-violet-400", shortcut: "4" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-green-400", shortcut: "5" },
  { key: "dropped", icon: XCircle, label: "Dropped", color: "text-neutral-500", shortcut: "6" },
];

const PRIORITY_OPTIONS = [
  { key: "urgent", icon: AlertTriangle, label: "Urgent", color: "text-red-400", shortcut: "1" },
  { key: "high", icon: ArrowUp, label: "High", color: "text-orange-400", shortcut: "2" },
  { key: "medium", icon: Minus, label: "Medium", color: "text-neutral-400", shortcut: "3" },
  { key: "low", icon: ArrowDown, label: "Low", color: "text-neutral-500", shortcut: "4" },
  { key: "none", icon: Minus, label: "None", color: "text-neutral-600", shortcut: "5" },
];

const DOC_TYPE_OPTIONS = [
  { key: "note", label: "Note", shortcut: "1" },
  { key: "plan", label: "Plan", shortcut: "2" },
  { key: "design", label: "Design", shortcut: "3" },
  { key: "spec", label: "Spec", shortcut: "4" },
  { key: "investigation", label: "Investigation", shortcut: "5" },
  { key: "handoff", label: "Handoff", shortcut: "6" },
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
  { label: "Dashboard", path: "/dashboard", icon: "grid", keywords: "home sessions main" },
  { label: "Tasks", path: "/tasks", icon: "check", keywords: "todo work items" },
  { label: "Documents", path: "/docs", icon: "file", keywords: "notes plans specs" },
  { label: "Inbox", path: "/inbox", icon: "inbox", keywords: "idle queue waiting" },
  { label: "Search", path: "/search", icon: "search", keywords: "find query" },
  { label: "Settings", path: "/settings", icon: "settings", keywords: "preferences config profile" },
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
  teamMembers,
  currentUser,
}: {
  mode: ActionMode;
  targets: any[];
  targetType: "task" | "doc" | "plan" | "session";
  onClose: () => void;
  onBack: () => void;
  teamMembers?: any[];
  currentUser?: any;
}) {
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const webUpdatePlan = useMutation(api.plans.webUpdate);
  const assignToAgent = useMutation(api.tasks.assignToAgent);
  const updateTask = useInboxStore((s) => s.updateTask);
  const updateDoc = useInboxStore((s) => s.updateDoc);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const archiveDoc = useInboxStore((s) => s.archiveDoc);
  const router = useRouter();

  const target = targets[0];
  const currentLabels = target?.labels || [];

  useWatchEffect(() => {
    setSearch("");
    setHighlightIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [mode]);

  const items = useMemo(() => {
    const q = search.toLowerCase();

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
        .map((l, i) => ({
          key: l,
          label: l,
          active: currentLabels.includes(l),
          shortcut: i < 9 ? String(i + 1) : undefined,
          dot: getLabelColor(l).dot,
        }));
      if (q && !matched.some((l) => l.key.toLowerCase() === q)) {
        matched.unshift({ key: q, label: `Create "${q}"`, active: false, shortcut: undefined, dot: getLabelColor(q).dot });
      }
      return matched;
    }
    if (mode === "assign") {
      const agents = AGENT_OPTIONS.map((a) => ({ ...a, type: "agent" as const, image: undefined }));
      const members = (teamMembers || []).filter(Boolean).map((m: any) => ({
        key: m._id,
        label: currentUser && m._id === currentUser._id ? `${m.name} (you)` : m.name,
        type: "user" as const,
        image: m.image || m.github_avatar_url,
      }));
      return [...agents, ...members].filter((o) => o.label.toLowerCase().includes(q));
    }
    if (mode === "plan_status") {
      return PLAN_STATUS_OPTIONS
        .filter((o) => o.label.toLowerCase().includes(q))
        .map((o) => ({
          ...o,
          active: target?.status === o.key,
        }));
    }
    return [];
  }, [mode, search, target, currentLabels, teamMembers, currentUser]);

  useWatchEffect(() => { setHighlightIndex(0); }, [search]);

  const selectItem = useCallback((index: number) => {
    const item = items[index] as any;
    if (!item || !target) return;
    const count = targets.length;

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
        if (item.key.startsWith("agent:")) {
          for (const t of targets as TaskItem[]) {
            assignToAgent({ short_id: t.short_id, agent_type: item.key.replace("agent:", "") }).catch(() => {});
          }
          toast.success(`Starting session with ${item.label}...`);
        } else {
          applyTaskUpdate({ assignee: item.key });
          const member = (teamMembers || []).find((m: any) => m._id === item.key);
          toast.success(`Assigned to ${member?.name || "user"}`);
        }
      }
    } else if (targetType === "plan") {
      if (mode === "plan_status") {
        const shortId = target.short_id || target._id;
        webUpdatePlan({ short_id: shortId, status: item.key }).catch(() => {});
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
  }, [items, target, targets, targetType, mode, currentLabels, onClose, updateTask, webUpdatePlan, assignToAgent, updateDoc, teamMembers, router]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" || (e.key === "Backspace" && search === "")) {
      e.preventDefault();
      onBack();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      selectItem(highlightIndex);
      return;
    }
    const num = parseInt(e.key);
    if (num >= 1 && num <= items.length) {
      e.preventDefault();
      selectItem(num - 1);
    }
  }, [items, highlightIndex, selectItem, onBack, search]);

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
    mode === "assign" ? "Assign to person or agent..." :
    mode === "type" ? "Change document type..." :
    "Select...";

  const itemClass = (i: number) =>
    `w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
      i === highlightIndex
        ? "bg-sol-bg-highlight text-sol-text"
        : "text-sol-text-muted hover:bg-sol-bg-alt/50"
    }`;

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30">
        <button
          onClick={onBack}
          className="text-xs px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
        >
          &larr;
        </button>
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
              {mode === "assign" ? (
                item.type === "agent" ? (
                  <Bot className={`w-4 h-4 flex-shrink-0 ${AGENT_COLORS[item.key] || "text-sol-violet"}`} />
                ) : item.image ? (
                  <img src={item.image} alt={item.label} className="w-4 h-4 rounded-full flex-shrink-0" />
                ) : (
                  <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                    {item.label.replace(" (you)", "").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                )
              ) : mode === "labels" ? (
                <span className={`w-3 h-3 rounded-full flex-shrink-0 ${item.dot || "bg-neutral-400"}`} />
              ) : Icon ? (
                <Icon className={`w-4 h-4 flex-shrink-0 ${item.color || ""}`} />
              ) : null}
              <span className="flex-1 text-left">{item.label}</span>
              {item.active && <Check className="w-4 h-4 text-sol-cyan flex-shrink-0" />}
              {item.shortcut && (
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                  {item.shortcut}
                </kbd>
              )}
              {mode === "assign" && item.type === "agent" && (
                <span className="text-[10px] text-sol-text-dim font-mono">start session</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 px-4 py-2 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
        <span className="flex items-center gap-1">
          <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">&uarr;&darr;</kbd>
          navigate
        </span>
        <span className="flex items-center gap-1">
          <CornerDownLeft className="w-3 h-3" />
          select
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">esc</kbd>
          back
        </span>
        {items.length > 0 && (
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">1-{Math.min(items.length, 9)}</kbd>
            quick pick
          </span>
        )}
      </div>
    </>
  );
}

// ─── Unified Command Palette ────────────────────────────────────
export function CommandPalette({ standalone = false }: { standalone?: boolean }) {
  const [query, setQuery] = useState("");
  const [actionMode, setActionMode] = useState<ActionMode | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const { open: paletteOpen, targets, targetType, initialMode, initialQuery: paletteInitialQuery } = useInboxStore((s) => s.palette);
  const closePalette = useInboxStore((s) => s.closePalette);
  const togglePalette = useInboxStore((s) => s.togglePalette);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);

  const updateTask = useInboxStore((s) => s.updateTask);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const { user: currentUser } = useCurrentUser();
  const effectiveTeamId = (activeTeamId || (currentUser as any)?.team_id) as string | undefined;
  const teamMembersQuery = useQuery(api.teams.getTeamMembers, effectiveTeamId ? { team_id: effectiveTeamId as any } : "skip");
  const cachedMembers = useInboxStore((s) => s.teamMembers);
  const teamMembers = teamMembersQuery ?? (cachedMembers.length > 0 ? cachedMembers : undefined);

  const open = standalone || paletteOpen;

  const killSessionMutation = useMutation(api.conversations.killSession);

  const favorites = useQuery(api.conversations.listFavorites, open ? {} : "skip");
  const bookmarks = useQuery(api.bookmarks.listBookmarks, open ? {} : "skip");
  const recentConversations = useQuery(api.conversations.listRecentSessions, open ? {} : "skip") ?? [];

  // Debounced search for async conversation results
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useWatchEffect(() => {
    if (!open) { setDebouncedQuery(""); return; }
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  const searchResults = useQuery(
    api.conversations.searchConversations,
    open && debouncedQuery.length >= 2 ? { query: debouncedQuery, limit: 10 } : "skip"
  );
  const searchData = searchResults && "results" in searchResults ? searchResults : null;

  const projects = useMemo(() => {
    const dirMap = new Map<string, number>();
    for (const c of recentConversations || []) {
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
  }, [recentConversations]);

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
    }
  }, [open, initialMode, paletteInitialQuery]);

  // Escape handling
  useWatchEffect(() => {
    if (standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !actionMode) {
        e.preventDefault();
        closePalette();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, standalone, actionMode, closePalette]);

  // Standalone palette events (Electron)
  useWatchEffect(() => {
    if (!standalone) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (actionMode) {
          setActionMode(null);
        } else if (isElectron()) {
          window.__CODECAST_ELECTRON__?.paletteHide?.();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [standalone, actionMode]);

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

  const navigateToSession = useCallback(
    (conv: { _id: string; session_id?: string; title?: string; updated_at: number; project_path?: string; git_root?: string; agent_type?: string; message_count?: number; is_idle?: boolean }) => {
      const conversationPath = `/conversation/${conv._id}`;
      if (standalone && isElectron()) {
        window.__CODECAST_ELECTRON__?.paletteNavigate?.(conversationPath);
        return;
      }
      const store = useInboxStore.getState();
      if (!store.sessions[conv._id]) {
        store.injectSession({
          _id: conv._id,
          session_id: conv.session_id || conv._id,
          title: conv.title,
          updated_at: conv.updated_at,
          project_path: conv.project_path,
          git_root: conv.git_root,
          agent_type: conv.agent_type || "claude_code",
          message_count: conv.message_count || 0,
          is_idle: conv.is_idle ?? true,
          has_pending: false,
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

  // Root action handlers
  const handleRootAction = useCallback((actionKey: string) => {
    if (!targets.length) return;
    const target = targets[0] as any;

    if (["status", "priority", "labels", "assign", "type", "plan_status"].includes(actionKey)) {
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
      } else if (actionKey === "session_kill") {
        const convexId = useInboxStore.getState().getConvexId(session._id);
        if (convexId) {
          killSessionMutation({ conversation_id: convexId as Id<"conversations">, mark_completed: true }).catch(() => {});
        }
        undoableStashSession(session._id, { verb: "Killed" });
        closePalette();
      } else if (actionKey === "session_stash") {
        undoableStashSession(session._id);
        closePalette();
      } else if (actionKey === "session_defer") {
        undoableDeferSession(session._id);
        closePalette();
      } else if (actionKey === "session_copy") {
        copyToClipboard(session._id);
        toast.success("Copied session ID");
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
  }, [targets, targetType, closePalette, updateTask, pinDoc, router, killSessionMutation, navigate]);

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

  const taskActions = useMemo(() => [
    { key: "status", label: "Change status...", icon: CircleDot, shortcut: "S" },
    { key: "priority", label: "Set priority...", icon: ArrowUp, shortcut: "P" },
    { key: "labels", label: "Add labels...", icon: Tag, shortcut: "L" },
    { key: "assign", label: "Assign to...", icon: User, shortcut: "A" },
    { key: "copy", label: "Copy task ID", icon: Copy, shortcut: "\u2318." },
    { key: "drop", label: "Drop task", icon: Trash2, shortcut: "D" },
  ], []);

  const docActions = useMemo(() => {
    const isPinned = target?.pinned;
    return [
      { key: "type", label: "Change type...", icon: FileText, shortcut: "T" },
      { key: "pin", label: isPinned ? "Unpin document" : "Pin document", icon: Pin, shortcut: "P" },
      { key: "labels", label: "Add labels...", icon: Tag, shortcut: "L" },
      { key: "copy", label: "Copy document ID", icon: Copy, shortcut: "\u2318." },
      { key: "archive", label: "Archive document", icon: Archive, shortcut: "A" },
    ];
  }, [target?.pinned]);

  const planActions = useMemo(() => [
    { key: "plan_status", label: "Change status...", icon: CircleDot, shortcut: "S" },
    { key: "copy", label: "Copy plan ID", icon: Copy, shortcut: "\u2318." },
  ], []);

  const sessionActions = useMemo(() => {
    if (targetType !== "session" || !target) return [];
    const s = target as InboxSession;
    return [
      { key: "session_pin", label: s.is_pinned ? "Unpin session" : "Pin session", icon: s.is_pinned ? PinOff : Pin, shortcut: "P" },
      { key: "session_kill", label: "Kill session", icon: Square, shortcut: "K" },
      { key: "session_stash", label: "Dismiss session", icon: Archive, shortcut: "D" },
      { key: "session_defer", label: "Defer session", icon: Clock, shortcut: "F" },
      { key: "session_rename", label: "Rename session", icon: Pencil, shortcut: "R" },
      { key: "session_copy", label: "Copy session ID", icon: Copy, shortcut: "\u2318." },
      { key: "session_newtab", label: "Open in new tab", icon: ExternalLink, shortcut: "O" },
    ];
  }, [targetType, target]);

  const actions = targetType === "task" ? taskActions
    : targetType === "doc" ? docActions
    : targetType === "plan" ? planActions
    : targetType === "session" ? sessionActions
    : [];

  const showFavorites = favorites && favorites.length > 0;
  const showBookmarks = bookmarks && bookmarks.length > 0;
  const showWorkspaces = projects.length > 0;
  const showRecent = recentConversations && recentConversations.length > 0;

  const groupClass = "px-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-sol-text-dim/70";
  const itemClass = "flex items-center gap-3 px-2.5 py-2 mx-1 rounded-lg text-sm text-sol-text-muted cursor-pointer transition-colors data-[selected=true]:bg-sol-cyan/10 data-[selected=true]:text-sol-text";

  // Action submenu mode
  if (actionMode && hasTargets) {
    const paletteContent = (
      <div className="w-[580px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
        {contextLabel && (
          <div className="px-4 pt-3 pb-0">
            <div className="text-xs font-mono text-sol-text-dim truncate">{contextLabel}</div>
          </div>
        )}
        <ActionSubmenu
          mode={actionMode}
          targets={targets}
          targetType={targetType!}
          onClose={closePalette}
          onBack={() => setActionMode(null)}
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
        if (value.startsWith("__search__") || value.startsWith("__compose__")) return 1;
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
          onKeyDown={() => {}}
        />
        <kbd className="px-1.5 py-0.5 text-[10px] font-medium text-sol-text-dim bg-sol-bg-alt rounded border border-sol-border/80 tracking-wide">
          ESC
        </kbd>
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
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                    {action.shortcut}
                  </kbd>
                </CommandPrimitive.Item>
              );
            })}
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
                onSelect={() => navigate(`/conversation/${bm.conversation_id}#msg-${bm.message_id}`)}
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

        {showRecent && (
          <CommandPrimitive.Group heading="Recent Sessions" className={groupClass}>
            {(query ? recentConversations : recentConversations.slice(0, 8)).map((conv: any) => (
              <CommandPrimitive.Item
                key={`recent-${conv._id}`}
                value={`session ${cleanTitle(conv.title || "")} ${conv.project_path || ""}|||${conv._id}`}
                onSelect={() => navigateToSession(conv)}
                className={`${itemClass} group`}
              >
                <span className="text-sol-text-dim flex-shrink-0">
                  <NavIcon type="session" />
                </span>
                <span className="truncate flex-1">{cleanTitle(conv.title || "Untitled")}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{timeAgo(conv.updated_at)}</span>
              </CommandPrimitive.Item>
            ))}
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
            <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">T</kbd>
          </CommandPrimitive.Item>
          <CommandPrimitive.Item
            key="create-plan"
            value="Create plan new project"
            onSelect={() => { closePalette(); openCreateModal('plan'); }}
            className={itemClass}
          >
            <MapIcon className="w-4 h-4 text-sol-yellow flex-shrink-0" />
            <span className="truncate flex-1">Create Plan</span>
            <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">P</kbd>
          </CommandPrimitive.Item>
        </CommandPrimitive.Group>

        {showWorkspaces && (
          <CommandPrimitive.Group heading="Workspaces" className={groupClass}>
            {projects.map((dir) => (
              <CommandPrimitive.Item
                key={`proj-${dir}`}
                value={`workspace ${getShortPath(dir)} ${dir}`}
                onSelect={() => navigate(`/dashboard?dir=${encodeURIComponent(dir)}`)}
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
                if (standalone && isElectron()) {
                  window.__CODECAST_ELECTRON__?.paletteNewSession?.();
                } else {
                  closePalette();
                  window.dispatchEvent(new CustomEvent('codecast-new-session'));
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

        {/* Async conversation search results */}
        {debouncedQuery.length >= 2 && (
          <CommandPrimitive.Group
            heading={searchData ? `Search Results (${searchData.results?.length || 0})` : "Searching..."}
            className={groupClass}
          >
            {!searchData && (
              <CommandPrimitive.Item
                value="__search__ loading"
                disabled
                className="px-4 py-3 text-center text-xs text-sol-text-dim animate-pulse cursor-default"
              >
                Searching conversations...
              </CommandPrimitive.Item>
            )}
            {searchData?.results?.map((result: any) => (
              <CommandPrimitive.Item
                key={`search-${result.conversationId}`}
                value={`__search__ ${result.title} ${result.matches?.[0]?.content?.slice(0, 100) || ""}|||${result.conversationId}`}
                onSelect={() => {
                  const firstMatch = result.matches?.[0];
                  if (firstMatch) {
                    navigate(`/conversation/${result.conversationId}#msg-${firstMatch.messageId}`);
                  } else {
                    navigate(`/conversation/${result.conversationId}`);
                  }
                }}
                className={itemClass}
              >
                <span className="text-sol-text-dim flex-shrink-0">
                  <NavIcon type="session" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm">{cleanTitle(result.title || "Untitled")}</div>
                  {result.matches?.[0]?.content && (
                    <div className="truncate text-[11px] text-sol-text-dim mt-0.5">
                      {result.matches[0].content.slice(0, 80)}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
                  {result.matches?.length || 0} match{(result.matches?.length || 0) !== 1 ? "es" : ""}
                </span>
              </CommandPrimitive.Item>
            ))}
            {searchData?.results?.length === 0 && (
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
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#8593;</kbd>
            <kbd className="px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#8595;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#9166;</kbd>
            open
          </span>
        </div>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">
            <span className="text-xs">&#8984;</span>K
          </kbd>
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
