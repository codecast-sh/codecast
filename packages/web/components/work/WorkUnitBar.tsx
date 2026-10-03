"use client";

// A task and its owning session are one unit of work with two faces: the task
// is the durable statement (what, why, done when), the session is the live
// work. This bar sits at the top of BOTH faces and draws the same thing on
// each, with the face you are on lit, so the two pages read as one object.
// It is the first item on the context rail (components/ContextRail).
// Switching faces re-points the pane you are in; Split puts the other face
// beside it.

import { useContext, useEffect, useRef } from "react";
import { Columns2, Rows2 } from "lucide-react";
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
import { openBeside, sessionPanePath, stageClose, stageFocus, stageHasRoom } from "../../lib/stage";
import { useTabContext } from "../../lib/tabParams";
import { InsideWorkUnit, setSessionStacked, taskFacePath, useLeafShowing, useSessionStacked, useSwitchFace, type WorkFace } from "../../lib/workUnit";
import { HeightGrip, savedGripHeight } from "../HeightGrip";
import { SessionPane } from "../stage/SessionPane";
import { RoutePane } from "../RoutePane";
import { ErrorBoundary } from "../ErrorBoundary";
import { RailDetail } from "../ContextRail";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { usePersonifyAll } from "../../hooks/usePersonifyAll";

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

// "closed/total" of a task's direct subtasks, or "" with none: a plain
// string, so the selector's result compares by value.
function subtaskTally(taskId: string, tasks: Record<string, any>): string {
  const c = subtaskCounts(taskId, Object.values(tasks));
  return c ? `${c.closed}/${c.open + c.closed}` : "";
}

function liveSig(row: any): string {
  if (!row) return "";
  return [row.title, row.is_idle, row.character_name, row.character_avatar, row.thread_state, row.thread_state_status, row.thread_state_at].join("\u0001");
}

export type { WorkFace } from "../../lib/workUnit";

const BOTH_HEIGHT_KEY = "work-unit-both-height";
const BOTH_MIN = 160;

export function WorkUnitBar(props: { face: WorkFace; task: WorkUnitTask; session: WorkUnitSession }) {
  // The other face stacked inside this one already sits under a bar.
  if (useContext(InsideWorkUnit)) return null;
  return <WorkUnitBarInner {...props} />;
}

