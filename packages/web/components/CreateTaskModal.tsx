import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "../hooks/useWorkspaceArgs";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { AssigneeSelect } from "./AssigneeSelect";
import { Switch } from "./ui/switch";
import { DocEditor } from "./editor/DocEditor";
import type { MentionItem } from "./editor/MentionList";
import { toast } from "sonner";
import { getLabelColor, DEFAULT_LABELS } from "../lib/labelColors";
import {
  Plus,
  Circle,
  CircleDot,
  CircleDotDashed,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  Check,
  ChevronDown,
  Tag,
  Search,
} from "lucide-react";

const api = _api as any;

const CREATE_STATUS_OPTIONS = [
  { key: "open", label: "Open", icon: Circle, color: "text-sol-blue" },
  { key: "backlog", label: "Backlog", icon: CircleDotDashed, color: "text-sol-text-dim" },
  { key: "in_progress", label: "In Progress", icon: CircleDot, color: "text-sol-yellow" },
];

const CREATE_PRIORITY_OPTIONS = [
  { key: "urgent", label: "Urgent", icon: AlertTriangle, color: "text-sol-red" },
  { key: "high", label: "High", icon: ArrowUp, color: "text-sol-orange" },
  { key: "medium", label: "Medium", icon: Minus, color: "text-sol-text-muted" },
  { key: "low", label: "Low", icon: ArrowDown, color: "text-sol-text-dim" },
];

