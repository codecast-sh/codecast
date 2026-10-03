"use client";

// A task and its owning session are one unit of work with two faces: the task
// is the durable statement (what, why, done when), the session is the live
// work. This bar sits at the top of BOTH faces and draws the same thing on
// each, with the face you are on lit, so the two pages read as one object.
// Switching faces re-points the pane you are in; Split puts the other face
// beside it.

import { useRouter } from "next/navigation";
import { Columns2 } from "lucide-react";
import { IdentityFace } from "../identity/IdentityFace";
import { LivenessDot } from "../LivenessDot";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { taskVisual } from "../TaskStatusBadge";
import { SubtaskRing } from "../tasks/TaskRow";
import { subtaskCounts } from "../../lib/scopePage";
import { identityLine, identityRowOf } from "../../lib/sessionIdentity";
import { sessionLiveAt } from "../../lib/liveness";
import { compactAge, threadStateView } from "../../lib/threadState";
import { cleanTitle } from "../../lib/conversationProcessor";
import { openBeside, sessionPanePath, stageNavigateLeaf } from "../../lib/stage";
import { useTabContext } from "../../lib/tabParams";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { usePersonifyAll } from "../../hooks/usePersonifyAll";

export type WorkFace = "task" | "session";

export interface WorkUnitTask {
  _id: string;
  short_id?: string | null;
  title: string;
  status?: string | null;
}

export interface WorkUnitSession {
  _id: string;
  title?: string | null;
  updated_at?: number;
  message_count?: number;
  [k: string]: unknown;
}

export function taskFacePath(task: Pick<WorkUnitTask, "_id" | "short_id">): string {
  return `/tasks/${task.short_id || task._id}`;
}

/** Re-point the pane this face renders in; a plain tab navigates. */
export function useSwitchFace(): (path: string) => void {
  const router = useRouter();
  const ctx = useTabContext();
  return (path: string) => {
    if (ctx?.leafId) stageNavigateLeaf(ctx.leafId, path, "replace");
    else router.push(path);
  };
}

function liveSig(row: any): string {
  if (!row) return "";
  return [row.title, row.is_idle, row.updated_at, row.message_count, row.character_name, row.character_avatar, row.last_heartbeat, row.producing_until].join("\u0001");
}

