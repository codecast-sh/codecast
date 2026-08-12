"use client";
/**
 * Task grouping, as data.
 *
 * Every grouping the task list offers is one axis: how to read a bucket key off
 * a task, how to order the buckets, and how to draw the header. Holding them as
 * descriptors instead of one memo apiece is what makes a *combined* grouping
 * ("Assignee · Project", from the Aug 12 huddle) cost a menu entry rather than a
 * new code path — buildTaskGroups walks however many axes the group value names.
 *
 * A group value is one or more axis names joined by "+": "assignee",
 * "assignee+project", "project+status". "none" means a flat list.
 */
import { ReactNode } from "react";
import Link from "next/link";
import { User, MessageSquare, FolderKanban, Tag, ListChecks } from "lucide-react";
import { TaskItem, ProjectItem } from "../store/inboxStore";
import { ListGroup } from "../components/GenericListView";
import { getLabelColor } from "./labelColors";
import { TASK_STATUS, TASK_STATUS_ORDER } from "../components/TaskStatusBadge";

/** What an axis needs from the page to draw a header (projects aren't on the
 *  task row, and the label header offers a one-click filter). */
export type TaskGroupContext = {
  projects: Record<string, ProjectItem>;
  onFilterLabel: (label: string) => void;
};

/** One bucket, seen through a single axis. `key` is "" for the none bucket
 *  (unassigned, no project, unplanned…), which always sorts last. */
type AxisBucket = { key: string; sample: TaskItem; tasks: TaskItem[] };

/** The header pieces an axis contributes. In a combined grouping these are
 *  concatenated left to right, so each axis only describes its own half. */
type HeaderPart = {
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  extra?: ReactNode;
};

export type TaskAxis = {
  /** Menu label, e.g. "Assignee". */
  label: string;
  /** Bucket key for a task; "" collects into the trailing none bucket. */
  keyOf: (t: TaskItem) => string;
  /** Bucket order within this axis. Never sees a none bucket — those are
   *  pushed last by buildTaskGroups, so no axis repeats that rule. */
  compare: (a: AxisBucket, b: AxisBucket, ctx: TaskGroupContext) => number;
  header: (b: AxisBucket, ctx: TaskGroupContext) => HeaderPart;
  /** Header text for this axis's none bucket. */
  noneLabel: string;
};

const byTitle = (a?: string, b?: string) => (a || "").localeCompare(b || "");