function PropertyChip<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string; icon: any; color?: string }[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.key === value) || options[0];
  const Icon = current.icon;

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-sol-border/30 hover:border-sol-border/60 text-sol-text-muted hover:text-sol-text transition-colors"
      >
        <Icon className={`w-3.5 h-3.5 ${current.color || ""}`} />
        <span>{current.label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-40 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1">
          {options.map((opt) => {
            const OptIcon = opt.icon;
            return (
              <button
                key={opt.key}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  opt.key === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                <OptIcon className={`w-3.5 h-3.5 ${opt.color || ""}`} />
                <span className="flex-1 text-left">{opt.label}</span>
                {opt.key === value && <Check className="w-3 h-3 text-sol-cyan" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LabelsChip({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useWatchEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = [...new Set([...DEFAULT_LABELS, ...value])]
    .filter((l) => !search.trim() || l.toLowerCase().includes(search.toLowerCase()));

  const canCreate = search.trim() && !filtered.some((l) => l.toLowerCase() === search.trim().toLowerCase());

  const toggle = (label: string) => {
    onChange(value.includes(label) ? value.filter((l) => l !== label) : [...value, label]);
  };

  const createAndAdd = () => {
    const name = search.trim().toLowerCase();
    if (name && !value.includes(name)) {
      onChange([...value, name]);
    }
    setSearch("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors border ${
          value.length > 0
            ? "border-sol-border/60 bg-sol-bg-alt text-sol-text"
            : "border-sol-border/30 hover:border-sol-border/60 text-sol-text-dim hover:text-sol-text"
        }`}
      >
        <Tag className="w-3.5 h-3.5" />
        {value.length > 0 ? (
          <span>{value.length === 1 ? value[0] : `${value.length} labels`}</span>
        ) : (
          <span>Labels</span>
        )}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/30">
            <Search className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type to search or create..."
              className="flex-1 text-xs bg-transparent text-sol-text placeholder:text-sol-text-dim outline-none"
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && canCreate) { e.preventDefault(); createAndAdd(); }
              }}
            />
          </div>
          <div className="py-1 max-h-48 overflow-y-auto">
            {canCreate && (
              <button
                onClick={createAndAdd}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sol-cyan hover:bg-sol-bg-alt transition-colors"
              >
                <Plus className="w-3 h-3 flex-shrink-0" />
                <span className="flex-1 text-left">Create &quot;{search.trim()}&quot;</span>
              </button>
            )}
            {filtered.map((label) => {
              const color = getLabelColor(label);
              return (
                <button
                  key={label}
                  onClick={() => toggle(label)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    value.includes(label) ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color.dot}`} />
                  <span className="flex-1 text-left">{label}</span>
                  {value.includes(label) && <Check className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function CreateTaskModal({ onClose, teamMembers, currentUser }: { onClose: () => void; teamMembers?: any[] | null; currentUser?: any }) {
  const createTask = useInboxStore((s) => s.createTask);
  const workspaceArgs = useWorkspaceArgs();
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);

  const [title, setTitle] = useState("");
  const descriptionRef = useRef("");
  const [priority, setPriority] = useState<string>("medium");
  const [status, setStatus] = useState<string>("open");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [assigneeInfo, setAssigneeInfo] = useState<{ name: string; image?: string } | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [createMore, setCreateMore] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const titleRef = useRef<HTMLInputElement>(null);

  const mentionResults = useQuery(api.docs.mentionSearch, { query: "", limit: 20 });
  const mentionResultsRef = useRef<MentionItem[]>([]);
  if (mentionResults) mentionResultsRef.current = mentionResults;

  const handleMentionQuery = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      const results = mentionResultsRef.current;
      if (!results.length) return [];
      const q = query.toLowerCase();
      if (!q) return results;
      return results.filter(
        (r: MentionItem) =>
          r.label.toLowerCase().includes(q) ||
          (r.sublabel && r.sublabel.toLowerCase().includes(q))
      );
    },
    []
  );

  const handleImageUpload = useCallback(async (file: File): Promise<string | null> => {
    const uploadUrl = await generateUploadUrl({});
    const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
    const { storageId } = await result.json();
    const url = await convex.query(api.images.getImageUrl, { storageId });
    return url || null;
  }, [generateUploadUrl, convex]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    const desc = descriptionRef.current.trim();
    const wsArgs = workspaceArgs === "skip" ? {} : workspaceArgs;
    const opts: any = {
      title: title.trim(),
      description: desc || undefined,
      task_type: "task",
      priority,
      status,
      assignee: assignee || undefined,
      labels: labels.length > 0 ? labels : undefined,
      ...wsArgs,
    };
    createTask(opts);
    toast.success(`Created: ${title.trim()}`);
    if (createMore) {
      setTitle("");
      descriptionRef.current = "";
      setEditorKey((k) => k + 1);
      setTimeout(() => titleRef.current?.focus(), 0);
    } else {
      onClose();
    }
  }, [title, priority, status, assignee, labels, createMore, createTask, onClose, workspaceArgs]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[10001] flex items-start justify-center pt-[10vh] animate-in fade-in duration-150"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
      }}
    >
      <div
        className="bg-sol-bg border border-sol-border rounded-2xl shadow-2xl w-full max-w-[640px] animate-in slide-in-from-bottom-4 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-1">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault();
            }}
            className="w-full text-xl font-semibold text-sol-text placeholder:text-sol-text-dim/40 bg-transparent outline-none"
          />
        </div>

        <div className="px-6 pb-4 min-h-[120px] max-h-[280px] overflow-y-auto doc-editor-compact">
          <DocEditor
            key={editorKey}
            content=""
            onUpdate={(md) => { descriptionRef.current = md; }}
            onMentionQuery={handleMentionQuery}
            onImageUpload={handleImageUpload}
            placeholder="Add description... use @ to mention, paste images"
            className="text-sm"
          />
        </div>

        <div className="flex items-center gap-2 px-6 py-3 border-t border-sol-border/40 flex-wrap">
          <PropertyChip value={status as any} options={CREATE_STATUS_OPTIONS as any} onChange={(v) => setStatus(v)} />
          <PropertyChip value={priority as any} options={CREATE_PRIORITY_OPTIONS as any} onChange={(v) => setPriority(v)} />
          <LabelsChip value={labels} onChange={setLabels} />
          <AssigneeSelect
            value={assignee}
            valueInfo={assigneeInfo}
            onChange={(id, info) => { setAssignee(id); setAssigneeInfo(info); }}
            teamMembers={teamMembers}
            currentUser={currentUser}
          />
        </div>

        <div className="flex items-center gap-3 px-6 py-4 border-t border-sol-border/40">
          <label className="flex items-center gap-2 text-xs text-sol-text-dim cursor-pointer select-none hover:text-sol-text transition-colors">
            <Switch checked={createMore} onCheckedChange={setCreateMore} />
            <span>Create another</span>
          </label>
          <div className="flex-1" />
          <span className="text-[11px] text-sol-text-dim/50 mr-1 hidden sm:inline">
            {typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent) ? "\u2318" : "Ctrl"}+&#x21B5;
          </span>
          <button
            onClick={handleSubmit}
            disabled={!title.trim()}
            className="px-5 py-2 text-sm rounded-lg bg-sol-cyan text-sol-bg font-semibold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            Create task
          </button>
        </div>
      </div>
    </div>
  );
}
