// Triage with a way back: resolve, ignore or reopen one issue or a
// selection, with a toast that names what changed and an Undo (also z). The
// undo puts back each group's status and its resolve stamps exactly, so a
// regressed issue resolved by mistake reads as regressed again
// (ingest.setGroupStatus restore). One step is kept per window: a newer
// triage replaces it.
import { createElement } from "react";
import { toast } from "sonner";
import type { GroupStatus } from "@codecast/shared/contracts/ingest";
import { useInboxStore } from "../../store/inboxStore";
import { UndoLabel } from "./issueParts";
import type { OpsGroupResolveStamps } from "../../store/opsSlice";
import { hogqlExclude } from "./issuesModel";
import type { OpsGroup, OpsWatch } from "./opsTypes";

export type TriageStep = {
  status: GroupStatus;
  label: string;
  rows: ({ id: string; status: GroupStatus } & OpsGroupResolveStamps)[];
};

/** The toast's Undo, with its key. */
const UNDO_ACTION = {
  label: createElement(UndoLabel),
  onClick: () => void undoTriage(),
};

const VERB: Partial<Record<GroupStatus, string>> = { resolved: "resolved", ignored: "ignored", open: "reopened", muted: "muted" };

/** The step a triage makes: the rows it changes with what they held, and the words for it. Null when it changes nothing. */
export function triageStep(rows: Pick<OpsGroup, "_id" | "short_id" | "status" | "resolved_at" | "resolved_in" | "resolved_via" | "resolved_by">[], status: GroupStatus): TriageStep | null {
  const changed = rows.filter((g) => g.status !== status);
  if (!changed.length) return null;
  const verb = VERB[status] ?? status;
  return {
    status,
    label: changed.length === 1 ? `${changed[0].short_id} ${verb}` : `${changed.length.toLocaleString()} issues ${verb}`,
    // Who resolved it rides only on a row that carried it: a server that never stamped it would refuse the field.
    rows: changed.map((g) => ({
      id: g._id,
      status: g.status,
      resolved_at: g.resolved_at ?? null,
      resolved_in: g.resolved_in ?? null,
      ...(g.resolved_via ? { resolved_via: g.resolved_via, resolved_by: g.resolved_by ?? null } : {}),
    })),
  };
}

/** Selections past this many rows confirm their count before a triage runs. */
export const TRIAGE_CONFIRM_AT = 25;

let last: TriageStep | null = null;
/** A problem task's status change from the Fix card, taken back by the same z. */
let lastTask: { label: string; undo: () => void } | null = null;

export function lastTriage(): TriageStep | null {
  return last;
}

export function triage(rows: OpsGroup[], status: GroupStatus): TriageStep | null {
  const step = triageStep(rows, status);
  if (!step) return null;
  last = step;
  lastTask = null;
  const st = useInboxStore.getState();
  for (const r of step.rows) st.setOpsGroupStatus(r.id, status);
  toast(step.label, {
    id: "ops-triage",
    duration: 8000,
    action: UNDO_ACTION,
  });
  return step;
}

/** Takes the last triage back; false when there is none to take back. */
export function undoTriage(): boolean {
  if (lastTask) {
    const t = lastTask;
    lastTask = null;
    t.undo();
    toast(`Undone: ${t.label}`, { id: "ops-triage", duration: 3000 });
    return true;
  }
  const step = last;
  if (!step) return false;
  last = null;
  const st = useInboxStore.getState();
  for (const { id, status, ...stamps } of step.rows) st.setOpsGroupStatus(id, status, stamps);
  toast(`Undone: ${step.label}`, { id: "ops-triage", duration: 3000 });
  return true;
}

const TASK_VERB: Record<string, string> = { open: "reopened", done: "closed", dropped: "dropped", in_progress: "started" };

/** Moves a problem task's status from the Fix card, with the same toast and Undo (z) as triage: it puts back the status it held. */
export function setTaskStatusUndoable(task: { short_id: string; status?: string }, status: string): void {
  const before = task.status ?? "open";
  if (before === status) return;
  const st = useInboxStore.getState();
  void st.updateTask(task.short_id, { status });
  const label = `${task.short_id} ${TASK_VERB[status] ?? status.replace("_", " ")}`;
  last = null;
  lastTask = { label, undo: () => void useInboxStore.getState().updateTask(task.short_id, { status: before }) };
  toast(label, {
    id: "ops-triage",
    duration: 8000,
    action: UNDO_ACTION,
  });
}

/** Leave a part out of a metric: the watch's own query with that part compared away, and an Undo that puts the query back. False when the query cannot say it. */
export function leaveOutOfWatch(watch: Pick<OpsWatch, "_id" | "short_id" | "query">, key: string): boolean {
  const next = hogqlExclude(watch.query, key);
  if (!next) return false;
  const before = watch.query;
  useInboxStore.getState().updateOpsWatch(watch._id, { query: next });
  toast(`${watch.short_id} no longer counts it`, { action: { label: "Undo", onClick: () => useInboxStore.getState().updateOpsWatch(watch._id, { query: before }) } });
  return true;
}
