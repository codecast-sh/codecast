"use client";
import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem, DocItem } from "../store/inboxStore";
import { CommandPaletteShell, PaletteMode } from "./CommandPaletteShell";
import { toast } from "sonner";
import { undoableArchiveDoc } from "../store/undoActions";
import { getLabelColor, DEFAULT_LABELS } from "../lib/labelColors";
import {
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  FileText,
  Pin,
  Archive,
  Copy,
  Trash2,
  Tag,
  User,
  Bot,
  ArrowUpCircle,
  MinusCircle,
} from "lucide-react";

const api = _api as any;

export type WorkItem = TaskItem | DocItem;

function isTask(item: WorkItem): item is TaskItem {
  return "status" in item && "short_id" in item;
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

interface ItemCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  targets: WorkItem[];
  initialMode?: string;
  teamMembers?: any[] | null;
  currentUser?: any;
}

export function ItemCommandPalette({
  open,
  onClose,
  targets,
  initialMode = "root",
  teamMembers,
  currentUser,
}: ItemCommandPaletteProps) {
  const router = useRouter();
  const webUpdateTask = useMutation(api.tasks.webUpdate);
  const assignToAgent = useMutation(api.tasks.assignToAgent);
  const updateTask = useInboxStore((s) => s.updateTask);
  const updateDoc = useInboxStore((s) => s.updateDoc);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const archiveDoc = useInboxStore((s) => s.archiveDoc);

  const itemType = targets.length > 0 && isTask(targets[0]) ? "task" : "doc";
  const target = targets[0] as any;

  const contextLabel = useMemo(() => {
    if (targets.length === 0) return "";
    if (targets.length === 1) {
      if (isTask(targets[0])) return `${targets[0].short_id} \u00B7 ${targets[0].title}`;
      return (targets[0] as any).display_title || targets[0].title;
    }
    return `${targets.length} ${itemType}s selected`;
  }, [targets, itemType]);

  const currentLabels = targets.length === 1 ? (target?.labels || []) : [];

  const modes = useMemo((): Record<string, PaletteMode> => {
    if (!target) return {};

    const labelItems = [...new Set([...DEFAULT_LABELS, ...currentLabels])].map((l, i) => ({
      key: l,
      label: l,
      active: currentLabels.includes(l),
      shortcut: i < 9 ? String(i + 1) : undefined,
      iconNode: <span className={`w-3 h-3 rounded-full flex-shrink-0 ${getLabelColor(l).dot}`} />,
    }));

    if (itemType === "task") {
      const task = target as TaskItem;
      const hasTriageable = (targets as TaskItem[]).some((t) => t.triage_status === "suggested");
      const triageItems = hasTriageable ? [
        { key: "promote", label: "Promote task", icon: ArrowUpCircle, shortcut: "Y" },
        { key: "dismiss", label: "Dismiss task", icon: MinusCircle, shortcut: "N" },
      ] : [];
      const triageHints = hasTriageable ? [
        { key: "y", label: "promote" },
        { key: "n", label: "dismiss" },
      ] : [];
      return {
        root: {
          key: "root",
          placeholder: "Type a command...",
          items: [
            ...triageItems,
            { key: "status", label: "Change status...", icon: CircleDot, shortcut: "S" },
            { key: "priority", label: "Set priority...", icon: ArrowUp, shortcut: "P" },
            { key: "labels", label: "Add labels...", icon: Tag, shortcut: "L" },
            { key: "assign", label: "Assign to...", icon: User, shortcut: "A" },
            { key: "copy", label: "Copy task ID", icon: Copy, shortcut: "\u2318." },
            { key: "drop", label: "Drop task", icon: Trash2, shortcut: "D" },
          ],
          footerHints: [
            ...triageHints,
            { key: "s", label: "status" },
            { key: "p", label: "priority" },
            { key: "l", label: "labels" },
            { key: "a", label: "assign" },
            { key: "d", label: "drop" },
          ],
        },
        status: {
          key: "status",
          placeholder: "Change status...",
          items: STATUS_OPTIONS.map((o) => ({
            key: o.key,
            label: o.label,
            icon: o.icon,
            color: o.color,
            shortcut: o.shortcut,
            active: task.status === o.key,
          })),
          footerHints: [],
        },
        priority: {
          key: "priority",
          placeholder: "Set priority...",
          items: PRIORITY_OPTIONS.map((o) => ({
            key: o.key,
            label: o.label,
            icon: o.icon,
            color: o.color,
            shortcut: o.shortcut,
            active: task.priority === o.key,
          })),
          footerHints: [],
        },
        labels: {
          key: "labels",
          placeholder: "Toggle label...",
          items: labelItems,
          footerHints: [],
        },
        assign: {
          key: "assign",
          placeholder: "Assign to person or agent...",
          items: [
            ...AGENT_OPTIONS.map((a) => ({
              key: a.key,
              label: a.label,
              iconNode: <Bot className={`w-4 h-4 flex-shrink-0 ${AGENT_COLORS[a.key] || "text-sol-violet"}`} />,
            })),
            ...(teamMembers || []).filter(Boolean).map((m: any) => ({
              key: m._id,
              label: currentUser && m._id === currentUser._id ? `${m.name} (you)` : m.name,
              iconNode: m.image || m.github_avatar_url
                ? <img src={m.image || m.github_avatar_url} alt={m.name} className="w-4 h-4 rounded-full flex-shrink-0" />
                : <div className="w-4 h-4 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted">
                    {m.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>,
            })),
          ],
          footerHints: [],
        },
      };
    }

    const doc = target as DocItem;
    const isPinned = doc.pinned;
    return {
      root: {
        key: "root",
        placeholder: "Type a command...",
        items: [
          { key: "type", label: "Change type...", icon: FileText, shortcut: "T" },
          { key: "pin", label: isPinned ? "Unpin document" : "Pin document", icon: Pin, shortcut: "P" },
          { key: "labels", label: "Add labels...", icon: Tag, shortcut: "L" },
          { key: "copy", label: "Copy document ID", icon: Copy, shortcut: "\u2318." },
          { key: "archive", label: "Archive document", icon: Archive, shortcut: "A" },
        ],
        footerHints: [
          { key: "t", label: "type" },
          { key: "p", label: isPinned ? "unpin" : "pin" },
          { key: "l", label: "labels" },
          { key: "a", label: "archive" },
        ],
      },
      type: {
        key: "type",
        placeholder: "Change document type...",
        items: DOC_TYPE_OPTIONS.map((o) => ({
          key: o.key,
          label: o.label,
          shortcut: o.shortcut,
          active: doc.doc_type === o.key,
        })),
        footerHints: [],
      },
      labels: {
        key: "labels",
        placeholder: "Toggle label...",
        items: labelItems,
        footerHints: [],
      },
    };
  }, [target, itemType, currentLabels, teamMembers, currentUser]);

  const handleSelect = useCallback(
    (modeKey: string, itemKey: string) => {
      if (!target) return;
      const count = targets.length;

      if (itemType === "task") {
        const applyTaskUpdate = (fields: Record<string, any>) => {
          for (const t of targets as TaskItem[]) {
            updateTask(t.short_id, fields);
            webUpdateTask({ short_id: t.short_id, ...fields }).catch(() => {});
          }
        };
        const label = count === 1 ? (targets[0] as TaskItem).short_id : `${count} tasks`;

        if (modeKey === "root") {
          if (itemKey === "status" || itemKey === "priority" || itemKey === "labels" || itemKey === "assign") return;
          if (itemKey === "promote") {
            applyTaskUpdate({ triage_status: "active" });
            toast.success(`${label} promoted`);
          } else if (itemKey === "dismiss") {
            applyTaskUpdate({ triage_status: "dismissed" });
            toast.success(`${label} dismissed`);
          } else if (itemKey === "copy" && count === 1) {
            navigator.clipboard.writeText((targets[0] as TaskItem).short_id);
            toast.success(`Copied ${(targets[0] as TaskItem).short_id}`);
          } else if (itemKey === "drop") {
            applyTaskUpdate({ status: "dropped" });
            toast.success("Task dropped");
          }
          onClose();
        } else if (modeKey === "status") {
          applyTaskUpdate({ status: itemKey });
          toast.success(`${label} \u2192 ${STATUS_OPTIONS.find((o) => o.key === itemKey)?.label || itemKey}`);
          onClose();
        } else if (modeKey === "priority") {
          applyTaskUpdate({ priority: itemKey });
          toast.success(`${label} priority \u2192 ${PRIORITY_OPTIONS.find((o) => o.key === itemKey)?.label || itemKey}`);
          onClose();
        } else if (modeKey === "labels") {
          const newLabels = currentLabels.includes(itemKey)
            ? currentLabels.filter((l: string) => l !== itemKey)
            : [...currentLabels, itemKey];
          applyTaskUpdate({ labels: newLabels });
          toast.success(`${currentLabels.includes(itemKey) ? "Removed" : "Added"} label: ${itemKey}`);
          onClose();
        } else if (modeKey === "assign") {
          if (itemKey.startsWith("agent:")) {
            const agentType = itemKey.replace("agent:", "");
            for (const t of targets as TaskItem[]) {
              assignToAgent({ short_id: t.short_id, agent_type: agentType }).catch(() => {});
            }
            toast.success(`Starting session with ${AGENT_OPTIONS.find((a) => a.key === itemKey)?.label || agentType}...`);
          } else {
            applyTaskUpdate({ assignee: itemKey });
            const member = (teamMembers || []).find((m: any) => m._id === itemKey);
            toast.success(`Assigned to ${member?.name || "user"}`);
          }
          onClose();
        }
        return;
      }

      // Doc actions
      const doc = target as DocItem;
      if (modeKey === "root") {
        if (itemKey === "type" || itemKey === "labels") return;
        if (itemKey === "pin") {
          pinDoc(doc._id, !doc.pinned);
          toast.success(doc.pinned ? "Unpinned" : "Pinned");
        } else if (itemKey === "copy") {
          navigator.clipboard.writeText(doc._id);
          toast.success("Copied ID");
        } else if (itemKey === "archive") {
          undoableArchiveDoc(doc._id);
          router.push("/docs");
        }
        onClose();
      } else if (modeKey === "type") {
        updateDoc(doc._id, { doc_type: itemKey });
        toast.success(`Type \u2192 ${itemKey}`);
        onClose();
      } else if (modeKey === "labels") {
        const newLabels = currentLabels.includes(itemKey)
          ? currentLabels.filter((l: string) => l !== itemKey)
          : [...currentLabels, itemKey];
        updateDoc(doc._id, { labels: newLabels });
        toast.success(`${currentLabels.includes(itemKey) ? "Removed" : "Added"} label: ${itemKey}`);
        onClose();
      }
    },
    [target, targets, itemType, currentLabels, onClose, updateTask, webUpdateTask, assignToAgent, updateDoc, pinDoc, archiveDoc, teamMembers, router]
  );

  if (!open || targets.length === 0) return null;

  return (
    <CommandPaletteShell
      open={open}
      onClose={onClose}
      contextLabel={contextLabel}
      modes={modes}
      initialMode={initialMode}
      onSelect={handleSelect}
    />
  );
}