function WorkUnitBarInner({ face, task, session }: { face: WorkFace; task: WorkUnitTask; session: WorkUnitSession }) {
  const now = useCoarseNow(30_000);
  const tab = useTabContext();
  // Both faces at once: beside this pane when the stage has room, else
  // stacked under the bar at a height the reader drags.
  const stacked = useSessionStacked(session._id);
  const setStacked = (on: boolean) => setSessionStacked(session._id, on);
  // A stacked face folds away when the bar goes (the page closes or moves).
  // eslint-disable-next-line no-restricted-syntax -- clears the shared stacked flag on unmount
  useEffect(() => () => setSessionStacked(session._id, false), [session._id]);
  const frameRef = useRef<HTMLDivElement>(null);
  const switchFace = useSwitchFace();
  const personifyAll = usePersonifyAll();
  // The store rows are the live truth; the props are what the page already
  // had in hand. The re-render signature covers identity, declared state, the
  // task's status and its subtask tally. Heartbeats are left out on purpose
  // (they tick about once a second); liveness is re-read on the coarse clock.
  const sig = useInboxStore((s) => `${liveSig(s.sessions[session._id])}|${(s.tasks as any)[task._id]?.status ?? ""}|${subtaskTally(task._id, s.tasks)}`);
  const st = useInboxStore.getState();
  const liveRow: any = { ...session, ...(st.sessions[session._id] ?? {}) };
  const status = (st.tasks as any)[task._id]?.status ?? task.status;
  const visual = taskVisual(status);
  const [closed, total] = sig.slice(sig.lastIndexOf("|") + 1).split("/").map(Number);
  const counts = total > 0 ? { closed, open: total - closed } : null;
  const StatusIcon = visual.icon;

  const row = identityRowOf(liveRow);
  const sessionTitle = cleanTitle(String(liveRow.title || "")) || "Session";
  const line = identityLine(row, sessionTitle, personifyAll);
  const live = sessionLiveAt(liveRow, now);
  const quiet = liveRow.updated_at ? compactAge(now - liveRow.updated_at) : null;

  const taskPath = taskFacePath(task);
  const sessionPath = sessionPanePath(session._id);
  const otherPath = face === "task" ? sessionPath : taskPath;
  // The other face already open in a pane beside this one: its tab focuses
  // that pane, and Both (pressed) closes it.
  const otherLeaf = useLeafShowing(otherPath);
  const together = stacked || otherLeaf !== null;
  const goOther = () => { if (otherLeaf) stageFocus(otherLeaf); else switchFace(otherPath); };

  const stateView = threadStateView(liveRow, liveRow.message_count ?? 0, now);
  const pinned = stateView?.text ?? null;
  const declared = stateView?.status ?? null;
  // The session says it finished while the task still reads as underway: the
  // two faces disagree, and the next move is the task's.
  const finishedAhead = declared === "done" && (status === "in_progress" || status === "open");

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

  const liveMark = declared === "blocked" ? (
    <span className="flex-shrink-0 text-sol-yellow">needs you</span>
  ) : declared === "done" ? (
    <span className="flex-shrink-0 text-sol-cyan">complete</span>
  ) : live ? (
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

  const bar = (
    <div data-work-unit data-cc-rail-item="task" className="flex items-center gap-1.5 flex-[1_0_20rem] min-w-0">
      <div role="tablist" aria-label="Task and session" className="flex items-stretch h-6 min-w-0 flex-1 rounded-md border border-sol-border/40 overflow-hidden text-[11px]">
        <button
          role="tab"
          aria-selected={face === "task"}
          onClick={() => face !== "task" && goOther()}
          className={segment(face === "task")}
          title={face === "task" ? "This task" : `Open the task: ${task.short_id ?? ""} ${task.title}`}
        >
          {taskSegment}
        </button>
        <span aria-hidden className="w-px bg-sol-border/40 flex-shrink-0" />
        <button
          role="tab"
          aria-selected={face === "session"}
          onClick={() => face !== "session" && goOther()}
          className={segment(face === "session")}
          title={face === "session" ? "The session doing this task" : `Open the session doing this task: ${line.name ? `${line.name} · ` : ""}${sessionTitle}`}
        >
          {sessionSegment}
        </button>
      </div>
      {finishedAhead && task.short_id && (
        <button
          type="button"
          onClick={() => void useInboxStore.getState().updateTaskStatus(task.short_id!, "in_review")}
          className="flex items-center h-6 px-2 rounded-md border border-sol-violet/40 bg-sol-violet/10 text-[11px] text-sol-violet hover:bg-sol-violet/20 transition-colors flex-shrink-0"
          title={`${line.name ?? "The session"} says it is complete; the task is still ${visual.label.toLowerCase()}`}
        >
          Move to review
        </button>
      )}
      <ShortcutTooltip label={together ? "Show this face alone" : "Show the task and the session together"}>
        <button
          type="button"
          onClick={() => {
            if (stacked) { setStacked(false); return; }
            if (otherLeaf) { stageClose(otherLeaf); return; }
            if (stageHasRoom() && openBeside(otherPath)) return;
            setStacked(true);
          }}
          aria-pressed={together}
          className={`flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] transition-colors flex-shrink-0 ${
            together ? "border-sol-cyan/50 text-sol-cyan bg-sol-cyan/10" : "border-sol-border/40 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40"
          }`}
        >
          {otherLeaf || (stageHasRoom() && !stacked) ? <Columns2 className="w-3.5 h-3.5" /> : <Rows2 className="w-3.5 h-3.5" />}
          <span>Both</span>
        </button>
      </ShortcutTooltip>
    </div>
  );

  if (!stacked) return bar;
  return (
    <>
      {bar}
      <RailDetail>
      <InsideWorkUnit.Provider value={true}>
        <div
          ref={frameRef}
          data-work-unit-stack
          className="relative flex flex-col min-h-0 overflow-hidden border-b border-sol-cyan/25 bg-sol-bg flex-shrink-0"
          style={{ height: savedGripHeight(BOTH_HEIGHT_KEY, BOTH_MIN) ?? 380 }}
        >
          <ErrorBoundary name="WorkUnitStack" level="panel">
            {face === "task" ? (
              <SessionPane sessionId={session._id} />
            ) : (
              <RoutePane tabId={tab?.tabId ?? "work-unit"} path={taskPath} isActive={false} isVisible={tab?.isVisible ?? true} />
            )}
          </ErrorBoundary>
        </div>
        <HeightGrip target={frameRef} storageKey={BOTH_HEIGHT_KEY} min={BOTH_MIN} />
      </InsideWorkUnit.Provider>
      </RailDetail>
    </>
  );
}