export function WorkUnitBar({ face, task, session }: { face: WorkFace; task: WorkUnitTask; session: WorkUnitSession }) {
  const now = useCoarseNow(30_000);
  const switchFace = useSwitchFace();
  const personifyAll = usePersonifyAll();
  // The store row is the live truth for the session (and the task's status);
  // the props are what the page already had in hand.
  useInboxStore((s) => {
    const counts = subtaskCounts(task._id, Object.values(s.tasks as any));
    return `${liveSig(s.sessions[session._id])}|${(s.tasks as any)[task._id]?.status ?? ""}|${counts ? `${counts.closed}/${counts.open}` : ""}`;
  });
  const st = useInboxStore.getState();
  const liveRow: any = { ...session, ...(st.sessions[session._id] ?? {}) };
  const status = (st.tasks as any)[task._id]?.status ?? task.status;
  const visual = taskVisual(status);
  const counts = subtaskCounts(task._id, Object.values(st.tasks as any));
  const StatusIcon = visual.icon;

  const row = identityRowOf(liveRow);
  const sessionTitle = cleanTitle(String(liveRow.title || "")) || "Session";
  const line = identityLine(row, sessionTitle, personifyAll);
  const live = sessionLiveAt(liveRow, now);
  const quiet = liveRow.updated_at ? compactAge(now - liveRow.updated_at) : null;

  const taskPath = taskFacePath(task);
  const sessionPath = sessionPanePath(session._id);
  const otherPath = face === "task" ? sessionPath : taskPath;

  const pinned = threadStateView(liveRow, liveRow.message_count ?? 0, now)?.text ?? null;

  // The face you are on is a compact "you are here" tab; the other face takes
  // the width and carries what you would go there to learn.
  const segment = (active: boolean) =>
    `flex items-center gap-1.5 min-w-0 px-2.5 h-full transition-colors ${
      active
        ? "flex-shrink-0 bg-sol-bg text-sol-text font-medium shadow-[inset_0_-2px_0_0_var(--sol-cyan,#2aa198)] cursor-default"
        : "flex-1 text-sol-text-secondary hover:text-sol-text hover:bg-sol-bg/60"
    }`;

  const taskSegment = face === "task" ? (
    <>
      <StatusIcon className={`w-3 h-3 flex-shrink-0 ${visual.color}`} />
      <span>Task</span>
    </>
  ) : (
    <>
      <StatusIcon className={`w-3 h-3 flex-shrink-0 ${visual.color}`} />
      {task.short_id && <span className="font-mono flex-shrink-0 text-sol-text-dim">{task.short_id}</span>}
      <span className="truncate">{task.title}</span>
      {counts && (
        <span className="ml-auto pl-1 flex items-center gap-1 flex-shrink-0 text-sol-text-dim tabular-nums" title={`${counts.closed} of ${counts.open + counts.closed} subtasks done`}>
          <SubtaskRing done={counts.closed} total={counts.open + counts.closed} />
          {counts.closed}/{counts.open + counts.closed}
        </span>
      )}
    </>
  );

  const liveMark = live ? (
    <span className="flex items-center gap-1 flex-shrink-0">
      <LivenessDot state="active" size="xs" />
      <span className="text-sol-green/80">working</span>
    </span>
  ) : quiet ? (
    <span className="flex-shrink-0 text-sol-text-dim tabular-nums">{quiet}</span>
  ) : null;

  const sessionSegment = face === "session" ? (
    <>
      <IdentityFace row={row as any} size={16} hover={false} className="flex-shrink-0" />
      <span>Session</span>
    </>
  ) : (
    <>
      <IdentityFace row={row as any} size={16} hover={false} className="flex-shrink-0" />
      <span className="flex-shrink-0 font-medium max-w-[40%] truncate">{line.name ?? sessionTitle}</span>
      {liveMark}
      {pinned && <span className="min-w-0 truncate text-sol-text-dim">{pinned}</span>}
    </>
  );

  return (
    <div data-work-unit className="flex items-center gap-2 h-8 px-3 border-b border-sol-border/30 bg-sol-bg-alt/50 flex-shrink-0">
      <div role="tablist" aria-label="Task and session" className="flex items-stretch h-6 min-w-0 flex-1 rounded-md border border-sol-border/40 overflow-hidden text-[11px]">
        <button
          role="tab"
          aria-selected={face === "task"}
          onClick={() => face !== "task" && switchFace(taskPath)}
          className={segment(face === "task")}
          title={face === "task" ? "This task" : `Open the task: ${task.short_id ?? ""} ${task.title}`}
        >
          {taskSegment}
        </button>
        <span aria-hidden className="w-px bg-sol-border/40 flex-shrink-0" />
        <button
          role="tab"
          aria-selected={face === "session"}
          onClick={() => face !== "session" && switchFace(sessionPath)}
          className={segment(face === "session")}
          title={face === "session" ? "The session doing this task" : `Open the session doing this task: ${line.name ? `${line.name} · ` : ""}${sessionTitle}`}
        >
          {sessionSegment}
        </button>
      </div>
      <ShortcutTooltip label={face === "task" ? "Open the session beside" : "Open the task beside"}>
        <button
          type="button"
          onClick={() => { if (!openBeside(otherPath)) switchFace(otherPath); }}
          className="flex items-center gap-1 h-6 px-2 rounded-md border border-sol-border/40 text-[11px] text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors flex-shrink-0"
          aria-label="Split"
        >
          <Columns2 className="w-3.5 h-3.5" />
          <span>Split</span>
        </button>
      </ShortcutTooltip>
    </div>
  );
}
