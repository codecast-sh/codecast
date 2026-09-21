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
 *
 * One axis nests: Chain (org-roles-run-work.md R5) buckets by assignee like
 * the Assignee axis, then orders the buckets by who reports to whom and gives
 * each a depth, through the axis's `arrange` hook.
 */
import { ReactNode } from "react";
import Link from "next/link";
import { User, MessageSquare, FolderKanban, Tag, ListChecks, Flag } from "lucide-react";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { byListOrder, initiativeHref } from "./initiatives";
import { HealthChip, OwnerChip } from "../components/initiatives/InitiativeAtoms";
import { INITIATIVE_ACCENT } from "./initiativeColors";
import { isRoleAssignee, type AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import type { TaskItem, ProjectItem } from "../store/inboxStore";
import type { ListGroup } from "../components/GenericListView";
import type { OrgRole } from "../components/org/orgTypes";
import { getLabelColor } from "./labelColors";
import { orderedStatuses, statusByKey, statusVisual, statusWriteFields, taskStatusKey } from "./taskStatuses";
import { DEFAULT_TASK_STATUSES, type TeamTaskStatus } from "@codecast/shared/tasks";
import { resolveAssigneeInfo, assigneeLabelOf } from "./liveEntities";
import { arrangeChain, type ChainNode } from "./taskChain";
import { AssigneeFace } from "../components/identity/AssigneeFace";
import { ProjectLeadChip } from "../components/charter/ProjectLeadChip";

/** What an axis needs from the page to draw a header (projects aren't on the
 *  task row, and the label header offers a one-click filter). */
export type TaskGroupContext = {
  projects: Record<string, ProjectItem>;
  onFilterLabel: (label: string) => void;
  /** The active workspace's status vocabulary (per-team custom statuses),
   *  already board-ordered. Defaults keep callers that predate the field working. */
  taskStatuses?: TeamTaskStatus[];
  /** The org tree slice's roles (useOrgRoles): the Chain axis reads who
   *  reports to whom from them. */
  roles?: OrgRole[] | null;
  /** The live roster and the viewer: what names a person who heads a chain
   *  but holds no task on screen, and which chain sorts first. */
  teamMembers?: any[] | null;
  currentUser?: { _id: string } | null;
  /** The initiative each project reads as (lib/initiatives
   *  projectInitiativeIndex): the Initiative axis reaches a task's initiative
   *  through its project, never from a field on the task. */
  initiativeOfProject?: Map<string, InitiativeRow> | null;
};

const ctxStatuses = (ctx: TaskGroupContext | undefined): TeamTaskStatus[] =>
  orderedStatuses(ctx?.taskStatuses ?? DEFAULT_TASK_STATUSES);

/** One bucket, seen through a single axis. `key` is "" for the none bucket
 *  (unassigned, no project, unplanned…), which always sorts last. */
type AxisBucket = { key: string; sample?: TaskItem; tasks: TaskItem[] };

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
  keyOf: (t: TaskItem, ctx: TaskGroupContext) => string;
  /** Bucket order within this axis. Never sees a none bucket — those are
   *  pushed last by buildTaskGroups, so no axis repeats that rule. */
  compare: (a: AxisBucket, b: AxisBucket, ctx: TaskGroupContext) => number;
  header: (b: AxisBucket, ctx: TaskGroupContext) => HeaderPart;
  /** Header text for this axis's none bucket. */
  noneLabel: string;
  /** updateTask fields that move a task into this axis's bucket `key` ("" =
   *  the none bucket). Omitted on axes a drop can't edit (plan membership,
   *  session provenance), which makes their groups refuse drops entirely. */
  dropUpdates?: (key: string, t: TaskItem, ctx: TaskGroupContext) => Record<string, any> | null;
  /** A nesting axis orders its own buckets: given the keys that hold tasks, it
   *  returns every group to draw, in order, each with a depth. It may add keys
   *  that hold no task (the people and roles above one that does); `compare`
   *  is then unused. Only honored on the first axis of a grouping. */
  arrange?: (keys: string[], ctx: TaskGroupContext) => ChainNode[];
};

const byTitle = (a?: string, b?: string) => (a || "").localeCompare(b || "");

/** Who a bucket key names. A bucket that holds tasks already carries the
 *  answer on its sample (the page derives `assignee_info` for every row); a
 *  chain group that holds none (a founder whose work is all delegated) is
 *  resolved the same way, from the roster and the roles. */
function assigneeOfKey(key: string, sample: TaskItem | undefined, ctx: TaskGroupContext): AssigneeInfo | null {
  return (sample?.assignee_info as AssigneeInfo | null | undefined)
    ?? resolveAssigneeInfo(key, undefined, ctx.teamMembers, ctx.currentUser as any, ctx.roles);
}

