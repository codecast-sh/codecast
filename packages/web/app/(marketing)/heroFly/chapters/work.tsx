"use client";

/**
 * Chapter 7, Track: the lead's `cast task create` block in its transcript,
 * then the task board: the Webhook reliability plan's tasks as the tasks page
 * lists them, the new task landing on top and getting claimed, the plan's
 * progress, and the new task's stations and activity beside the list.
 * Clicking a row's status or priority cycles it, the way the palette would.
 */

import { useMemo, useState } from "react";
import { CastCommandBlock } from "@/components/conversation/blocks/castBlocks";
import { EntityIdPill } from "@/components/EntityIdPill";
import { ListGroupHeader, ListRowShell, type ItemRowState } from "@/components/ListRowShell";
import { PlanProgressBar } from "@/components/PlanDetailPanel";
import { StationStrip } from "@/components/tasks/StationStrip";
import { TaskRow, type TaskPriority } from "@/components/tasks/TaskRow";
import { TaskTimeline } from "@/components/tasks/TaskTimeline";
import { buildTaskGroups } from "@/lib/taskGrouping";
import type { TaskItem } from "@/store/inboxStore";
import { FILE_RESULT, FILE_TOOL, filedHistory, filedSessions, filedTask, mergedEvent, planProgress, planTasks } from "../fixtures/work";
import { WORK_AT } from "./work.motion";
import { CUES, OBJECTS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import type { PartProps } from "./contract";

const noop = () => {};
const STATUS_CYCLE = ["open", "in_progress", "in_review", "done"];
const PRIORITY_CYCLE: TaskPriority[] = ["urgent", "high", "medium", "low"];
const next = <T,>(cycle: T[], v: T) => cycle[(cycle.indexOf(v) + 1) % cycle.length];

/** The lead files the task: the real cast command block, with its task and plan cards. */
export function TaskFiled() {
  const filed = useFilmTime((t) => t >= CUES.taskFiled);
  if (!filed) return null;
  return (
    <div className="px-6 pb-2" {...fly("desk/work.files")}>
      <CastCommandBlock tool={FILE_TOOL} result={FILE_RESULT} />
    </div>
  );
}

/** The board: the plan's task list, its progress, and the new task's stations and activity. */
export function TaskBoard({ now }: PartProps) {
  const stage = useFilmTime((t) => (t < CUES.taskClaimed ? "landed" : "claimed"));
  const advanced = useFilmTime((t) => t >= WORK_AT.planAdvances);
  const merged = useFilmTime((t) => t >= CUES.merged);
  const before = useFilmTime((t) => t < CUES.taskFiled);
  // What a visitor's clicks changed, per task; forgotten when the film comes round again.
  const [edits, setEdits] = useState<Record<string, Partial<TaskItem>>>({});
  const [focused, setFocused] = useState("hero-t1");
  if (before && (Object.keys(edits).length > 0 || focused !== "hero-t1")) {
    setEdits({});
    setFocused("hero-t1");
  }

  const filed = { ...filedTask(now, stage), ...edits["hero-t1"] };
  const tasks = [filed, ...planTasks(now, advanced).map((t) => ({ ...t, ...edits[t._id] }))];
  const group = useMemo(
    () => buildTaskGroups({ group: "plan", tasks, sortTasks: (ts) => ts, statusFilter: "", ctx: { projects: {}, onFilterLabel: noop } })?.[0],
    // The header reads the plan only, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const edit = (task: TaskItem, mode: string) => {
    if (mode !== "status" && mode !== "priority") return;
    const patch = mode === "status" ? { status: next(STATUS_CYCLE, task.status) } : { priority: next(PRIORITY_CYCLE, task.priority as TaskPriority) };
    setEdits((e) => ({ ...e, [task._id]: { ...e[task._id], ...patch } }));
  };
  const stateOf = (task: TaskItem): ItemRowState => ({
    isFocused: focused === task._id,
    isSelected: false,
    isEditing: false,
    onClick: () => setFocused(task._id),
    onSelect: () => setFocused(task._id),
    onContextMenu: noop,
    onEditDone: noop,
    onTitleCommit: noop,
    onOpenPalette: (mode) => edit(task, mode),
  });

  return (
    <div className="cq-container flex h-full flex-col text-sol-text">
      {group && <ListGroupHeader label={group.label} count={tasks.length} icon={group.icon} badge={group.badge} extra={group.extra} collapsed={false} />}
      {tasks.map((task) => (
        <div key={task._id} data-hero-live="" {...fly(`board/work.row:${task._id}`)}>
          <ListRowShell state={stateOf(task)}>
            <TaskRow task={task} state={stateOf(task)} onFilterLabel={noop} />
          </ListRowShell>
        </div>
      ))}
      <div className="flex min-h-0 flex-1 gap-6 px-4 pt-4" {...fly("board/work.below")}>
        <div className="w-[440px] shrink-0">
          <div {...fly("board/work.plan")}>
            <PlanProgressBar progress={planProgress(tasks)} />
          </div>
          <div {...fly("board/work.station")}>
            <StationStrip task={filed as TaskItem & { status_id?: string }} />
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-hidden" {...fly("board/work.detail")}>
          <TaskTimeline
            task={{ _id: filed._id, created_at: filed.created_at, creator: filed.creator, created_from_conversation: filed.created_from_conversation, history: filedHistory(now, stage), external: filed.external && { provider: filed.external.provider as "linear" } }}
            sessions={filedSessions(now, stage)}
            externalEvents={merged ? [mergedEvent(now)] : []}
            openLinkedSession={noop}
          />
        </div>
      </div>
    </div>
  );
}

/** The task in flight from the transcript to the board: its real reference pill. */
export function TaskFlyer() {
  return (
    <div className="-translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-sol-violet/30 bg-sol-bg px-2.5 py-1.5 text-[13px] shadow-xl">
      <EntityIdPill shortId={OBJECTS.task.shortId} type="task" />
    </div>
  );
}
