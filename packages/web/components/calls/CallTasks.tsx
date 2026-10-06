"use client";

// The tasks pulled from a call (tasks.from_call), under the recap on the call
// page. The list derives from the store's task rows, so a task linked here, on
// another device or by `cast task create --from-call` shows at once. Linking
// an existing task is the palette in pick mode; typing a new title there
// creates one on the call.

import { useMemo, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { ListPlus, Plus, X } from "lucide-react";
import { taskVisual } from "../TaskStatusBadge";
import { openBeside } from "../../lib/stage";
import { taskFacePath } from "../../lib/workUnit";
import { createTaskAndAdopt } from "../../lib/taskActions";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useInboxStore } from "../../store/inboxStore";
import type { WorkspaceKey } from "../../lib/workspaceScope";

type CallRef = { _id: string; team_id?: string };
type CallTask = { _id: string; short_id: string; title: string; status: string; from_call?: string; created_at?: number };

const callTaskSig = (row: any) => `${row.from_call ?? ""}|${row.status}|${row.title}|${row.short_id}`;

/** The live tasks pulled from this call, oldest first. Read in the call's own
 *  workspace, so the page shows them whichever team is active. */
export function useCallTasks(call: CallRef | null | undefined): CallTask[] {
  const workspace = (call?.team_id ? `team:${call.team_id}` : null) as WorkspaceKey | null;
  const rows = useWorkspaceCollection<CallTask>("tasks", callTaskSig, workspace);
  return useMemo(
    () =>
      rows
        .filter((t) => !!call && t.from_call === call._id && t.status !== "dropped")
        .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)),
    [rows, call?._id],
  );
}

/** A new task on this call, filed in the call's team. */
export function makeCallTask(call: CallRef, title: string) {
  const t = title.trim();
  if (!t) return;
  void createTaskAndAdopt({
    title: t,
    from_call: call._id,
    ...(call.team_id ? { team_id: call.team_id, workspace: "team" } : {}),
  });
}

/** Pick a task to link to this call, or type a title to create one. */
function pickCallTask(call: CallRef) {
  useInboxStore.getState().openPalette({
    pick: {
      title: "Add a task to this call",
      kinds: ["task"],
      extras: [{ key: "new", label: "New task with the title typed above", icon: "sparkles", primary: true, needsQuery: true }],
      onPick: (target, result) => {
        if (target.kind === "extra") return makeCallTask(call, result.query);
        const s = useInboxStore.getState();
        const row = (s.tasks as any)[target.id];
        if (row?.short_id) s.updateTask(row.short_id, { from_call: call._id });
      },
    },
  });
}

/** Normalized title, so an action item finds the task made from it. */
export const itemKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.]+$/, "");

export function CallTasks({ call, tasks }: { call: CallRef; tasks: CallTask[] }) {
  const router = useRouter();
  const open = (e: MouseEvent, t: CallTask) => {
    e.preventDefault();
    const path = taskFacePath(t);
    if (!openBeside(path)) router.push(path);
  };
  return (
    <section className="rt-tasks" aria-label="Tasks from this call">
      <div className="rt-tasks-head">
        <span className="rt-recap-items-label">
          <ListPlus className="h-3 w-3" /> Tasks{tasks.length > 0 ? ` · ${tasks.length}` : ""}
        </span>
        <button type="button" className="rt-tasks-add" onClick={() => pickCallTask(call)} title="Link a task to this call, or create one">
          <Plus className="h-3 w-3" /> Add task
        </button>
      </div>
      {tasks.length === 0 ? (
        <p className="rt-tasks-empty">None yet. Make one from an action item, or add one.</p>
      ) : (
        <ul>
          {tasks.map((t) => {
            const { icon: StatusIcon, color, label } = taskVisual(t.status);
            return (
              <li key={t._id} className="group rt-task">
                <a href={taskFacePath(t)} onClick={(e) => open(e, t)} className="rt-task-link" title={`${t.short_id}: ${t.title} (${label.toLowerCase()})`}>
                  <StatusIcon className={`h-3.5 w-3.5 flex-shrink-0 ${color}`} />
                  <span className="rt-task-id">{t.short_id}</span>
                  <span className="truncate">{t.title}</span>
                </a>
                <button
                  type="button"
                  className="rt-task-unlink"
                  onClick={() => useInboxStore.getState().updateTask(t.short_id, { from_call: "" })}
                  title="Unlink from this call (the task stays)"
                  aria-label={`Unlink ${t.short_id} from this call`}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