const HEADER_LINK = "text-[10px] text-sol-cyan hover:underline flex-shrink-0";

const initiativeOfTask = (t: TaskItem | undefined, ctx: TaskGroupContext): InitiativeRow | undefined =>
  ctx.initiativeOfProject?.get((t as any)?.project_id ?? "");

// Roles and people are peers here: one bucket each, sorted together by name,
// each headed by its face. A role's face opens the role hover card.
const assigneeAxis: TaskAxis = {
  label: "Assignee",
  // assignee_info is the enriched twin; a task with an assignee we can't
  // resolve reads as unassigned rather than as a bucket named by a raw id.
  keyOf: (t) => (t.assignee && t.assignee_info ? t.assignee : ""),
  compare: (a, b) => byTitle(a.sample?.assignee_info?.name, b.sample?.assignee_info?.name),
  header: (b, ctx) => {
    const info = assigneeOfKey(b.key, b.sample, ctx);
    const href = isRoleAssignee(info)
      ? { to: `/org/${info.role_short_id}`, label: "Open role" }
      : info?.github_username
        ? { to: `/team/${info.github_username}`, label: "Profile" }
        : null;
    return {
      label: assigneeLabelOf(b.key, info),
      icon: info ? <AssigneeFace info={info} size={16} /> : <User className="w-3.5 h-3.5 text-sol-text-dim" />,
      extra: href ? (
        <Link href={href.to} onClick={(e) => e.stopPropagation()} className={HEADER_LINK}>
          {href.label}
        </Link>
      ) : undefined,
    };
  },
  noneLabel: "Unassigned",
  dropUpdates: (key) => ({ assignee: key }),
};

