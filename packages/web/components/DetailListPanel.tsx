"use client";
import { useState, useMemo, useCallback, useRef, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem } from "../store/inboxStore";
import { useSyncTasks } from "../hooks/useSyncTasks";
import { useWorkspaceArgs } from "../hooks/useWorkspaceArgs";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { getLabelColor } from "../lib/labelColors";
import { Panel, Group, Separator } from "react-resizable-panels";
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
} from "lucide-react";

const api = _api as any;

type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";

const STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string }> = {
  backlog: { icon: CircleDotDashed, color: "text-sol-text-dim" },
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  in_review: { icon: CircleDot, color: "text-sol-violet" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
  dropped: { icon: XCircle, color: "text-sol-text-dim" },
};

const PRIORITY_CONFIG: Record<string, { icon: typeof Minus; color: string }> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red" },
  high: { icon: ArrowUp, color: "text-sol-orange" },
  medium: { icon: Minus, color: "text-sol-text-muted" },
  low: { icon: ArrowDown, color: "text-sol-text-dim" },
  none: { icon: Minus, color: "text-sol-text-dim" },
};

const STATUS_ORDER: TaskStatus[] = ["backlog", "open", "in_progress", "in_review", "done", "dropped"];
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function formatAge(ts: number) {
  const ago = Date.now() - ts;
  if (ago < 3600000) return `${Math.round(ago / 60000)}m`;
  if (ago < 86400000) return `${Math.round(ago / 3600000)}h`;
  return `${Math.round(ago / 86400000)}d`;
}