export const TASK_AXES: Record<string, TaskAxis> = {
  status: {
    label: "Status",
    keyOf: (t) => t.status as string,
    compare: (a, b) => TASK_STATUS_ORDER.indexOf(a.key as any) - TASK_STATUS_ORDER.indexOf(b.key as any),
    header: (b) => {
      const cfg = TASK_STATUS[b.key as keyof typeof TASK_STATUS];
      const Icon = cfg?.icon;
      return {
        label: cfg?.label || b.key,
        icon: Icon ? <Icon className={`w-3.5 h-3.5 ${cfg.color}`} /> : undefined,
      };
    },
    // Every task has a status, so this bucket never fills.
    noneLabel: "No status",
  },

  project: {
    label: "Project",
    keyOf: (t) => (t as any).project_id || "",
    compare: (a, b, ctx) => byTitle(ctx.projects[a.key]?.title, ctx.projects[b.key]?.title),
    header: (b, ctx) => {
      const project = ctx.projects[b.key];
      return {
        label: project?.title || b.key,
        icon: <FolderKanban className="w-3.5 h-3.5 text-sol-cyan" />,
        extra: project ? (
          <Link
            href={`/projects/${project._id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-sol-cyan hover:underline flex-shrink-0"
          >
            View project
          </Link>
        ) : undefined,
      };
    },
    noneLabel: "No project",
  },

  plan: {
    label: "Plan",
    keyOf: (t) => t.plan?._id || "",
    compare: (a, b) => byTitle(a.sample.plan?.title, b.sample.plan?.title),
    header: (b) => {
      const plan = b.sample.plan!;
      return {
        label: plan.title || b.key,
        icon: <ListChecks className="w-3.5 h-3.5 text-sol-cyan" />,
        badge: (
          <span
            className={`text-[10px] px-1.5 py-0 rounded border ${
              plan.status === "active" ? "border-sol-green/30 text-sol-green" : "border-sol-border/30 text-sol-text-dim"
            }`}
          >
            {plan.status}
          </span>
        ),
        extra: (
          <Link
            href={`/plans/${plan._id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-sol-cyan hover:underline flex-shrink-0"
          >
            View plan
          </Link>
        ),
      };
    },
    noneLabel: "Unplanned",
  },

  assignee: {
    label: "Assignee",
    // assignee_info is the enriched twin; a task with an assignee we can't
    // resolve reads as unassigned rather than as a bucket named by a raw id.
    keyOf: (t) => (t.assignee && t.assignee_info ? t.assignee : ""),
    compare: (a, b) => byTitle(a.sample.assignee_info?.name, b.sample.assignee_info?.name),
    header: (b) => {
      const info = b.sample.assignee_info;
      const github = (info as any)?.github_username;
      return {
        label: info?.name || b.key,
        icon: info?.image ? (
          <img src={info.image} alt={info.name} className="w-4 h-4 rounded-full" />
        ) : (
          <User className="w-3.5 h-3.5 text-sol-text-dim" />
        ),
        extra: github ? (
          <Link
            href={`/team/${github}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-sol-cyan hover:underline flex-shrink-0"
          >
            Profile
          </Link>
        ) : undefined,
      };
    },
    noneLabel: "Unassigned",
  },

  label: {
    // Tasks here carry three or four phrase-shaped labels, so the first one is a
    // representative, not a category — but one bucket per task is what keeps a
    // task's _id unique across the virtualizer's row model.
    label: "Label",
    keyOf: (t) => t.labels?.[0] || "",
    compare: (a, b) => a.key.localeCompare(b.key),
    header: (b, ctx) => ({
      label: b.key,
      icon: <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getLabelColor(b.key).dot}`} />,
      extra: (
        <button
          onClick={(e) => {
            e.stopPropagation();
            ctx.onFilterLabel(b.key);
          }}
          className="text-[10px] text-sol-cyan hover:underline flex-shrink-0"
        >
          Filter
        </button>
      ),
    }),
    noneLabel: "No label",
  },

  session: {
    label: "Session",
    keyOf: (t) => t.origin_session?.session_id || "",
    // Newest work first: sessions are a chronology, not a vocabulary.
    compare: (a, b) =>
      Math.max(...b.tasks.map((t) => t.created_at)) - Math.max(...a.tasks.map((t) => t.created_at)),
    header: (b) => {
      const session = b.sample.origin_session!;
      return {
        label: session.title || b.key.slice(0, 8),
        icon: <MessageSquare className="w-3.5 h-3.5 text-sol-cyan" />,
        extra: session.conversation_id ? (
          <Link
            href={`/sessions/${session.conversation_id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-sol-cyan hover:underline flex-shrink-0"
          >
            View session
          </Link>
        ) : undefined,
      };
    },
    noneLabel: "No session",
  },
};

/** Axis order for the group menus. */
export const TASK_AXIS_KEYS = ["status", "project", "plan", "assignee", "label", "session"] as const;

/** Split a group value into its axes, dropping anything unknown. "none" (or an
 *  unrecognised value) yields an empty list, meaning a flat list. */
export function parseTaskGroup(group: string): string[] {
  if (!group || group === "none") return [];
  const axes = group.split("+").filter((a) => a in TASK_AXES);
  // Repeats would produce a header like "Open · Open"; keep the first.
  return [...new Set(axes)];
}

/** Whether a raw group value is legal — one or more known axes, or "none". */
export function isValidTaskGroup(group: string): boolean {
  if (group === "none") return true;
  if (!group) return false;
  const parts = group.split("+");
  return parts.length > 0 && parts.every((p) => p in TASK_AXES);
}

// A bucket's id is its axis keys joined. Both sentinels are control characters,
// so they can't collide with a real id, project title or label phrase, and
// ("ab","c") stays a different bucket from ("a","bc").
const NONE_BUCKET = "\u0000none";
const KEY_SEP = "\u0001";
const bucketId = (keys: string[]) => keys.map((k) => k || NONE_BUCKET).join(KEY_SEP);

/**
 * Bucket tasks by every axis in `group` and return the flat header list
 * GenericListView renders. `sortTasks` orders rows inside each bucket (it also
 * nests subtasks under parents), so grouping never changes row order.
 *
 * Returns null when the grouping shouldn't apply — no axes (flat list), or a
 * pure status grouping while a single-status tab is active, where every row
 * would share one header.
 */
export function buildTaskGroups({
  group,
  tasks,
  sortTasks,
  statusFilter,
  ctx,
}: {
  group: string;
  tasks: TaskItem[];
  sortTasks: (tasks: TaskItem[]) => TaskItem[];
  statusFilter: string;
  ctx: TaskGroupContext;
}): ListGroup<TaskItem>[] | null {
  const axisKeys = parseTaskGroup(group);
  if (axisKeys.length === 0) return null;
  if (axisKeys.length === 1 && axisKeys[0] === "status" && statusFilter && statusFilter !== "all") {
    return null;
  }

  const axes = axisKeys.map((k) => TASK_AXES[k]);
  const buckets = new Map<string, { keys: string[]; sample: TaskItem; tasks: TaskItem[] }>();
  for (const task of tasks) {
    const keys = axes.map((axis) => axis.keyOf(task));
    const id = bucketId(keys);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { keys, sample: task, tasks: [] };
      buckets.set(id, bucket);
    }
    bucket.tasks.push(task);
  }

  const view = (bucket: { keys: string[]; sample: TaskItem; tasks: TaskItem[] }, i: number): AxisBucket => ({
    key: bucket.keys[i],
    sample: bucket.sample,
    tasks: bucket.tasks,
  });

  const ordered = [...buckets.values()].sort((a, b) => {
    for (let i = 0; i < axes.length; i++) {
      // The none bucket trails its siblings on every axis, so "Unassigned" sits
      // under the named people rather than wherever "" would sort.
      if (!a.keys[i] !== !b.keys[i]) return a.keys[i] ? -1 : 1;
      if (!a.keys[i]) continue;
      const r = axes[i].compare(view(a, i), view(b, i), ctx);
      if (r !== 0) return r;
    }
    return 0;
  });

  return ordered.map((bucket) => {
    const parts = bucket.keys.map((key, i) =>
      key
        ? axes[i].header(view(bucket, i), ctx)
        : ({ label: axes[i].noneLabel } as HeaderPart)
    );
    const icons = parts.filter((p) => p.icon);
    const extras = parts.filter((p) => p.extra);
    return {
      key: bucketId(bucket.keys),
      label: parts.map((p) => p.label).join(" · "),
      icon: icons.length ? (
        <span className="flex items-center gap-1 flex-shrink-0">{icons.map((p, i) => <span key={i} className="flex">{p.icon}</span>)}</span>
      ) : undefined,
      badge: parts.find((p) => p.badge)?.badge,
      extra: extras.length ? (
        <span className="flex items-center gap-2 flex-shrink-0">{extras.map((p, i) => <span key={i}>{p.extra}</span>)}</span>
      ) : undefined,
      items: sortTasks(bucket.tasks),
    };
  });
}