export const TASK_AXES: Record<string, TaskAxis> = {
  status: {
    label: "Status",
    // Buckets by the RESOLVED team status (custom "Working on" and its
    // category default are different buckets), so headers match the board.
    keyOf: (t, ctx) => taskStatusKey(t, ctxStatuses(ctx)),
    compare: (a, b, ctx) => {
      const statuses = ctxStatuses(ctx);
      const idx = (key: string) => statuses.findIndex((s) => s.id === key);
      const ai = idx(a.key);
      const bi = idx(b.key);
      const category = statuses[ai]?.category;
      if (category === statuses[bi]?.category && (category === "in_progress" || category === "in_review")) {
        return bi - ai;
      }
      return ai - bi;
    },
    header: (b, ctx) => {
      const status = statusByKey(ctxStatuses(ctx), b.key);
      const cfg = status ? statusVisual(status, ctxStatuses(ctx)) : undefined;
      const Icon = cfg?.icon;
      return {
        label: cfg?.label || b.key,
        icon: Icon ? <Icon className={`w-3.5 h-3.5 ${cfg.color}`} /> : undefined,
      };
    },
    // Every task has a status, so this bucket never fills.
    noneLabel: "No status",
    dropUpdates: (key, _t, ctx) => {
      const status = statusByKey(ctxStatuses(ctx), key);
      return status ? statusWriteFields(status) : null;
    },
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
        // Who leads the project (org-roles-run-work.md R4) sits with the link,
        // outside the header's toggle button: the chip is itself a link.
        extra: project ? (
          <span className="flex items-center gap-2 flex-shrink-0">
            <ProjectLeadChip projectId={project._id} size="xs" />
            <Link
              href={`/projects/${project._id}`}
              onClick={(e) => e.stopPropagation()}
              className={HEADER_LINK}
            >
              View project
            </Link>
          </span>
        ) : undefined,
      };
    },
    noneLabel: "No project",
    // "" clears the project (webUpdate treats an empty id as detach).
    dropUpdates: (key) => ({ project_id: key }),
  },

  plan: {
    label: "Plan",
    keyOf: (t) => t.plan?._id || "",
    compare: (a, b) => byTitle(a.sample?.plan?.title, b.sample?.plan?.title),
    header: (b) => {
      const plan = b.sample!.plan!;
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
            className={HEADER_LINK}
          >
            View plan
          </Link>
        ),
      };
    },
    noneLabel: "Unplanned",
  },

  assignee: assigneeAxis,

  // The same buckets as Assignee, drawn as a tree: a person's group, then one
  // nested group per role that reports to them, and the roles under those
  // (org-roles-run-work.md R5). Read from the org tree at render, so a role
  // moved on the chart moves here with no write to any task.
  chain: {
    ...assigneeAxis,
    label: "Chain",
    arrange: (keys, ctx) =>
      arrangeChain(keys, ctx.roles ?? [], {
        meId: ctx.currentUser?._id,
        nameOf: (key) => assigneeLabelOf(key, assigneeOfKey(key, undefined, ctx)),
      }),
  },

  // The goal a task serves, read through its project
  // (initiatives-projects-role-page.md I1). A project may sit in several
  // initiatives and a task takes one bucket, so it reads as the first by the
  // list's order. A drop cannot move a task between initiatives: membership is
  // the project's, so the groups refuse drops.
  initiative: {
    label: "Initiative",
    keyOf: (t, ctx) => initiativeOfTask(t, ctx)?._id ?? "",
    compare: (a, b, ctx) => {
      const ra = initiativeOfTask(a.sample, ctx);
      const rb = initiativeOfTask(b.sample, ctx);
      return ra && rb ? byListOrder(ra, rb) : 0;
    },
    header: (b, ctx) => {
      const row = initiativeOfTask(b.sample, ctx);
      return {
        label: row?.title || b.key,
        icon: <Flag className="w-3.5 h-3.5" style={{ color: INITIATIVE_ACCENT }} />,
        badge: row ? <HealthChip health={row.health} at={row.health_at} now={Date.now()} /> : undefined,
        extra: row ? (
          <span className="flex items-center gap-2 flex-shrink-0">
            <OwnerChip owner={row.owner} size={14} />
            <Link href={initiativeHref(row)} onClick={(e) => e.stopPropagation()} className={HEADER_LINK}>
              View initiative
            </Link>
          </span>
        ) : undefined,
      };
    },
    noneLabel: "No initiative",
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
          className={HEADER_LINK}
        >
          Filter
        </button>
      ),
    }),
    noneLabel: "No label",
    // The axis buckets by the FIRST label, so a drop makes the target label
    // primary and keeps the rest; the none bucket clears them all.
    dropUpdates: (key, t) =>
      key ? { labels: [key, ...(t.labels ?? []).filter((l) => l !== key)] } : { labels: [] },
  },

  session: {
    label: "Session",
    keyOf: (t) => t.origin_session?.session_id || "",
    // Newest work first: sessions are a chronology, not a vocabulary.
    compare: (a, b) =>
      Math.max(...b.tasks.map((t) => t.created_at)) - Math.max(...a.tasks.map((t) => t.created_at)),
    header: (b) => {
      const session = b.sample!.origin_session!;
      return {
        label: session.title || b.key.slice(0, 8),
        icon: <MessageSquare className="w-3.5 h-3.5 text-sol-cyan" />,
        extra: session.conversation_id ? (
          <Link
            href={`/sessions/${session.conversation_id}`}
            onClick={(e) => e.stopPropagation()}
            className={HEADER_LINK}
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
export const TASK_AXIS_KEYS = ["status", "initiative", "project", "plan", "assignee", "chain", "label", "session"] as const;

/** Split a group value into its axes, dropping anything unknown. "none" (or an
 *  unrecognised value) yields an empty list, meaning a flat list. */
export function parseTaskGroup(group: string): string[] {
  if (!group || group === "none") return [];
  // A space is accepted alongside "+": a shared link carries the separator
  // percent-encoded, but a hand-edited one keeps a literal "+", which a query
  // parser hands back as " ". Both should mean the same grouping.
  const axes = group.split(/[+ ]/).filter((a) => a in TASK_AXES);
  // Repeats would produce a header like "Open · Open"; keep the first.
  return [...new Set(axes)].filter((a, i, all) => i === 0 || canSubGroup(all[0], a));
}

/** Whether `axis` can divide `primary`'s groups. A nesting axis (Chain) only
 *  works first, since its tree IS the layout; and two axes that read the same
 *  key off a task (Chain and Assignee) would only repeat each other. */
export function canSubGroup(primary: string, axis: string): boolean {
  const a = TASK_AXES[axis];
  return !!a && axis !== primary && !a.arrange && a.keyOf !== TASK_AXES[primary]?.keyOf;
}

/** Whether a raw group value is legal — one or more known axes, or "none". */
export function isValidTaskGroup(group: string): boolean {
  if (group === "none") return true;
  if (!group) return false;
  const parts = group.split(/[+ ]/);
  return parts.length > 0 && parts.every((p) => p in TASK_AXES);
}

// A bucket's id is its axis keys joined. Both sentinels are control characters,
// so they can't collide with a real id, project title or label phrase, and
// ("ab","c") stays a different bucket from ("a","bc").
const NONE_BUCKET = "\u0000none";
const KEY_SEP = "\u0001";
const bucketId = (keys: string[]) => keys.map((k) => k || NONE_BUCKET).join(KEY_SEP);

/**
 * The updateTask fields that move `task` into the bucket `groupKey` names under
 * the grouping `group` — the inverse of buildTaskGroups's bucketing, one axis at
 * a time. Returns null when the move can't be honored (an axis without
 * dropUpdates, e.g. plan/session), so callers refuse the whole drop rather than
 * half-apply a combined grouping. Axes where the task already sits in the
 * target bucket contribute nothing, so a same-bucket drop yields {}.
 */
export function taskGroupDropUpdates(
  group: string,
  groupKey: string,
  task: TaskItem,
  ctx: TaskGroupContext,
): Record<string, any> | null {
  const axisKeys = parseTaskGroup(group);
  if (axisKeys.length === 0) return null;
  const keys = groupKey.split(KEY_SEP).map((k) => (k === NONE_BUCKET ? "" : k));
  if (keys.length !== axisKeys.length) return null;
  const updates: Record<string, any> = {};
  for (let i = 0; i < axisKeys.length; i++) {
    const axis = TASK_AXES[axisKeys[i]];
    if (axis.keyOf(task, ctx) === keys[i]) continue;
    const u = axis.dropUpdates?.(keys[i], task, ctx);
    if (!u) return null;
    Object.assign(updates, u);
  }
  return updates;
}

type Bucket = {
  keys: string[];
  sample?: TaskItem;
  tasks: TaskItem[];
  /** Set by a nesting first axis (Chain): how far under its top the group sits. */
  depth?: number;
  /** Tasks in this group and every group nested under it, on the first header
   *  of a group that has any nested; absent where it would repeat the count. */
  chainTotal?: number;
};

/**
 * Lay sorted buckets out along a nesting axis's tree. Each node takes its own
 * buckets (several, when a second axis splits it) in the order they already
 * hold; a node with none gets an empty header, because the groups nested under
 * it need something to hang from. The none bucket keeps its place at the end.
 */
function nestBuckets(ordered: Bucket[], nodes: ChainNode[]): Bucket[] {
  const own = nodes.map((node) => ordered.filter((b) => b.keys[0] === node.key));
  const count = (list: Bucket[]) => list.reduce((n, b) => n + b.tasks.length, 0);
  const out: Bucket[] = [];
  nodes.forEach((node, n) => {
    let total = count(own[n]);
    let nested = false;
    for (let m = n + 1; m < nodes.length && nodes[m].depth > node.depth; m++) {
      total += count(own[m]);
      nested = true;
    }
    const mine: Bucket[] = own[n].length ? own[n] : [{ keys: [node.key], tasks: [] }];
    mine.forEach((b, i) => out.push({ ...b, depth: node.depth, chainTotal: nested && i === 0 ? total : undefined }));
  });
  return [...out, ...ordered.filter((b) => !b.keys[0])];
}

/**
 * Bucket tasks by every axis in `group` and return the flat header list
 * GenericListView renders. `sortTasks` orders rows inside each bucket (it also
 * nests subtasks under parents), so grouping never changes row order.
 *
 * Returns null when the grouping shouldn't apply — no axes (flat list), or a
 * pure status grouping while exactly one status is selected, where every row
 * would share one header. (Several selected statuses still group usefully.)
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
  if (axisKeys.length === 1 && axisKeys[0] === "status" && statusFilter && statusFilter !== "all" && !statusFilter.includes(",")) {
    return null;
  }

  const axes = axisKeys.map((k) => TASK_AXES[k]);
  const buckets = new Map<string, Bucket>();
  for (const task of tasks) {
    const keys = axes.map((axis) => axis.keyOf(task, ctx));
    const id = bucketId(keys);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { keys, sample: task, tasks: [] };
      buckets.set(id, bucket);
    }
    bucket.tasks.push(task);
  }

  const view = (bucket: Bucket, i: number): AxisBucket => ({
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

  const arrange = axes[0].arrange;
  const laid = arrange
    ? nestBuckets(ordered, arrange([...new Set(ordered.map((b) => b.keys[0]).filter(Boolean))], ctx))
    : ordered;

  return laid.map((bucket) => {
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
      badge: bucket.chainTotal !== undefined ? (
        <span className="text-[10px] text-sol-text-dim normal-case tracking-normal">{bucket.chainTotal} in chain</span>
      ) : parts.find((p) => p.badge)?.badge,
      depth: bucket.depth,
      extra: extras.length ? (
        <span className="flex items-center gap-2 flex-shrink-0">{extras.map((p, i) => <span key={i}>{p.extra}</span>)}</span>
      ) : undefined,
      items: sortTasks(bucket.tasks),
    };
  });
}
