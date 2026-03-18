import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem } from "../store/inboxStore";
import { toast } from "sonner";
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
  Search,
  User,
  Tag,
  Copy,
  Trash2,
  Check,
  CornerDownLeft,
} from "lucide-react";

const api = _api as any;

type CommandMode =
  | "root"
  | "status"
  | "priority"
  | "labels"
  | "assign";

const STATUS_OPTIONS = [
  { key: "draft", icon: CircleDotDashed, label: "Draft", color: "text-neutral-500", shortcut: "1" },
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

const LABEL_PRESETS = [
  "bug", "feature", "improvement", "refactor", "docs", "infra",
  "design", "perf", "security", "testing", "urgent", "blocked",
];

interface TaskCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  targetTasks: TaskItem[];
  initialMode?: CommandMode;
}

export function TaskCommandPalette({
  open,
  onClose,
  targetTasks,
  initialMode = "root",
}: TaskCommandPaletteProps) {
  const [mode, setMode] = useState<CommandMode>(initialMode);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const webUpdate = useMutation(api.tasks.webUpdate);
  const updateTask = useInboxStore((s) => s.updateTask);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setSearch("");
      setHighlightIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initialMode]);

  const applyUpdate = useCallback(
    async (fields: Record<string, any>) => {
      for (const task of targetTasks) {
        updateTask(task.short_id, fields);
        try {
          await webUpdate({ short_id: task.short_id, ...fields });
        } catch {}
      }
      onClose();
    },
    [targetTasks, webUpdate, updateTask, onClose]
  );

  const taskLabel = useMemo(() => {
    if (targetTasks.length === 0) return "";
    if (targetTasks.length === 1)
      return `${targetTasks[0].short_id} \u00B7 ${targetTasks[0].title}`;
    return `${targetTasks.length} tasks selected`;
  }, [targetTasks]);

  const currentStatus = targetTasks.length === 1 ? targetTasks[0].status : null;
  const currentPriority = targetTasks.length === 1 ? targetTasks[0].priority : null;
  const currentLabels = targetTasks.length === 1 ? (targetTasks[0].labels || []) : [];

  const rootItems = useMemo(
    () => [
      { id: "status", label: "Change status...", icon: CircleDot, shortcut: "S", action: () => setMode("status") },
      { id: "priority", label: "Set priority...", icon: ArrowUp, shortcut: "P", action: () => setMode("priority") },
      { id: "labels", label: "Add labels...", icon: Tag, shortcut: "L", action: () => setMode("labels") },
      { id: "assign", label: "Assign to me", icon: User, shortcut: "I", action: () => { applyUpdate({ assignee: "me" }); toast.success("Assigned to you"); } },
      { id: "copy", label: "Copy task ID", icon: Copy, shortcut: "\u2318.", action: () => {
        if (targetTasks.length === 1) {
          navigator.clipboard.writeText(targetTasks[0].short_id);
          toast.success(`Copied ${targetTasks[0].short_id}`);
        }
        onClose();
      }},
      { id: "delete", label: "Drop task", icon: Trash2, shortcut: "D", action: () => { applyUpdate({ status: "dropped" }); toast.success("Task dropped"); } },
    ],
    [applyUpdate, targetTasks, onClose]
  );

  const getFilteredItems = useCallback(() => {
    const q = search.toLowerCase();
    if (mode === "root") {
      return rootItems.filter((i) => i.label.toLowerCase().includes(q));
    }
    if (mode === "status") {
      return STATUS_OPTIONS.filter((i) => i.label.toLowerCase().includes(q));
    }
    if (mode === "priority") {
      return PRIORITY_OPTIONS.filter((i) => i.label.toLowerCase().includes(q));
    }
    if (mode === "labels") {
      const all = [...new Set([...LABEL_PRESETS, ...currentLabels])];
      return all
        .filter((l) => l.toLowerCase().includes(q))
        .map((l, i) => ({
          key: l,
          label: l,
          active: currentLabels.includes(l),
          shortcut: i < 9 ? String(i + 1) : undefined,
        }));
    }
    return [];
  }, [mode, search, rootItems, currentLabels]);

  const items = getFilteredItems();

  useEffect(() => {
    setHighlightIndex(0);
  }, [search, mode]);

  const selectItem = useCallback(
    (index: number) => {
      const count = targetTasks.length;
      const label = count === 1 ? targetTasks[0].short_id : `${count} tasks`;
      if (mode === "root") {
        const item = items[index] as (typeof rootItems)[0] | undefined;
        item?.action();
      } else if (mode === "status") {
        const item = items[index] as (typeof STATUS_OPTIONS)[0] | undefined;
        if (item) {
          applyUpdate({ status: item.key });
          toast.success(`${label} → ${item.label}`);
        }
      } else if (mode === "priority") {
        const item = items[index] as (typeof PRIORITY_OPTIONS)[0] | undefined;
        if (item) {
          applyUpdate({ priority: item.key });
          toast.success(`${label} priority → ${item.label}`);
        }
      } else if (mode === "labels") {
        const item = items[index] as any;
        if (item) {
          const newLabels = item.active
            ? currentLabels.filter((l: string) => l !== item.key)
            : [...currentLabels, item.key];
          applyUpdate({ labels: newLabels });
          toast.success(`${item.active ? "Removed" : "Added"} label: ${item.key}`);
        }
      }
    },
    [mode, items, applyUpdate, currentLabels, targetTasks]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (mode !== "root" && initialMode === "root") {
          setMode("root");
          setSearch("");
        } else {
          onClose();
        }
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

      if (mode === "status" || mode === "priority" || mode === "labels") {
        const num = parseInt(e.key);
        if (num >= 1 && num <= items.length) {
          e.preventDefault();
          selectItem(num - 1);
          return;
        }
      }

      if (e.key === "Backspace" && search === "" && mode !== "root" && initialMode === "root") {
        e.preventDefault();
        setMode("root");
        return;
      }
    },
    [mode, initialMode, items, highlightIndex, selectItem, onClose, search]
  );

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const highlighted = el.children[highlightIndex] as HTMLElement;
    if (highlighted) {
      highlighted.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  if (!open || targetTasks.length === 0) return null;

  const modeLabel =
    mode === "status" ? "Change status..." :
    mode === "priority" ? "Set priority..." :
    mode === "labels" ? "Toggle label..." :
    mode === "assign" ? "Assign to..." :
    "Type a command or search...";

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center pt-[12vh]"
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-xl bg-sol-bg border border-sol-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Task context header */}
        <div className="px-4 pt-3 pb-0">
          <div className="text-xs font-mono text-sol-text-dim truncate">{taskLabel}</div>
        </div>

        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30">
          {mode !== "root" && initialMode === "root" && (
            <button
              onClick={() => { setMode("root"); setSearch(""); }}
              className="text-xs px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
            >
              &larr;
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

        {/* Items list */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-sol-text-dim">No results</div>
          )}

          {mode === "root" &&
            (items as typeof rootItems).map((item, i) => (
              <button
                key={item.id}
                onClick={() => selectItem(i)}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  i === highlightIndex
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-alt/50"
                }`}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                  {item.shortcut}
                </kbd>
              </button>
            ))}

          {mode === "status" &&
            (items as typeof STATUS_OPTIONS).map((item, i) => {
              const Icon = item.icon;
              const isCurrent = item.key === currentStatus;
              return (
                <button
                  key={item.key}
                  onClick={() => selectItem(i)}
                  onMouseEnter={() => setHighlightIndex(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                    i === highlightIndex
                      ? "bg-sol-bg-highlight text-sol-text"
                      : "text-sol-text-muted hover:bg-sol-bg-alt/50"
                  }`}
                >
                  <Icon className={`w-4 h-4 flex-shrink-0 ${item.color}`} />
                  <span className="flex-1 text-left">{item.label}</span>
                  {isCurrent && <Check className="w-4 h-4 text-sol-cyan flex-shrink-0" />}
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                    {item.shortcut}
                  </kbd>
                </button>
              );
            })}

          {mode === "priority" &&
            (items as typeof PRIORITY_OPTIONS).map((item, i) => {
              const Icon = item.icon;
              const isCurrent = item.key === currentPriority;
              return (
                <button
                  key={item.key}
                  onClick={() => selectItem(i)}
                  onMouseEnter={() => setHighlightIndex(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                    i === highlightIndex
                      ? "bg-sol-bg-highlight text-sol-text"
                      : "text-sol-text-muted hover:bg-sol-bg-alt/50"
                  }`}
                >
                  <Icon className={`w-4 h-4 flex-shrink-0 ${item.color}`} />
                  <span className="flex-1 text-left">{item.label}</span>
                  {isCurrent && <Check className="w-4 h-4 text-sol-cyan flex-shrink-0" />}
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                    {item.shortcut}
                  </kbd>
                </button>
              );
            })}

          {mode === "labels" &&
            (items as any[]).map((item, i) => (
              <button
                key={item.key}
                onClick={() => selectItem(i)}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  i === highlightIndex
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-alt/50"
                }`}
              >
                <Tag className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.active && <Check className="w-4 h-4 text-sol-cyan flex-shrink-0" />}
                {item.shortcut && (
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            ))}
        </div>

        {/* Footer hints */}
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
            {mode !== "root" && initialMode === "root" ? "back" : "close"}
          </span>
          {(mode === "status" || mode === "priority") && (
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">1-{mode === "status" ? "6" : "5"}</kbd>
              quick pick
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