function CompactTaskRow({ task, isSelected }: { task: TaskItem; isSelected: boolean }) {
  const status = STATUS_CONFIG[task.status] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
  const StatusIcon = status.icon;
  const PriorityIcon = priority.icon;

  return (
    <Link
      href={`/tasks/${task._id}`}
      data-item-id={task._id}
      className={`w-full flex items-center gap-2 px-3 py-2 transition-colors text-left border-b border-sol-border/10 ${
        isSelected
          ? "bg-sol-cyan/10 border-l-[3px] border-l-sol-cyan"
          : "hover:bg-sol-bg-alt/50 border-l-[3px] border-l-transparent"
      }`}
    >
      <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${status.color}`} />
      <span className="text-[10px] font-mono text-sol-text-dim w-12 flex-shrink-0">{task.short_id}</span>
      <span className="flex-1 text-xs text-sol-text truncate min-w-0">{task.title}</span>
      {task.labels?.slice(0, 1).map((l: string) => {
        const lc = getLabelColor(l);
        return (
          <span key={l} className={`inline-flex items-center gap-0.5 text-[9px] px-1 py-0 rounded-full border flex-shrink-0 ${lc.bg} ${lc.border} ${lc.text}`}>
            <span className={`w-1 h-1 rounded-full ${lc.dot}`} />
            {l}
          </span>
        );
      })}
      {task.assignee_info?.image && (
        <img src={task.assignee_info.image} alt="" className="w-4 h-4 rounded-full flex-shrink-0" />
      )}
      <PriorityIcon className={`w-3 h-3 flex-shrink-0 ${priority.color}`} />
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{formatAge(task.updated_at)}</span>
    </Link>
  );
}

export function TaskListPanel({ selectedId }: { selectedId: string }) {
  const router = useRouter();
  useSyncTasks();
  const tasks = useInboxStore((s) => s.tasks);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const tasksList = useMemo(() => {
    return Object.values(tasks).filter(
      (t) => t.status !== "done" && t.status !== "dropped"
    );
  }, [tasks]);

  const planGroups = useMemo(() => {
    const byPlan: Record<string, { plan: TaskItem["plan"]; tasks: TaskItem[] }> = {};
    const unplanned: TaskItem[] = [];
    for (const t of tasksList) {
      if (t.plan) {
        const key = t.plan._id;
        if (!byPlan[key]) byPlan[key] = { plan: t.plan, tasks: [] };
        byPlan[key].tasks.push(t);
      } else {
        unplanned.push(t);
      }
    }
    const ordered = Object.values(byPlan)
      .sort((a, b) => (a.plan!.title || "").localeCompare(b.plan!.title || ""));
    if (unplanned.length > 0) {
      ordered.push({ plan: undefined, tasks: unplanned });
    }
    for (const g of ordered) {
      g.tasks.sort((a, b) => {
        const pd = (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
        if (pd !== 0) return pd;
        return STATUS_ORDER.indexOf(a.status as TaskStatus) - STATUS_ORDER.indexOf(b.status as TaskStatus);
      });
    }
    return ordered;
  }, [tasksList]);

  const flatTasks = useMemo(() => {
    const result: TaskItem[] = [];
    for (const g of planGroups) {
      const key = g.plan?._id || "__unplanned";
      if (!collapsedGroups.has(key)) {
        result.push(...g.tasks);
      }
    }
    return result;
  }, [planGroups, collapsedGroups]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  useWatchEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-item-id="${CSS.escape(selectedId)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useWatchEffect(() => {
    if (flatTasks.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "j") {
        e.preventDefault();
        const idx = flatTasks.findIndex(t => t._id === selectedId);
        const nextIdx = idx === -1 ? 0 : (idx + 1) % flatTasks.length;
        if (flatTasks[nextIdx]) router.push(`/tasks/${flatTasks[nextIdx]._id}`);
      } else if (e.key === "k") {
        e.preventDefault();
        const idx = flatTasks.findIndex(t => t._id === selectedId);
        const prevIdx = idx === -1 ? flatTasks.length - 1 : (idx - 1 + flatTasks.length) % flatTasks.length;
        if (flatTasks[prevIdx]) router.push(`/tasks/${flatTasks[prevIdx]._id}`);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flatTasks, selectedId, router]);

  return (
    <div className="h-full flex flex-col bg-sol-bg/50">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {planGroups.map((g) => {
          const key = g.plan?._id || "__unplanned";
          const isCollapsed = collapsedGroups.has(key);
          return (
            <div key={key}>
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-sol-bg-alt/30 border-b border-sol-border/20">
                <button
                  onClick={() => toggleGroup(key)}
                  className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                >
                  <svg className={`w-2.5 h-2.5 text-sol-text-dim transition-transform flex-shrink-0 ${isCollapsed ? "" : "rotate-90"}`} fill="currentColor" viewBox="0 0 20 20">
                    <path d="M6 4l8 6-8 6V4z" />
                  </svg>
                  <span className="text-[10px] font-medium text-sol-text-dim uppercase tracking-wide truncate">
                    {g.plan?.title || "Unplanned"}
                  </span>
                  <span className="text-[10px] text-sol-text-dim flex-shrink-0">({g.tasks.length})</span>
                  {g.plan?.status && (
                    <span className={`text-[9px] px-1 py-0 rounded border flex-shrink-0 ${
                      g.plan.status === "active" ? "border-sol-green/30 text-sol-green" : "border-sol-border/30 text-sol-text-dim"
                    }`}>
                      {g.plan.status}
                    </span>
                  )}
                </button>
                {g.plan && (
                  <Link
                    href={`/plans/${g.plan._id}`}
                    className="text-[9px] text-sol-cyan hover:underline flex-shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    View plan
                  </Link>
                )}
              </div>
              {!isCollapsed && g.tasks.map((t) => (
                <CompactTaskRow key={t._id} task={t} isSelected={t._id === selectedId} />
              ))}
            </div>
          );
        })}
        {tasksList.length === 0 && (
          <div className="px-3 py-8 text-xs text-sol-text-dim text-center">No tasks</div>
        )}
      </div>
    </div>
  );
}

const DOC_TYPE_COLORS: Record<string, string> = {
  plan: "text-sol-blue",
  design: "text-sol-violet",
  spec: "text-sol-cyan",
  investigation: "text-sol-yellow",
  handoff: "text-sol-orange",
  note: "text-sol-text-muted",
};

export function DocListPanel({ selectedId }: { selectedId: string }) {
  const router = useRouter();
  const workspaceArgs = useWorkspaceArgs();
  const result = useQuery(
    api.docs.webList,
    workspaceArgs === "skip" ? "skip" : { ...workspaceArgs, limit: 50 }
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => (result?.docs ?? result ?? []) as any[], [result]);

  useWatchEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-item-id="${CSS.escape(selectedId)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useWatchEffect(() => {
    if (items.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "j") {
        e.preventDefault();
        const idx = items.findIndex((d: any) => d._id === selectedId);
        const nextIdx = idx === -1 ? 0 : (idx + 1) % items.length;
        const next = items[nextIdx];
        if (next) {
          const href = next.plan_short_id ? `/plans/${next.plan_short_id}` : `/docs/${next._id}`;
          router.push(href);
        }
      } else if (e.key === "k") {
        e.preventDefault();
        const idx = items.findIndex((d: any) => d._id === selectedId);
        const prevIdx = idx === -1 ? items.length - 1 : (idx - 1 + items.length) % items.length;
        const prev = items[prevIdx];
        if (prev) {
          const href = prev.plan_short_id ? `/plans/${prev.plan_short_id}` : `/docs/${prev._id}`;
          router.push(href);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [items, selectedId, router]);

  return (
    <div className="h-full flex flex-col bg-sol-bg/50">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {items.map((d: any) => {
          const href = d.plan_short_id
            ? `/plans/${d.plan_short_id}`
            : `/docs/${d._id}`;
          const isSelected = d._id === selectedId;
          const typeColor = DOC_TYPE_COLORS[d.doc_type] || "text-sol-text-dim";
          return (
            <Link
              key={d._id}
              href={href}
              data-item-id={d._id}
              className={`w-full flex items-center gap-2 px-3 py-2 transition-colors text-left border-b border-sol-border/10 ${
                isSelected
                  ? "bg-sol-cyan/10 border-l-[3px] border-l-sol-cyan"
                  : "hover:bg-sol-bg-alt/50 border-l-[3px] border-l-transparent"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${typeColor}`} style={{ backgroundColor: "currentColor" }} />
              <span className="flex-1 text-xs text-sol-text truncate min-w-0">
                {d.display_title || d.title || "Untitled"}
              </span>
              <span className={`text-[9px] px-1 py-0 rounded border border-current/20 flex-shrink-0 ${typeColor}`}>
                {d.doc_type}
              </span>
              <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
                {formatAge(d.created_at)}
              </span>
            </Link>
          );
        })}
        {items.length === 0 && (
          <div className="px-3 py-8 text-xs text-sol-text-dim text-center">No docs</div>
        )}
      </div>
    </div>
  );
}

const listSeparatorClass = "relative z-10 w-px bg-sol-border/20 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

export function DetailSplitLayout({
  list,
  children,
}: {
  list: ReactNode;
  children: ReactNode;
}) {
  return (
    <Group
      orientation="horizontal"
      className="h-full"
      defaultLayout={{ "detail-list": 22, "detail-content": 78 }}
    >
      <Panel id="detail-list" minSize="15%" maxSize="40%">
        {list}
      </Panel>
      <Separator className={listSeparatorClass} />
      <Panel id="detail-content" minSize="30%">
        {children}
      </Panel>
    </Group>
  );
}
