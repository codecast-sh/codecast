// Task evidence (docs/architecture/the-line.md L6): the one object
// taskEvidence.get computes for a task, stored under the task's Convex id so
// the page paints from cache on the next visit. Feeder returns readiness
// only; the section reads the store (useTaskEvidence).
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export type TaskEvidencePage = {
  id: string;
  slug: string;
  title: string;
  version: number;
  kind: string;
  station: string | null;
  thumbnail_url: string | null;
  href: string;
  updated_at: number;
};

export type TaskEvidenceRow = {
  _id: string;
  task: { id: string; short_id: string; station: string };
  pages: TaskEvidencePage[];
  stations: Array<{ station: string; pages: TaskEvidencePage[] }>;
  docs: Array<{ id: string; title: string; doc_type: string; updated_at: number; href: string }>;
  images: Array<{ url: string; conversation_id: string; message_id: string; timestamp: number }>;
  files_changed: string[];
  verification_evidence: string | null;
  execution_status: string | null;
  pr_url: string | null;
  review_verdict: { verdict: string; at: number; note?: string; by_conversation_id?: string } | null;
};

const selectRow = (row: any) => (row?.task?.id ? [{ _id: row.task.id, ...row }] : []);

/** Feeder: one task's evidence. Accepts the Convex id or the short id; the
 *  row lands under the Convex id either way. */
export function useSyncTaskEvidence(taskRef: string | null | undefined) {
  return useSyncCollection("taskEvidence", api.taskEvidence.get, taskRef ? { task_id: taskRef } : "skip", useMemo(() => ({ select: selectRow }), []));
}

/** Reader: the evidence row for a task's Convex id. */
export function useTaskEvidence(taskId: string | null | undefined): TaskEvidenceRow | undefined {
  return useInboxStore((s) => (taskId ? ((s as any).taskEvidence?.[taskId] as TaskEvidenceRow | undefined) : undefined));
}
