import { useCallback } from "react";
import { useTrackedStore, type TaskDetail } from "../store/inboxStore";
import type { PageThreadRow } from "../store/threadTypes";
import type { Comment } from "../lib/commentThread";
import type { ThreadCardModel } from "../lib/threadCards";
import { codeAnchorOf, rowOf } from "../lib/threadRows";
import { useCodeComments } from "./useSyncCodeComments";
import type { CodeCommentRow } from "../lib/prView";
import { useThreadsPage } from "../components/threads/threadsContext";

// The store readers the Threads kind renderers share. Hooks live here rather
// than beside the renderers so every component module exports only
// components (the Fast Refresh guard).

/** The task row, woken only by the fields a card shows. */
function taskSig(t: TaskDetail | undefined): string {
  if (!t) return "";
  const last = t.comments?.[t.comments.length - 1];
  return `${t.short_id}|${t.external?.identifier ?? ""}|${t.external?.synced_at ?? ""}|${t.external?.last_error ?? ""}|${t.title}|${t.status}|${t.priority ?? ""}|${t.assignee_info?.name ?? ""}|${t.plan?.short_id ?? ""}|${(t.description ?? "").length}|${t.comments?.length ?? 0}|${last?._id ?? ""}|${last?.text?.length ?? 0}`;
}

export function useTaskRow(taskId: string): TaskDetail | undefined {
  const s = useTrackedStore([(s) => taskSig(s.tasks[taskId] as TaskDetail | undefined)]);
  return s.tasks[taskId] as TaskDetail | undefined;
}

/** The page row, woken only by what a card shows. */
function pageSig(p: PageThreadRow | undefined): string {
  if (!p) return "";
  const last = p.comments[p.comments.length - 1];
  return `${p.title}|${p.slug}|${p.comments.length}|${last?._id ?? ""}|${last?.text.length ?? 0}`;
}

export function usePageThreadRow(artifactId: string): PageThreadRow | undefined {
  const s = useTrackedStore([(s: any) => pageSig(s.pageThreads[artifactId])]);
  return (s as any).pageThreads[artifactId] as PageThreadRow | undefined;
}

/** A code thread's rows, oldest first, from the store the commit page reads. */
export function useCodeThreadRows(card: ThreadCardModel): CodeCommentRow[] {
  const { repository, ref, filePath, lineNumber } = codeAnchorOf(rowOf(card));
  return useCodeComments(
    useCallback(
      (c: CodeCommentRow) =>
        c.repository === repository &&
        c.ref === ref &&
        (c.file_path ?? undefined) === filePath &&
        (c.line_number ?? undefined) === lineNumber,
      [repository, ref, filePath, lineNumber],
    ),
  );
}

const EMPTY_COMMENTS: Comment[] = [];

/** A session comment thread's rows, oldest first — from the page's ONE
 *  assembled map (threadsContext.commentThreads), never a per-card scan of
 *  the whole comments collection. */
export function useCommentThreadRows(card: ThreadCardModel): Comment[] {
  const { commentThreads } = useThreadsPage();
  return commentThreads.get(rowOf(card).root_key) ?? EMPTY_COMMENTS;
}
